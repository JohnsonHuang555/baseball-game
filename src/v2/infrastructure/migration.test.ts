// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fixture from '../domain/__fixtures__/club-v3-phase3.json'
import fixtureV4 from '../domain/__fixtures__/club-v4-phase4.json'
import fixtureV5 from '../domain/__fixtures__/club-v5-phase5.json'
import fixtureV6 from '../domain/__fixtures__/club-v6-phase5b.json'
import { openClubSafely } from '../application/clubLifecycle'
import { claim, settleDue } from '../application/settlementService'
import { upgrade } from '../application/economyService'
import { resolveRoster } from '../domain/roster'
import { validateClubV3 } from '../domain/legacyV3'
import { CLUB_SCHEMA_VERSION } from '../domain/club'
import { FakeLockManager, HOUR, ManualClock, tab, v8League } from '../testkit'
import { CLUB_BACKUP_KEY_V3, CLUB_BACKUP_KEY_V4, CLUB_BACKUP_KEY_V5, CLUB_BACKUP_KEY_V6, CLUB_STORAGE_KEY, ClubRepository, ClubSaveError, MemoryStorage, type KeyValueStorage } from './clubRepository'

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

/**
 * 可以在指定時機插入「另一個分頁」動作的儲存：
 * afterRead：這個分頁讀完主存檔之後（讀到的值照樣回傳），afterWrite：寫完某個 key 之後
 */
class RaceStorage extends MemoryStorage {
  afterRead: (() => void) | null = null
  afterWrite: ((key: string) => void) | null = null
  dropWrites = new Set<string>()
  override getItem(key: string): string | null {
    const value = super.getItem(key)
    if (key === CLUB_STORAGE_KEY && this.afterRead) {
      const hook = this.afterRead
      this.afterRead = null
      hook()
    }
    return value
  }
  override setItem(key: string, value: string): void {
    if (this.dropWrites.has(key)) return
    super.setItem(key, value)
    if (this.afterWrite) {
      const hook = this.afterWrite
      this.afterWrite = null
      hook(key)
    }
  }
}

/** 另一份合法的 V3：同一個球團、revision 不同（舊版分頁又存了一次） */
const RAW_V3_NEWER = JSON.stringify({ ...fixture, revision: fixture.revision + 1, clubName: '舊版分頁又存了一次' })
const revisionOf = (raw: string | null) => JSON.parse(raw!).revision as number

describe('遷移的備份不會被競爭操作覆寫', () => {
  it('A 遷移完成後，晚一步的 B（拿著同一份原始文字）收到 conflict：備份、主存檔都不動', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    const a = new ClubRepository(storage)
    const b = new ClubRepository(storage)
    // B 讀完主存檔的瞬間，A 完成整個遷移
    storage.afterRead = () => a.migrateClub()
    expect(() => b.migrateClub()).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    const main = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(main.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(main.migratedFrom.revision).toBe(revisionOf(storage.getItem(CLUB_BACKUP_KEY_V3)))
  })

  it('B 拿著較舊的 V3、A 遷移較新的 V3：B 不會用舊內容覆寫 A 的備份', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    const a = new ClubRepository(storage)
    const b = new ClubRepository(storage)
    storage.afterRead = () => {
      // B 讀到 RAW_V3 之後：舊版分頁存了較新的 V3，接著 A 遷移它
      storage.setItem(CLUB_STORAGE_KEY, RAW_V3_NEWER)
      a.migrateClub()
    }
    expect(() => b.migrateClub()).toThrow(expect.objectContaining({ code: 'conflict' }))
    // 備份是 A 實際遷移的那份（較新的），不是 B 讀到的舊內容
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3_NEWER)
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).migratedFrom.revision).toBe(fixture.revision + 1)
  })

  it('讀完主存檔、寫備份之前，原始存檔被改了：不寫備份、不改主存檔；重試時遷移的是新內容', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    const repo = new ClubRepository(storage)
    storage.afterRead = () => storage.setItem(CLUB_STORAGE_KEY, RAW_V3_NEWER)
    expect(() => repo.migrateClub()).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBeNull()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V3_NEWER)
    const club = repo.migrateClub()!
    expect(club.clubName).toBe('舊版分頁又存了一次')
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3_NEWER)
  })

  it('寫完備份、寫主存檔之前，原始存檔被改了：主存檔不變；重試後備份換成實際被遷移的那份', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    const repo = new ClubRepository(storage)
    storage.afterWrite = (key) => {
      if (key === CLUB_BACKUP_KEY_V3) storage.setItem(CLUB_STORAGE_KEY, RAW_V3_NEWER)
    }
    expect(() => repo.migrateClub()).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V3_NEWER)
    // 這次沒有完成遷移，備份是沒用上的 RAW_V3；重試時換成真正被遷移的較新版本
    const club = repo.migrateClub()!
    expect(club.migratedFrom!.revision).toBe(fixture.revision + 1)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3_NEWER)
  })

  it('備份沒有真的寫進去（讀回來不一致）：不開始主存檔遷移', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    storage.dropWrites.add(CLUB_BACKUP_KEY_V3)
    expect(() => new ClubRepository(storage).migrateClub()).toThrow(expect.objectContaining({ code: 'write-failed' }))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V3)
  })

  it('已經遷移完成：再呼叫遷移不會碰備份', () => {
    const storage = new RaceStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V3)
    const repo = new ClubRepository(storage)
    repo.migrateClub()
    storage.setItem(CLUB_BACKUP_KEY_V3, 'sentinel')
    expect(repo.migrateClub()!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe('sentinel')
  })
})

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
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).schemaVersion).toBe(CLUB_SCHEMA_VERSION)
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
      expect(value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
      expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    }
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
      [JSON.stringify({ ...fixture, schemaVersion: CLUB_SCHEMA_VERSION + 1 }), 'unsupported-version'],
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

