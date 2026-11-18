// V2 球團存檔：localStorage 的獨立 key（dice-baseball.club.v3），不讀也不動 V1 時期留下的任何 key（ADR-0016）。
// 儲存介面抽象成 KeyValueStorage，測試換成記憶體版；跨分頁互斥抽象成 ClubLock。
//
// 多分頁（見 ADR-0008）：localStorage 沒有交易、沒有 compare-and-swap。
// - 有 Web Locks：結算整段（讀最新存檔 → 模擬 → 存檔）包在同一把跨分頁的鎖裡，不會有兩個分頁同時結算。
// - 沒有 Web Locks：只能保證同一個分頁內互斥；存檔前會重新讀取比對 revision，能抓到大部分衝突，
//   但「讀取比對」和「寫入」之間還是可能被別的分頁插隊，所以 crossTab 標成 false，UI 應該限制只用單一分頁。
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { ClubLock, ClubStore } from '../application/settlementService'
import { ClubValidationError, newClub, validateClub, type ClubSave, type PersistentRoster } from '../domain/club'
import { MigrationError, migrateToLatest, needsMigration, sourceVersion, type MigratableVersion } from '../domain/migration'

/**
 * V2 球團存檔的 key。名稱裡的 v3 是第一版存檔的版本號，現在存的是 schemaVersion 8：
 * 每次升版都原地升級、沿用同一個 key，讓還開著舊版程式的分頁讀到新版本會停止寫入（見 ADR-0010、ADR-0011、ADR-0012）
 */
export const CLUB_STORAGE_KEY = 'dice-baseball.club.v3'
/** 遷移前的原始文字依來源版本逐字備份（遷移後不再寫入，也不會自動還原） */
export const CLUB_BACKUP_KEY_V3 = 'dice-baseball.club.v3.backup-schema3'
export const CLUB_BACKUP_KEY_V4 = 'dice-baseball.club.v3.backup-schema4'
export const CLUB_BACKUP_KEY_V5 = 'dice-baseball.club.v3.backup-schema5'
export const CLUB_BACKUP_KEY_V6 = 'dice-baseball.club.v3.backup-schema6'
export const CLUB_BACKUP_KEY_V7 = 'dice-baseball.club.v3.backup-schema7'
const BACKUP_KEYS: Record<MigratableVersion, string> = { 3: CLUB_BACKUP_KEY_V3, 4: CLUB_BACKUP_KEY_V4, 5: CLUB_BACKUP_KEY_V5, 6: CLUB_BACKUP_KEY_V6, 7: CLUB_BACKUP_KEY_V7 }
export const CLUB_LOCK_NAME = 'dice-baseball.club.v3.settlement'

/** Storage 的最小子集，localStorage 與記憶體版都符合 */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class MemoryStorage implements KeyValueStorage {
  private readonly data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  keys(): string[] {
    return [...this.data.keys()]
  }
}

/** 瀏覽器的 localStorage；被停用（無痕、封鎖網站資料）時回傳 null */
export function browserStorage(): KeyValueStorage | null {
  try {
    const s = globalThis.localStorage
    if (!s) return null
    s.getItem(CLUB_STORAGE_KEY)
    return s
  } catch {
    return null
  }
}

export type ClubSaveErrorCode =
  | 'storage-unavailable'
  | 'invalid-json'
  | 'invalid-schema'
  | 'unsupported-version'
  | 'write-failed'
  | 'conflict'
  | 'already-exists'
  /** 這個分頁已經不是可寫分頁（沒有 Web Locks 時的單一可寫分頁限制） */
  | 'read-only'
  /** 存檔是舊格式（schemaVersion 3～7），要先遷移才能使用 */
  | 'needs-migration'
  /** 舊格式遷移失敗：原本的存檔沒有被改動 */
  | 'migration-failed'

export class ClubSaveError extends Error {
  override name = 'ClubSaveError'
  constructor(
    readonly code: ClubSaveErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export interface CreateClubInput {
  clubName: string
  now: number
  /** 不給就隨機產生（只在建立時用一次，之後一切由它推導） */
  clubSeed?: number
  clubId?: string
  roster?: PersistentRoster
}

export class ClubRepository implements ClubStore {
  constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly key = CLUB_STORAGE_KEY,
  ) {}

  /** 讀取存檔：沒有存檔回傳 null；壞掉、版本不相容都丟 ClubSaveError，不會默默當成沒有存檔（避免被新球團蓋掉） */
  loadClub(): ClubSave | null {
    const raw = this.read()
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new ClubSaveError('invalid-json', '球團存檔不是合法的 JSON', { cause })
    }
    if (needsMigration(parsed)) throw new ClubSaveError('needs-migration', '球團存檔是舊格式，需要先升級')
    try {
      return validateClub(parsed)
    } catch (cause) {
      if (cause instanceof ClubValidationError) throw new ClubSaveError(cause.code, cause.message, { cause })
      throw cause
    }
  }

