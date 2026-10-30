// 錦標賽一輪內的道具：裝備（掛在單一球員身上）與秘寶（全隊共用）
import type { CardTier } from './generate'
import type { BatterRatings, Player, PitcherRatings, Roster, Team } from './types'

export type EquipmentId =
  | 'trainingBat' // 練習球棒
  | 'masterBat' // 名匠球棒
  | 'weightedBat' // 加重球棒
  | 'compressedBat' // 壓縮木棒
  | 'legendBat' // 傳說球棒
  | 'spikes' // 釘鞋
  | 'carbonSpikes' // 碳纖釘鞋
  | 'leatherGlove' // 皮革手套
  | 'goldGlove' // 金手套
  | 'gripBag' // 止滑粉袋
  | 'precisionSleeve' // 精準臂套
  | 'elbowGuard' // 加壓護肘
  | 'fireballGlove' // 火球手套
  | 'enduranceBand' // 耐力護腕
  | 'goldenSleeve' // 黃金臂套

export interface EquipmentDef {
  id: EquipmentId
  tier: CardTier
  role: Player['role']
  /** 加在能力值上的數值 */
  bonus: Partial<BatterRatings> | Partial<PitcherRatings>
}

export const EQUIPMENT: Record<EquipmentId, EquipmentDef> = {
  trainingBat: { id: 'trainingBat', tier: 'bronze', role: 'batter', bonus: { contact: 1 } },
  masterBat: { id: 'masterBat', tier: 'silver', role: 'batter', bonus: { contact: 2 } },
  weightedBat: { id: 'weightedBat', tier: 'bronze', role: 'batter', bonus: { power: 1 } },
  compressedBat: { id: 'compressedBat', tier: 'silver', role: 'batter', bonus: { power: 2 } },
  legendBat: { id: 'legendBat', tier: 'rainbow', role: 'batter', bonus: { contact: 2, power: 2 } },
  spikes: { id: 'spikes', tier: 'bronze', role: 'batter', bonus: { speed: 1 } },
  carbonSpikes: { id: 'carbonSpikes', tier: 'silver', role: 'batter', bonus: { speed: 2 } },
  leatherGlove: { id: 'leatherGlove', tier: 'bronze', role: 'batter', bonus: { fielding: 1 } },
  goldGlove: { id: 'goldGlove', tier: 'gold', role: 'batter', bonus: { fielding: 2, contact: 1 } },
  gripBag: { id: 'gripBag', tier: 'bronze', role: 'pitcher', bonus: { control: 1 } },
  precisionSleeve: { id: 'precisionSleeve', tier: 'silver', role: 'pitcher', bonus: { control: 2 } },
  elbowGuard: { id: 'elbowGuard', tier: 'bronze', role: 'pitcher', bonus: { stuff: 1 } },
  fireballGlove: { id: 'fireballGlove', tier: 'silver', role: 'pitcher', bonus: { stuff: 2 } },
  enduranceBand: { id: 'enduranceBand', tier: 'bronze', role: 'pitcher', bonus: { stamina: 2 } },
  goldenSleeve: { id: 'goldenSleeve', tier: 'gold', role: 'pitcher', bonus: { stuff: 2, control: 1 } },
}

/** 每位球員最多帶幾件裝備 */
export const MAX_EQUIPMENT = 2
/** 裝備加上去之後的能力值上限 */
const MAX_RATING = 10

export type RelicId =
  | 'leadoff' // 開路先鋒
  | 'speedster' // 飛毛腿
  | 'deepRelief' // 後援陣容
  | 'stamina' // 耐力訓練
  | 'rispSoul' // 得點圈之魂
  | 'ironWall' // 鐵壁
  | 'comeback' // 逆轉魂
  | 'strikeZone' // 好球帶
  | 'patience' // 選球眼
  | 'powerHouse' // 重砲軍團
  | 'guardian' // 守護神
  | 'dynasty' // 王朝
  | 'powerFactory' // 全壘打工廠
  | 'runSchool' // 跑壘學校
  | 'hitClass' // 打擊教室
  | 'ironCurtain' // 銅牆鐵壁
  | 'captainBand' // 隊長臂章

export interface RelicDef {
  id: RelicId
  tier: CardTier
  /** 有了羈絆之後不再出現的舊秘寶；已經拿到的照舊有效 */
  retired?: boolean
}

export const RELICS: Record<RelicId, RelicDef> = {
  leadoff: { id: 'leadoff', tier: 'bronze' },
  speedster: { id: 'speedster', tier: 'bronze', retired: true },
  deepRelief: { id: 'deepRelief', tier: 'bronze' },
  stamina: { id: 'stamina', tier: 'bronze' },
  rispSoul: { id: 'rispSoul', tier: 'silver' },
  ironWall: { id: 'ironWall', tier: 'silver', retired: true },
  comeback: { id: 'comeback', tier: 'silver' },
  strikeZone: { id: 'strikeZone', tier: 'silver' },
  patience: { id: 'patience', tier: 'silver' },
  powerHouse: { id: 'powerHouse', tier: 'gold', retired: true },
  guardian: { id: 'guardian', tier: 'gold' },
  dynasty: { id: 'dynasty', tier: 'rainbow' },
  powerFactory: { id: 'powerFactory', tier: 'gold' },
  runSchool: { id: 'runSchool', tier: 'gold' },
  hitClass: { id: 'hitClass', tier: 'gold' },
  ironCurtain: { id: 'ironCurtain', tier: 'gold' },
  captainBand: { id: 'captainBand', tier: 'silver' },
}

/** 獎勵、商店、起始秘寶會出現的秘寶 */
export const OFFERED_RELICS = (Object.keys(RELICS) as RelicId[]).filter((id) => !RELICS[id].retired)

export function equipmentOf(p: Player): readonly EquipmentId[] {
  return p.equipment ?? []
}

/** 把裝備的加成加進能力值（不超過上限），比賽用這份；錦標賽裡存的是沒加成的原始能力 */
export function withEquipment<P extends Player>(p: P): P {
  const items = equipmentOf(p)
  if (!items.length) return p
  const ratings = { ...p.ratings } as Record<string, number>
  for (const id of items) {
    for (const [k, v] of Object.entries(EQUIPMENT[id].bonus)) ratings[k] = Math.min(MAX_RATING, ratings[k] + (v as number))
  }
  return { ...p, ratings } as P
}

export function mapRoster(roster: Roster, f: <P extends Player>(p: P) => P): Roster {
  return {
    ...roster,
    lineup: roster.lineup.map((s) => ({ ...s, player: f(s.player) })),
    bench: roster.bench.map(f),
    starter: f(roster.starter),
    relievers: roster.relievers.map(f),
  }
}

/** 上場比賽用的隊伍：每位球員加上裝備的加成 */
export function equippedTeam(team: Team): Team {
  return { ...team, roster: mapRoster(team.roster, withEquipment) }
}
