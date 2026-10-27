// 潛能與覺醒：部分球員帶著顯示為「？」的潛在特性，這一輪累積到條件就覺醒成真正的特性
import type { PlayerLine } from './game'
import { Rng } from './rng'
import { TRAITS, conflicts, type TraitId } from './traits'
import type { Player } from './types'

/** 累積的是比賽紀錄裡的哪一欄：安打、全壘打、打點、三振（投手）、抓到的出局數 */
export type PotentialStat = 'hits' | 'hr' | 'rbi' | 'k' | 'outs'

export interface Potential {
  trait: TraitId
  stat: PotentialStat
  need: number
  progress: number
}

/** 每種潛能的覺醒條件；條件跟特性的意思接得起來 */
const POTENTIALS: readonly Omit<Potential, 'progress'>[] = [
  { trait: 'slugger', stat: 'hr', need: 4 },
  { trait: 'clutch', stat: 'rbi', need: 7 },
  { trait: 'lineDrive', stat: 'hits', need: 9 },
  { trait: 'eye', stat: 'hits', need: 7 },
  { trait: 'baserunner', stat: 'hits', need: 6 },
  { trait: 'strikeoutArtist', stat: 'k', need: 18 },
  { trait: 'ironArm', stat: 'outs', need: 60 },
  { trait: 'groundballer', stat: 'outs', need: 36 },
  { trait: 'escapeArtist', stat: 'k', need: 12 },
]

/** 這位球員可以帶的潛能：角色要對，還沒有這個特性，也不跟現有特性互斥 */
function candidates(p: Player): Omit<Potential, 'progress'>[] {
  return POTENTIALS.filter((x) => TRAITS[x.trait].role === p.role && !p.traits.includes(x.trait) && !p.traits.some((t) => conflicts(t, x.trait)))
}

/** 隨機給一個潛能；沒有合適的就原樣回傳 */
export function withPotential<P extends Player>(rng: Rng, p: P): P {
  const pool = candidates(p)
  if (!pool.length) return p
  return { ...p, potential: { ...rng.pick(pool), progress: 0 } }
}

/** 這場比賽累積的數字 */
export function statOf(line: PlayerLine | undefined, stat: PotentialStat): number {
  return line ? line[stat] : 0
}

/** 訓練推進潛能：一次推進四分之一（至少 1） */
export function trainingBoost(p: Potential): number {
  return Math.max(1, Math.ceil(p.need / 4))
}

/**
 * 把進度加上去；達成就覺醒：潛能變成特性（取代互斥的特性），潛能清掉。
 * 回傳更新後的球員，以及有沒有覺醒
 */
export function advancePotential<P extends Player>(p: P, amount: number): { player: P; awakened: TraitId | null } {
  const pot = p.potential
  if (!pot || amount <= 0) return { player: p, awakened: null }
  const progress = pot.progress + amount
  if (progress < pot.need) return { player: { ...p, potential: { ...pot, progress } }, awakened: null }
  const traits = [...p.traits.filter((t) => !conflicts(t, pot.trait)), pot.trait]
  const { potential: _done, ...rest } = p
  return { player: { ...rest, traits } as P, awakened: pot.trait }
}

/** 還差多少才覺醒 */
export function remaining(p: Potential): number {
  return Math.max(0, p.need - p.progress)
}
