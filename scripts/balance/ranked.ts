// Phase 7 競技積分／降級的「模擬專用」規則（RFC 待確認，不是正式規則）。
// 這裡的數字只給 scripts/balance-v2-ranked.ts 比較方案用，不會寫進遊戲 Config 或存檔。
//
// 做法：正式的結算、領取、升級、挑戰服務照常跑（比賽結果就是玩家實際會遇到的），
// 這個檔案在旁邊記一份「影子積分」，需要升降級時才直接改模擬用的記憶體存檔：
// - 降級：把 league.tier 改成下一級，並把 highestTier／promotions／rewardedTiers 一起壓到同一級，
//   讓現行的 leagueViolations（Phase 5「沒有降級」的不變量）在模擬裡繼續成立；真正的最高階級與已發獎勵記在影子狀態。
// - 積分制聯盟的挑戰：現行 eligibility 只認 100 場／60%，所以挑戰前暫時把本聯盟戰績補到符合，挑戰後（失敗時）還原。
// - 重返已經領過獎勵的聯盟：applyChallenge 會因為 rewardedTiers 被壓掉而再發一次，模擬裡馬上扣回，對應設計「不重複發放」。
import type { challengeNextLeague } from '../../src/v2/application/leagueService'
import type { ClubSave } from '../../src/v2/domain/club'
import { eligibility } from '../../src/v2/domain/league'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from '../../src/v2/domain/leagueConfig'
import type { tab } from '../../src/v2/testkit'

type Deps = ReturnType<typeof tab>
type ChallengeOut = Awaited<ReturnType<typeof challengeNextLeague>>
interface Settled {
  result: { won: boolean; leagueTier?: number }
}

export interface PointsRules {
  kind: 'points'
  name: string
  /** 從這一級開始用積分（含） */
  rankedFrom: number
  /** 這些階級會降級（降一級） */
  relegateTiers: readonly number[]
  max: number
  start: number
  win: number
  loss: number
  /** 積分 ≥ 這個值才進入晉級區 */
  promoteAt: number
  /** 降級後在下一級的起始積分 */
  afterRelegation: number
  /** 晉級後前 N 場積分不會降到 1 以下（不會馬上掉回去） */
  protectMatches: number
  /** 積分制聯盟挑戰前至少要在本聯盟打幾場 */
  minMatches: number
  /** 晉級資格：points＝積分進入晉級區；classic＝維持現行 100 場／60%（積分只用來保級） */
  promotion?: 'points' | 'classic'
}

export interface SeasonRules {
  kind: 'season'
  name: string
  relegateTiers: readonly number[]
  /** 每 N 場一般比賽是一季 */
  season: number
  /** 一季勝率低於這個值就降級 */
  relegateBelow: number
  /** 晉級後第一季不降級 */
  protectFirstSeason: boolean
}

export type RankedRules = PointsRules | SeasonRules

export interface RankedEvent {
  kind: 'promote' | 'relegate' | 'danger'
  day: number
  matches: number
  from: number
  to: number
}

export interface RankedLog {
  events: RankedEvent[]
  /** 每一級待過的一般比賽場數 */
  matchesAt: number[]
  /** 每一級在危險區（積分 ≤ 20）的場數 */
  dangerAt: number[]
  /** 每次降級後到重返原聯盟的天數（沒回去就是 null） */
  returns: { from: number; days: number | null }[]
  /** 單一批次結算（一次上線）裡積分掉最多的一次 */
  worstBatchDrop: number[]
  /** 因為單一次上線的離線批次就從非危險區直接降級的次數 */
  oneBatchRelegations: number
}

export interface RankedHook {
  readonly rules: RankedRules
  readonly log: RankedLog
  /** 每次上線結算完，依序處理新結算的比賽；必要時改存檔（降級） */
  afterSettle(d: Deps, settled: readonly Settled[], day: number): void
  /** 現在能不能挑戰下一級 */
  canChallenge(c: ClubSave): boolean
  /** 挑戰前：讓現行的 eligibility 放行，回傳還原用的函式 */
  prepareChallenge(d: Deps): (out: ChallengeOut, day: number) => void
  points(): number
}

