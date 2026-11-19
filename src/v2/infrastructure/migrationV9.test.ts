// @vitest-environment node
// Phase 7B：schemaVersion 8 → 9（競技積分）的遷移。fixture 是 main（Phase 7A）的程式實際產生的 V8 存檔：
// 職業聯盟（舊版直接放上去，階級＝最高＝晉級次數）、挑戰失敗冷卻中、有固定的進行中比賽、288 場、升級過
import { describe, expect, it } from 'vitest'
import fixtureV8 from '../domain/__fixtures__/club-v8-phase7a.json'
import fixtureV7 from '../domain/__fixtures__/club-v7-phase5b.json'
import fixture from '../domain/__fixtures__/club-v3-phase3.json'
import { openClubSafely } from '../application/clubLifecycle'
import { challengeNextLeague } from '../application/leagueService'
import { settleDue } from '../application/settlementService'
import { CLUB_SCHEMA_VERSION, type ClubSave } from '../domain/club'
import { leagueViolations } from '../domain/league'
import { RANKED_CONFIG } from '../domain/leagueConfig'
import { migrateToLatest, sourceVersion } from '../domain/migration'
import type { ClubSaveV8 } from '../domain/legacyV8'
import { FakeLockManager, HOUR, ManualClock, tab, v8League } from '../testkit'
import { CLUB_BACKUP_KEY_V7, CLUB_BACKUP_KEY_V8, CLUB_STORAGE_KEY, MemoryStorage } from './clubRepository'

const RAW_V8 = JSON.stringify(fixtureV8)
const v8 = () => JSON.parse(RAW_V8) as ClubSaveV8
/** 把 fixture 改成某一級（舊版的不變量：階級＝最高＝晉級次數） */
const v8At = (tier: number): ClubSaveV8 => {
  const c = v8()
  return { ...c, league: { ...c.league, tier, highestTier: tier, promotions: tier, rewardedTiers: Array.from({ length: tier }, (_, i) => i + 1) } }
}

class SpyStorage extends MemoryStorage {
  failKey: string | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error('quota')
    super.setItem(key, value)
  }
}

describe('V8 → V9（純函式）', () => {
  it('fixture 是真的 V8：職業聯盟、冷卻中、有固定的進行中比賽', () => {
    expect(sourceVersion(v8())).toBe(8)
    expect(fixtureV8.league).toMatchObject({ tier: 3, highestTier: 3, promotions: 3, rewardedTiers: [1, 2, 3] })
    expect(fixtureV8.league.challengeReadyAt).toBeGreaterThan(fixtureV8.idle.nextMatchIndex)
    expect(fixtureV8.liveMatch).not.toBeNull()
  })

  it('每一級的初始化：新秀、業餘沒有積分；挑戰者以上 50 分＋20 場適應保護；降級次數 0、沒有紀錄', () => {
    for (const tier of [0, 1, 2, 3, 4]) {
      const club = migrateToLatest(v8At(tier))
      const ranked = tier >= RANKED_CONFIG.enabledFromTier
      expect(club.league).toMatchObject({
        tier,
        highestTier: tier,
        promotions: tier,
        points: ranked ? RANKED_CONFIG.initialPoints : null,
        protectionRemaining: ranked ? RANKED_CONFIG.promotionProtectionMatches : 0,
        relegations: 0,
        lastRelegation: null,
      })
      expect(leagueViolations(club.league)).toEqual([])
    }
  })

  it('其他欄位一個字都不動：球員、資金、經驗、陣容、戰術、比賽、Replay、挑戰序號與紀錄、冷卻、進行中比賽、獎勵紀錄', () => {
    const old = v8()
    const club = migrateToLatest(old)
    const { schemaVersion, stats: newStats, revision, migratedFrom, league, ...rest } = club
    expect(newStats).toEqual({ sinceMatch: club.idle.nextMatchIndex, throughMatch: club.idle.nextMatchIndex, players: {} })
    const { schemaVersion: _s, revision: oldRevision, league: oldLeague, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(v8League(league)).toEqual(oldLeague)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 8, revision: oldRevision })
    // 舊比賽沒有積分紀錄（不補算）
    expect(club.recentMatches.every((m) => m.ranked === undefined)).toBe(true)
  })

  it('確定性、不改輸入；遷移完的存檔不會再遷移一次', () => {
    const old = v8()
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v8()))
    expect(JSON.stringify(old)).toBe(RAW_V8)
    expect(sourceVersion(migrateToLatest(old))).toBeNull()
  })

  it('舊版本串接到 V9：V3、V7 都直接升到 9（新秀、業餘沒有積分）', () => {
    for (const src of [fixture, fixtureV7]) {
      const club = migrateToLatest(structuredClone(src))
      expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
      expect(club.league.points).toBe(club.league.tier >= 2 ? RANKED_CONFIG.initialPoints : null)
      expect(club.league.relegations).toBe(0)
    }
  })

  it('壞掉的 V8 丟錯（不產生半成品）', () => {
    expect(() => migrateToLatest({ ...v8(), league: { ...v8().league, tier: 9 } })).toThrow()
  })
})

