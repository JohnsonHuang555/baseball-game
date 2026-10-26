import { Rng, clamp } from './rng'
import { TRAITS, conflicts, type TraitId, type TraitTier } from './traits'
import { POSITIONS, type Batter, type Pitcher, type Player, type Roster, type Team, type Tendency } from './types'

const ZH_SURNAMES = ['陳', '林', '黃', '張', '李', '王', '吳', '劉', '蔡', '楊', '許', '鄭', '謝', '郭', '洪', '曾']
const ZH_GIVEN = ['建宏', '志明', '冠宇', '家豪', '承翰', '柏翰', '宗翰', '俊傑', '彥廷', '子軒', '品睿', '哲瑋', '士豪', '信宏', '威廷', '育成']
const JA_SURNAMES = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡邊', '山本', '中村', '小林', '加藤', '山田', '松本', '井上', '木村']
const JA_GIVEN = ['翔太', '大輝', '拓海', '健太', '蓮', '悠斗', '陽翔', '誠', '亮', '隼人', '直樹', '和也']
const EN_FIRST = ['Mike', 'Jake', 'Tyler', 'Ryan', 'Chris', 'Matt', 'Josh', 'Kyle', 'Luis', 'Carlos', 'Derek', 'Sam']
const EN_LAST = ['Johnson', 'Smith', 'Miller', 'Davis', 'Garcia', 'Martinez', 'Brown', 'Wilson', 'Lopez', 'Clark', 'Young', 'Walker']

const CITIES = ['台北', '高雄', '台中', '花蓮', '東京', '大阪', '橫濱', '仙台', '波士頓', '芝加哥', '休士頓', '西雅圖']
const MASCOTS = ['猛虎', '飛鷹', '雷霆', '海盜', '雄獅', '金龍', '藍鯨', '火焰', '鐵騎', '狂鯊', '白狼', '流星']

export type CardTier = 'bronze' | 'silver' | 'gold' | 'rainbow'

/** 能力值分布的中心。AI 隊伍的難度就是把中心往上移 */
export const BASE_MEAN = 5

function rating(rng: Rng, mean: number): number {
  return clamp(Math.round(rng.normal(mean, 1.6)), 1, 10)
}

function playerName(rng: Rng): string {
  switch (rng.int(0, 2)) {
    case 0:
      return rng.pick(ZH_SURNAMES) + rng.pick(ZH_GIVEN)
    case 1:
      return rng.pick(JA_SURNAMES) + rng.pick(JA_GIVEN)
    default:
      return `${rng.pick(EN_FIRST)} ${rng.pick(EN_LAST)}`
  }
}

function playerId(rng: Rng): string {
  return 'p' + rng.int(0, 2 ** 31 - 1).toString(36) + rng.int(0, 2 ** 31 - 1).toString(36)
}

function traits(rng: Rng, role: Player['role']): TraitId[] {
  const ofTier = (tier: TraitTier) =>
    Object.values(TRAITS)
      .filter((t) => t.role === role && t.tier === tier)
      .map((t) => t.id)
  const result: TraitId[] = []
  const add = (id: TraitId) => {
    if (!result.includes(id) && !result.some((t) => conflicts(t, id))) result.push(id)
  }
  if (rng.chance(0.03)) add(rng.pick(ofTier('gold')))
  if (rng.chance(0.35)) add(rng.pick(ofTier('blue')))
  if (rng.chance(0.1)) add(rng.pick(ofTier('blue')))
  if (rng.chance(0.2)) add(rng.pick(ofTier('red')))
  return result
}

export function generateBatter(rng: Rng, mean = BASE_MEAN): Batter {
  const id = playerId(rng)
  return {
    id,
    name: playerName(rng),
    role: 'batter',
    ratings: {
      contact: rating(rng, mean),
      power: rating(rng, mean),
      speed: rating(rng, mean),
      fielding: rating(rng, mean),
    },
    traits: traits(rng, 'batter'),
    tendency: tendencyFor(id),
  }
}

/**
 * 擊球方向傾向由球員編號決定：偏左、偏右各三成，平均四成。
 * 不多抽亂數，同一個種子產生的隊伍跟以前一模一樣
 */
function tendencyFor(id: string): Tendency {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  const r = Math.abs(h) % 10
  return r < 3 ? 'left' : r < 6 ? 'right' : 'even'
}

export function generatePitcher(rng: Rng, mean = BASE_MEAN): Pitcher {
  return {
    id: playerId(rng),
    name: playerName(rng),
    role: 'pitcher',
    ratings: { stuff: rating(rng, mean), control: rating(rng, mean), stamina: rating(rng, mean) },
    traits: traits(rng, 'pitcher'),
  }
}

/** 打擊能力強的排前面 */
function battingOrderScore(b: Batter): number {
  return b.ratings.contact * 2 + b.ratings.power + b.ratings.speed * 0.5
}

export function generateRoster(rng: Rng, mean = BASE_MEAN): Roster {
  const lineup = POSITIONS.map((position) => ({ position, player: generateBatter(rng, mean) }))
  lineup.sort((a, b) => battingOrderScore(b.player) - battingOrderScore(a.player))
  return {
    lineup,
    bench: [generateBatter(rng, mean), generateBatter(rng, mean)],
    starter: generatePitcher(rng, mean),
    relievers: [generatePitcher(rng, mean), generatePitcher(rng, mean)],
  }
}

export function teamName(rng: Rng): string {
  return rng.pick(CITIES) + rng.pick(MASCOTS)
}

export function generateTeam(rng: Rng, mean = BASE_MEAN): Team {
  return { name: teamName(rng), roster: generateRoster(rng, mean) }
}

export function allPlayers(roster: Roster): Player[] {
  return [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]
}

export function teamAverage(roster: Roster): number {
  const players = allPlayers(roster)
  return players.reduce((sum, p) => sum + overall(p), 0) / players.length
}

export function overall(p: Player): number {
  const values: number[] = Object.values(p.ratings)
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** 卡色對齊字母等級：彩虹＝A 以上、金＝B、銀＝D～C、銅＝E 以下 */
export function cardTier(p: Player): CardTier {
  const o = overall(p)
  if (o >= 7.5) return 'rainbow'
  if (o >= 6.5) return 'gold'
  if (o >= 4.5) return 'silver'
  return 'bronze'
}

/** 抽到時要播放特殊動畫的球員：彩虹卡或帶金特 */
export function isSpecial(p: Player): boolean {
  return cardTier(p) === 'rainbow' || p.traits.some((t) => TRAITS[t].tier === 'gold')
}