  /**
   * 存檔：先重新讀取，確認存檔的 revision 還是 expectedRevision（新球團是 null，代表必須還沒有存檔），
   * 寫入的 revision 加 1。寫入失敗（容量不足、被停用）丟 write-failed，呼叫端不能當作成功
   */
  saveClub(club: ClubSave, expectedRevision: number | null): ClubSave {
    validateClub(club)
    const current = this.peekRevision()
    if (current !== expectedRevision) {
      throw new ClubSaveError('conflict', `存檔已經被其他地方更新（預期版本 ${expectedRevision}，目前 ${current}），請重新讀取`)
    }
    const next: ClubSave = { ...club, revision: (expectedRevision ?? -1) + 1 }
    const storage = this.requireStorage()
    try {
      storage.setItem(this.key, JSON.stringify(next))
    } catch (cause) {
      throw new ClubSaveError('write-failed', '球團存檔寫入失敗（可能是儲存空間不足或被停用）', { cause })
    }
    return next
  }

  /** 建立新球團；已經有存檔（包含壞掉的存檔）就丟 already-exists，要先 resetClub */
  createClub(input: CreateClubInput): ClubSave {
    if (this.read() !== null) throw new ClubSaveError('already-exists', '已經有球團存檔')
    const clubSeed = (input.clubSeed ?? randomUint32()) >>> 0
    const club = newClub({
      clubId: input.clubId ?? randomId(),
      clubName: input.clubName,
      clubSeed,
      roster: input.roster ?? generateRoster(new Rng(clubSeed)),
      now: input.now,
    })
    return this.saveClub(club, null)
  }

  /**
   * 把舊格式（schemaVersion 3～7）的存檔升級到目前格式，回傳升級後的球團；沒有存檔回傳 null。
   * 呼叫端要在 ClubLock 裡呼叫（application 的 openClubSafely）。步驟：
   * 1. 讀主存檔的原始文字；已經是目前格式（別的分頁剛遷移完）就直接回傳
   * 2. 在記憶體裡遷移（純函式），失敗丟 migration-failed，什麼都不寫
   * 3. 碰備份之前，再讀一次主存檔：跟第 1 步不同（別的分頁已經遷移、或舊版分頁又存了一次）就丟 conflict，
   *    備份、主存檔都不寫。所以競爭中較晚的那一方，永遠不會覆寫已經存在、對應到真正遷移結果的備份
   * 4. 把原始文字逐字寫進來源版本的備份 key（backup-schema3 / 4 / 5 / 6 / 7），再讀回來確認一字不差；
   *    寫入失敗丟 write-failed，主存檔不動。備份 key 已經有「別的」內容（例如重設後的另一個球團、更早的遷移）
   *    就不覆寫，改寫到 `<備份 key>.r<revision>`，所以有價值的舊備份不會被蓋掉
   * 5. 寫主存檔前最後再讀一次主存檔，還是第 1 步的原始文字才寫入升級後的存檔
   * 備份永遠是「這一次被遷移的那份舊存檔」：只有第 3、5 步都確認主存檔還是它，才會寫備份與主存檔。
   * 限制：localStorage 沒有交易，第 5 步的「確認」和「寫入」之間仍有極短的空檔。有 Web Locks 時所有 V2 分頁都在鎖裡
   * 排隊，不會有這種競爭；沒有 Web Locks 時（或還開著不認得鎖的舊版分頁）不保證原子性——萬一發生，
   * 主存檔會是升級後的格式（舊版分頁讀到會停止寫入），備份是遷移當下讀到的 V3，那次空檔內被覆蓋的進度會遺失
   */
  migrateClub(): ClubSave | null {
    const raw = this.read()
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new ClubSaveError('invalid-json', '球團存檔不是合法的 JSON', { cause })
    }
    const version = sourceVersion(parsed)
    if (version === null) return this.loadClub()
    let migrated: ClubSave
    try {
      migrated = migrateToLatest(parsed)
    } catch (cause) {
      const message = cause instanceof MigrationError ? cause.message : String(cause)
      throw new ClubSaveError('migration-failed', `球團存檔升級失敗，原本的存檔沒有被改動：${message}`, { cause })
    }
    const unchanged = () => {
      if (this.read() !== raw) throw new ClubSaveError('conflict', '升級時存檔被其他地方改過（可能是另一個分頁），沒有寫入任何東西，請重新讀取')
    }
    const storage = this.requireStorage()
    unchanged()
    const backupKey = this.backupKeyFor(version, raw, parsed)
    try {
      if (storage.getItem(backupKey) !== raw) storage.setItem(backupKey, raw)
    } catch (cause) {
      throw new ClubSaveError('write-failed', '無法寫入舊存檔的備份，沒有進行升級', { cause })
    }
    if (this.readKey(backupKey) !== raw) throw new ClubSaveError('write-failed', '舊存檔的備份讀回來不一致，沒有進行升級')
    unchanged()
    try {
      storage.setItem(this.key, JSON.stringify(migrated))
    } catch (cause) {
      throw new ClubSaveError('write-failed', '升級後的存檔寫入失敗，原本的存檔沒有被改動', { cause })
    }
    return migrated
  }

  /**
   * 這份舊存檔要備份到哪個 key。主要的 key 可以用的情況：空著、已經是同一份、或是同一個球團較舊（含相同）revision 的
   * 未完成遷移殘留（被更新的同一個球團取代沒有損失）。其他內容（例如重設前另一個球團的備份）都視為有價值，
   * 不覆寫，改用帶 revision 的 key
   */
  private backupKeyFor(version: MigratableVersion, raw: string, parsed: unknown): string {
    const primary = BACKUP_KEYS[version]
    const existing = this.readKey(primary)
    if (existing === null || existing === raw || supersedes(parsed, existing)) return primary
    const revision = (parsed as { revision?: unknown }).revision
    const fallback = `${primary}.r${Number.isSafeInteger(revision) ? revision : 'x'}`
    const other = this.readKey(fallback)
    if (other !== null && other !== raw) throw new ClubSaveError('write-failed', '舊存檔的備份位置都已經有其他內容，為了不覆寫備份，沒有進行升級')
    return fallback
  }

  private readKey(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  /** 遷移前的 schemaVersion 3 備份原始文字（給「下載備份」用），沒有就是 null */
  readBackupV3(): string | null {
    return this.readKey(CLUB_BACKUP_KEY_V3)
  }

  /** 遷移前的 schemaVersion 4 備份原始文字，沒有就是 null */
  readBackupV4(): string | null {
    return this.readKey(CLUB_BACKUP_KEY_V4)
  }

  /** 遷移前的 schemaVersion 5 備份原始文字，沒有就是 null */
  readBackupV5(): string | null {
    return this.readKey(CLUB_BACKUP_KEY_V5)
  }

  /** 刪掉 V2 球團存檔（只動自己的 key；遷移備份保留） */
  resetClub(): void {
    const storage = this.requireStorage()
    try {
      storage.removeItem(this.key)
    } catch (cause) {
      throw new ClubSaveError('write-failed', '無法刪除球團存檔', { cause })
    }
  }

  /** 目前存檔的 revision；沒有存檔是 null。存檔壞掉也照樣丟錯，不讓壞檔被覆蓋 */
  private peekRevision(): number | null {
    return this.loadClub()?.revision ?? null
  }

  private requireStorage(): KeyValueStorage {
    if (!this.storage) throw new ClubSaveError('storage-unavailable', '瀏覽器儲存無法使用（可能是無痕模式或封鎖了網站資料）')
    return this.storage
  }

  private read(): string | null {
    const storage = this.requireStorage()
    try {
      return storage.getItem(this.key)
    } catch (cause) {
      throw new ClubSaveError('storage-unavailable', '無法讀取瀏覽器儲存', { cause })
    }
  }
}