describe('V8 → V9（打開存檔）', () => {
  it('自動遷移：原始文字逐字備份到 backup-schema8，舊的 schema7 備份不動；不降級、不發獎勵、資源不變', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V8)
    storage.setItem(CLUB_BACKUP_KEY_V7, '舊的 V7 備份')
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV8.idle.anchorMs), new FakeLockManager()))
    const club = value.club!
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V8)).toBe(RAW_V8)
    expect(storage.getItem(CLUB_BACKUP_KEY_V7)).toBe('舊的 V7 備份')
    expect(club.league).toMatchObject({ tier: 3, points: 50, protectionRemaining: 20, relegations: 0 })
    expect(club.economy).toEqual(fixtureV8.economy)
    expect(club.liveMatch).toEqual(fixtureV8.liveMatch)
  })

  it('再打開一次不會重複遷移、不會再寫備份', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V8)
    const deps = tab(storage, new ManualClock(fixtureV8.idle.anchorMs), new FakeLockManager())
    await openClubSafely(deps)
    const after = storage.getItem(CLUB_STORAGE_KEY)
    storage.setItem(CLUB_BACKUP_KEY_V8, '標記')
    const again = await openClubSafely(deps)
    expect(again.value.migrated).toBe(false)
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(after)
    expect(storage.getItem(CLUB_BACKUP_KEY_V8)).toBe('標記')
  })

  it('寫入失敗（備份或主存檔）時原本的 V8 存檔不變，之後可以再遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V8, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V8)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(fixtureV8.idle.anchorMs), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V8)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })

  it('遷移後繼續玩：固定的進行中比賽照開賽時的計畫結算；之後的比賽開始計分；冷卻照舊；不會一上線就降級', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V8)
    const clock = new ManualClock(fixtureV8.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    clock.advance(8 * HOUR)
    const report = await settleDue(deps)
    const c: ClubSave = report.club
    expect(report.settled[0].matchIndex).toBe(fixtureV8.idle.nextMatchIndex)
    // 固定的那一場用遷移前的計畫（職業聯盟），它也計分（同一個聯盟）
    expect(report.settled[0].result.leagueTier).toBe(3)
    expect(report.settled.every((m) => m.ranked !== undefined || m.result.leagueTier! < 2)).toBe(true)
    // 適應保護：前 20 場不會降級
    const first20 = report.settled.slice(0, 20)
    expect(first20.every((m) => m.ranked?.relegatedTo === null)).toBe(true)
    expect(first20.at(-1)!.ranked!.protectionRemaining).toBe(0)
    expect(c.league.nextChallengeSeq).toBe(fixtureV8.league.nextChallengeSeq)
    expect(leagueViolations(c.league)).toEqual([])
    // 這支球隊在職業偏弱：保護期過後可能真的降級（正式規則），降級會清掉冷卻；沒降級的話冷卻照舊
    const relegation = report.settled.find((m) => m.ranked?.relegatedTo != null)
    if (relegation) {
      expect(relegation.matchIndex).toBeGreaterThanOrEqual(fixtureV8.idle.nextMatchIndex + RANKED_CONFIG.promotionProtectionMatches)
      expect(c.league).toMatchObject({ tier: 2, highestTier: 3, promotions: 3, relegations: 1, rewardedTiers: [1, 2, 3], challengeReadyAt: 0 })
      // 降級之後同一批剩下的比賽改用挑戰者聯盟規劃
      expect(report.settled.filter((m) => m.matchIndex > relegation.matchIndex).every((m) => m.result.leagueTier === 2)).toBe(true)
    } else {
      expect(c.league.challengeReadyAt).toBe(fixtureV8.league.challengeReadyAt)
    }
    // 舊請求（以為還在職業）在降級後是過期請求；沒降級時冷卻中也不能挑戰
    const code = relegation ? 'stale-request' : 'not-eligible'
    await expect(challengeNextLeague(deps, { challengeSeq: c.league.nextChallengeSeq, fromTier: 3 })).rejects.toMatchObject({ code })
  })
})
