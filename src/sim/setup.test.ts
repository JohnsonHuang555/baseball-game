import { describe, expect, it } from 'vitest'
import { PLAYER_REROLLS, TEAM_REROLLS, createSetup, getSlot, rerollPlayer, rerollTeam, swapSlots } from './setup'

describe('賽前重骰', () => {
  it('開局有整隊 3 次、單人 5 次', () => {
    const s = createSetup(1)
    expect(s.teamRerollsLeft).toBe(TEAM_REROLLS)
    expect(s.playerRerollsLeft).toBe(PLAYER_REROLLS)
    expect(TEAM_REROLLS).toBe(3)
    expect(PLAYER_REROLLS).toBe(5)
  })

  it('整隊重骰換掉所有人並扣次數，用完就不能再骰', () => {
    let s = createSetup(1)
    const before = s.team.roster.starter.id
    s = rerollTeam(s)
    expect(s.team.roster.starter.id).not.toBe(before)
    expect(s.teamRerollsLeft).toBe(2)
    s = rerollTeam(rerollTeam(s))
    expect(s.teamRerollsLeft).toBe(0)
    expect(rerollTeam(s)).toBe(s)
  })

  it('單人重骰只換該格球員，守備位置不變', () => {
    const s = createSetup(2)
    const slot = { kind: 'lineup', index: 3 } as const
    const next = rerollPlayer(s, slot)
    expect(next.playerRerollsLeft).toBe(4)
    expect(getSlot(next.team.roster, slot).id).not.toBe(getSlot(s.team.roster, slot).id)
    expect(next.team.roster.lineup[3].position).toBe(s.team.roster.lineup[3].position)
    expect(next.team.roster.lineup[0]).toBe(s.team.roster.lineup[0])
    expect(next.team.roster.starter).toBe(s.team.roster.starter)
  })

  it('投手格重骰出來的還是投手', () => {
    const s = rerollPlayer(createSetup(3), { kind: 'reliever', index: 1 })
    expect(s.team.roster.relievers[1].role).toBe('pitcher')
  })
})

describe('賽前換人', () => {
  const roster = createSetup(5).team.roster

  it('打序互換：兩人連同守備位置交換打序', () => {
    const r = swapSlots(roster, { kind: 'lineup', index: 0 }, { kind: 'lineup', index: 8 })!
    expect(r.lineup[0]).toEqual(roster.lineup[8])
    expect(r.lineup[8]).toEqual(roster.lineup[0])
  })

  it('板凳換上先發：接手原本的守備位置', () => {
    const r = swapSlots(roster, { kind: 'lineup', index: 2 }, { kind: 'bench', index: 1 })!
    expect(r.lineup[2].player).toBe(roster.bench[1])
    expect(r.lineup[2].position).toBe(roster.lineup[2].position)
    expect(r.bench[1]).toBe(roster.lineup[2].player)
  })

  it('先發投手和後援互換', () => {
    const r = swapSlots(roster, { kind: 'starter' }, { kind: 'reliever', index: 0 })!
    expect(r.starter).toBe(roster.relievers[0])
    expect(r.relievers[0]).toBe(roster.starter)
  })

  it('打者和投手不能互換', () => {
    expect(swapSlots(roster, { kind: 'lineup', index: 0 }, { kind: 'starter' })).toBeNull()
  })
})