function randomUint32(): number {
  const c = globalThis.crypto
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0]
  return Math.floor(Math.random() * 2 ** 32)
}

function randomId(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `club-${randomUint32().toString(16)}-${Date.now().toString(16)}`
}

// ---- 互斥 ----

/** Web Locks API 的最小子集（navigator.locks） */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

/** 跨分頁互斥：同一個來源（origin）的所有分頁共用同一把鎖 */
export class WebLocksClubLock implements ClubLock {
  readonly crossTab = true
  constructor(
    private readonly locks: LockManagerLike,
    private readonly name = CLUB_LOCK_NAME,
  ) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.request(this.name, { mode: 'exclusive' }, fn)
  }
}

/** 只在同一個分頁（同一個 JS 執行環境）內互斥：沒有 Web Locks 時的降級，不保證跨分頁 */
export class InProcessLock implements ClubLock {
  readonly crossTab = false
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/** 有 Web Locks 就用，否則降級成分頁內互斥（crossTab: false，UI 要提示只用單一分頁） */
export function createClubLock(nav: { locks?: LockManagerLike } | undefined = globalThis.navigator as { locks?: LockManagerLike } | undefined): ClubLock {
  return nav?.locks?.request ? new WebLocksClubLock(nav.locks) : new InProcessLock()
}

/** next 是不是同一個球團、revision 不比 existing 舊（existing 是無法解析的內容就不算） */
function supersedes(next: unknown, existingRaw: string): boolean {
  try {
    const a = next as { clubId?: unknown; revision?: unknown }
    const b = JSON.parse(existingRaw) as { clubId?: unknown; revision?: unknown }
    return typeof a.clubId === 'string' && a.clubId === b.clubId && typeof a.revision === 'number' && typeof b.revision === 'number' && b.revision <= a.revision
  } catch {
    return false
  }
}