describe('V4 → V5 存檔遷移', () => {
  const RAW_V4 = JSON.stringify(fixtureV4)

  it('打開球團時自動遷移：原始文字備份到 backup-schema4，等級、陣容、資產、支出、游標、錨點都不變，V3 備份不受影響', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V4)
    storage.setItem(CLUB_BACKUP_KEY_V3, RAW_V3)
    for (const [k, v] of Object.entries(V1)) storage.setItem(k, v)
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV4.idle.anchorMs), new FakeLockManager()))
    const club = value.club!
    expect(value.migrated).toBe(true)
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(storage.getItem(CLUB_BACKUP_KEY_V4)).toBe(RAW_V4)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    expect(club.players).toEqual(fixtureV4.players)
    expect(club.roster).toEqual(fixtureV4.roster)
    expect(club.economy).toEqual(fixtureV4.economy)
    expect(club.idle).toEqual(fixtureV4.idle)
    expect(club.record).toEqual(fixtureV4.record)
    expect(club.revision).toBe(fixtureV4.revision + 1)
    for (const [k, v] of Object.entries(V1)) expect(storage.getItem(k)).toBe(v)
  })

  it('遷移後繼續遊玩：不重算舊比賽、不重複發獎、招募次數接著算', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V4)
    const clock = new ManualClock(fixtureV4.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    expect((await settleDue(deps)).settled).toHaveLength(0)
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled[0].matchIndex).toBe(fixtureV4.idle.nextMatchIndex)
    expect(report.club.league.matches).toBe(fixtureV4.record.wins + fixtureV4.record.losses + 12)
    expect(report.club.recruitment.count).toBe(fixtureV4.recruitment.count)
  })

  it('備份位置已經有另一個球團的備份：不覆寫，改寫到帶 revision 的 key', async () => {
    const storage = new MemoryStorage()
    const otherClub = JSON.stringify({ ...fixtureV4, clubId: 'another-club' })
    storage.setItem(CLUB_STORAGE_KEY, RAW_V4)
    storage.setItem(CLUB_BACKUP_KEY_V4, otherClub)
    const repo = new ClubRepository(storage)
    repo.migrateClub()
    expect(storage.getItem(CLUB_BACKUP_KEY_V4)).toBe(otherClub)
    expect(storage.getItem(`${CLUB_BACKUP_KEY_V4}.r${fixtureV4.revision}`)).toBe(RAW_V4)
  })

  it('多個分頁同時打開 V4：只遷移一次', async () => {
    for (const locks of [new FakeLockManager(), undefined]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V4)
      storage.writes = []
      const results = await Promise.allSettled([0, 1, 2].map(() => openClubSafely(tab(storage, new ManualClock(), locks))))
      expect(storage.writes.filter((k) => k === CLUB_STORAGE_KEY)).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ClubSaveError).code).toBe('conflict')
      expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).revision).toBe(fixtureV4.revision + 1)
    }
  })

  it('V4 遷移寫入失敗：原本的存檔不變，可以重試', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V4, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V4)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V4)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })
})

