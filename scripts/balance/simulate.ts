// V2 平衡模擬的核心（Phase 6C）：用正式的服務（結算、領取、升級、招募、釋出、晉級挑戰、換陣容）跑完整的遊玩流程。
// 不另外寫一套經濟或比賽公式：比賽由 MatchRunner 打、獎勵由結算服務發、成本由經濟服務扣，所以結果就是玩家實際會遇到的數字。
//
// 時間模型（跟 IdleEngine 一樣）：
// - 建立球團的那一刻是第 0 秒，第一場在 5 分鐘後打完。
// - 每天上線 sessionsPerDay 次、平均分散（間隔 24 / n 小時）。每次上線：結算 → 領取 → 依策略花資源 → 有資格就挑戰 → 離開。
// - 離線超過 8 小時的部分捨棄（IdleEngine 的 MAX_OFFLINE），所以一天上線 1 次的有效結算時間是 8 小時（96 場），
//   2 次是 16 小時（192 場），3 次以上是 24 小時（288 場）。
// - 「經過的真實時間」「系統有效結算時間（場數 × 5 分鐘）」「上線次數與操作次數」分開記錄，不把離線等待算成遊玩時間。
import { overall } from '../../src/sim/generate'
import { isOffPosition } from '../../src/sim/positions'
import type { Batter, Pitcher, Player } from '../../src/sim/types'
import { createClubSafely } from '../../src/v2/application/clubLifecycle'
import { canAfford, recruit, release, upgrade } from '../../src/v2/application/economyService'
import { nearestUpgrade, suggestNextAction } from '../../src/v2/application/guidance'
import { challengeNextLeague } from '../../src/v2/application/leagueService'
import { claim, settleDue, updateSettings } from '../../src/v2/application/settlementService'
import type { ClubSave, Resources } from '../../src/v2/domain/club'
import { eligibility } from '../../src/v2/domain/league'
import { LEAGUES } from '../../src/v2/domain/leagueConfig'
import { swapWithReserve, type LineupDraft } from '../../src/v2/domain/lineup'
import { upgradeCost } from '../../src/v2/domain/progression'
import { MAX_LEVEL } from '../../src/v2/domain/progressionConfig'
import { bestCandidateIndex, compareCandidate } from '../../src/v2/domain/recruitCompare'
import { recruitCandidates, recruitCost, rosterFull } from '../../src/v2/domain/recruitment'
import { rewardFor } from '../../src/v2/domain/rewards'
import { assignedIds, reserves, resolveRoster, toAssignment } from '../../src/v2/domain/roster'
import { MemoryStorage } from '../../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab } from '../../src/v2/testkit'

export const STRATEGIES = ['A', 'B', 'C', 'D', 'E'] as const
export type Strategy = (typeof STRATEGIES)[number]
export const STRATEGY_NAMES: Record<Strategy, string> = {
  A: 'A 完全不養成',
  B: 'B 平均養成',
  C: 'C 集中養成',
  D: 'D 招募＋養成',
  E: 'E 跟著首頁建議',
}

type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!

/** 上場球員（先發、板凳、投手） */
export const activeRecords = (c: ClubSave) => {
  const ids = assignedIds(c.roster)
  return c.players.filter((r) => ids.has(r.player.id))
}

/** 上場 14 人的平均能力（含養成），跟首頁的「球隊戰力」相同 */
export function teamPower(c: ClubSave): number {
  const r = resolveRoster(c)
  const team = [...r.lineup.map((x) => x.player), ...r.bench, r.starter, ...r.relievers]
  return team.reduce((x, p) => x + overall(p), 0) / team.length
}

export const batterScore = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3 + b.ratings.speed * 0.15
export const pitcherScore = (p: Pitcher) => p.ratings.stuff + p.ratings.control + p.ratings.stamina * 0.3

/** 每日快照 */
export interface DaySnapshot {
  day: number
  /** 經過的真實時間（小時） */
  realHours: number
  /** 已結算的比賽 */
  matches: number
  /** 系統有效結算時間（小時）= 場數 × 5 分鐘 */
  settledHours: number
  sessions: number
  /** 玩家的操作次數（領取、升級、招募、釋出、換陣容、挑戰） */
  actions: number
  earned: Resources
  assets: Resources
  unclaimed: Resources
  spentUpgrade: Resources
  spentRecruit: Resources
  avgLevel: number
  maxLevel: number
  power: number
  players: number
  tier: number
  wins: number
  losses: number
}