const DANGER = 20

export function createRankedHook(rules: RankedRules): RankedHook {
  const n = LEAGUES.length
  const log: RankedLog = { events: [], matchesAt: Array(n).fill(0), dangerAt: Array(n).fill(0), returns: [], worstBatchDrop: Array(n).fill(0), oneBatchRelegations: 0 }
  let tier = 0
  let points = rules.kind === 'points' ? rules.start : 0
  let inTier = 0
  let seasonWins = 0
  let seasonGames = 0
  let protect = 0
  let firstSeason = false
  const rewarded = new Set<number>()
  const pending: { from: number; day: number; idx: number }[] = []

  const relegate = (d: Deps, day: number) => {
    const c = d.store.loadClub()!
    const to = tier - 1
    const league = { ...c.league, tier: to, highestTier: to, promotions: to, rewardedTiers: c.league.rewardedTiers.filter((t) => t <= to), matches: 0, wins: 0, losses: 0, recent: '', challengeReadyAt: 0 }
    d.store.saveClub({ ...c, league }, c.revision)
    log.events.push({ kind: 'relegate', day, matches: c.idle.nextMatchIndex, from: tier, to })
    log.returns.push({ from: tier, days: null })
    pending.push({ from: tier, day, idx: log.returns.length - 1 })
    tier = to
    inTier = 0
    seasonWins = 0
    seasonGames = 0
    protect = 0
    if (rules.kind === 'points') points = rules.afterRelegation
  }

  return {
    rules,
    log,
    points: () => points,
    afterSettle(d, settled, day) {
      const before = points
      let minInBatch = points
      let relegatedThisBatch = false
      for (const m of settled) {
        const t = m.result.leagueTier ?? 0
        if (t !== tier) continue // 降級後同一批剩下的比賽（還是舊聯盟打的）不再計分
        log.matchesAt[t]++
        inTier++
        if (rules.kind === 'points') {
          if (t < rules.rankedFrom) continue
          points = Math.min(rules.max, Math.max(0, points + (m.result.won ? rules.win : -rules.loss)))
          if (protect > 0) {
            protect--
            points = Math.max(1, points)
          }
          if (points <= DANGER) log.dangerAt[t]++
          minInBatch = Math.min(minInBatch, points)
          if (points === 0 && rules.relegateTiers.includes(t)) {
            if (before > DANGER) log.oneBatchRelegations++
            log.worstBatchDrop[t] = Math.max(log.worstBatchDrop[t], before - 0)
            relegate(d, day)
            relegatedThisBatch = true
          }
        } else {
          if (!rules.relegateTiers.includes(t)) continue
          seasonGames++
          if (m.result.won) seasonWins++
          if (seasonGames >= rules.season) {
            const rate = seasonWins / seasonGames
            const safe = rules.protectFirstSeason && firstSeason
            firstSeason = false
            seasonWins = 0
            seasonGames = 0
            if (rate < rules.relegateBelow && !safe) {
              relegate(d, day)
              relegatedThisBatch = true
            }
          }
        }
      }
      if (rules.kind === 'points' && !relegatedThisBatch) log.worstBatchDrop[tier] = Math.max(log.worstBatchDrop[tier], before - minInBatch)
    },
    canChallenge(c) {
      if (c.league.tier >= MAX_TIER) return false
      if (rules.kind === 'points' && rules.promotion !== 'classic' && c.league.tier >= rules.rankedFrom) {
        const retry = Math.max(0, c.league.challengeReadyAt - c.idle.nextMatchIndex)
        return points >= rules.promoteAt && inTier >= rules.minMatches && retry === 0
      }
      return eligibility(c.league, c.idle.nextMatchIndex).ok
    },
    prepareChallenge(d) {
      const c = d.store.loadClub()!
      const saved = { matches: c.league.matches, wins: c.league.wins, losses: c.league.losses, recent: c.league.recent }
      const patched = rules.kind === 'points' && rules.promotion !== 'classic' && c.league.tier >= rules.rankedFrom
      if (patched) {
        const need = Math.max(c.league.matches, PROMOTION_CONFIG.minMatches)
        const recent = 'W'.repeat(PROMOTION_CONFIG.window)
        d.store.saveClub({ ...c, league: { ...c.league, matches: need, wins: need, losses: 0, recent } }, c.revision)
      }
      return (out, day) => {
        const x = d.store.loadClub()!
        if (out.challenge.won) {
          const to = out.challenge.toTier
          // 重返已經領過獎勵的聯盟：設計是不再發放，模擬裡扣回這次多發的
          if (rewarded.has(to) && (out.challenge.reward.funds > 0 || out.challenge.reward.experience > 0)) {
            const r = out.challenge.reward
            const e = x.economy
            d.store.saveClub({ ...x, economy: { ...e, unclaimed: { funds: e.unclaimed.funds - r.funds, experience: e.unclaimed.experience - r.experience }, earned: { funds: e.earned.funds - r.funds, experience: e.earned.experience - r.experience } } }, x.revision)
          }
          rewarded.add(to)
          log.events.push({ kind: 'promote', day, matches: x.idle.nextMatchIndex, from: tier, to })
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].from === to) {
              log.returns[pending[i].idx].days = day - pending[i].day
              pending.splice(i, 1)
            }
          }
          tier = to
          inTier = 0
          seasonWins = 0
          seasonGames = 0
          firstSeason = true
          if (rules.kind === 'points') {
            points = rules.start
            protect = rules.protectMatches
          }
        } else if (patched) {
          d.store.saveClub({ ...x, league: { ...x.league, ...saved } }, x.revision)
        }
      }
    },
  }
}

