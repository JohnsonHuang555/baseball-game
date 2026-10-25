import { describe, expect, it } from 'vitest'
import { cardTier, generateRoster, generateTeam, overall } from './generate'
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

  it('同一個種子產生同一支隊伍', () => {
    expect(generateTeam(new Rng(7))).toEqual(generateTeam(new Rng(7)))
  })

  it('球員 id 在大量產生時不重複', () => {
    const ids = allPlayers(200).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
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

  it('卡色依總評分級，彩虹卡最稀有', () => {
    const counts = { bronze: 0, silver: 0, gold: 0, rainbow: 0 }
    for (const p of players) counts[cardTier(p)]++
    expect(counts.bronze).toBeGreaterThan(counts.silver)
    expect(counts.silver).toBeGreaterThan(counts.gold)
    expect(counts.gold).toBeGreaterThan(counts.rainbow)
    expect(counts.rainbow).toBeGreaterThan(0)
  })

  it('總評是能力值平均', () => {
    const p = players[0]
    const values = Object.values(p.ratings)
    expect(overall(p)).toBeCloseTo(values.reduce((a, b) => a + b, 0) / 3, 5)
  })
})