export interface TierLog {
  games: number
  wins: number
  attempts: number
  successes: number
  /** 挑戰失敗後的冷卻場數（合計） */
  cooldownMatches: number
  /** 第一次到達這個聯盟的時間（天，可以是小數） */
  reachedDay: number | null
  /** 本聯盟第一次符合挑戰資格的時間（天） */
  firstEligibleDay: number | null
}

/** 收入與支出的來源 */
export interface Ledger {
  baseWinFunds: number
  baseLossFunds: number
  runFunds: number
  /** 聯盟倍率帶來的額外收入（資金） */
  multiplierFunds: number
  baseExp: number
  multiplierExp: number
  promotion: Resources
  upgrades: Resources
  recruits: Resources
  upgradeCount: number
  recruitCount: number
  releaseCount: number
}

/** 新手里程碑（真實時間，分鐘） */
export interface Milestones {
  firstMatchMinutes: number | null
  firstMatchReward: Resources | null
  firstUpgradeMinutes: number | null
  firstUpgradeMatches: number | null
  firstUpgradeClaims: number | null
  firstUpgradePowerGain: number | null
  firstRecruitMinutes: number | null
  firstRecruitMatches: number | null
}

/** 一次簽約：第幾天、第幾場、簽下的人與當時陣容的比較 */
export interface RecruitLog {
  day: number
  matches: number
  role: 'batter' | 'pitcher'
  cost: number
  /** 簽下那位的總評（Lv.1） */
  overall: number
  /** 跟比較對象（同守位先發、先發投手或最弱後援）的差距 */
  diff: number
  /** 能力高於比較對象（預估的能力數值差距 ≥ 0.3，不代表勝率） */
  improves: boolean
  /** 三位候選人的總評（看三選一實際挑到多好的人） */
  candidates: number[]
}

/**
 * 招募時怎麼選人：
 * - first：只看第 0 位（等同舊制「付錢後隨機得到一位」）
 * - best：三選一，挑能力比比較對象高最多的那位（bestCandidateIndex）
 */
export type RecruitPick = 'first' | 'best'
let recruitPick: RecruitPick = 'best'
export function setRecruitPick(pick: RecruitPick): void {
  recruitPick = pick
}
export function currentRecruitPick(): RecruitPick {
  return recruitPick
}

export interface SimResult {
  strategy: Strategy
  seed: number
  sessionsPerDay: number
  days: number
  snapshots: DaySnapshot[]
  tiers: TierLog[]
  ledger: Ledger
  milestones: Milestones
  recruits: RecruitLog[]
}

export interface SimOptions {
  strategy: Strategy
  seed: number
  sessionsPerDay: number
  days: number
  /** 改用指定的上線時間（開始後第幾分鐘），每次上線後記一筆快照（新手前 24 小時分析用） */
  sessionMinutes?: number[]
}

const zero = (): Resources => ({ funds: 0, experience: 0 })

