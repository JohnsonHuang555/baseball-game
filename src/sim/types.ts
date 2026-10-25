import type { TraitId } from './traits'

export type Position = 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF' | 'DH'

export const POSITIONS: readonly Position[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

export interface BatterRatings {
  contact: number
  power: number
  speed: number
  /** 守備：處理擊球時的失誤率、守備範圍、雙殺；捕手還會影響對方盜壘 */
  fielding: number
}

export interface PitcherRatings {
  stuff: number
  control: number
  stamina: number
}

export interface Batter {
  id: string
  name: string
  role: 'batter'
  ratings: BatterRatings
  traits: TraitId[]
}

export interface Pitcher {
  id: string
  name: string
  role: 'pitcher'
  ratings: PitcherRatings
  traits: TraitId[]
}

export type Player = Batter | Pitcher

export interface LineupSpot {
  player: Batter
  position: Position
}

/** 球隊名單：9 名先發打者（含打序）、2 名板凳、1 名先發投手、2 名後援投手 */
export interface Roster {
  lineup: LineupSpot[]
  bench: Batter[]
  starter: Pitcher
  relievers: Pitcher[]
}

export interface Team {
  name: string
  roster: Roster
}
