// @vitest-environment node
// Phase 9 PR 2：schemaVersion 10 → 11（戰術風格）的遷移。
// fixture 是 main（Phase 8、PR #20 合併後）的程式實際產生的 V10 存檔：從 Phase 7B 的 V9 遷移上來、結算到第 348 場、
// 玩家改過均衡型的進階設定（保守跑壘 0.85、關掉後段調度）、進行中的第 348 場已經固定
import { describe, expect, it } from 'vitest'
import fixtureV10 from '../domain/__fixtures__/club-v10-phase8.json'
import fixtureV9 from '../domain/__fixtures__/club-v9-phase7b.json'
import fixtureV3 from '../domain/__fixtures__/club-v3-phase3.json'
import { openClubSafely } from '../application/clubLifecycle'
import { runMatch } from '../application/matchRunner'
import type { MatchPlan } from '../application/batchRunner'
import { settleDue, updateSettings } from '../application/settlementService'
import { CLUB_SCHEMA_VERSION, validateClub, type ClubSave } from '../domain/club'
import { stableJson } from '../domain/fingerprint'
import type { ClubSaveV10 } from '../domain/legacyV10'
import { unpackTactics } from '../domain/matchTactics'
import { MIGRATABLE_VERSIONS, migrateToLatest, sourceVersion } from '../domain/migration'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { CLUB_BACKUP_KEY_V10, CLUB_BACKUP_KEY_V9, CLUB_STORAGE_KEY, MemoryStorage } from './clubRepository'

const RAW_V10 = JSON.stringify(fixtureV10)
const v10 = () => JSON.parse(RAW_V10) as ClubSaveV10

class SpyStorage extends MemoryStorage {
  failKey: string | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error('quota')
    super.setItem(key, value)
  }
}

