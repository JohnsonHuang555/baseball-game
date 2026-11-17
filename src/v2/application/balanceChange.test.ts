// @vitest-environment node
// Phase 6C（ADR-0015）：聯盟對手強度調整後，舊存檔裡已經固定的進行中比賽照舊、已結算的比賽不重算、獎勵不重發
import { afterEach, describe, expect, it } from 'vitest'
import { LEAGUES } from '../domain/leagueConfig'
import { rewardFor } from '../domain/rewards'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { MINUTE, ManualClock, tab } from '../testkit'
import { planMatch, runBatch, type MatchPlan } from './batchRunner'
import { freezeLiveMatch } from './liveMatch'
import { claim, settleDue, summarize } from './settlementService'

const current = LEAGUES.map((l) => l.opponentMean)
const setStep = (step: number) => LEAGUES.forEach((l, i) => ((l as { opponentMean: number }).opponentMean = Math.round((5 + step * i) * 100) / 100))

describe('聯盟對手強度調整（+0.5 → +0.4）與舊存檔', () => {
  afterEach(() => LEAGUES.forEach((l, i) => ((l as { opponentMean: number }).opponentMean = current[i])))

  function amateurClub() {
    const clock = new ManualClock()
    const deps = tab(new MemoryStorage(), clock)
    const created = deps.store.createClub({ clubName: '舊存檔', clubSeed: 6203, clubId: 'club-6c', now: clock.now() })
    const club = { ...created, league: { ...created.league, tier: 1, highestTier: 1, promotions: 1, rewardedTiers: [1] } }
    return { deps, clock, club }
  }

  it('目前的數值就是 +0.4（舊值 +0.5 只在這個測試裡用來模擬舊版）', () => {
    expect(current).toEqual([5.0, 5.4, 5.8, 6.2, 6.6])
  })

  it('舊版固定的進行中比賽：用開賽時（+0.5）的對手結算，結果與舊版相同；下一場起才用新強度', async () => {
    const { deps, clock, club } = amateurClub()
    // 舊版（業餘對手 5.5）的分頁固定了進行中的第 0 場並存檔
    setStep(0.5)
    const frozen = freezeLiveMatch(club)
    const oldPlan = frozen.liveMatch!.plan
    const expected = summarize(await playOne(oldPlan))
    deps.store.saveClub(frozen, created(deps))
    // 更新到新版（業餘對手 5.4）
    setStep(0.4)
    const newPlan = planMatch(frozen, 0)
    expect(JSON.stringify(newPlan.setup)).not.toBe(JSON.stringify(oldPlan.setup))

    clock.advance(10 * MINUTE)
    const report = await settleDue(deps)
    expect(report.settled.map((m) => m.matchIndex)).toEqual([0, 1])
    const first = report.settled[0]
    expect(first.result).toEqual(expected)
    const reward = rewardFor(expected.won, expected.runsFor, LEAGUES[1].rewardMultiplier)
    expect([first.earnedFunds, first.earnedExperience]).toEqual([reward.funds, reward.experience])
    // 第 1 場用新強度
    const second = summarize(await playOne(planMatch(frozen, 1)))
    expect(report.settled[1].result).toEqual(second)
  })

  it('已結算的比賽、等級、資源、聯盟不因為數值調整而改變；重新結算與領取不重發', async () => {
    const { deps, clock, club } = amateurClub()
    setStep(0.5)
    deps.store.saveClub(club, created(deps))
    clock.advance(30 * MINUTE)
    const before = (await settleDue(deps)).club
    await claim(deps, before.economy.nextClaimSeq)
    const claimed = deps.store.loadClub()!

    setStep(0.4)
    const again = await settleDue(deps)
    expect(again.settled).toEqual([])
    const after = deps.store.loadClub()!
    expect(after.recentMatches).toEqual(claimed.recentMatches)
    expect(after.economy).toEqual(claimed.economy)
    expect(after.league).toEqual(claimed.league)
    expect(after.players).toEqual(claimed.players)
    // 同一個領取序號重送：不再入帳
    await claim(deps, before.economy.nextClaimSeq)
    expect(deps.store.loadClub()!.economy).toEqual(claimed.economy)
  })
})

function created(deps: ReturnType<typeof tab>): number {
  return deps.store.loadClub()!.revision
}

async function playOne(plan: MatchPlan) {
  const run = await runBatch([plan], { yieldControl: null })
  return run.outcomes[0]
}
