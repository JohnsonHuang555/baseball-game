// @vitest-environment node
// Phase 9 PR 3：特性訓練（application）：開始與扣款、重送、取消、資源不足、多分頁、正式比賽的進度、
// 訓練完成後下一場才生效、96 場離線分段、固定的進行中比賽、中途降級、批次中斷與重試
import { describe, expect, it } from 'vitest'
import { economyViolations, type ClubSave } from '../domain/club'
import { leagueAtTier } from '../domain/league'
import { recordOf, reserves } from '../domain/roster'
import { effectiveTraits, potentialPool, trainingOptions, TRAINING_CONFIG } from '../domain/traitTraining'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, tab } from '../testkit'
import type { MatchPlan } from './batchRunner'
import { createClubSafely } from './clubLifecycle'
import { EconomyError, cancelTraining, recruit, release, startTraining } from './economyService'
import { runMatch } from './matchRunner'
import { matchesBeforePossibleChange, settleDue } from './settlementService'

const rich = { funds: 10_000_000, experience: 1_000_000 }
type Deps = ReturnType<typeof tab>

async function setup(assets = rich, seed = 42, storage = new MemoryStorage()) {
  const clock = new ManualClock()
  const deps = tab(storage, clock, new FakeLockManager())
  await createClubSafely(deps, { clubName: '訓練測試', clubSeed: seed, clubId: 'club-train' })
  const c = deps.store.loadClub()!
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { ...assets }, earned: { ...assets } } }, c.revision)
  return { deps, clock, storage }
}
const load = (d: Deps) => d.store.loadClub()!
/** 第一棒（每一場都會打擊）可以學的第一個正面特性 */
function leadoffOption(c: ClubSave) {
  const id = c.roster.lineup[0].playerId
  const o = trainingOptions(c.clubSeed, recordOf(c, id)!, { active: null, assets: rich }).find((x) => x.kind === 'learn' && x.block === null)!
  return { id, trait: o.trait, cost: o.cost, need: o.need }
}
/** 打完到期的比賽，記下每一場計畫裡這位球員的特性（看訓練結果從哪一場開始生效） */
async function settleLogged(d: Deps, playerId: string) {
  const log: { index: number; traits: string[] }[] = []
  const simulate = (plan: MatchPlan) => {
    const r = plan.setup[plan.userSide].roster
    const p = [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].find((x) => x.id === playerId)
    log.push({ index: plan.matchIndex, traits: p ? [...p.traits] : [] })
    return runMatch(plan.setup, plan.ai)
  }
  const report = await settleDue({ ...d, batch: { simulate, yieldControl: null } })
  return { report, log }
}
/** 一直結算（每次 8 小時），直到結算游標至少到 n（讓「已經累積 progress 場」的存檔合法） */
async function playUntil(d: Deps, clock: ManualClock, n: number) {
  // 一次最多 8 小時（96 場）；最後一段剛好推進到第 n 場，不多打（多打可能讓訓練自己完成）
  while (load(d).idle.nextMatchIndex < n) {
    clock.advance(Math.min(96, n - load(d).idle.nextMatchIndex) * 5 * MINUTE)
    await settleDue(d)
  }
}
/** 把訓練進度直接改成 progress（模擬已經累積了一段時間；保持存檔合法：開始的場次往前推） */
function setProgress(d: Deps, progress: number) {
  const c = load(d)
  const a = c.training.active!
  const next = c.idle.nextMatchIndex
  d.store.saveClub({ ...c, training: { ...c.training, active: { ...a, progress, startedAtMatch: Math.max(0, next - progress), lastCountedMatch: progress > 0 ? next - 1 : null } } }, c.revision)
}

