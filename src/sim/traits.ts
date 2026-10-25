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
  | 'ironArm' // 鐵腕
  | 'strikeoutArtist' // 奪三振
  | 'wild' // 四死球

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
  clutchBad: { id: 'clutchBad', tier: 'red', role: 'batter' },
  freeSwinger: { id: 'freeSwinger', tier: 'red', role: 'batter' },
  ironArm: { id: 'ironArm', tier: 'gold', role: 'pitcher' },
  strikeoutArtist: { id: 'strikeoutArtist', tier: 'blue', role: 'pitcher' },
  wild: { id: 'wild', tier: 'red', role: 'pitcher' },
}

/** 不能同時出現在同一名球員身上的特性 */
export const TRAIT_CONFLICTS: readonly (readonly [TraitId, TraitId])[] = [['clutch', 'clutchBad']]

export function hasTrait(player: Player, trait: TraitId): boolean {
  return player.traits.includes(trait)
}

export function conflicts(a: TraitId, b: TraitId): boolean {
  return TRAIT_CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
}