describe('V10 → V11（純函式）', () => {
  it('fixture 是真的 V10：均衡型＋自訂參數、固定的進行中比賽、近期比賽有球員數據、沒有戰術摘要', () => {
    expect(sourceVersion(v10())).toBe(10)
    expect(MIGRATABLE_VERSIONS).toContain(10)
    expect(fixtureV10.strategy).toEqual({ coach: { style: 'balanced', params: { stealMin: 0.85, latePlatoon: false, sacBunt: true } }, effectiveFromMatch: 348 })
    expect(fixtureV10.liveMatch?.matchIndex).toBe(348)
    expect(fixtureV10.recentMatches.filter((m) => 'lines' in m).length).toBeGreaterThan(0)
    expect(fixtureV10.recentMatches.some((m) => 'tactics' in m)).toBe(false)
  })

  it('只改版本號：球員、能力、生涯、招募次數、帳務、聯盟、積分、降級紀錄、比賽、Replay、固定的比賽、均衡參數一個字都不動', () => {
    const old = v10()
    const club = migrateToLatest(old)
    const { schemaVersion, revision, migratedFrom, training, ...rest } = club
    const { schemaVersion: _s, revision: oldRevision, migratedFrom: _m, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(training).toEqual({ potentialVersion: 1, active: null, recent: [] })
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 10, revision: oldRevision })
    // 逐項確認規格要求保留的資料
    expect(club.players).toEqual(old.players)
    expect(club.stats).toEqual(old.stats)
    expect(club.recruitment).toEqual(old.recruitment)
    expect(club.economy).toEqual(old.economy)
    expect(club.league).toEqual(old.league)
    expect(club.record).toEqual(old.record)
    expect(club.recentMatches).toEqual(old.recentMatches)
    expect(club.replays).toEqual(old.replays)
    expect(club.challengeReplay).toEqual(old.challengeReplay)
    expect(club.liveMatch).toEqual(old.liveMatch)
    expect(club.strategy).toEqual(old.strategy)
    // 舊比賽不回填戰術摘要
    expect(club.recentMatches.some((m) => m.tactics)).toBe(false)
  })

  it('確定性、不改輸入；遷移完的存檔不會再遷移一次', () => {
    const old = v10()
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v10()))
    expect(JSON.stringify(old)).toBe(RAW_V10)
    expect(sourceVersion(migrateToLatest(old))).toBeNull()
  })

  it('V3～V10 的遷移鏈仍然正常：V9、V3 一路升到目前版本，戰術一律是均衡型', () => {
    const a = migrateToLatest(structuredClone(fixtureV9))
    expect(a.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(a.migratedFrom).toEqual({ schemaVersion: 9, revision: fixtureV9.revision })
    expect(a.strategy.coach.style).toBe('balanced')
    const b = migrateToLatest(structuredClone(fixtureV3))
    expect(b.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(b.migratedFrom?.schemaVersion).toBe(3)
    expect(b.strategy.coach.style).toBe('balanced')
  })

  it('壞掉的 V10 丟錯（不產生半成品）；V11 驗證：風格、戰術摘要的格式', () => {
    expect(() => migrateToLatest({ ...v10(), strategy: { coach: { style: 'power' }, effectiveFromMatch: 0 } })).toThrow(/均衡型/)
    expect(() => migrateToLatest({ ...v10(), idle: { ...v10().idle, nextMatchIndex: -1 } })).toThrow()
    const club = migrateToLatest(v10())
    expect(() => validateClub({ ...club, strategy: { ...club.strategy, coach: { style: 'reckless' } } })).toThrow(/風格/)
    for (const style of ['power', 'speed', 'defense']) expect(validateClub({ ...club, strategy: { ...club.strategy, coach: { style, params: { fatigueMargin: -15 } } } }).strategy.coach.style).toBe(style)
    expect(() => validateClub({ ...club, strategy: { ...club.strategy, coach: { style: 'defense', params: { fatigueMargin: -31 } } } })).toThrow(/fatigueMargin/)
    const m = club.recentMatches.at(-1)!
    const bad = (tactics: unknown) => validateClub({ ...club, recentMatches: [...club.recentMatches.slice(0, -1), { ...m, tactics }] })
    expect(() => bad(['balanced', 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/成功/)
    expect(() => bad(['reckless', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/風格/)
    expect(() => bad(['balanced', 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0])).toThrow(/局數/)
    expect(() => bad({ style: 'balanced' })).toThrow()
    expect(bad(['speed', 1, 3, 2, 1, 1, 1, 2, 6, 0, 1, 1]).recentMatches.at(-1)!.tactics).toEqual(['speed', 1, 3, 2, 1, 1, 1, 2, 6, 0, 1, 1])
  })
})

describe('V10 → V11（打開存檔）', () => {
  it('自動遷移：原始文字逐字備份到 backup-schema10，舊的 schema9 備份不動', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V10)
    storage.setItem(CLUB_BACKUP_KEY_V9, '舊的 V9 備份')
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV10.idle.anchorMs), new FakeLockManager()))
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V10)).toBe(RAW_V10)
    expect(storage.getItem(CLUB_BACKUP_KEY_V9)).toBe('舊的 V9 備份')
    expect(value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
  })

  it('寫入失敗（備份或主存檔）時原本的 V10 存檔不變，之後可以再遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V10, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V10)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(fixtureV10.idle.anchorMs), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V10)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })

  it('遷移後繼續玩：固定的第 348 場照遷移前的計畫打（比分跟用 V10 的計畫重新模擬一樣）；新比賽有戰術摘要，舊比賽沒有', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V10)
    const clock = new ManualClock(fixtureV10.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    clock.advance(1 * HOUR)
    const report = await settleDue(deps)
    const c: ClubSave = report.club
    expect(report.settled.length).toBeGreaterThan(5)
    // 固定的那一場：用 V10 存下來的計畫重新模擬，比分一樣（均衡型在教練版本 2 逐指令相同）
    const plan = fixtureV10.liveMatch!.plan as unknown as MatchPlan
    const expected = runMatch(structuredClone(plan.setup), plan.ai)
    const first = c.recentMatches.find((m) => m.matchIndex === 348)!
    expect([first.result.runsFor, first.result.runsAgainst]).toEqual([expected.score[plan.setup.userSide], expected.score[plan.setup.userSide === 'home' ? 'away' : 'home']])
    // 每一場新比賽都記下當場的風格（均衡型、玩家自訂過參數）
    for (const m of report.settled) expect(unpackTactics(m.tactics!)).toMatchObject({ style: 'balanced', custom: true })
    expect(c.recentMatches.filter((m) => m.matchIndex < 348).every((m) => !m.tactics)).toBe(true)
    expect(stableJson(c.strategy.coach)).toBe(stableJson(fixtureV10.strategy.coach))
  })

  it('遷移後改成守備型：進行中那一場維持均衡型，下一場起才是守備型；每一場都記下當場實際的風格', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V10)
    const clock = new ManualClock(fixtureV10.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    const changed = await updateSettings(deps, { coach: { style: 'defense', params: { stealMin: 0.75, latePlatoon: true, sacBunt: true } } })
    expect(changed.strategy.effectiveFromMatch).toBe(349)
    expect(changed.liveMatch!.matchIndex).toBe(348)
    expect(changed.liveMatch!.plan.ai[changed.liveMatch!.plan.userSide]).toMatchObject({ kind: 'autoCoach', style: 'balanced' })
    clock.advance(1 * HOUR)
    const report = await settleDue(deps)
    const styles = report.settled.map((m) => [m.matchIndex, unpackTactics(m.tactics!).style])
    expect(styles[0]).toEqual([348, 'balanced'])
    expect(styles.slice(1).every(([, s]) => s === 'defense')).toBe(true)
    // 再結算一次（同一個時間點）不會重複記錄
    const again = await settleDue(deps)
    expect(again.settled).toEqual([])
    expect(again.club.recentMatches).toEqual(report.club.recentMatches)
  })
})