describe('開始訓練與扣款', () => {
  it('扣資金與經驗、建立訓練（進度從下一場還沒開始的比賽算）、記一筆支出；帳務不變量成立', async () => {
    const { deps } = await setup()
    const c0 = load(deps)
    const { id, trait, cost, need } = leadoffOption(c0)
    const out = await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    const c = load(deps)
    expect(out.duplicate).toBe(false)
    expect(c.economy.assets).toEqual({ funds: rich.funds - cost.funds, experience: rich.experience - cost.experience })
    expect(c.economy.recentOps.at(-1)).toMatchObject({ kind: 'trainStart', playerId: id, trait, cost })
    // 進行中的第 0 場已經固定（用開始前的資料），進度從第 1 場起算
    expect(c.liveMatch?.matchIndex).toBe(0)
    expect(c.training.active).toEqual({ playerId: id, trait, kind: 'learn', progress: 0, need, startedAtMatch: 1, lastCountedMatch: null })
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('同一個請求重送不會再扣款；別的分頁已經做了別的操作，舊請求被拒絕', async () => {
    const { deps } = await setup()
    const { id, trait } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    const after = load(deps)
    const again = await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    expect(again.duplicate).toBe(true)
    expect(load(deps)).toEqual(after)
    // 另一個分頁拿舊的序號開始別的訓練：序號已經用掉，拒絕
    const other = recordOf(after, after.roster.lineup[1].playerId)!
    const otherTrait = potentialPool(after.clubSeed, other.player)[0]
    const err = await startTraining(deps, { opSeq: 0, playerId: other.player.id, trait: otherTrait, kind: 'learn' }).catch((e) => e)
    expect(err.code).toBe('stale-request')
    // 用最新的序號：訓練槽已經被占用
    const busy = await startTraining(deps, { opSeq: after.economy.nextOpSeq, playerId: other.player.id, trait: otherTrait, kind: 'learn' }).catch((e) => e)
    expect(busy).toBeInstanceOf(EconomyError)
    expect([busy.code, busy.block]).toEqual(['training-blocked', 'slot-busy'])
    expect(load(deps).economy).toEqual(after.economy)
  })

  it('資源不足：拒絕、不扣款；不在潛能池、角色不符：拒絕', async () => {
    const { deps } = await setup({ funds: 1000, experience: 100 })
    const { id, trait } = leadoffOption(load(deps))
    const before = load(deps)
    const e = await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' }).catch((x) => x)
    expect(e.code).toBe('insufficient')
    expect(load(deps).economy).toEqual(before.economy)
    const { deps: d2 } = await setup()
    const e2 = await startTraining(d2, { opSeq: 0, playerId: id, trait: 'ironArm', kind: 'learn' }).catch((x) => x)
    expect([e2.code, e2.block]).toEqual(['training-blocked', 'not-eligible'])
    const e3 = await startTraining(d2, { opSeq: 0, playerId: 'nobody', trait, kind: 'learn' }).catch((x) => x)
    expect(e3.code).toBe('no-player')
  })
})

describe('取消與釋出', () => {
  it('取消：釋放訓練槽、不退款、進度不保留；之後的比賽不再累積；重送不會再記一筆', async () => {
    const { deps, clock } = await setup()
    const { id, trait } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    clock.advance(30 * MINUTE)
    await settleDue(deps)
    expect(load(deps).training.active!.progress).toBeGreaterThan(0)
    const spent = load(deps).economy.spent
    const seq = load(deps).economy.nextOpSeq
    await cancelTraining(deps, { opSeq: seq, playerId: id, trait })
    const c = load(deps)
    expect(c.training.active).toBeNull()
    expect(c.economy.spent).toEqual(spent)
    expect(c.economy.recentOps.at(-1)).toMatchObject({ kind: 'trainCancel', cost: { funds: 0, experience: 0 } })
    const dup = await cancelTraining(deps, { opSeq: seq, playerId: id, trait })
    expect(dup.duplicate).toBe(true)
    expect(load(deps).economy.nextOpSeq).toBe(seq + 1)
    clock.advance(1 * HOUR)
    await settleDue(deps)
    expect(load(deps).training.active).toBeNull()
    expect(effectiveTraits(recordOf(load(deps), id)!)).not.toContain(trait)
    // 已經沒有這項訓練：再取消一次（新的序號）被拒絕
    const gone = await cancelTraining(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id, trait }).catch((e) => e)
    expect(gone.code).toBe('no-training')
  })

  it('訓練中的球員不能釋出（要先取消訓練）；取消後就可以；陣容裡的球員本來就不能釋出', async () => {
    const { deps } = await setup()
    await recruit(deps, { opSeq: 0, role: 'batter', candidateIndex: 0, expectedCount: 0 })
    const c = load(deps)
    const reserve = reserves(c)[0]
    const trait = potentialPool(c.clubSeed, reserve)[0]
    await startTraining(deps, { opSeq: c.economy.nextOpSeq, playerId: reserve.id, trait, kind: 'learn' })
    const e = await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: reserve.id }).catch((x) => x)
    expect(e.code).toBe('training-player')
    expect(recordOf(load(deps), reserve.id)).toBeDefined()
    await cancelTraining(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: reserve.id, trait })
    await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: reserve.id })
    expect(recordOf(load(deps), reserve.id)).toBeUndefined()
  })
})

