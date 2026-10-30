// 流派羈絆：先發 9 人中同流派的人數達到門檻就啟動；隊長在自己流派算兩人
import type { RelicId } from './items'
import { ARCHETYPES, type Archetype, type LineupSpot } from './types'

/** 0：未啟動；1：3 人階；2：5 人階 */
export type SynergyTier = 0 | 1 | 2

/** 六個羈絆：四個流派羈絆加上兩個守位羈絆（黃金二遊、投捕搭檔） */
export type SynergyKey = Archetype | 'middle' | 'battery'

export const SYNERGY_KEYS: readonly SynergyKey[] = [...ARCHETYPES, 'middle', 'battery']

/** 守位羈絆：黃金二遊要二壘手和游擊手都守本職；投捕搭檔要捕手守本職 */
export function positionSynergies(lineup: readonly LineupSpot[]): { middle: boolean; battery: boolean } {
  const at = (pos: LineupSpot['position']) => lineup.find((s) => s.position === pos)?.player
  const native = (pos: 'C' | '2B' | 'SS') => at(pos)?.primary === pos
  return { middle: native('2B') && native('SS'), battery: native('C') }
}

/** 每個流派各自的「門檻 −1」秘寶 */
export const THRESHOLD_RELICS: Record<Archetype, RelicId> = {
  power: 'powerFactory',
  speed: 'runSchool',
  skill: 'hitClass',
  defense: 'ironCurtain',
}

/** 兩階的門檻；有對應的秘寶就各少 1 人 */
export function thresholds(archetype: Archetype, relics: readonly RelicId[]): [number, number] {
  return relics.includes(THRESHOLD_RELICS[archetype]) ? [2, 4] : [3, 5]
}

/** 隊長在自己流派算幾人：平常 2 人，有隊長臂章 3 人 */
export function captainWeight(relics: readonly RelicId[]): number {
  return relics.includes('captainBand') ? 3 : 2
}

/** 先發陣容裡各流派的人數；隊長不在先發就不算 */
export function archetypeCounts(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): Record<Archetype, number> {
  const counts: Record<Archetype, number> = { power: 0, speed: 0, skill: 0, defense: 0 }
  for (const { player } of lineup) counts[player.archetype] += player.id === captain ? captainWeight(relics) : 1
  return counts
}

export function tierOf(count: number, archetype: Archetype, relics: readonly RelicId[]): SynergyTier {
  const [low, high] = thresholds(archetype, relics)
  return count >= high ? 2 : count >= low ? 1 : 0
}

/** 每個流派目前的階級 */
export function synergyTiers(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): Record<Archetype, SynergyTier> {
  const counts = archetypeCounts(lineup, captain, relics)
  const tiers = {} as Record<Archetype, SynergyTier>
  for (const a of ARCHETYPES) tiers[a] = tierOf(counts[a], a, relics)
  return tiers
}

/** 隊長只能是先發打者；不在先發就當作沒有隊長 */
export function captainIn(lineup: readonly LineupSpot[], captain: string | null | undefined): string | null {
  return captain && lineup.some((s) => s.player.id === captain) ? captain : null
}

/** 系統挑的隊長：讓啟動的羈絆階級加起來最多的人，平手時選總評最高的 */
export function defaultCaptain(lineup: readonly LineupSpot[], relics: readonly RelicId[]): string {
  const score = (id: string) => Object.values(synergyTiers(lineup, id, relics)).reduce<number>((a, b) => a + b, 0)
  // 打者都是四項能力，比總和跟比總評（平均）一樣；這裡自己算，避免跟產生球員的模組互相引用
  const ovr = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
  const ranked = lineup.map((s) => ({ id: s.player.id, score: score(s.player.id), ovr: ovr({ ...s.player.ratings }) }))
  ranked.sort((a, b) => b.score - a.score || b.ovr - a.ovr)
  return ranked[0].id
}
