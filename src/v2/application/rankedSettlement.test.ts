// @vitest-environment node
// Phase 7B：正式結算流程裡的競技積分與降級（分段結算、冪等、多分頁、中斷、失敗、挑戰與其他寫入操作前的結算）
import { describe, expect, it } from 'vitest'
import { SEED_SALT, deriveSeed, type ClubSave } from '../domain/club'
import { leagueAtTier, leagueViolations } from '../domain/league'
import { LEAGUES, PROMOTION_CONFIG, RANKED_CONFIG } from '../domain/leagueConfig'
import { rewardFor } from '../domain/rewards'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { atMatch, FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab } from '../testkit'
import { planMatches, runBatch, type MatchPlan } from './batchRunner'
import { upgrade } from './economyService'
import { challengeNextLeague } from './leagueService'
import { freezeLiveMatch } from './liveMatch'
import { runMatch } from './matchRunner'
import { SettlementError, settleDue, settleIdle, settleOutcomes } from './settlementService'

type Deps = ReturnType<typeof tab>

/** 把所有球員的能力改成 v（1 很弱、10 很強）：比賽仍是正式模擬，只是結果幾乎一面倒 */
function withRatings(c: ClubSave, v: number): ClubSave {
  return { ...c, players: c.players.map((r) => ({ ...r, player: { ...r.player, ratings: Object.fromEntries(Object.keys(r.player.ratings).map((k) => [k, v])) } as unknown as typeof r.player })) }
}

async function setup(edit: (c: ClubSave) => ClubSave, storage = new MemoryStorage(), locks: FakeLockManager | undefined = new FakeLockManager()) {
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, locks)
  const c0 = deps.store.createClub({ clubName: '積分測試', clubSeed: 4242, clubId: 'club-ranked', now: T0 })
  const club = deps.store.saveClub(edit(c0), c0.revision)
  return { storage, clock, deps, club, locks }
}
const load = (d: Deps) => d.store.loadClub()!
/** 傳奇聯盟、積分 10、沒有保護、全隊能力 1：離線 8 小時一定會在中途降級（而且可能連降兩級） */
const weakLegend = (points = 10) => (c: ClubSave) => withRatings({ ...c, league: leagueAtTier(c.league, 4, { points }) }, 1)