describe('正式比賽的進度', () => {
  it('第一棒每一場都出場：進度 = 開始以後結算的場數；同一場不會算兩次（重複結算）', async () => {
    const { deps, clock } = await setup()
    const { id, trait } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    clock.advance(61 * MINUTE)
    const r = await settleDue(deps)
    const c = load(deps)
    // 第 0 場（固定的進行中比賽）不算，第 1 場起每場都算
    expect(c.training.active!.progress).toBe(r.settled.filter((m) => m.matchIndex >= 1).length)
    expect(c.training.active!.lastCountedMatch).toBe(c.idle.nextMatchIndex - 1)
    expect((await settleDue(deps)).settled).toEqual([])
    expect(load(deps).training.active!.progress).toBe(c.training.active!.progress)
  })

  it('沒有出場的球員（板凳上沒被用到、預備名單）不增加；替補有上場的場次才增加，跟 lines 完全一致', async () => {
    const { deps, clock } = await setup()
    const c = load(deps)
    const benchId = c.roster.bench[0]
    const trait = potentialPool(c.clubSeed, recordOf(c, benchId)!.player)[0]
    await startTraining(deps, { opSeq: 0, playerId: benchId, trait, kind: 'learn' })
    clock.advance(4 * HOUR)
    const r = await settleDue(deps)
    const appeared = r.settled.filter((m) => m.matchIndex >= 1 && (m.lines!.bat.some((x) => x[0] === benchId) || m.lines!.pit.some((x) => x[0] === benchId))).length
    const a = load(deps).training.active
    const progress = a ? a.progress : TRAINING_CONFIG.common.appearances
    expect(progress).toBe(appeared)
    expect(appeared).toBeLessThan(r.settled.length)
  })
})

