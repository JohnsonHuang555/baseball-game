// V2 球團存檔：localStorage 的獨立 key（dice-baseball.club.v3），不讀也不動 V1 的任何 key。
// 儲存介面抽象成 KeyValueStorage，測試換成記憶體版；跨分頁互斥抽象成 ClubLock。
//
// 多分頁（見 ADR-0008）：localStorage 沒有交易、沒有 compare-and-swap。
// - 有 Web Locks：結算整段（讀最新存檔 → 模擬 → 存檔）包在同一把跨分頁的鎖裡，不會有兩個分頁同時結算。
// - 沒有 Web Locks：只能保證同一個分頁內互斥；存檔前會重新讀取比對 revision，能抓到大部分衝突，
//   但「讀取比對」和「寫入」之間還是可能被別的分頁插隊，所以 crossTab 標成 false，UI 應該限制只用單一分頁。
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { ClubLock, ClubStore } from '../application/settlementService'
import { ClubValidationError, newClub, validateClub, type ClubSaveV3, type PersistentRoster } from '../domain/club'

export const CLUB_STORAGE_KEY = 'dice-baseball.club.v3'
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
  loadClub(): ClubSaveV3 | null {
    const raw = this.read()
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (cause) {
      throw new ClubSaveError('invalid-json', '球團存檔不是合法的 JSON', { cause })
    }
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
  saveClub(club: ClubSaveV3, expectedRevision: number | null): ClubSaveV3 {
    validateClub(club)
    const current = this.peekRevision()
    if (current !== expectedRevision) {
      throw new ClubSaveError('conflict', `存檔已經被其他地方更新（預期版本 ${expectedRevision}，目前 ${current}），請重新讀取`)
    }
    const next: ClubSaveV3 = { ...club, revision: (expectedRevision ?? -1) + 1 }
    const storage = this.requireStorage()
    try {
      storage.setItem(this.key, JSON.stringify(next))
    } catch (cause) {
      throw new ClubSaveError('write-failed', '球團存檔寫入失敗（可能是儲存空間不足或被停用）', { cause })
    }
    return next
  }

  /** 建立新球團；已經有存檔（包含壞掉的存檔）就丟 already-exists，要先 resetClub */
  createClub(input: CreateClubInput): ClubSaveV3 {
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

  /** 刪掉 V2 球團存檔（只動自己的 key） */
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

