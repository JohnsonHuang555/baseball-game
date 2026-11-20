// @vitest-environment node
// Phase 8：schemaVersion 9 → 10（球員比賽數據）的遷移。fixture 是 main（Phase 7B）的程式實際產生的 V9 存檔：
// 從 Phase 7A 的 V8 存檔遷移上來、又放置結算了 24 場（職業聯盟、有競技積分紀錄）、312 場、50 場近期比賽
import { describe, expect, it } from 'vitest'
import fixtureV9 from '../domain/__fixtures__/club-v9-phase7b.json'
import fixtureV8 from '../domain/__fixtures__/club-v8-phase7a.json'
import { openClubSafely } from '../application/clubLifecycle'
import { settleDue } from '../application/settlementService'
import { CLUB_SCHEMA_VERSION, validateClub, type ClubSave } from '../domain/club'
import { migrateToLatest, sourceVersion } from '../domain/migration'
import type { ClubSaveV9 } from '../domain/legacyV9'
import { careerTotals, totalsByPlayer } from '../domain/stats'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { CLUB_BACKUP_KEY_V8, CLUB_BACKUP_KEY_V9, CLUB_STORAGE_KEY, MemoryStorage } from './clubRepository'

const RAW_V9 = JSON.stringify(fixtureV9)
const v9 = () => JSON.parse(RAW_V9) as ClubSaveV9

class SpyStorage extends MemoryStorage {
  failKey: string | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error('quota')
    super.setItem(key, value)
  }
}

describe('V9 → V10（純函式）', () => {
  it('fixture 是真的 V9：職業聯盟、有競技積分、近期比賽只有舊的 Box Score', () => {
    expect(sourceVersion(v9())).toBe(9)
    expect(fixtureV9.league).toMatchObject({ tier: 3, points: 32 })
    expect(fixtureV9.idle.nextMatchIndex).toBe(312)
    expect(fixtureV9.recentMatches).toHaveLength(50)
    expect(fixtureV9.recentMatches.filter((m) => 'ranked' in m)).toHaveLength(24)
    expect(fixtureV9.recentMatches.every((m) => m.box && m.box.batters.length > 0 && !('lines' in m))).toBe(true)
  })

  it('只加上球員數據：記錄起點＝目前游標、生涯從 0 開始；其他欄位一個字都不動', () => {
    const old = v9()
    const club = migrateToLatest(old)
    const { schemaVersion, revision, migratedFrom, stats, training: _t, ...rest } = club
    const { schemaVersion: _s, revision: oldRevision, migratedFrom: _m, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(stats).toEqual({ sinceMatch: 312, throughMatch: 312, players: {} })
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 9, revision: oldRevision })
    // 不重新結算、不發獎勵、不改積分與勝負；舊比賽不回填數據
    expect(club.economy).toEqual(old.economy)
    expect(club.league).toEqual(old.league)
    expect(club.record).toEqual(old.record)
    expect(club.recentMatches).toEqual(old.recentMatches)
    expect(club.replays).toEqual(old.replays)
    expect(club.recentMatches.some((m) => m.lines)).toBe(false)
  })

  it('確定性、不改輸入；遷移完的存檔不會再遷移一次', () => {
    const old = v9()
    const a = migrateToLatest(old)
    const b = migrateToLatest(v9())
    expect(a).toEqual(b)
    expect(JSON.stringify(old)).toBe(RAW_V9)
    expect(sourceVersion(a)).toBeNull()
  })

  it('從 V8 一路升上來，記錄起點一樣是當時的游標', () => {
    const club = migrateToLatest(structuredClone(fixtureV8))
    expect(club.stats).toEqual({ sinceMatch: fixtureV8.idle.nextMatchIndex, throughMatch: fixtureV8.idle.nextMatchIndex, players: {} })
    expect(club.migratedFrom).toEqual({ schemaVersion: 8, revision: fixtureV8.revision })
  })

  it('壞掉的 V9 丟錯（不產生半成品）', () => {
    expect(() => migrateToLatest({ ...v9(), idle: { ...v9().idle, nextMatchIndex: -1 } })).toThrow()
  })

  it('驗證：生涯不能超過游標、舊比賽不能有數據、戰報裡的球員一定要有生涯紀錄', () => {
    const club = migrateToLatest(v9())
    expect(() => validateClub({ ...club, stats: { ...club.stats, throughMatch: 313 } })).toThrow(/throughMatch/)
    const old = { ...club.recentMatches[0], lines: { bat: [['x', 1]], pit: [] } }
    expect(() => validateClub({ ...club, recentMatches: [old, ...club.recentMatches.slice(1)] })).toThrow(/記錄起點之前/)
  })
})

describe('V9 → V10（打開存檔）', () => {
  it('自動遷移：原始文字逐字備份到 backup-schema9，舊的 schema8 備份不動', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V9)
    storage.setItem(CLUB_BACKUP_KEY_V8, '舊的 V8 備份')
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV9.idle.anchorMs), new FakeLockManager()))
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V9)).toBe(RAW_V9)
    expect(storage.getItem(CLUB_BACKUP_KEY_V8)).toBe('舊的 V8 備份')
    expect(value.club!.stats.sinceMatch).toBe(312)
  })

  it('寫入失敗（備份或主存檔）時原本的 V9 存檔不變，之後可以再遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V9, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V9)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(fixtureV9.idle.anchorMs), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V9)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })

  it('遷移後繼續玩：新的比賽開始累積生涯；最近 50 場裡舊比賽沒有數據（不回填），近期統計只算有記錄的場次', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V9)
    const clock = new ManualClock(fixtureV9.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    clock.advance(2 * HOUR)
    const report = await settleDue(deps)
    const c: ClubSave = report.club
    const n = report.settled.length
    expect(n).toBeGreaterThan(10)
    expect(c.stats).toMatchObject({ sinceMatch: 312, throughMatch: 312 + n })
    expect(c.recentMatches.filter((m) => m.lines)).toHaveLength(n)
    expect(c.recentMatches.filter((m) => !m.lines).every((m) => m.matchIndex < 312)).toBe(true)
    // 生涯 = 遷移後每一場的加總（不含遷移前的比賽）
    const recent = totalsByPlayer(c.recentMatches)
    for (const [id, rec] of Object.entries(c.stats.players)) {
      expect(careerTotals(rec)).toEqual(recent.get(id))
      expect(rec.first).toBeGreaterThanOrEqual(312)
    }
    expect(c.record.wins + c.record.losses).toBe(fixtureV9.record.wins + fixtureV9.record.losses + n)
  })
})
