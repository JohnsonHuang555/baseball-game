// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { deriveSeed, newClub, type ClubSaveV3 } from '../domain/club'
import { T0 } from '../testkit'
import { planMatch, planMatches, runBatch, type MatchOutcome } from './batchRunner'
import { runMatch } from './matchRunner'

function club(seed = 7): ClubSaveV3 {
  return newClub({ clubId: 'club-a', clubName: '測試球團', clubSeed: seed, roster: generateRoster(new Rng(seed)), now: T0 })
}

describe('比賽計畫', () => {
  it('matchId 唯一，種子由球團種子與場次序號穩定推導', () => {
    const c = club()
    const plans = planMatches(c, 0, 500)
    expect(new Set(plans.map((p) => p.matchId)).size).toBe(500)
    expect(new Set(plans.map((p) => p.seed)).size).toBe(500)
    expect(planMatches(club(), 0, 500)).toEqual(plans)
    expect(plans[42].seed).toBe(deriveSeed(7, 42))
    // 不同的球團種子，種子不同
    expect(planMatch(club(8), 42).seed).not.toBe(plans[42].seed)
    // 主客場輪流
    expect(plans.slice(0, 4).map((p) => p.userSide)).toEqual(['home', 'away', 'home', 'away'])
  })

  it('計畫是開打前的快照：之後改球團的陣容與戰術，不影響已經做好的計畫', () => {
    const c = club()
    const plan = planMatch(c, 3)
    const before = JSON.stringify(plan)
    c.roster.lineup[0].player.ratings.contact = 99
    c.roster.lineup[0].player.name = '改名'
    c.strategy.coach.params = { stealMin: 0 }
    expect(JSON.stringify(plan)).toBe(before)
  })

  it('同一個計畫打出來的結果一樣', () => {
    const plan = planMatch(club(), 5)
    expect(runMatch(plan.setup, plan.ai)).toEqual(runMatch(plan.setup, plan.ai))
  })
})

describe('批次執行', () => {
  const plans = planMatches(club(), 0, 30)

  it('依序打完，回傳摘要；每打 chunkSize 場讓出一次主執行緒', async () => {
    let yields = 0
    const run = await runBatch(plans, { chunkSize: 4, yieldControl: async () => void yields++ })
    expect(run.status).toBe('completed')
    expect(run.outcomes.map((o) => o.plan.matchId)).toEqual(plans.map((p) => p.matchId))
    expect(yields).toBe(7)
    expect(run.summary.completed).toBe(30)
    expect(run.summary.wins + run.summary.losses).toBe(30)
  })

  it('中斷後接續，結果跟一次打完相同，已經打完的場次不會重打', async () => {
    const full = await runBatch(plans)
    const controller = new AbortController()
    const first = await runBatch(plans, { onProgress: (done) => done === 12 && controller.abort(), signal: controller.signal })
    expect(first.status).toBe('aborted')
    expect(first.outcomes).toHaveLength(12)
    let simulated = 0
    const resumed = await runBatch(plans, {
      completed: first.outcomes,
      simulate: (p) => {
        simulated++
        return runMatch(p.setup, p.ai)
      },
    })
    expect(simulated).toBe(18)
    expect(resumed).toEqual(full)
  })

  it('接續的場次跟計畫對不起來就報錯', async () => {
    const other = planMatches(club(99), 0, 1)
    const fake: MatchOutcome = { plan: { ...other[0], matchId: plans[0].matchId }, result: runMatch(other[0].setup, other[0].ai) }
    await expect(runBatch(plans, { completed: [fake] })).rejects.toThrow('對不起來')
  })

  it('某一場模擬失敗：回傳失敗之前的場次，失敗的那場沒有結果', async () => {
    const run = await runBatch(plans, {
      simulate: (p) => {
        if (p.matchIndex === 9) throw new Error('boom')
        return runMatch(p.setup, p.ai)
      },
    })
    expect(run.status).toBe('failed')
    expect(run.failedMatchId).toBe(plans[9].matchId)
    expect(run.outcomes).toHaveLength(9)
  })

  it('chunkSize 必須是大於 0 的整數', async () => {
    for (const chunkSize of [0, -1, 1.5, NaN]) await expect(runBatch(plans, { chunkSize })).rejects.toThrow(RangeError)
  })

  it('沒有 DOM 也能跑', () => {
    expect(typeof document).toBe('undefined')
  })
})
