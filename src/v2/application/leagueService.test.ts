// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { economyViolations, validateClub, type ClubSave } from '../domain/club'
import { eligibility, leagueAtTier, newLeagueState, recentWinRate, recordLeagueResult } from '../domain/league'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from '../domain/leagueConfig'
import { rewardFor } from '../domain/rewards'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, ManualClock, tab } from '../testkit'
import { planMatch, planMatches, runBatch } from './batchRunner'
import { createClubSafely } from './clubLifecycle'
import { LeagueError, applyChallenge, challengeNextLeague, planChallenge } from './leagueService'
import { buildTimeline } from './replayPlayer'
import { runMatch } from './matchRunner'
import { SettlementError, claim, settleDue, settleOutcomes } from './settlementService'

type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!

async function setup(storage: MemoryStorage | FlakyStorage = new MemoryStorage(), locks: FakeLockManager | null = new FakeLockManager(), clubSeed = 7) {
  const clock = new ManualClock()
  const deps = tab(storage, clock, locks ?? undefined)
  await createClubSafely(deps, { clubName: '聯盟測試', clubSeed, clubId: 'club-league' })
  return { deps, clock, storage }
}

/** 直接把本聯盟戰績改成達標（等同已經打了 window 場、全勝），一般比賽游標也推到那裡 */
function forceEligible(deps: Deps, tier?: number): ClubSave {
  const c = load(deps)
  const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
  const t = tier ?? c.league.tier
  const league = t === c.league.tier ? { ...c.league, matches: n, wins: n, losses: 0, recent: 'W'.repeat(PROMOTION_CONFIG.window) } : leagueAtTier(c.league, t, { matches: n, wins: n, losses: 0, recent: 'W'.repeat(PROMOTION_CONFIG.window) })
  return deps.store.saveClub({ ...c, league, idle: { ...c.idle, nextMatchIndex: Math.max(n, c.idle.nextMatchIndex) } }, c.revision)
}

/** 找一個挑戰會贏（或會輸）的狀態：換球團種子直到第一場挑戰的結果符合 */
async function setupWithChallenge(want: boolean) {
  for (let seed = 1; seed < 200; seed++) {
    const s = await setup(new MemoryStorage(), new FakeLockManager(), seed)
    const c = forceEligible(s.deps)
    const plan = planChallenge(c)
    const r = runMatch(plan.setup, plan.ai)
    if ((r.winner === plan.userSide) === want) return s
  }
  throw new Error('找不到符合的種子')
}

describe('聯盟的純函式', () => {
  it('最近戰績只保留 window 場；勝率、場數條件、冷卻都要達到才可以挑戰', () => {
    let s = newLeagueState()
    for (let i = 0; i < PROMOTION_CONFIG.window + 10; i++) s = recordLeagueResult(s, i % 3 !== 0)
    expect(s.recent).toHaveLength(PROMOTION_CONFIG.window)
    expect(s.matches).toBe(PROMOTION_CONFIG.window + 10)
    expect(recentWinRate({ recent: 'WWLL' })).toBe(0.5)
    const good = { ...newLeagueState(), matches: PROMOTION_CONFIG.minMatches, wins: PROMOTION_CONFIG.minMatches, recent: 'W'.repeat(PROMOTION_CONFIG.window) }
    expect(eligibility(good, 100).ok).toBe(true)
    expect(eligibility({ ...good, challengeReadyAt: 103 }, 100)).toMatchObject({ ok: false, retryRemaining: 3 })
    expect(eligibility({ ...good, recent: 'L'.repeat(PROMOTION_CONFIG.window) }, 100).ok).toBe(false)
    expect(eligibility({ ...good, matches: 5, wins: 5, recent: 'WWWWW' }, 100).ok).toBe(false)
    expect(eligibility({ ...good, tier: MAX_TIER, highestTier: MAX_TIER, promotions: MAX_TIER }, 100)).toMatchObject({ ok: false, atMaxTier: true })
  })

  it('聯盟越高，一般對手越強、收益越多；新秀聯盟的收益與 Phase 4 相同', () => {
    for (let i = 1; i < LEAGUES.length; i++) {
      expect(LEAGUES[i].opponentMean).toBeGreaterThan(LEAGUES[i - 1].opponentMean)
      expect(LEAGUES[i].rewardMultiplier).toBeGreaterThan(LEAGUES[i - 1].rewardMultiplier)
    }
    expect(rewardFor(true, 4, LEAGUES[0].rewardMultiplier)).toEqual(rewardFor(true, 4))
    expect(rewardFor(true, 4, 1.5)).toEqual({ funds: Math.round(rewardFor(true, 4).funds * 1.5), experience: Math.round(rewardFor(true, 4).experience * 1.5) })
  })
})

