import type { EquipmentId, RelicId } from './items'
import type { PitchTraitId, PitchType } from './pitches'
import type { Potential } from './potential'
import type { TraitId } from './traits'

export type Position = 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF' | 'DH'

export const POSITIONS: readonly Position[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH']

/** 有守備的守位：指定打擊以外的八個 */
export type FieldPosition = Exclude<Position, 'DH'>

export const FIELD_POSITIONS: readonly FieldPosition[] = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF']

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

/** 流派：每名打者固定帶有的打法類型 */
export type Archetype = 'power' | 'speed' | 'skill' | 'defense'

export const ARCHETYPES: readonly Archetype[] = ['power', 'speed', 'skill', 'defense']

/** 擊球方向傾向：偏左外野、平均、偏右外野 */
export type Tendency = 'left' | 'even' | 'right'

/** 慣用手：左、右 */
export type Hand = 'L' | 'R'
/** 打擊：左打、右打、兩打（S，永遠站在有利的一側） */
export type Bats = Hand | 'S'

export interface Batter {
  id: string
  name: string
  role: 'batter'
  ratings: BatterRatings
  traits: TraitId[]
  tendency: Tendency
  bats: Bats
  /** 本職守位：守別的位置時守備打折 */
  primary: FieldPosition
  /** 流派：產生時決定，之後不會因為成長或裝備改變 */
  archetype: Archetype
  /** 錦標賽中帶的裝備，最多 2 件 */
  equipment?: EquipmentId[]
  /** 錦標賽中還沒覺醒的潛能 */
  potential?: Potential
}

export interface Pitcher {
  id: string
  name: string
  role: 'pitcher'
  ratings: PitcherRatings
  traits: TraitId[]
  throws: Hand
  /** 錦標賽中帶的裝備，最多 2 件 */
  equipment?: EquipmentId[]
  /** 錦標賽中還沒覺醒的潛能 */
  potential?: Potential
  /** 錦標賽中學會的新球種，接在原本的球種後面 */
  extraPitches?: PitchType[]
  /** 錦標賽中某些球種帶的球種特性，每個球種最多一個 */
  pitchTraits?: Partial<Record<PitchType, PitchTraitId>>
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
  /** 隊長的球員編號：先發打者中的一人，在自己流派的人數中算兩人；離開先發就清空 */
  captain?: string
}

export interface Team {
  name: string
  roster: Roster
  /** 錦標賽中全隊共用的秘寶；AI 隊伍沒有 */
  relics?: RelicId[]
}