export async function simulate(o: SimOptions): Promise<SimResult> {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const d = tab(storage, clock, new FakeLockManager())
  d.batch.yieldControl = null
  await createClubSafely(d, { clubName: '平衡測試', clubSeed: o.seed, clubId: `bal-${o.seed}` })
  const c0 = load(d)
  const r0 = resolveRoster(c0)
  // 集中養成的主力：上場打者打擊最好的 4 人 + 先發投手
  const core = new Set([...r0.lineup.map((s) => s.player).sort((a, b) => batterScore(b) - batterScore(a)).slice(0, 4).map((p) => p.id), r0.starter.id])
  const tiers: TierLog[] = LEAGUES.map((_, i) => ({ games: 0, wins: 0, attempts: 0, successes: 0, cooldownMatches: 0, reachedDay: i === 0 ? 0 : null, firstEligibleDay: null }))
  const ledger: Ledger = { baseWinFunds: 0, baseLossFunds: 0, runFunds: 0, multiplierFunds: 0, baseExp: 0, multiplierExp: 0, promotion: zero(), upgrades: zero(), recruits: zero(), upgradeCount: 0, recruitCount: 0, releaseCount: 0 }
  const ms: Milestones = { firstMatchMinutes: null, firstMatchReward: null, firstUpgradeMinutes: null, firstUpgradeMatches: null, firstUpgradeClaims: null, firstUpgradePowerGain: null, firstRecruitMinutes: null, firstRecruitMatches: null }
  let sessions = 0
  let actions = 0
  let claims = 0
  const now = () => (clock.now() - T0) / MINUTE
  const day = () => (clock.now() - T0) / (24 * HOUR)

  const doUpgrade = async (playerId: string): Promise<boolean> => {
    const c = load(d)
    const r = c.players.find((x) => x.player.id === playerId)
    const cost = r && upgradeCost(r.level)
    if (!r || !cost || !canAfford(c, cost)) return false
    const before = teamPower(c)
    await upgrade(d, { opSeq: c.economy.nextOpSeq, playerId, expectedLevel: r.level })
    ledger.upgrades.funds += cost.funds
    ledger.upgrades.experience += cost.experience
    ledger.upgradeCount++
    actions++
    if (ms.firstUpgradeMinutes === null) {
      ms.firstUpgradeMinutes = now()
      ms.firstUpgradeMatches = load(d).idle.nextMatchIndex
      ms.firstUpgradeClaims = claims
      ms.firstUpgradePowerGain = teamPower(load(d)) - before
    }
    return true
  }

  /** 把資源花在等級最低的球員上（pool 之內），直到付不起 */
  const upgradeEvenly = async (pool: (c: ClubSave) => string[]) => {
    for (let guard = 0; guard < 600; guard++) {
      const c = load(d)
      const ids = new Set(pool(c))
      const target = c.players.filter((r) => ids.has(r.player.id) && r.level < MAX_LEVEL).sort((a, b) => a.level - b.level || overall(b.player) - overall(a.player))[0]
      if (!target || !(await doUpgrade(target.player.id))) return
    }
  }

  const recruitLog: RecruitLog[] = []
  const doRecruit = async (role: 'batter' | 'pitcher') => {
    const c = load(d)
    const cost = recruitCost(c.recruitment.count)
    const candidates = recruitCandidates(c, role)
    const candidateIndex = recruitPick === 'best' ? bestCandidateIndex(c, candidates) : 0
    const cmp = compareCandidate(c, candidates[candidateIndex])
    await recruit(d, { opSeq: c.economy.nextOpSeq, role, candidateIndex, expectedCount: c.recruitment.count })
    recruitLog.push({ day: day(), matches: c.idle.nextMatchIndex, role, cost: cost.funds, overall: overall(candidates[candidateIndex]), diff: cmp.diff, improves: cmp.improves, candidates: candidates.map(overall) })
    ledger.recruits.funds += cost.funds
    ledger.recruitCount++
    actions++
    if (ms.firstRecruitMinutes === null) {
      ms.firstRecruitMinutes = now()
      ms.firstRecruitMatches = load(d).idle.nextMatchIndex
    }
  }

  /** 預備名單裡更好的人換上場（打者要守本職或當指定打擊，投手直接比） */
  const promoteReserves = async () => {
    const c = load(d)
    let draft: LineupDraft = { roster: resolveRoster(c), reserves: reserves(c) }
    let changed = false
    for (let pass = 0; pass < 30; pass++) {
      let improved = false
      for (let ri = 0; ri < draft.reserves.length && !improved; ri++) {
        const p = draft.reserves[ri] as Player
        if (p.role === 'batter') {
          draft.roster.lineup.forEach((s, i) => {
            if (improved) return
            const fits = s.position === 'DH' || !isOffPosition(p, s.position)
            if (fits && batterScore(p as Batter) > batterScore(s.player) + 0.3) {
              draft = swapWithReserve(draft, { kind: 'lineup', index: i }, ri)
              improved = true
            }
          })
        } else {
          const slots = [{ kind: 'starter' as const }, ...draft.roster.relievers.map((_, i) => ({ kind: 'reliever' as const, index: i }))]
          for (const slot of slots) {
            const current = slot.kind === 'starter' ? draft.roster.starter : draft.roster.relievers[slot.index]
            if (!improved && pitcherScore(p as Pitcher) > pitcherScore(current) + 0.3) {
              draft = swapWithReserve(draft, slot, ri)
              improved = true
            }
          }
        }
      }
      if (!improved) break
      changed = true
    }
    if (changed) {
      await updateSettings(d, { roster: toAssignment(draft.roster) })
      actions++
    }
  }

  const tryChallenge = async () => {
    const c = load(d)
    const e = eligibility(c.league, c.idle.nextMatchIndex)
    if (!e.ok) return
    const out = await challengeNextLeague(d, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
    actions++
    const t = tiers[c.league.tier]
    t.attempts++
    if (out.challenge.won) {
      t.successes++
      tiers[out.challenge.toTier].reachedDay = day()
      ledger.promotion.funds += out.challenge.reward.funds
      ledger.promotion.experience += out.challenge.reward.experience
    } else t.cooldownMatches += out.club.league.challengeReadyAt - out.club.idle.nextMatchIndex
  }

  const session = async () => {
    sessions++
    const report = await settleDue(d)
    for (const m of report.settled) {
      const t = m.result.leagueTier ?? 0
      tiers[t].games++
      if (m.result.won) tiers[t].wins++
      const base = rewardFor(m.result.won, m.result.runsFor, 1)
      const flat = rewardFor(m.result.won, 0, 1)
      if (m.result.won) ledger.baseWinFunds += flat.funds
      else ledger.baseLossFunds += flat.funds
      ledger.runFunds += base.funds - flat.funds
      ledger.multiplierFunds += m.earnedFunds - base.funds
      ledger.baseExp += base.experience
      ledger.multiplierExp += m.earnedExperience - base.experience
      if (ms.firstMatchMinutes === null) {
        ms.firstMatchMinutes = ((m.playedAt ?? clock.now()) - T0) / MINUTE
        ms.firstMatchReward = { funds: m.earnedFunds, experience: m.earnedExperience }
      }
    }
    let c = load(d)
    if (c.economy.unclaimed.funds > 0 || c.economy.unclaimed.experience > 0) {
      await claim(d, c.economy.nextClaimSeq)
      claims++
      actions++
    }
    c = load(d)
    const e = eligibility(c.league, c.idle.nextMatchIndex)
    if (e.ok && tiers[c.league.tier].firstEligibleDay === null) tiers[c.league.tier].firstEligibleDay = day()
    const active = (x: ClubSave) => activeRecords(x).map((r) => r.player.id)
    switch (o.strategy) {
      case 'A':
        break
      case 'B':
        await upgradeEvenly(active)
        break
      case 'C': {
        await upgradeEvenly(() => [...core])
        const x = load(d)
        if (x.players.filter((r) => core.has(r.player.id)).every((r) => r.level >= MAX_LEVEL)) await upgradeEvenly(active)
        break
      }
      case 'D': {
        for (let guard = 0; guard < 40; guard++) {
          let x = load(d)
          // 名單滿了：釋出能力最差的預備球員，空出名額繼續招募（只在付得起下一次招募時才釋出）
          if (rosterFull(x) && x.economy.assets.funds >= recruitCost(x.recruitment.count).funds) {
            const worst = reserves(x).sort((a, b) => overall(a) - overall(b))[0]
            if (!worst) break
            await release(d, { opSeq: x.economy.nextOpSeq, playerId: worst.id })
            ledger.releaseCount++
            actions++
            x = load(d)
          }
          if (rosterFull(x) || x.economy.assets.funds < recruitCost(x.recruitment.count).funds) break
          await doRecruit(x.recruitment.count % 3 === 2 ? 'pitcher' : 'batter')
        }
        await promoteReserves()
        await upgradeEvenly(active)
        break
      }
      case 'E': {
        // 新手友善：照首頁「目前建議」一步一步做（領取、挑戰、培養建議的那位、把建議的預備球員換上場）
        for (let guard = 0; guard < 400; guard++) {
          const s = suggestNextAction(load(d), { canWrite: true })
          if (s.kind === 'claim') {
            await claim(d, load(d).economy.nextClaimSeq)
            claims++
            actions++
          } else if (s.kind === 'upgrade') {
            if (!(await doUpgrade(s.playerId))) break
          } else if (s.kind === 'challenge') {
            await tryChallenge()
          } else if (s.kind === 'lineup') {
            await promoteReserves()
            if (suggestNextAction(load(d), { canWrite: true }).kind === 'lineup') break
          } else break // watch：沒有其他可以做的事
        }
        // 適度招募：經驗不夠升級、資金卻多到付得起兩次招募時，招募一位（球團最多 20 人，打者、投手 2：1）
        const x = load(d)
        const goal = nearestUpgrade(x)
        const cost = recruitCost(x.recruitment.count).funds
        if (x.players.length < 20 && goal && goal.short.experience > 0 && x.economy.assets.funds >= cost * 2) {
          await doRecruit(x.recruitment.count % 3 === 2 ? 'pitcher' : 'batter')
          await promoteReserves()
        }
        break
      }
    }
    await tryChallenge()
  }

  const snapshots: DaySnapshot[] = []
  const snap = (dday: number): DaySnapshot => {
    const c = load(d)
    const active = activeRecords(c)
    return {
      day: dday,
      realHours: (clock.now() - T0) / HOUR,
      matches: c.idle.nextMatchIndex,
      settledHours: (c.idle.nextMatchIndex * 5) / 60,
      sessions,
      actions,
      earned: { ...c.economy.earned },
      assets: { ...c.economy.assets },
      unclaimed: { ...c.economy.unclaimed },
      spentUpgrade: { ...ledger.upgrades },
      spentRecruit: { ...ledger.recruits },
      avgLevel: active.reduce((x, r) => x + r.level, 0) / active.length,
      maxLevel: Math.max(...c.players.map((r) => r.level)),
      power: teamPower(c),
      players: c.players.length,
      tier: c.league.tier,
      wins: c.record.wins,
      losses: c.record.losses,
    }
  }
  if (o.sessionMinutes) {
    for (const m of o.sessionMinutes) {
      clock.set(T0 + m * MINUTE)
      await session()
      snapshots.push(snap(m / 1440))
    }
  } else {
    const interval = (24 / o.sessionsPerDay) * HOUR
    // 第 0 秒：建立球團（這時沒有任何事可以做）
    for (let dday = 1; dday <= o.days; dday++) {
      for (let s = 0; s < o.sessionsPerDay; s++) {
        clock.advance(interval)
        await session()
      }
      snapshots.push(snap(dday))
    }
  }
  return { strategy: o.strategy, seed: o.seed, sessionsPerDay: o.sessionsPerDay, days: o.days, snapshots, tiers, ledger, milestones: ms, recruits: recruitLog }
}

// ---- 統計 ----

export interface Dist {
  n: number
  mean: number
  p10: number
  p50: number
  p90: number
  min: number
  max: number
}

/** 分位數（線性內插）；空陣列回傳 NaN 的統計（呼叫端要判斷 n） */
export function dist(xs: readonly number[]): Dist {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  const q = (p: number) => {
    if (!v.length) return NaN
    const i = (v.length - 1) * p
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)
  }
  return { n: v.length, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN, p10: q(0.1), p50: q(0.5), p90: q(0.9), min: v[0] ?? NaN, max: v.at(-1) ?? NaN }
}

/** 有「沒有發生」（例如 30 天內沒到）的分位數：沒發生的當成無限大，所以 P50 只在一半以上的樣本有發生時才是有限值 */
export function censoredQuantiles(xs: readonly (number | null)[]): { n: number; reached: number; p10: number; p50: number; p90: number } {
  const v = xs.map((x) => (x === null ? Infinity : x)).sort((a, b) => a - b)
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] : NaN)
  return { n: v.length, reached: xs.filter((x) => x !== null).length, p10: q(0.1), p50: q(0.5), p90: q(0.9) }
}

/** 兩組成對樣本的平均差與 95% 信賴區間（t 分佈近似） */
export function pairedDiff(a: readonly number[], b: readonly number[]): { mean: number; lo: number; hi: number; n: number } {
  const diffs = a.map((x, i) => x - b[i])
  const n = diffs.length
  const mean = diffs.reduce((s, x) => s + x, 0) / n
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1))
  const t = n >= 30 ? 2.045 : n >= 10 ? 2.262 : 2.776
  const half = (t * sd) / Math.sqrt(n)
  return { mean, lo: mean - half, hi: mean + half, n }
}
