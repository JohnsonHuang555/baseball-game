// 配球：球種、九宮格位置、打者熱區，以及 AI 投手每一球投什麼。
// 全部由球員編號或「種子＋第幾步」的雜湊決定，不抽亂數，所以重播結果不變（ADR-0001）
import { hashOf } from './generate'
import { clamp } from './rng'
import type { Batter, Hand, Pitcher } from './types'

export type PitchType = 'fastball' | 'slider' | 'curve' | 'change' | 'splitter'
export const PITCH_TYPES: readonly PitchType[] = ['fastball', 'slider', 'curve', 'change', 'splitter']

/** 打者猜球：猜直球或猜變化球 */
export type PitchGuess = 'fastball' | 'breaking'

/** 打者的熱區：喜歡打的那一塊，正對面就是弱點 */
export type HotZone = 'high' | 'low' | 'in' | 'out'
const OPPOSITE: Record<HotZone, HotZone> = { high: 'low', low: 'high', in: 'out', out: 'in' }

/** 變化球比較容易讓打者揮空 */
export const PITCH_WHIFF: Record<PitchType, number> = { fastball: 0, slider: 0.08, curve: 0.07, change: 0.06, splitter: 0.09 }

/** 0～1 的雜湊值：多攪拌一次，連續的步數才不會出現規律 */
function unit(text: string): number {
  let h = hashOf(text) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 投手的球種：一定有直球，再加 1～3 種變化球；第二個是他的看家球種。錦標賽學會的新球種接在最後面 */
export function repertoire(p: Pitcher): PitchType[] {
  const pool: PitchType[] = ['slider', 'curve', 'change', 'splitter']
  const count = 1 + Math.floor(unit(p.id + '#pitches') * 3)
  const picked: PitchType[] = ['fastball']
  for (let i = 0; i < count; i++) picked.push(pool.splice(Math.floor(unit(`${p.id}#pitch${i}`) * pool.length), 1)[0])
  for (const extra of p.extraPitches ?? []) if (!picked.includes(extra)) picked.push(extra)
  return picked
}

/** 球種特性：銳利（揮空變多）、尾勁（被打中也比較難形成安打）、精準（比較容易進好球帶） */
export type PitchTraitId = 'sharp' | 'heavy' | 'command'
export const PITCH_TRAIT_IDS: readonly PitchTraitId[] = ['sharp', 'heavy', 'command']
/** 球種特性的效果大小 */
export const PITCH_TRAIT_EFFECT = { sharpWhiff: 0.07, heavyHit: 0.025, commandZone: 0.04 }
/** 自動投球時，每多學一種新球種，打者的擊球率就降低這麼多 */
export const EXTRA_PITCH_CONTACT = 0.02

export function pitchTraitOf(p: Pitcher, pitch: PitchType | undefined): PitchTraitId | undefined {
  return pitch ? p.pitchTraits?.[pitch] : undefined
}

export function isBreaking(pitch: PitchType): boolean {
  return pitch !== 'fastball'
}

export function hotZone(b: Batter): HotZone {
  return (['high', 'low', 'in', 'out'] as const)[Math.floor(unit(b.id + '#hot') * 4)]
}

export function coldZone(b: Batter): HotZone {
  return OPPOSITE[hotZone(b)]
}

/** 打者這個打席站哪一邊：兩打站在投手的對側 */
export function stance(b: Batter, pitcher: Pitcher): Hand {
  return b.bats === 'S' ? (pitcher.throws === 'R' ? 'L' : 'R') : b.bats
}

/**
 * 九宮格位置 0～8（從捕手後方看，0 是左上、8 是右下）屬於哪些區塊。
 * 右打者站在左邊，所以左邊那一欄是他的內角
 */
export function spotZones(spot: number, hand: Hand): HotZone[] {
  const row = Math.floor(spot / 3)
  const col = spot % 3
  const zones: HotZone[] = []
  if (row === 0) zones.push('high')
  if (row === 2) zones.push('low')
  if (col !== 1) zones.push((col === 0) === (hand === 'R') ? 'in' : 'out')
  return zones
}

/** 四個角落：最難打，但投偏了就是壞球 */
export function isCorner(spot: number): boolean {
  return spot !== 4 && spot % 2 === 0
}

/** AI 投手這一球投直球的機率：球數落後多投直球搶好球，兩好球後多用變化球 */
export function fastballChance(p: Pitcher, balls: number, strikes: number): number {
  const bias = (unit(p.id + '#mix') - 0.5) * 0.2
  return clamp(0.55 + bias + (balls - strikes) * 0.08 + (balls === 3 ? 0.1 : 0) - (strikes === 2 ? 0.08 : 0), 0.2, 0.85)
}

/** AI 投手第 stepIndex 步投的球種 */
export function aiPitch(seed: number, stepIndex: number, p: Pitcher, balls: number, strikes: number): PitchType {
  const kinds = repertoire(p)
  if (unit(`${seed}:${stepIndex}:pitch`) < fastballChance(p, balls, strikes)) return 'fastball'
  const breaking = kinds.slice(1)
  // 看家球種用得比較多
  const u = unit(`${seed}:${stepIndex}:kind`)
  return u < 0.5 ? breaking[0] : breaking[Math.floor(((u - 0.5) / 0.5) * breaking.length)]
}