describe('訓練完成：下一場才生效、離線 96 場分段', () => {
  it('差 2 場（例如 198／200）離線 8 小時：第 1 場 199、第 2 場完成；第 3 場起的比賽才有新特性；每一場只模擬一次；之前的比賽結果不變', async () => {
    const { deps, clock } = await setup()
    const { id, trait, need } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    await playUntil(deps, clock, need - 2)
    setProgress(deps, need - 2)
    const first = load(deps).idle.nextMatchIndex
    // 對照組：同一份存檔但沒有訓練
    const control = structuredClone(load(deps))
    control.training = { ...control.training, active: null }
    clock.advance(8 * HOUR)
    const { report, log } = await settleLogged(deps, id)
    expect(report.settled).toHaveLength(96)
    // 每一場只模擬一次（分段剛好切在完成的那一場，沒有丟掉重打）
    expect(log.map((x) => x.index)).toEqual(Array.from({ length: 96 }, (_, i) => first + i))
    const c = load(deps)
    expect(c.training.active).toBeNull()
    expect(c.training.recent.at(-1)).toMatchObject({ playerId: id, trait, completedAtMatch: first + 1, effectiveFromMatch: first + 2 })
    for (const x of log) expect(x.traits.includes(trait)).toBe(x.index >= first + 2)
    expect(effectiveTraits(recordOf(c, id)!)).toContain(trait)
    // 完成那一場以前（含）的比賽：跟沒有訓練的對照組一模一樣
    const store2 = new MemoryStorage()
    const d2 = tab(store2, new ManualClock(clock.now()), new FakeLockManager())
    store2.setItem('dice-baseball.club.v3', JSON.stringify(control))
    const ctrl = await settleDue(d2)
    const score = (m: { result: { runsFor: number; runsAgainst: number } }) => [m.result.runsFor, m.result.runsAgainst]
    expect(report.settled.slice(0, 2).map(score)).toEqual(ctrl.settled.slice(0, 2).map(score))
    // 重送（同一時間再結算）不會重複發放成果
    expect((await settleDue(deps)).settled).toEqual([])
    expect(recordOf(load(deps), id)!.dev).toEqual({ learned: [trait], removed: [] })
  })

  it('恰好在離線第 1 場完成（差 1 場、離線 8 小時）、恰好在這批的最後 1 場完成（差 24 場、離線 2 小時＝24 場）', async () => {
    for (const [missing, hours, at] of [
      [1, 8, 0],
      [24, 2, 23],
    ] as const) {
      const { deps, clock } = await setup()
      const { id, trait, need } = leadoffOption(load(deps))
      await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
      await playUntil(deps, clock, need - missing)
      setProgress(deps, need - missing)
      const first = load(deps).idle.nextMatchIndex
      clock.advance(hours * HOUR)
      const { report, log } = await settleLogged(deps, id)
      expect(report.settled).toHaveLength(hours * 12)
      expect(log.map((x) => x.index)).toEqual(report.settled.map((m) => m.matchIndex))
      expect(load(deps).training.recent.at(-1)!.completedAtMatch).toBe(first + at)
      for (const x of log) expect(x.traits.includes(trait)).toBe(x.index >= first + at + 1)
    }
  })

  it('固定的進行中比賽：在那一場完成時，那一場用開賽時的特性，下一場起才生效', async () => {
    const { deps, clock } = await setup()
    const { id, trait, need } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    await playUntil(deps, clock, need - 1)
    setProgress(deps, need - 1)
    // 開始看直播：把進行中那一場固定下來（之後才完成訓練）
    const { freezeLiveMatch } = await import('./liveMatch')
    const c = load(deps)
    deps.store.saveClub(freezeLiveMatch(c), c.revision)
    const live = load(deps).liveMatch!
    clock.advance(30 * MINUTE)
    const { report, log } = await settleLogged(deps, id)
    expect(report.settled[0].matchIndex).toBe(live.matchIndex)
    expect(log[0].traits).not.toContain(trait)
    expect(load(deps).training.recent.at(-1)!.completedAtMatch).toBe(live.matchIndex)
    expect(log.slice(1).every((x) => x.traits.includes(trait))).toBe(true)
  })

  it('中途降級也正確：降級與訓練完成在同一批離線比賽裡，每一場只記一次、聯盟與特性各自從下一場生效', async () => {
    const { deps, clock } = await setup()
    const { id, trait, need } = leadoffOption(load(deps))
    await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
    await playUntil(deps, clock, need - 10)
    setProgress(deps, need - 10)
    // 傳奇聯盟、積分很低、沒有保護：很快就可能降級
    let c = load(deps)
    const league = { ...leagueAtTier(c.league, 4), points: 6, protectionRemaining: 0 }
    deps.store.saveClub({ ...c, league }, c.revision)
    // 降級最快 3 場（積分 6、每敗 −2）、訓練最快 10 場：取小的
    expect(matchesBeforePossibleChange(load(deps))).toBe(3)
    clock.advance(8 * HOUR)
    const tiers: number[] = []
    const { report, log } = await settleLogged(deps, id)
    c = load(deps)
    expect(report.settled).toHaveLength(96)
    expect(new Set(log.map((x) => x.index)).size).toBe(96)
    for (const m of report.settled) tiers.push(m.result.leagueTier!)
    expect(c.league.relegations).toBeGreaterThan(0)
    const done = c.training.recent.at(-1)!
    for (const x of log) expect(x.traits.includes(trait)).toBe(x.index > done.completedAtMatch)
    expect(c.stats.throughMatch).toBe(c.idle.nextMatchIndex)
  })

  it('批次中斷後重試：已經結算的保留、沒打完的不套用新特性，接著打的結果跟一次打完相同', async () => {
    const runs: ClubSave[] = []
    for (const interrupt of [false, true]) {
      const { deps, clock } = await setup()
      const { id, trait, need } = leadoffOption(load(deps))
      await startTraining(deps, { opSeq: 0, playerId: id, trait, kind: 'learn' })
      await playUntil(deps, clock, need - 5)
      setProgress(deps, need - 5)
      clock.advance(8 * HOUR)
      if (interrupt) {
        const ctl = new AbortController()
        let n = 0
        const simulate = (plan: MatchPlan) => {
          if (++n === 3) ctl.abort()
          return runMatch(plan.setup, plan.ai)
        }
        const partial = await settleDue({ ...deps, batch: { simulate, yieldControl: null, chunkSize: 1 } }, { signal: ctl.signal })
        expect(partial.status).toBe('aborted')
        expect(load(deps).training.active!.progress).toBe(need - 5 + partial.settled.length)
        expect(effectiveTraits(recordOf(load(deps), id)!)).not.toContain(trait)
      }
      await settleDue(deps)
      const c = load(deps)
      runs.push({ ...c, revision: 0, idle: { ...c.idle, lastSettledAt: 0 }, recentMatches: c.recentMatches.map((m) => ({ ...m, settledAt: 0 })) })
    }
    expect(runs[1]).toEqual(runs[0])
  })

  it('沒有訓練的球團：分段跟以前一樣（新秀聯盟一段打完 96 場）', async () => {
    const { deps, clock } = await setup()
    expect(matchesBeforePossibleChange(load(deps))).toBe(Infinity)
    clock.advance(8 * HOUR)
    const { report, log } = await settleLogged(deps, 'x')
    expect(report.settled).toHaveLength(96)
    expect(log).toHaveLength(96)
  })
})