describe('聯盟與一般比賽', () => {
  it('比賽計畫記錄聯盟；對手強度跟著聯盟走，種子、對手名字不變', async () => {
    const { deps } = await setup()
    const c = load(deps)
    const low = planMatch(c, 3)
    const high = planMatch({ ...c, league: leagueAtTier(c.league, 3) }, 3)
    expect([low.leagueTier, high.leagueTier]).toEqual([0, 3])
    expect(high.seed).toBe(low.seed)
    const avg = (p: typeof low) => {
      const opp = p.userSide === 'home' ? p.setup.away : p.setup.home
      const xs = opp.roster.lineup.map((s) => Object.values(s.player.ratings as unknown as Record<string, number>).reduce((a, b) => a + b, 0) / 4)
      return xs.reduce((a, b) => a + b, 0) / xs.length
    }
    expect(avg(high)).toBeGreaterThan(avg(low))
  })

  it('一般比賽記進本聯盟戰績，收益用比賽計畫記的聯盟倍率', async () => {
    const { deps, clock } = await setup()
    const c = forceEligible(deps, 2)
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled.length).toBe(12)
    for (const m of report.settled) {
      expect(m.result.leagueTier).toBe(2)
      expect({ funds: m.earnedFunds, experience: m.earnedExperience }).toEqual(rewardFor(m.result.won, m.result.runsFor, LEAGUES[2].rewardMultiplier))
    }
    const after = load(deps)
    expect(after.league.matches).toBe(c.league.matches + 12)
    expect(after.league.recent).toHaveLength(PROMOTION_CONFIG.window)
    expect(economyViolations(after.economy)).toEqual([])
  })

  it('不同聯盟算好的結果不能結算，也不能拿來接續批次', async () => {
    const { deps } = await setup()
    const c = load(deps)
    const plans = planMatches(c, 0, 2)
    const outcomes = (await runBatch(plans, { yieldControl: () => Promise.resolve() })).outcomes
    const promoted = { ...c, league: { ...c.league, tier: 1, highestTier: 1, promotions: 1 } }
    expect(() => settleOutcomes(promoted, outcomes, 0)).toThrow(expect.objectContaining({ code: 'mismatch' }))
    const resumed = await runBatch(planMatches(promoted, 0, 2), { completed: outcomes, yieldControl: () => Promise.resolve() }).catch((e) => e)
    expect(resumed).toBeInstanceOf(Error)
    expect(resumed.name).toBe('BatchResumeError')
  })
})

