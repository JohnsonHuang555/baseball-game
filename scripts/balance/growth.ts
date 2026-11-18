// 成長曲線檢查（純計算，不跑比賽）：用正式的 progression.ts 算每一級的能力成長、成本與「碰到上限 10」的情況。
// 球員來自正式的產生器（初始球隊與招募同一個分布），N 個球團種子。
import { overall, generateBatter, generatePitcher, generateRoster } from '../../src/sim/generate'
import { Rng } from '../../src/sim/rng'
import type { Pitcher, Player } from '../../src/sim/types'
import { batterGrowth, growthShare, leveled, pitcherGrowth, upgradeCost } from '../../src/v2/domain/progression'
import { MAX_LEVEL, MAX_RATING, RECRUIT_CONFIG } from '../../src/v2/domain/progressionConfig'

export interface LevelRow {
  level: number
  /** 從上一級升到這一級的成本 */
  cost: { funds: number; experience: number }
  /** 平均整體能力（overall）與比 Lv.1 多多少 */
  overall: number
  gainFromLv1: number
  /** 這一級比上一級多多少整體能力 */
  marginal: number
  /** 每 100 經驗換到的整體能力 */
  per100Exp: number
  /** 有多少比例的球員，這一級的升級「完全沒有提升任何能力」 */
  zeroGainShare: number
  /** 有多少比例的能力值已經在上限 10 */
  cappedShare: number
}

export function growthTable(players: Player[]): LevelRow[] {
  const rows: LevelRow[] = []
  const base = players.reduce((s, p) => s + overall(p), 0) / players.length
  let prev = base
  for (let lv = 1; lv <= MAX_LEVEL; lv++) {
    const at = players.map((p) => leveled(p, lv))
    const ov = at.reduce((s, p) => s + overall(p), 0) / at.length
    const cost = lv === 1 ? { funds: 0, experience: 0 } : upgradeCost(lv - 1)!
    const before = lv === 1 ? at : players.map((p) => leveled(p, lv - 1))
    const zero = lv === 1 ? 0 : at.filter((p, i) => overall(p) - overall(before[i]) < 1e-9).length / at.length
    const values = at.flatMap((p) => Object.values(p.ratings) as number[])
    rows.push({
      level: lv,
      cost,
      overall: ov,
      gainFromLv1: ov - base,
      marginal: ov - prev,
      per100Exp: lv === 1 ? 0 : ((ov - prev) / cost.experience) * 100,
      zeroGainShare: zero,
      cappedShare: values.filter((v) => v >= MAX_RATING - 1e-9).length / values.length,
    })
    prev = ov
  }
  return rows
}

/** N 個球團的初始球員（打者、投手分開）＋同樣數量的招募候選 */
export function samplePlayers(seeds: number[]): { batters: Player[]; pitchers: Player[]; recruitsB: Player[]; recruitsP: Player[] } {
  const batters: Player[] = []
  const pitchers: Player[] = []
  const recruitsB: Player[] = []
  const recruitsP: Player[] = []
  for (const seed of seeds) {
    const r = generateRoster(new Rng(seed))
    batters.push(...r.lineup.map((s) => s.player), ...r.bench)
    pitchers.push(r.starter, ...r.relievers)
    const rng = new Rng(seed ^ 0x5bd1e995)
    for (let i = 0; i < 6; i++) recruitsB.push(generateBatter(rng, RECRUIT_CONFIG.mean))
    for (let i = 0; i < 3; i++) recruitsP.push(generatePitcher(rng, RECRUIT_CONFIG.mean))
  }
  return { batters, pitchers, recruitsB, recruitsP }
}

/** 第一個碰到上限 10 的能力出現在哪一級（每位球員），沒有碰到就是 null */
export function firstCapLevel(p: Player): number | null {
  for (let lv = 1; lv <= MAX_LEVEL; lv++) if ((Object.values(leveled(p, lv).ratings) as number[]).some((v) => v >= MAX_RATING - 1e-9)) return lv
  return null
}

/** Lv.15→20 這段（高等級）的整體能力提升，跟「沒有上限 10 的話」的提升比，看被上限吃掉多少 */
export function lateGain(p: Player): { gain: number; uncapped: number } {
  const a = leveled(p, 15)
  const b = leveled(p, 20)
  const g: Record<string, number> = p.role === 'batter' ? { ...batterGrowth(p) } : { ...pitcherGrowth(p as Pitcher) }
  const keys = Object.keys(g)
  const uncapped = keys.reduce((s, k) => s + g[k] * (growthShare(20) - growthShare(15)), 0) / keys.length
  return { gain: overall(b) - overall(a), uncapped }
}