describe('V5 → V7 存檔遷移', () => {
  const RAW_V5 = JSON.stringify(fixtureV5)

  it('打開球團時自動遷移：原始文字備份到 backup-schema5，既有的 schema3、schema4 備份不受影響，進度全部保留', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V5)
    storage.setItem(CLUB_BACKUP_KEY_V3, RAW_V3)
    storage.setItem(CLUB_BACKUP_KEY_V4, JSON.stringify(fixtureV4))
    for (const [k, v] of Object.entries(V1)) storage.setItem(k, v)
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV5.idle.anchorMs), new FakeLockManager()))
    const club = value.club!
    expect(value.migrated).toBe(true)
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(club.challengeReplay).toBeNull()
    expect(club.liveMatch).toBeNull()
    expect(storage.getItem(CLUB_BACKUP_KEY_V5)).toBe(RAW_V5)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(RAW_V3)
    expect(storage.getItem(CLUB_BACKUP_KEY_V4)).toBe(JSON.stringify(fixtureV4))
    expect(v8League(club.league)).toEqual(fixtureV5.league)
    expect(club.players).toEqual(fixtureV5.players)
    expect(club.economy).toEqual(fixtureV5.economy)
    expect(club.idle).toEqual(fixtureV5.idle)
    expect(club.revision).toBe(fixtureV5.revision + 1)
    for (const [k, v] of Object.entries(V1)) expect(storage.getItem(k)).toBe(v)
  })

  it('遷移後繼續遊玩：不重算舊比賽、挑戰序號接著算', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V5)
    const clock = new ManualClock(fixtureV5.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    expect((await settleDue(deps)).settled).toHaveLength(0)
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled[0].matchIndex).toBe(fixtureV5.idle.nextMatchIndex)
    expect(report.club.league.nextChallengeSeq).toBe(fixtureV5.league.nextChallengeSeq)
  })

  it('多個分頁同時打開 V5：只遷移一次；寫入失敗時原本的存檔不變', async () => {
    for (const locks of [new FakeLockManager(), undefined]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V5)
      storage.writes = []
      const results = await Promise.allSettled([0, 1, 2].map(() => openClubSafely(tab(storage, new ManualClock(), locks))))
      expect(storage.writes.filter((k) => k === CLUB_STORAGE_KEY)).toHaveLength(1)
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ClubSaveError).code).toBe('conflict')
    }
    for (const failKey of [CLUB_BACKUP_KEY_V5, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V5)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V5)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })
})

describe('V6（PR #9 草稿）→ V7 存檔遷移', () => {
  const RAW_V6 = JSON.stringify(fixtureV6)

  it('自動遷移：備份到 backup-schema6，挑戰 Replay、進度全部保留；之後的比賽正常結算、不重算舊比賽', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V6)
    const clock = new ManualClock(fixtureV6.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    const { value } = await openClubSafely(deps)
    const club = value.club!
    expect(value.migrated).toBe(true)
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(storage.getItem(CLUB_BACKUP_KEY_V6)).toBe(RAW_V6)
    expect(club.challengeReplay).toEqual(fixtureV6.challengeReplay)
    expect(v8League(club.league)).toEqual(fixtureV6.league)
    expect(club.economy).toEqual(fixtureV6.economy)
    expect((await settleDue(deps)).settled).toHaveLength(0)
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled[0].matchIndex).toBe(fixtureV6.idle.nextMatchIndex)
    expect(report.settled.every((m) => m.box && m.playedAt)).toBe(true)
  })

  it('多個分頁同時打開 V6：只遷移一次', async () => {
    for (const locks of [new FakeLockManager(), undefined]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V6)
      storage.writes = []
      await Promise.allSettled([0, 1, 2].map(() => openClubSafely(tab(storage, new ManualClock(), locks))))
      expect(storage.writes.filter((k) => k === CLUB_STORAGE_KEY)).toHaveLength(1)
    }
  })
})