describe('離線結算中途降級', () => {
  it('依時間順序結算：降級那一場之前用傳奇聯盟，之後的比賽改用新聯盟的對手與收益倍率；種子、序號、錨點都不變', async () => {
    const { deps, clock, club } = await setup(weakLegend())
    clock.advance(8 * HOUR)
    const report = await settleDue(deps)
    const s = report.settled
    expect(s).toHaveLength(96)
    expect(s.map((m) => m.matchIndex)).toEqual(Array.from({ length: 96 }, (_, i) => i))
    for (const m of s) expect(m.seed).toBe(deriveSeed(club.clubSeed, m.matchIndex, SEED_SALT.match))
    const first = s.findIndex((m) => m.ranked?.relegatedTo !== null)
    expect(first).toBeGreaterThanOrEqual(4) // 10 分最少要輸 5 場
    expect(s[first].ranked).toMatchObject({ tier: 4, after: 0, relegatedTo: 3 })
    // 降級前：傳奇聯盟的計畫與結果，跟一開始就規劃好的一模一樣（沒有重打）
    const before = (await runBatch(planMatches(club, 0, first + 1))).outcomes
    for (const [i, o] of before.entries()) {
      expect(s[i].result.leagueTier).toBe(4)
      expect([s[i].result.runsFor, s[i].result.runsAgainst]).toEqual([o.result.score[o.plan.userSide], o.result.score[o.plan.userSide === 'home' ? 'away' : 'home']])
    }
    // 降級後：同一批剩下的比賽用職業聯盟（或再降到挑戰者），收益倍率照新聯盟
    for (const m of s.slice(first + 1)) {
      expect(m.result.leagueTier).toBeLessThan(4)
      const r = rewardFor(m.result.won, m.result.runsFor, LEAGUES[m.result.leagueTier!].rewardMultiplier)
      expect([m.earnedFunds, m.earnedExperience]).toEqual([r.funds, r.experience])
    }
    expect(s[first + 1].ranked).toMatchObject({ tier: 3, before: RANKED_CONFIG.initialPoints })
    const c = report.club
    expect(c.idle.anchorMs).toBe(T0 + 96 * 5 * MINUTE)
    expect(c.league.highestTier).toBe(4)
    expect(c.league.rewardedTiers).toEqual([1, 2, 3, 4])
    expect(c.league.lastRelegation).toMatchObject({ matchIndex: [...s].reverse().find((m) => m.ranked?.relegatedTo != null)!.matchIndex })
    expect(leagueViolations(c.league)).toEqual([])
    // 挑戰者是保底
    expect(c.league.tier).toBeGreaterThanOrEqual(2)
    // 本聯盟戰績只算新聯盟的比賽
    expect(c.league.matches).toBe(s.filter((m) => m.result.leagueTier === c.league.tier && m.matchIndex > c.league.lastRelegation!.matchIndex).length)
  })

  it('同一個種子、同一個時間點，結果完全確定（重開多次都一樣）', async () => {
    const run = async () => {
      const { deps, clock } = await setup(weakLegend())
      clock.advance(8 * HOUR)
      return (await settleDue(deps)).club
    }
    const [a, b] = [await run(), await run()]
    expect(a.league).toEqual(b.league)
    expect(a.recentMatches).toEqual(b.recentMatches)
  })

  it('新秀、業餘：跟加入競技系統前的「一次規劃整批」結果一模一樣（比賽、獎勵、戰績）', async () => {
    for (const tier of [0, 1]) {
      const { deps, clock, club } = await setup((c) => ({ ...c, league: leagueAtTier(c.league, tier) }))
      clock.advance(8 * HOUR)
      const now = clock.now()
      const old = settleIdle(club, (await runBatch(planMatches(club, 0, 96))).outcomes, now)
      const report = await settleDue(deps)
      expect({ ...report.club, revision: 0 }).toEqual({ ...old.club, revision: 0 })
      expect(report.settled.every((m) => m.ranked === undefined)).toBe(true)
    }
  })

  it('挑戰者 0 分不降級：一路輸到 0 分，之後的比賽仍在挑戰者', async () => {
    const { deps, clock } = await setup((c) => withRatings({ ...c, league: leagueAtTier(c.league, 2, { points: 6 }) }, 1))
    clock.advance(8 * HOUR)
    const { club, settled } = await settleDue(deps)
    expect(club.league).toMatchObject({ tier: 2, relegations: 0 })
    expect(settled.every((m) => m.result.leagueTier === 2 && m.ranked!.relegatedTo === null)).toBe(true)
    expect(settled.some((m) => m.ranked!.after === 0)).toBe(true)
  })
})

describe('冪等與重送', () => {
  it('同一場重送不重複計分（已結算的場次直接略過）', async () => {
    const { club } = await setup((c) => ({ ...c, league: leagueAtTier(c.league, 3) }))
    const outcomes = (await runBatch(planMatches(club, 0, 3))).outcomes
    const once = settleOutcomes(club, outcomes, T0 + HOUR).club
    const twice = settleOutcomes(once, outcomes, T0 + HOUR)
    expect(twice.duplicates).toBe(3)
    expect(twice.club.league).toEqual(once.league)
    expect(once.recentMatches.map((m) => m.ranked!.after)).toHaveLength(3)
  })

  it('同一個時間點再結算一次：沒有到期的比賽、積分不變', async () => {
    const { deps, clock } = await setup(weakLegend(30))
    clock.advance(4 * HOUR)
    const a = await settleDue(deps)
    const b = await settleDue(deps)
    expect(b.status).toBe('nothing-due')
    expect(b.club.league).toEqual(a.club.league)
  })

  it('多個分頁同時結算（Web Locks）：只結算一次，跟單一分頁的結果相同', async () => {
    const single = await setup(weakLegend())
    single.clock.advance(8 * HOUR)
    const expected = (await settleDue(single.deps)).club

    const shared = await setup(weakLegend())
    shared.clock.advance(8 * HOUR)
    const tabs = [shared.deps, tab(shared.storage, shared.clock, shared.locks), tab(shared.storage, shared.clock, shared.locks)]
    const reports = await Promise.all(tabs.map((t) => settleDue(t)))
    expect(reports.map((r) => r.settled.length).sort((a, b) => b - a)).toEqual([96, 0, 0])
    const final = load(shared.deps)
    expect(final.league).toEqual(expected.league)
    expect(final.recentMatches).toEqual(expected.recentMatches)
  })
})

