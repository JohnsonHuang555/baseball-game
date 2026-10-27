// 錦標賽中的成長：每場比賽後，表現好的球員能力小幅提升
import type { Game, PlayerLine, Side } from './game'
import { allPlayers } from './generate'
import type { BatterRatings, Player, PitcherRatings, Roster } from './types'

export interface Growth {
  playerId: string
  rating: keyof BatterRatings | keyof PitcherRatings
  /** 提升幅度：MVP +1，其他表現好的 +0.5；不會超過上限 10 */
  amount: number
  mvp: boolean
}

/** MVP 的門檻：表現分至少要這麼多才選 */
const MVP_MIN = 2
/** 其他人成長的門檻 */
const GROWTH_MIN = 2
const MAX_RATING = 10

/**
 * 表現分。打者：安打 1、全壘打再加 2、打點 0.5。
 * 投手：每局（三個出局）1、三振 0.3、每失一分 −1.5
 */
export function performance(player: Player, line: PlayerLine): number {
  if (player.role === 'batter') return line.hits + line.hr * 2 + line.rbi * 0.5
  return line.outs / 3 + line.k * 0.3 - line.runs * 1.5
}

/** 這場表現最該成長的能力：打者有全壘打長力量、否則長打擊；投手每局至少一次三振長球威，否則投很久長體力、再不然長控球 */
function ratingFor(player: Player, line: PlayerLine): Growth['rating'] {
  if (player.role === 'batter') return line.hr > 0 ? 'power' : 'contact'
  if (line.k * 3 >= line.outs) return 'stuff'
  return line.outs >= 21 ? 'stamina' : 'control'
}

/**
 * 某一隊這場比賽的成長名單：MVP 一位 +1，其他達標的 +0.5。
 * 比賽裡的能力含裝備加成，給了 base（沒加成的名單）就照原始能力算離上限還有多少
 */
export function gameGrowth(game: Game, side: Side, base?: Roster): Growth[] {
  const baseRatings = new Map((base ? allPlayers(base) : []).map((p) => [p.id, p.ratings as unknown as Record<string, number>]))
  // 開賽時名單上的全部球員，換下場的人成績也算
  const players = [...game.rosterIds(side)].map((id) => game.player(id)!)
  const scored = players
    .filter((p) => game.box[p.id])
    .map((p) => ({ p, line: game.box[p.id], score: performance(p, game.box[p.id]) }))
    .sort((a, b) => b.score - a.score)
  const growth: Growth[] = []
  scored.forEach(({ p, line, score }, i) => {
    const mvp = i === 0 && score >= MVP_MIN
    if (!mvp && score < GROWTH_MIN) return
    const rating = ratingFor(p, line)
    const current = (baseRatings.get(p.id) ?? (p.ratings as unknown as Record<string, number>))[rating]
    const amount = Math.min(mvp ? 1 : 0.5, MAX_RATING - current)
    if (amount > 0) growth.push({ playerId: p.id, rating, amount, mvp })
  })
  return growth
}

/** 把成長套用到陣容上（回傳新的陣容，不改原本的） */
export function applyGrowth(roster: Roster, growth: readonly Growth[]): Roster {
  const grow = <P extends Player>(p: P): P => {
    const g = growth.find((x) => x.playerId === p.id)
    if (!g) return p
    const ratings = { ...p.ratings } as Record<string, number>
    ratings[g.rating] = Math.min(MAX_RATING, ratings[g.rating] + g.amount)
    return { ...p, ratings } as P
  }
  return {
    lineup: roster.lineup.map((s) => ({ ...s, player: grow(s.player) })),
    bench: roster.bench.map(grow),
    starter: grow(roster.starter),
    relievers: roster.relievers.map(grow),
  }
}
