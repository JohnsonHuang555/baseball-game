// 推薦戰術（Phase 9 PR 2）：看目前「上場」的陣容（先發 9 人、先發投手、牛棚；不含板凳與預備名單），
// 算出三個傾向分數，明顯突出的那一項就推薦對應的風格，都不突出就推薦均衡型。
// 純函式、確定性：同一份陣容永遠得到同一個建議；不改玩家的選擇，只是提示。
import type { TraitId } from '../../sim/traits'
import type { Batter, Pitcher, Roster } from '../../sim/types'
import type { CoachStyle } from '../application/autoCoach'

/**
 * 一般球隊的傾向分數（中位數）與離散程度：用引擎的 generateTeam 產生 1,000 支隨機球隊量出來的（平均能力 4.2～6.6 都差不多）。
 * 速度傾向本身就偏高（隨機球隊的速度通常比其他能力高、盜壘特性也多），所以要先扣掉一般球隊的水準再比
 */
export const ADVICE_BASELINE = { power: 0, speed: 0.48, pitching: -0.07 } as const
export const ADVICE_SPREAD = { power: 0.42, speed: 0.45, pitching: 0.82 } as const
/** 比一般球隊高出這麼多個標準差才推薦專門的風格：每一項大約只有前 10% 的球隊會被推薦，其他都推薦均衡型 */
export const ADVICE_THRESHOLD = 1.3

export interface TacticsAdvice {
  style: CoachStyle
  /** 推薦的理由：哪一項最突出（均衡型是 null） */
  reason: 'power' | 'speed' | 'pitching' | null
  /** 分數的來源（畫面拿來說明） */
  facts: {
    /** 先發打者的平均打擊、長打、速度、守備 */
    contact: number
    power: number
    speed: number
    fielding: number
    /** 打者四項能力的平均 */
    batting: number
    /** 投手陣容（先發算兩人份）的平均球威＋控球 ÷ 2 */
    pitching: number
    /** 牛棚人數 */
    bullpen: number
  }
  /** 三個傾向分數（越大越適合那個風格） */
  edges: { power: number; speed: number; pitching: number }
  /** 跟一般球隊比，高出幾個標準差（≥ ADVICE_THRESHOLD 才推薦） */
  z: { power: number; speed: number; pitching: number }
}

const count = (players: readonly (Batter | Pitcher)[], ids: readonly TraitId[]) => players.reduce((n, p) => n + p.traits.filter((t) => ids.includes(t)).length, 0)
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * 公式（能力 1～10）：
 * - 長打傾向 = 平均長打 − 打者四項平均 ＋ 0.25 × 強打者特性 − 0.15 × 亂揮特性
 * - 速度傾向 = 平均速度 − 打者四項平均 ＋ 0.2 ×（盜壘、跑壘特性）＋ 0.1 × 觸擊特性
 * - 投手傾向 = 投手陣容平均 −（平均打擊＋平均長打）÷ 2 ＋ 0.25 × 終結者 ＋ 0.15 × 鐵臂
 *            − 0.15 ×（控球不穩、易被轟、體力差）＋ 0.2 ×（平均守備 − 打者四項平均）＋ 0.1（牛棚 4 人以上）
 * 每一項換算成「比一般球隊高幾個標準差」：z =（傾向 − ADVICE_BASELINE）÷ ADVICE_SPREAD。
 * 最高的 z ≥ ADVICE_THRESHOLD 就推薦對應風格（強攻、機動、守備）；同分依長打、速度、投手的順序；都不夠就是均衡型
 */
export function recommendStyle(roster: Roster): TacticsAdvice {
  const bats = roster.lineup.map((s) => s.player)
  const pitchers = [roster.starter, ...roster.relievers]
  const contact = avg(bats.map((b) => b.ratings.contact))
  const power = avg(bats.map((b) => b.ratings.power))
  const speed = avg(bats.map((b) => b.ratings.speed))
  const fielding = avg(bats.map((b) => b.ratings.fielding))
  const batting = (contact + power + speed + fielding) / 4
  const staff = [roster.starter, ...pitchers].map((p) => (p.ratings.stuff + p.ratings.control) / 2)
  const pitching = avg(staff)
  const edges = {
    power: power - batting + 0.25 * count(bats, ['slugger']) - 0.15 * count(bats, ['freeSwinger']),
    speed: speed - batting + 0.2 * count(bats, ['stealer', 'baserunner']) + 0.1 * count(bats, ['bunter']),
    pitching:
      pitching -
      (contact + power) / 2 +
      0.25 * count(pitchers, ['closer']) +
      0.15 * count(pitchers, ['ironArm']) -
      0.15 * count(pitchers, ['wild', 'homerProne', 'lowStamina']) +
      0.2 * (fielding - batting) +
      (roster.relievers.length >= 4 ? 0.1 : 0),
  }
  const order = ['power', 'speed', 'pitching'] as const
  const z = { power: 0, speed: 0, pitching: 0 }
  for (const k of order) z[k] = (edges[k] - ADVICE_BASELINE[k]) / ADVICE_SPREAD[k]
  const top = order.reduce((best, k) => (z[k] > z[best] ? k : best), order[0])
  const pick = z[top] >= ADVICE_THRESHOLD ? top : null
  const style: CoachStyle = pick === 'power' ? 'power' : pick === 'speed' ? 'speed' : pick === 'pitching' ? 'defense' : 'balanced'
  return {
    style,
    reason: pick,
    facts: { contact: round2(contact), power: round2(power), speed: round2(speed), fielding: round2(fielding), batting: round2(batting), pitching: round2(pitching), bullpen: roster.relievers.length },
    edges: { power: round2(edges.power), speed: round2(edges.speed), pitching: round2(edges.pitching) },
    z: { power: round2(z.power), speed: round2(z.speed), pitching: round2(z.pitching) },
  }
}
