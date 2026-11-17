// 球員養成：等級 → 能力成長 → 比賽實際使用的能力。
// 存檔只存原始能力（Lv.1）與等級；養成後的能力每次由這裡算出來（確定性），不另外存一份，
// 所以畫面顯示、比賽模擬用的永遠是同一個數字
import { ARCHETYPE_STAT } from '../../sim/generate'
import type { Batter, BatterRatings, Pitcher, PitcherRatings, Player } from '../../sim/types'
import type { Resources } from './club'
import { GROWTH, MAX_LEVEL, MAX_RATING, UPGRADE_COST } from './progressionConfig'

export { MAX_LEVEL }

/** 0～1：這個等級拿到總成長的幾成。前面成長快、後面遞減，Lv.1 是 0、Lv.20 是 1 */
export function growthShare(level: number): number {
  checkLevel(level)
  return ((level - 1) / (MAX_LEVEL - 1)) ** GROWTH.curve
}

/** 能力值四捨五入到小數兩位，避免浮點誤差讓畫面和存檔對不起來 */
const round2 = (x: number) => Math.round(x * 100) / 100

/** 打者各項能力在 Lv.20 的總成長：流派那一項最多，其他三項依原始能力高低（高的多） */
export function batterGrowth(b: Batter): BatterRatings {
  const primary = ARCHETYPE_STAT[b.archetype]
  const order: (keyof BatterRatings)[] = ['contact', 'power', 'speed', 'fielding']
  const others = order.filter((k) => k !== primary).sort((x, y) => b.ratings[y] - b.ratings[x] || order.indexOf(x) - order.indexOf(y))
  const growth = { contact: 0, power: 0, speed: 0, fielding: 0 }
  growth[primary] = GROWTH.batterPrimary
  others.forEach((k, i) => (growth[k] = GROWTH.batterOthers[i]))
  return growth
}

/** 投手各項能力在 Lv.20 的總成長：球威、控球較高的那項最多（平手算球威），耐力最少 */
export function pitcherGrowth(p: Pitcher): PitcherRatings {
  const stuffFirst = p.ratings.stuff >= p.ratings.control
  return {
    stuff: stuffFirst ? GROWTH.pitcherPrimary : GROWTH.pitcherSecondary,
    control: stuffFirst ? GROWTH.pitcherSecondary : GROWTH.pitcherPrimary,
    stamina: GROWTH.pitcherStamina,
  }
}

/** 某個等級的養成後球員（比賽實際用的能力）。原始能力 + 成長，不超過上限 10；其他資料完全不變 */
export function leveled<P extends Player>(base: P, level: number): P {
  const share = growthShare(level)
  if (share === 0) return base
  const growth: Record<string, number> = base.role === 'batter' ? { ...batterGrowth(base) } : { ...pitcherGrowth(base as Pitcher) }
  const ratings: Record<string, number> = {}
  for (const [k, v] of Object.entries(base.ratings)) ratings[k] = Math.min(MAX_RATING, round2(v + growth[k] * share))
  return { ...base, ratings } as P
}

/** 從 level 升到 level + 1 的成本；已經滿級回傳 null */
export function upgradeCost(level: number): Resources | null {
  checkLevel(level)
  if (level >= MAX_LEVEL) return null
  const experience = Math.round((UPGRADE_COST.expBase * level ** UPGRADE_COST.expPower) / 5) * 5
  return { funds: experience * UPGRADE_COST.fundsPerExp, experience }
}

/** 從 from 升到 to 的累計成本（平衡模擬、畫面說明用） */
export function totalUpgradeCost(from: number, to: number): Resources {
  const total = { funds: 0, experience: 0 }
  for (let l = from; l < to; l++) {
    const c = upgradeCost(l)!
    total.funds += c.funds
    total.experience += c.experience
  }
  return total
}

export function checkLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) throw new RangeError(`等級不合法：${level}`)
}
