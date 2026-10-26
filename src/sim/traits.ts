import type { Player } from './types'

export type TraitTier = 'gold' | 'blue' | 'red'

export type TraitId =
  | 'slugger' // 怪力
  | 'clutch' // 得點圈強打
  | 'eye' // 選球眼
  | 'stealer' // 盜壘○
  | 'bunter' // 觸擊○
  | 'clutchBad' // 得點圈×
  | 'freeSwinger' // 扇風機
  | 'goodGlove' // 好手套
  | 'lineDrive' // 平飛打者
  | 'baserunner' // 跑壘○
  | 'errorProne' // 守備不穩
  | 'ironArm' // 鐵腕
  | 'closer' // 終結者
  | 'strikeoutArtist' // 奪三振
  | 'groundballer' // 滾地球投手
  | 'escapeArtist' // 危機處理
  | 'wild' // 四死球
  | 'homerProne' // 被全壘打
  | 'lowStamina' // 體力差

export interface TraitDef {
  id: TraitId
  tier: TraitTier
  role: Player['role']
}

export const TRAITS: Record<TraitId, TraitDef> = {
  slugger: { id: 'slugger', tier: 'gold', role: 'batter' },
  clutch: { id: 'clutch', tier: 'blue', role: 'batter' },
  eye: { id: 'eye', tier: 'blue', role: 'batter' },
  stealer: { id: 'stealer', tier: 'blue', role: 'batter' },
  bunter: { id: 'bunter', tier: 'blue', role: 'batter' },
  goodGlove: { id: 'goodGlove', tier: 'blue', role: 'batter' },
  lineDrive: { id: 'lineDrive', tier: 'blue', role: 'batter' },
  baserunner: { id: 'baserunner', tier: 'blue', role: 'batter' },
  clutchBad: { id: 'clutchBad', tier: 'red', role: 'batter' },
  freeSwinger: { id: 'freeSwinger', tier: 'red', role: 'batter' },
  errorProne: { id: 'errorProne', tier: 'red', role: 'batter' },
  ironArm: { id: 'ironArm', tier: 'gold', role: 'pitcher' },
  closer: { id: 'closer', tier: 'gold', role: 'pitcher' },
  strikeoutArtist: { id: 'strikeoutArtist', tier: 'blue', role: 'pitcher' },
  groundballer: { id: 'groundballer', tier: 'blue', role: 'pitcher' },
  escapeArtist: { id: 'escapeArtist', tier: 'blue', role: 'pitcher' },
  wild: { id: 'wild', tier: 'red', role: 'pitcher' },
  homerProne: { id: 'homerProne', tier: 'red', role: 'pitcher' },
  lowStamina: { id: 'lowStamina', tier: 'red', role: 'pitcher' },
}

/** 不能同時出現在同一名球員身上的特性 */
export const TRAIT_CONFLICTS: readonly (readonly [TraitId, TraitId])[] = [
  ['clutch', 'clutchBad'],
  ['goodGlove', 'errorProne'],
  ['ironArm', 'lowStamina'],
  ['groundballer', 'homerProne'],
]

export function hasTrait(player: Player, trait: TraitId): boolean {
  return player.traits.includes(trait)
}

export function conflicts(a: TraitId, b: TraitId): boolean {
  return TRAIT_CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
}
