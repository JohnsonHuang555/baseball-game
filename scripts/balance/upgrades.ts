// 升級效益的對照實驗：同一個球團種子、同一批比賽（場次序號、種子、對手完全相同）、同樣的戰術與陣容配置，
// 只改球員等級。比賽用正式的 planMatches + runBatch（MatchRunner），所以差異只來自養成後的能力。
// 每種配置花「同樣多的經驗」（資金固定是經驗的 8 倍，不是限制），比較平均養成、集中打者、集中投手、打投各半、集中主力。
import { leagueAtTier } from '../../src/v2/domain/league'
import { overall } from '../../src/sim/generate'
import { planMatches, runBatch } from '../../src/v2/application/batchRunner'
import type { ClubSave } from '../../src/v2/domain/club'
import { totalUpgradeCost, upgradeCost } from '../../src/v2/domain/progression'
import { MAX_LEVEL } from '../../src/v2/domain/progressionConfig'
import { resolveRoster } from '../../src/v2/domain/roster'
import { ClubRepository, MemoryStorage } from '../../src/v2/infrastructure/clubRepository'
import { T0 } from '../../src/v2/testkit'
import { batterScore } from './simulate'

export const VARIANTS = ['even', 'batters', 'pitchers', 'balanced', 'core'] as const
export type Variant = (typeof VARIANTS)[number] | 'base'
export const VARIANT_NAMES: Record<Variant, string> = {
  base: '未升級',
  even: '平均升級（14 人）',
  batters: '集中打者（9 位先發）',
  pitchers: '集中投手（先發＋後援 3 人）',
  balanced: '打投各半',
  core: '集中主力（4 打者＋先發投手）',
}

export function baseClub(seed: number, tier: number): ClubSave {
  const club = new ClubRepository(new MemoryStorage()).createClub({ clubName: '對照', clubSeed: seed, clubId: `up-${seed}`, now: T0 })
  return { ...club, league: leagueAtTier(club.league, tier) }
}

/** 在 pool 裡的球員之間，從等級最低的開始升級，直到花完 budget 經驗（下一級付不起就停） */
function spend(club: ClubSave, pool: string[], budget: number): number {
  let left = budget
  for (let guard = 0; guard < 2000; guard++) {
    const target = club.players.filter((r) => pool.includes(r.player.id) && r.level < MAX_LEVEL).sort((a, b) => a.level - b.level)[0]
    const cost = target && upgradeCost(target.level)
    if (!target || !cost || cost.experience > left) break
    target.level++
    left -= cost.experience
  }
  return budget - left
}

export function variantClub(seed: number, tier: number, v: Variant, budget: number): { club: ClubSave; spent: number } {
  const club = structuredClone(baseClub(seed, tier))
  const r = resolveRoster(club)
  const lineup = r.lineup.map((s) => s.player.id)
  const pitchers = [r.starter.id, ...r.relievers.map((p) => p.id)]
  const all = [...lineup, ...r.bench.map((p) => p.id), ...pitchers]
  const core = [...r.lineup.map((s) => s.player).sort((a, b) => batterScore(b) - batterScore(a)).slice(0, 4).map((p) => p.id), r.starter.id]
  let spent = 0
  if (v === 'even') spent = spend(club, all, budget)
  if (v === 'batters') spent = spend(club, lineup, budget)
  if (v === 'pitchers') spent = spend(club, pitchers, budget)
  if (v === 'core') spent = spend(club, core, budget)
  if (v === 'balanced') spent = spend(club, lineup, budget / 2) + spend(club, pitchers, budget / 2)
  return { club, spent }
}

export interface VariantStat {
  winRate: number
  runsFor: number
  runsAgainst: number
  power: number
  lineupContactPower: number
  pitcherStuffControl: number
  spent: number
}

export async function measure(seed: number, tier: number, v: Variant, budget: number, matches: number, from = 0): Promise<VariantStat> {
  const { club, spent } = variantClub(seed, tier, v, budget)
  const run = await runBatch(planMatches(club, from, matches), { yieldControl: null })
  const s = run.summary
  const r = resolveRoster(club)
  const team = [...r.lineup.map((x) => x.player), ...r.bench, r.starter, ...r.relievers]
  const lineup = r.lineup.map((x) => x.player)
  const pitchers = [r.starter, ...r.relievers]
  return {
    winRate: s.wins / s.completed,
    runsFor: s.runsFor / s.completed,
    runsAgainst: s.runsAgainst / s.completed,
    power: team.reduce((a, p) => a + overall(p), 0) / team.length,
    lineupContactPower: lineup.reduce((a, p) => a + (p.ratings.contact + p.ratings.power) / 2, 0) / lineup.length,
    pitcherStuffControl: pitchers.reduce((a, p) => a + (p.ratings.stuff + p.ratings.control) / 2, 0) / pitchers.length,
    spent,
  }
}

/** 「14 人都升到 Lv.L」需要的經驗：用來定義同樣的預算 */
export const budgetForEven = (level: number) => totalUpgradeCost(1, level).experience * 14