describe('晉級挑戰', () => {
  it('沒有達到條件：拒絕，不打挑戰賽、序號不變', async () => {
    const { deps } = await setup()
    const error = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }).catch((e) => e)
    expect(error).toBeInstanceOf(LeagueError)
    expect(error.code).toBe('not-eligible')
    expect(load(deps).league.nextChallengeSeq).toBe(0)
  })

  it('挑戰成功：晉級、本聯盟戰績歸零、第一次晉級的獎勵進未領取；球員、資產、總戰績、游標都不動', async () => {
    const { deps } = await setupWithChallenge(true)
    const before = load(deps)
    const out = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 })
    const c = load(deps)
    expect(out.duplicate).toBe(false)
    expect(out.challenge).toMatchObject({ seq: 0, fromTier: 0, toTier: 1, won: true, reward: LEAGUES[1].promotionReward })
    expect(c.league).toMatchObject({ tier: 1, highestTier: 1, promotions: 1, matches: 0, wins: 0, losses: 0, recent: '', nextChallengeSeq: 1, rewardedTiers: [1] })
    expect(c.economy.unclaimed).toEqual({ funds: before.economy.unclaimed.funds + LEAGUES[1].promotionReward.funds, experience: before.economy.unclaimed.experience + LEAGUES[1].promotionReward.experience })
    expect(c.economy.assets).toEqual(before.economy.assets)
    expect([c.players, c.roster, c.record, c.idle, c.recentMatches, c.replays]).toEqual([before.players, before.roster, before.record, before.idle, before.recentMatches, before.replays])
    expect(economyViolations(c.economy)).toEqual([])
    expect(validateClub(structuredClone(c))).toEqual(c)
    // 下一場一般比賽就是新聯盟
    expect(planMatch(c, c.idle.nextMatchIndex).leagueTier).toBe(1)
    // 領取後獎勵進資產，只發一次
    await claim(deps, c.economy.nextClaimSeq)
    expect(load(deps).economy.assets.funds).toBe(before.economy.assets.funds + before.economy.unclaimed.funds + LEAGUES[1].promotionReward.funds)
  })

  it('挑戰失敗：不晉級、不發獎，要再打幾場一般比賽才能再挑戰', async () => {
    const { deps, clock } = await setupWithChallenge(false)
    const before = load(deps)
    const out = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 })
    const c = load(deps)
    expect(out.challenge).toMatchObject({ won: false, reward: { funds: 0, experience: 0 } })
    expect(c.league).toMatchObject({ tier: 0, promotions: 0, nextChallengeSeq: 1, challengeReadyAt: before.idle.nextMatchIndex + PROMOTION_CONFIG.retryAfterMatches })
    expect(c.economy).toEqual(before.economy)
    const again = await challengeNextLeague(deps, { challengeSeq: 1, fromTier: 0 }).catch((e) => e)
    expect(again.code).toBe('not-eligible')
    // 打完冷卻的場數（全勝讓勝率維持）之後可以再挑戰；結算用 forceEligible 模擬
    clock.advance(HOUR)
    await settleDue(deps)
    forceEligible(deps)
    expect(eligibility(load(deps).league, load(deps).idle.nextMatchIndex).ok).toBe(true)
  })

  it('重送、連點：同一個序號只挑戰一次，回傳原本的結果；不會連跳兩級、不會重複發獎', async () => {
    const { deps } = await setupWithChallenge(true)
    const [a, b] = await Promise.all([challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }), challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 })])
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(b.challenge).toEqual(a.challenge)
    const again = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 })
    expect(again.duplicate).toBe(true)
    const c = load(deps)
    expect(c.league).toMatchObject({ tier: 1, promotions: 1, nextChallengeSeq: 1 })
    expect(c.economy.earned.funds - LEAGUES[1].promotionReward.funds).toBe(0)
  })

  it('多分頁同時按：只挑戰一次，另一個分頁拿到同一個結果；拿著舊畫面的請求被拒絕（有沒有 Web Locks 都一樣）', async () => {
    for (const locks of [new FakeLockManager(), null]) {
      const storage = new MemoryStorage()
      const { deps } = await setup(storage, locks, 3)
      forceEligible(deps)
      const other = tab(storage, new ManualClock(), locks ?? undefined)
      const results = await Promise.allSettled([challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }), challengeNextLeague(other, { challengeSeq: 0, fromTier: 0 })])
      const ok = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof challengeNextLeague>>>).value)
      // 沒有 Web Locks 時較晚的一方可能在存檔時撞到 revision 衝突；不管哪一種，都只挑戰一次
      for (const r of results) if (r.status === 'rejected') expect((r.reason as ClubSaveError).code).toBe('conflict')
      expect(ok.filter((o) => !o.duplicate)).toHaveLength(1)
      const c = load(deps)
      expect(c.league.nextChallengeSeq).toBe(1)
      expect(c.league.tier).toBeLessThanOrEqual(1)
      const stale = await challengeNextLeague(other, { challengeSeq: 0, fromTier: 1 }).catch((e) => e)
      expect(stale).toBeInstanceOf(LeagueError)
      expect(stale.code).toBe('stale-request')
    }
  })

  it('挑戰賽的 Replay：成功、失敗都存最近一場；重送不會改變；可以重現同樣的比分，而且不影響聯盟進度', async () => {
    for (const want of [true, false]) {
      const { deps } = await setupWithChallenge(want)
      const out = await challengeNextLeague(deps, { fromTier: 0, challengeSeq: 0, requestId: 'r1' })
      const c = load(deps)
      expect(c.challengeReplay).toMatchObject({ seq: 0, matchId: 'club-league#c0' })
      const t = buildTimeline(c.challengeReplay!.replay, {
        userSide: c.challengeReplay!.replay.setup.userSide,
        runsFor: out.challenge.runsFor,
        runsAgainst: out.challenge.runsAgainst,
        won: out.challenge.won,
        innings: out.challenge.innings,
      })
      expect(t.final.over).toBe(true)
      const again = await challengeNextLeague(deps, { fromTier: 0, challengeSeq: 0, requestId: 'r1' })
      expect(again.duplicate).toBe(true)
      expect(load(deps)).toEqual(c)
      // 觀看（重建時間軸）不改任何東西
      expect(load(deps).league).toEqual(c.league)
    }
  })

  it('過期畫面：分頁 B 已經晉級，分頁 A 拿著新秀聯盟的舊畫面挑戰 → 拒絕，不會開始「業餘 → 挑戰者」', async () => {
    for (const locks of [new FakeLockManager(), null]) {
      const { deps, storage } = await setupWithChallenge(true)
      const tabA = tab(storage, new ManualClock(), locks ?? undefined)
      const tabB = tab(storage, new ManualClock(), locks ?? undefined)
      // 分頁 A 的畫面：新秀聯盟、挑戰序號 0
      const shown = { fromTier: load(tabA).league.tier, challengeSeq: load(tabA).league.nextChallengeSeq }
      expect(shown).toEqual({ fromTier: 0, challengeSeq: 0 })
      // 分頁 B 晉級到業餘聯盟，接著又打到符合業餘聯盟的晉級條件
      await challengeNextLeague(tabB, { ...shown, requestId: 'tab-b' })
      forceEligible(deps)
      const before = load(deps)
      expect(before.league.tier).toBe(1)
      // 分頁 A 按舊畫面的按鈕
      const error = await challengeNextLeague(tabA, { ...shown, requestId: 'tab-a' }).catch((e) => e)
      expect(error).toBeInstanceOf(LeagueError)
      expect(error.code).toBe('stale-request')
      const after = load(deps)
      expect(after.league).toEqual(before.league)
      expect(after.league.challenges.some((c) => c.fromTier === 1)).toBe(false)
      expect(after.economy).toEqual(before.economy)
      // 拿著 B 晉級前「目前」序號（1）但聯盟是舊的（0）也一樣拒絕
      const mixed = await challengeNextLeague(tabA, { fromTier: 0, challengeSeq: 1, requestId: 'tab-a2' }).catch((e) => e)
      expect(mixed.code).toBe('stale-request')
      expect(load(deps).league.nextChallengeSeq).toBe(1)
      void locks
    }
  })

  it('同一個請求（同一個 requestId）重送：回傳原本的結果；不同 requestId 用同一個序號：拒絕', async () => {
    const { deps } = await setupWithChallenge(false)
    const req = { fromTier: 0, challengeSeq: 0, requestId: 'click-1' }
    const first = await challengeNextLeague(deps, req)
    const resend = await challengeNextLeague(deps, req)
    expect(resend.duplicate).toBe(true)
    expect(resend.challenge).toEqual(first.challenge)
    const other = await challengeNextLeague(deps, { ...req, requestId: 'click-2' }).catch((e) => e)
    expect(other.code).toBe('stale-request')
    expect(load(deps).league.nextChallengeSeq).toBe(1)
  })

  it('挑戰前先用舊聯盟結算到期的比賽；進行中那一場固定在舊聯盟（收益照舊聯盟、不算進新聯盟戰績）；下一場才是新聯盟', async () => {
    const { deps, clock } = await setupWithChallenge(true)
    clock.advance(HOUR)
    const out = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }).catch((e) => e)
    const c = load(deps)
    // 到期的 12 場用新秀聯盟結算（不管挑戰結果如何）
    expect(c.recentMatches.slice(-12).every((m) => m.result.leagueTier === 0)).toBe(true)
    expect(c.idle.nextMatchIndex).toBe(Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches) + 12)
    if (!(out instanceof Error)) expect(out.settledMatches).toBe(12)
    const tier = c.league.tier
    expect(c.liveMatch?.matchIndex).toBe(c.idle.nextMatchIndex)
    expect(c.liveMatch?.plan.leagueTier).toBe(0)
    clock.advance(HOUR)
    await settleDue(deps)
    const after = load(deps)
    const last = after.recentMatches.slice(-12)
    expect(last[0].result.leagueTier).toBe(0)
    expect(last.slice(1).every((m) => m.result.leagueTier === tier)).toBe(true)
    // 晉級的話：新聯盟的戰績只算之後的 11 場
    if (tier === 1) expect(after.league.matches).toBe(11)
  })

  it('確定性：同一個序號的挑戰賽永遠是同一場；跟一般比賽的種子分開', async () => {
    const { deps } = await setup()
    const c = forceEligible(deps)
    expect(planChallenge(c)).toEqual(planChallenge(structuredClone(c)))
    expect(planChallenge(c).seed).not.toBe(planMatch(c, 0).seed)
    expect(planChallenge(c).matchId).toBe('club-league#c0')
  })

  it('挑戰賽模擬失敗：不晉級、序號不變，到期的比賽照樣存檔', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const failing = tab(storage, clock, new FakeLockManager())
    await createClubSafely(failing, { clubName: '聯盟測試', clubSeed: 7, clubId: 'club-league' })
    forceEligible(failing)
    clock.advance(HOUR)
    const deps: Deps = {
      ...failing,
      batch: {
        ...failing.batch,
        simulate: (plan) => {
          if (plan.matchId.includes('#c')) throw new Error('boom')
          return runMatch(plan.setup, plan.ai)
        },
      },
    }
    const error = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }).catch((e) => e)
    expect(error).toBeInstanceOf(SettlementError)
    const c = load(failing)
    expect(c.league).toMatchObject({ tier: 0, nextChallengeSeq: 0 })
    expect(c.idle.nextMatchIndex).toBe(Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches) + 12)
  })

  it('存檔寫入失敗：不回報成功，什麼都沒變', async () => {
    const storage = new FlakyStorage()
    const { deps } = await setup(storage)
    forceEligible(deps)
    const before = storage.getItem('dice-baseball.club.v3')
    storage.failWrites = true
    const error = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: 0 }).catch((e) => e)
    expect(error).toBeInstanceOf(ClubSaveError)
    storage.failWrites = false
    expect(storage.getItem('dice-baseball.club.v3')).toBe(before)
  })

  it('最高聯盟不能再晉級；晉級獎勵每個聯盟只發一次', async () => {
    const { deps } = await setup()
    forceEligible(deps, MAX_TIER)
    const error = await challengeNextLeague(deps, { challengeSeq: 0, fromTier: MAX_TIER }).catch((e) => e)
    expect(error.code).toBe('max-tier')
    const c = forceEligible(deps, 1)
    const planned = planChallenge({ ...c, league: { ...c.league, rewardedTiers: [1, 2] } })
    const result = runMatch(planned.setup, planned.ai)
    const fakeWin = { plan: planned, result: { ...result, winner: planned.userSide } }
    // 防呆：就算目標聯盟已經發過獎勵（沒有降級，正常不會發生），也不會再發一次
    const applied = applyChallenge({ ...c, league: { ...c.league, rewardedTiers: [1, 2] } }, { challengeSeq: 0, fromTier: 1 }, fakeWin, 0)
    expect(applied.challenge.reward).toEqual({ funds: 0, experience: 0 })
  })
})
