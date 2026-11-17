// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { deriveSeed, newClub, type ClubSave } from '../domain/club'
import { T0 } from '../testkit'
import { BatchResumeError, planMatch, planMatches, runBatch, yieldToMain, type MatchOutcome } from './batchRunner'
import { runMatch } from './matchRunner'
import { applySettingsChange } from './settlementService'
import { substitute } from '../domain/lineup'
import { resolveRoster, toAssignment } from '../domain/roster'
import { RULES_VERSION } from '../../sim/game'

function club(seed = 7): ClubSave {
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
    const first = c.players.find((r) => r.player.id === c.roster.lineup[0].playerId)!
    ;(first.player.ratings as { contact: number }).contact = 99
    first.player.name = '改名'
    first.level = 20
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
    await expect(runBatch(plans, { completed: [fake] })).rejects.toThrow(BatchResumeError)
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

  it('從存檔讀回來（JSON 來回、key 順序不同）的舊結果，計畫相同就可以沿用', async () => {
    const first = await runBatch(plans.slice(0, 3), { yieldControl: null })
    const restored = JSON.parse(JSON.stringify(first.outcomes)) as MatchOutcome[]
    const run = await runBatch(plans.slice(0, 3), { completed: restored, simulate: () => { throw new Error('不應該重打') } })
    expect(run.status).toBe('completed')
  })

  it('chunkSize 必須是大於 0 的整數', async () => {
    for (const chunkSize of [0, -1, 1.5, NaN]) await expect(runBatch(plans, { chunkSize })).rejects.toThrow(RangeError)
  })

  it('沒有 DOM 也能跑', () => {
    expect(typeof document).toBe('undefined')
  })
})

describe('接續時拒絕舊結果', () => {
  /** 中斷在第 5 場，回傳舊結果 */
  async function interrupted(c: ClubSave) {
    const controller = new AbortController()
    const run = await runBatch(planMatches(c, 0, 10), { yieldControl: null, signal: controller.signal, onProgress: (d) => d === 5 && controller.abort() })
    expect(run.outcomes).toHaveLength(5)
    return run.outcomes
  }

  it('陣容改了之後，用新計畫接續舊結果：拒絕', async () => {
    const c = club()
    const old = await interrupted(c)
    // 板凳換上第一棒：只有陣容不同
    const changed = applySettingsChange(c, { roster: toAssignment(substitute(resolveRoster(c), 0, 0)) })
    // 種子、場次、matchId 都一樣，只有陣容不同
    expect(planMatch(changed, 0).seed).toBe(old[0].plan.seed)
    const error = await runBatch(planMatches(changed, 0, 10), { yieldControl: null, completed: old }).catch((e) => e)
    expect(error).toBeInstanceOf(BatchResumeError)
    expect(error.matchId).toBe(old[0].plan.matchId)
  })

  it('戰術改了之後接續舊結果：拒絕', async () => {
    const c = club()
    const old = await interrupted(c)
    const changed = applySettingsChange(c, { coach: { style: 'balanced', params: { stealMin: 0.95 } } })
    await expect(runBatch(planMatches(changed, 0, 10), { yieldControl: null, completed: old })).rejects.toThrow(BatchResumeError)
  })

  it('舊結果的規則版本、比賽設定或 AI 設定被改過：拒絕', async () => {
    const c = club()
    const plans = planMatches(c, 0, 10)
    const tamper = async (f: (o: MatchOutcome) => void) => {
      const old = structuredClone(await interrupted(c))
      f(old[2])
      return runBatch(plans, { yieldControl: null, completed: old })
    }
    await expect(tamper((o) => (o.result.replay.rulesVersion = RULES_VERSION - 1))).rejects.toThrow(/規則版本/)
    await expect(tamper((o) => (o.plan.setup.rules = RULES_VERSION - 1))).rejects.toThrow(BatchResumeError)
    await expect(tamper((o) => (o.result.replay.setup.seed = 1))).rejects.toThrow(/比賽設定/)
    await expect(tamper((o) => (o.result.replay.ai = { home: { kind: 'builtin' }, away: { kind: 'autoCoach', style: 'balanced' } }))).rejects.toThrow(BatchResumeError)
  })

  it('計畫寫明規則版本', () => {
    expect(planMatch(club(), 0).setup.rules).toBe(RULES_VERSION)
  })
})

describe('讓出主執行緒', () => {
  afterEach(() => {
    delete (globalThis as { scheduler?: unknown }).scheduler
  })
  const plans = planMatches(club(), 0, 20)

  it('預設就用 yieldToMain：每 chunkSize 場讓出一次', async () => {
    const yieldSpy = vi.fn(() => Promise.resolve())
    ;(globalThis as { scheduler?: unknown }).scheduler = { yield: yieldSpy }
    await runBatch(plans, { chunkSize: 6 })
    expect(yieldSpy).toHaveBeenCalledTimes(3)
    yieldSpy.mockClear()
    await runBatch(plans)
    expect(yieldSpy).toHaveBeenCalledTimes(Math.floor(20 / 8))
  })

  it('讓出發生在第 chunkSize、2×chunkSize… 場打完之後', async () => {
    const at: number[] = []
    let done = 0
    await runBatch(plans, { chunkSize: 5, onProgress: (d) => (done = d), yieldControl: async () => void at.push(done) })
    expect(at).toEqual([5, 10, 15, 20])
  })

  it('yieldControl: null（Web Worker）就不讓出', async () => {
    const yieldSpy = vi.fn(() => Promise.resolve())
    ;(globalThis as { scheduler?: unknown }).scheduler = { yield: yieldSpy }
    await runBatch(plans, { chunkSize: 1, yieldControl: null })
    expect(yieldSpy).not.toHaveBeenCalled()
  })

  it('yieldToMain 是真的讓出到下一個工作（不是微任務），中間其他工作可以執行', async () => {
    let resolved = false
    const p = yieldToMain().then(() => (resolved = true))
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(resolved).toBe(false)
    let other = false
    setTimeout(() => (other = true), 0)
    await p
    await new Promise((r) => setTimeout(r, 0))
    expect(resolved && other).toBe(true)
  })

  it('批次在讓出時，其他工作（例如畫面更新）真的有機會插進來', async () => {
    const ticks: number[] = []
    let done = 0
    const interval = setInterval(() => ticks.push(done), 0)
    try {
      await runBatch(plans, { chunkSize: 2, onProgress: (d) => (done = d), yieldControl: () => new Promise((r) => setTimeout(r, 0)) })
    } finally {
      clearInterval(interval)
    }
    expect(ticks.some((d) => d > 0 && d < 20)).toBe(true)
  })
})
