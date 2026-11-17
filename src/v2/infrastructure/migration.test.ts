// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fixture from '../domain/__fixtures__/club-v3-phase3.json'
import { openClubSafely } from '../application/clubLifecycle'
import { claim, settleDue } from '../application/settlementService'
import { upgrade } from '../application/economyService'
import { resolveRoster } from '../domain/roster'
import { validateClubV3 } from '../domain/legacyV3'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { CLUB_BACKUP_KEY_V3, CLUB_STORAGE_KEY, ClubRepository, ClubSaveError, MemoryStorage, type KeyValueStorage } from './clubRepository'

const RAW_V3 = JSON.stringify(fixture)
const V1 = {
  'dice-baseball.tournament.v2': '{"version":2,"phase":"playing","round":"season"}',
  'dice-baseball.progress': '{"trophies":[],"cleared":1}',
  'dice-baseball.teamName': '老虎隊',
}

function v3Storage(): MemoryStorage {
  const s = new MemoryStorage()
  s.setItem(CLUB_STORAGE_KEY, RAW_V3)
  for (const [k, v] of Object.entries(V1)) s.setItem(k, v)
  return s
}

/** 記錄寫入次數，可以讓某個 key 的寫入失敗 */
class SpyStorage extends MemoryStorage {
  writes: string[] = []
  failKey: string | null = null
  onWrite: ((key: string) => void) | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    this.writes.push(key)
    super.setItem(key, value)
    this.onWrite?.(key)
  }
}

describe('存檔遷移', () => {
  it('偵測舊格式：直接讀取會要求先升級，不會當成損壞', () => {
    const repo = new ClubRepository(v3Storage())
    const error = (() => {
      try {
        repo.loadClub()
      } catch (e) {
        return e as ClubSaveError
      }
    })()
    expect(error?.code).toBe('needs-migration')
  })

  it('打開球團時自動遷移：原始文字備份、主存檔換成新格式，進度全部保留、V1 不受影響', async () => {
    const storage = v3Storage()
    const deps = tab(storage, new ManualClock(), new FakeLockManager())
    const { value } = await openClubSafely(deps)
    expect(value.migrated).toBe(true)
    const club = value.club!
    expect(club.schemaVersion).toBe(4)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).schemaVersion).toBe(4)
    expect(resolveRoster(club)).toEqual(fixture.roster)
    expect(club.economy.assets).toEqual(fixture.economy.assets)
    expect(club.record).toEqual(fixture.record)
    expect(club.idle.nextMatchIndex).toBe(fixture.idle.nextMatchIndex)
    for (const [k, v] of Object.entries(V1)) expect(storage.getItem(k)).toBe(v)
    // 再打開一次：已經是新格式，不再遷移
    const again = await openClubSafely(deps)
    expect(again.value.migrated).toBe(false)
    expect(again.value.club).toEqual(club)
  })

  it('遷移後可以正常遊玩：結算不會重算舊比賽，領取、升級都正常', async () => {
    const storage = v3Storage()
    const clock = new ManualClock(fixture.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    // 時間沒到：0 場（已結算的 36 場不會重算）
    expect((await settleDue(deps)).settled).toHaveLength(0)
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled.map((m) => m.matchIndex)).toEqual(Array.from({ length: 12 }, (_, i) => 36 + i))
    await claim(deps, report.club.economy.nextClaimSeq)
    const c = deps.store.loadClub()!
    await upgrade(deps, { opSeq: 0, playerId: c.roster.lineup[0].playerId, expectedLevel: 1 })
    expect(deps.store.loadClub()!.players[0].level + deps.store.loadClub()!.players.slice(1).reduce((s, r) => s + r.level, 0)).toBe(15)
  })

  it('遷移中斷（寫入失敗）：原本的存檔不變，下次可以重新遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V3, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(), new FakeLockManager())
      const error = await openClubSafely(deps).catch((e) => e)
      expect(error).toBeInstanceOf(ClubSaveError)
      expect(error.code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V3)
      storage.failKey = null
      const { value } = await openClubSafely(deps)
      expect(value.club!.schemaVersion).toBe(4)
      expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    }
  })

  it('遷移途中存檔被別的地方改過：不覆蓋（conflict）', () => {
    const storage = new SpyStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    // 寫完備份的瞬間，別的分頁（舊版程式）又存了一次
    storage.onWrite = (key) => {
      if (key === CLUB_BACKUP_KEY_V3) {
        storage.onWrite = null
        storage.setItem(CLUB_STORAGE_KEY, RAW_V3.replace('"revision":5', '"revision":6'))
      }
    }
    const repo = new ClubRepository(storage)
    expect(() => repo.migrateClub()).toThrow(ClubSaveError)
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).schemaVersion).toBe(3)
  })

  it('多個分頁同時打開：只遷移一次（有 Web Locks、沒有 Web Locks 都一樣）', async () => {
    for (const locks of [new FakeLockManager(), undefined]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
      storage.writes = []
      const tabs = [0, 1, 2].map(() => tab(storage, new ManualClock(), locks))
      const results = await Promise.allSettled(tabs.map((t) => openClubSafely(t)))
      expect(storage.writes.filter((k) => k === CLUB_STORAGE_KEY)).toHaveLength(1)
      const ok = results.filter((r) => r.status === 'fulfilled')
      expect(ok.length).toBeGreaterThanOrEqual(1)
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ClubSaveError).code).toBe('conflict')
      expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).revision).toBe(fixture.revision + 1)
    }
  })

  it('壞掉的 V3、不支援的版本：明確報錯，不覆蓋原本的存檔', async () => {
    const cases: [string, string][] = [
      [JSON.stringify({ ...fixture, economy: { ...fixture.economy, assets: { funds: -5, experience: 0 } } }), 'migration-failed'],
      [JSON.stringify({ ...fixture, schemaVersion: 9 }), 'unsupported-version'],
      ['{oops', 'invalid-json'],
    ]
    for (const [raw, code] of cases) {
      const storage: KeyValueStorage = new MemoryStorage()
      storage.setItem(CLUB_STORAGE_KEY, raw)
      const error = await openClubSafely(tab(storage, new ManualClock(), new FakeLockManager())).catch((e) => e)
      expect(error.code).toBe(code)
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
    }
  })

  it('舊版程式的分頁讀到新格式：會被判定為版本不相容而停止寫入（不會用舊格式覆蓋）', async () => {
    const storage = v3Storage()
    await openClubSafely(tab(storage, new ManualClock(), new FakeLockManager()))
    // Phase 3 的驗證邏輯（凍結在 legacyV3）只認得 schemaVersion 3：讀到 4 丟 unsupported-version，
    // Phase 3 的 saveClub 寫入前會重新讀取驗證，所以舊分頁不會把舊格式寫回去
    const migrated = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(() => validateClubV3(migrated)).toThrow(expect.objectContaining({ code: 'unsupported-version' }))
  })

  it('沒有存檔：不遷移、也不建立', async () => {
    const storage = new MemoryStorage()
    const { value } = await openClubSafely(tab(storage, new ManualClock(), new FakeLockManager()))
    expect(value).toEqual({ club: null, migrated: false })
    expect(storage.keys()).toEqual([])
  })
})
