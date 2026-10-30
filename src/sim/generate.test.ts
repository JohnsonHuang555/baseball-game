import { describe, expect, it } from 'vitest'
import { cardTier, generateBatter, generateRoster, generateTeam, overall } from './generate'
import { Rng } from './rng'
import { TRAITS, conflicts } from './traits'
import type { Player } from './types'

function allPlayers(seedCount: number): Player[] {
  const players: Player[] = []
  for (let seed = 1; seed <= seedCount; seed++) {
    const r = generateRoster(new Rng(seed))
    players.push(...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers)
  }
  return players
}

describe('generateRoster', () => {
  it('產生 9 先發、2 板凳、1 先發投手、2 後援投手，守備位置不重複', () => {
    const r = generateRoster(new Rng(42))
    expect(r.lineup).toHaveLength(9)
    expect(r.bench).toHaveLength(2)
    expect(r.relievers).toHaveLength(2)
    expect(new Set(r.lineup.map((s) => s.position)).size).toBe(9)
    expect(r.starter.role).toBe('pitcher')
  })

  it('開局的八個守位都由本職擔任', () => {
    for (let seed = 1; seed <= 50; seed++) {
      for (const s of generateRoster(new Rng(seed)).lineup) if (s.position !== 'DH') expect(s.player.primary).toBe(s.position)
    }
  })

  it('同一個種子產生同一支隊伍', () => {
    expect(generateTeam(new Rng(7))).toEqual(generateTeam(new Rng(7)))
  })

  it('球員 id 在大量產生時不重複', () => {
    const ids = allPlayers(200).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('本職守位', () => {
  it('隨機球員的本職涵蓋八個守位，本職捕手比較少見', () => {
    const rng = new Rng(3)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 4000; i++) {
      const p = generateBatter(rng).primary
      counts[p] = (counts[p] ?? 0) + 1
    }
    expect(Object.keys(counts)).toHaveLength(8)
    expect(counts.C / 4000).toBeLessThan(0.1)
    expect(counts.SS / 4000).toBeGreaterThan(0.1)
  })
})

describe('能力值與特性', () => {
  const players = allPlayers(500)
  const ratings = players.flatMap((p) => Object.values(p.ratings))

  it('能力值都在 1～10，且呈鐘形分布（平均約 5，10 分很少見）', () => {
    expect(Math.min(...ratings)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...ratings)).toBeLessThanOrEqual(10)
    const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length
    expect(mean).toBeGreaterThan(4.7)
    expect(mean).toBeLessThan(5.3)
    const tens = ratings.filter((r) => r === 10).length / ratings.length
    expect(tens).toBeLessThan(0.02)
  })

  it('特性符合球員角色，且不會有互相衝突的特性', () => {
    for (const p of players) {
      for (const t of p.traits) expect(TRAITS[t].role).toBe(p.role)
      for (const a of p.traits) for (const b of p.traits) if (a !== b) expect(conflicts(a, b)).toBe(false)
      expect(new Set(p.traits).size).toBe(p.traits.length)
    }
  })

  it('金特大約 3% 的球員有', () => {
    const gold = players.filter((p) => p.traits.some((t) => TRAITS[t].tier === 'gold')).length
    const rate = gold / players.length
    expect(rate).toBeGreaterThan(0.015)
    expect(rate).toBeLessThan(0.05)
  })

  it('卡色依總評分級：平均水準是銀卡，彩虹卡最稀有', () => {
    const counts = { bronze: 0, silver: 0, gold: 0, rainbow: 0 }
    for (const p of players) counts[cardTier(p)]++
    expect(counts.silver).toBeGreaterThan(counts.bronze)
    expect(counts.silver).toBeGreaterThan(counts.gold)
    expect(counts.gold).toBeGreaterThan(counts.rainbow)
    expect(counts.bronze).toBeGreaterThan(0)
    expect(counts.rainbow).toBeGreaterThan(0)
  })

  it('總評是能力值平均（打者四項、投手三項）', () => {
    for (const p of players.slice(0, 20)) {
      const values: number[] = Object.values(p.ratings)
      expect(values).toHaveLength(p.role === 'batter' ? 4 : 3)
      expect(overall(p)).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 5)
    }
  })
})
