// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClubRepository, MemoryStorage } from '../infrastructure/clubRepository'
import type { ClubSave, SettledMatch } from './club'
import { recentForm, teamPower, teamPowerIf } from './growthInfo'
import { reserves } from './roster'

const club = () => new ClubRepository(new MemoryStorage()).createClub({ clubName: '成長', clubSeed: 5, clubId: 'growth', now: 0 })
const match = (i: number, won: boolean, tier = 0) => ({ matchIndex: i, result: { won, leagueTier: tier } }) as unknown as SettledMatch

describe('球隊戰力', () => {
  it('上場球員升級：戰力提高，而且就是升級後的實際戰力；不改輸入', () => {
    const c = club()
    const id = c.roster.lineup[0].playerId
    const before = JSON.stringify(c)
    const after = teamPowerIf(c, id, 2)!
    expect(after).toBeGreaterThan(teamPower(c))
    const upgraded: ClubSave = { ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, level: 2 } : r)) }
    expect(after).toBeCloseTo(teamPower(upgraded), 10)
    expect(JSON.stringify(c)).toBe(before)
  })

  it('預備球員升級不改變目前的戰力（回傳 null）', () => {
    const c = club()
    const extra = { ...c.players[0], player: { ...c.players[0].player, id: 'reserve-1' } }
    const withReserve = { ...c, players: [...c.players, extra] }
    expect(reserves(withReserve)).toHaveLength(1)
    expect(teamPowerIf(withReserve, 'reserve-1', 5)).toBeNull()
  })
})

describe('近期戰績對照', () => {
  it('不到 10 場：null；10～19 場：只有最近 10 場', () => {
    expect(recentForm({ recentMatches: Array.from({ length: 9 }, (_, i) => match(i, true)) })).toBeNull()
    const f = recentForm({ recentMatches: Array.from({ length: 15 }, (_, i) => match(i, i % 3 === 0)) })!
    expect(f.last).toEqual({ wins: 3, losses: 7 })
    expect(f.previous).toBeNull()
  })

  it('20 場以上：最近 10 場與前 10 場分開算', () => {
    const ms = [...Array.from({ length: 10 }, (_, i) => match(i, i < 4)), ...Array.from({ length: 10 }, (_, i) => match(10 + i, i < 7))]
    expect(recentForm({ recentMatches: ms })).toEqual({ last: { wins: 7, losses: 3 }, previous: { wins: 4, losses: 6 } })
  })

  it('兩段跨了聯盟（對手強度不同）：不比較前 10 場', () => {
    const ms = [...Array.from({ length: 10 }, (_, i) => match(i, true, 0)), ...Array.from({ length: 10 }, (_, i) => match(10 + i, false, 1))]
    expect(recentForm({ recentMatches: ms })!.previous).toBeNull()
  })
})

describe('升級效益', () => {
  it('等級越高，每 100 經驗換到的能力越少', async () => {
    const { upgradeEfficiency } = await import('./growthInfo')
    const r = club().players[0]
    const per = [1, 5, 10, 15, 19].map((level) => upgradeEfficiency({ ...r, level })!.per100)
    for (let i = 1; i < per.length; i++) expect(per[i]).toBeLessThan(per[i - 1])
    expect(upgradeEfficiency({ ...r, level: 20 })).toBeNull()
  })

  it('升高等級的球員時，提醒同樣經驗升低等級的上場球員比較划算；都差不多時不提醒', async () => {
    const { betterUpgrade } = await import('./growthInfo')
    const c = club()
    const id = c.roster.lineup[0].playerId
    const high = { ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, level: 12 } : r)) }
    const tip = betterUpgrade(high, id)!
    expect(tip.playerId).not.toBe(id)
    expect(tip.level).toBe(1)
    expect(tip.ratio).toBeGreaterThanOrEqual(2)
    expect(betterUpgrade(c, id)).toBeNull()
  })
})