// ---- 比較用的方案（只在模擬裡） ----

const common = { rankedFrom: 2, relegateTiers: [3, 4], max: 100, start: 50, promoteAt: 80, afterRelegation: 50, minMatches: 30 } as const

export const RANKED_VARIANTS: Record<string, RankedRules | null> = {
  /** 現行規則：100 場＋60%，沒有降級 */
  BASE: null,
  /** 方案 A（混合）設計稿的示意數字：勝 +3／敗 −2，晉級後 20 場保護 */
  'A+3-2': { kind: 'points', name: 'A 積分 +3／−2', ...common, win: 3, loss: 2, protectMatches: 20 },
  /** 方案 A，勝敗同分：損益兩平的勝率是 50% */
  'A+2-2': { kind: 'points', name: 'A 積分 +2／−2', ...common, win: 2, loss: 2, protectMatches: 20 },
  /** 方案 A 的調整版：勝 +2／敗 −1（損益兩平 33%）、晉級後 40 場保護 */
  'A+2-1': { kind: 'points', name: 'A 積分 +2／−1', ...common, win: 2, loss: 1, protectMatches: 40 },
  /** 方案 C（保級積分）：晉級維持 100 場＋60%＋挑戰賽；積分只用來保級（勝 +3／敗 −2，損益兩平 40%），晉級後 20 場保護 */
  'C+3-2': { kind: 'points', name: 'C 保級積分 +3／−2', ...common, win: 3, loss: 2, protectMatches: 20, promotion: 'classic' },
  /** 方案 B（賽季）：維持 100 場＋60% 晉級；職業／傳奇每 100 場一季，季勝率 < 40% 降級，晉級後第一季不降 */
  B40: { kind: 'season', name: 'B 賽季 100 場 <40%', relegateTiers: [3, 4], season: 100, relegateBelow: 0.4, protectFirstSeason: true },
}