describe('中斷與失敗', () => {
  it('中斷（AbortSignal）：已經結算的前綴存檔；接著結算的結果跟沒中斷時一樣（降級前後都一樣）', async () => {
    const ref = await setup(weakLegend())
    ref.clock.advance(8 * HOUR)
    const expected = (await settleDue(ref.deps)).club

    for (const stopAt of [3, 12, 40]) {
      const { deps, clock } = await setup(weakLegend())
      clock.advance(8 * HOUR)
      const ctrl = new AbortController()
      let done = 0
      const d = { ...deps, batch: { ...deps.batch, onProgress: () => ++done >= stopAt && ctrl.abort() } }
      const r1 = await settleDue(d, { signal: ctrl.signal })
      expect(r1.status).toBe('aborted')
      expect(r1.settled.length).toBe(stopAt)
      expect(load(deps).idle.nextMatchIndex).toBe(stopAt)
      const r2 = await settleDue(deps)
      expect(r2.settled[0].matchIndex).toBe(stopAt)
      expect(load(deps).league).toEqual(expected.league)
      expect(load(deps).recentMatches.map((m) => [m.matchIndex, m.result.leagueTier, m.ranked])).toEqual(expected.recentMatches.map((m) => [m.matchIndex, m.result.leagueTier, m.ranked]))
    }
  })

  it('某一場模擬失敗：失敗之前的場次（含降級）存檔、丟 SettlementError；修好後接著結算，結果跟沒失敗時一樣', async () => {
    const ref = await setup(weakLegend())
    ref.clock.advance(8 * HOUR)
    const refReport = await settleDue(ref.deps)
    const expected = refReport.club
    const relegatedAt = refReport.settled.find((m) => m.ranked?.relegatedTo != null)!.matchIndex

    const { deps, clock } = await setup(weakLegend())
    clock.advance(8 * HOUR)
    const failAt = relegatedAt + 3
    const simulate = (p: MatchPlan) => {
      if (p.matchIndex === failAt) throw new Error('boom')
      return runMatch(p.setup, p.ai)
    }
    const broken = { ...deps, batch: { ...deps.batch, simulate } }
    const error = await settleDue(broken).catch((e) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect(error.code).toBe('simulation-failed')
    const saved = load(deps)
    expect(saved.idle.nextMatchIndex).toBe(failAt)
    expect(saved.league.relegations).toBeGreaterThanOrEqual(1)
    expect(saved.league.tier).toBeLessThan(4)
    await settleDue(deps)
    expect(load(deps).league).toEqual(expected.league)
  })
})

describe('其他寫入操作前的結算也包含降級', () => {
  it('挑戰：請求帶傳奇聯盟，但結算到期比賽時已經降回職業 → 過期請求，不會打傳奇的挑戰；結算的結果有存起來', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    // 職業聯盟、符合晉級資格、積分 2：再結算幾場就會降回挑戰者
    const { deps, clock } = await setup((c) =>
      withRatings({ ...c, league: leagueAtTier(c.league, 3, { points: 2, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }), idle: { ...c.idle } }, 1),
    )
    clock.advance(HOUR)
    const req = { challengeSeq: 0, fromTier: 3 }
    const error = await challengeNextLeague(deps, req).catch((e) => e)
    expect(error.code).toBe('stale-request')
    expect(error.settled.matches).toBeGreaterThan(0)
    const c = load(deps)
    expect(c.league).toMatchObject({ tier: 2, relegations: 1, nextChallengeSeq: 0 })
    expect(c.league.challenges).toEqual([])
  })

  it('升級：先結算（可能降級），再用結算後的資源升級；兩件事一起存檔', async () => {
    const { deps, clock } = await setup((c) => ({ ...weakLegend(4)(c), economy: { ...c.economy, assets: { funds: 100_000, experience: 10_000 }, earned: { funds: 100_000, experience: 10_000 } } }))
    clock.advance(HOUR)
    const c0 = load(deps)
    const target = c0.players[0]
    await upgrade(deps, { opSeq: c0.economy.nextOpSeq, playerId: target.player.id, expectedLevel: target.level })
    const c = load(deps)
    expect(c.idle.nextMatchIndex).toBe(12)
    expect(c.league.tier).toBe(3)
    expect(c.players[0].level).toBe(target.level + 1)
  })

  it('晉級前就固定的進行中比賽（舊聯盟）不計入新聯盟的積分與戰績', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    const { deps, clock } = await setup((c) => withRatings({ ...c, league: leagueAtTier(c.league, 2, { matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }) }, 10))
    // 第 0 場進行中：固定計畫（挑戰者聯盟）
    clock.advance(2 * MINUTE)
    const c0 = load(deps)
    deps.store.saveClub(freezeLiveMatch(c0), c0.revision)
    const out = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 2 })
    expect(out.challenge.won).toBe(true)
    expect(load(deps).league).toMatchObject({ tier: 3, points: RANKED_CONFIG.initialPoints, protectionRemaining: RANKED_CONFIG.promotionProtectionMatches })
    clock.advance(3 * MINUTE)
    const report = await settleDue(deps)
    expect(report.settled).toHaveLength(1)
    expect(report.settled[0].result.leagueTier).toBe(2)
    expect(report.settled[0].ranked).toBeUndefined()
    expect(report.club.league).toMatchObject({ tier: 3, matches: 0, points: RANKED_CONFIG.initialPoints, protectionRemaining: RANKED_CONFIG.promotionProtectionMatches })
    // 下一場才開始用職業聯盟計分、扣保護
    clock.advance(5 * MINUTE)
    const next = await settleDue(deps)
    expect(next.settled[0].ranked).toMatchObject({ tier: 3, protectionRemaining: RANKED_CONFIG.promotionProtectionMatches - 1 })
  })

  it('晉級挑戰不計分；失敗不改積分；降級後重返不再發首次晉級獎勵', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    // 曾經到過傳奇、現在降回職業（已經領過傳奇的獎勵）
    const { deps } = await setup((c) => {
      const base = leagueAtTier(c.league, 4)
      return withRatings(
        {
          ...c,
          league: { ...base, tier: 3, relegations: 1, lastRelegation: { fromTier: 4, toTier: 3, matchIndex: 0, at: T0 }, points: 33, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) },
          ...atMatch(c, n),
        },
        10,
      )
    })
    const before = load(deps)
    const out = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 3 })
    const c = load(deps)
    if (out.challenge.won) {
      expect(out.challenge.reward).toEqual({ funds: 0, experience: 0 })
      expect(c.economy.unclaimed).toEqual(before.economy.unclaimed)
      expect(c.league).toMatchObject({ tier: 4, promotions: 5, relegations: 1, highestTier: 4, points: 50, protectionRemaining: 20 })
    } else {
      expect(c.league.points).toBe(33)
    }
    expect(leagueViolations(c.league)).toEqual([])
  })
})
