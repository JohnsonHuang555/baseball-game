import { generateBatter, generatePitcher, generateTeam } from './generate'
import { Rng } from './rng'
import type { Player, Roster, Team } from './types'

export const TEAM_REROLLS = 3
export const PLAYER_REROLLS = 5

/** 比賽開打前的組隊階段 */
export interface PregameSetup {
  team: Team
  teamRerollsLeft: number
  playerRerollsLeft: number
  rngState: number
}

export type Slot =
  | { kind: 'lineup'; index: number }
  | { kind: 'bench'; index: number }
  | { kind: 'starter' }
  | { kind: 'reliever'; index: number }

export function createSetup(seed: number): PregameSetup {
  const rng = new Rng(seed)
  const team = generateTeam(rng)
  return { team, teamRerollsLeft: TEAM_REROLLS, playerRerollsLeft: PLAYER_REROLLS, rngState: rng.state }
}

/** 整隊重骰：隊名保留，球員全部換新 */
export function rerollTeam(s: PregameSetup): PregameSetup {
  if (s.teamRerollsLeft <= 0) return s
  const rng = new Rng(s.rngState)
  const { roster } = generateTeam(rng)
  return { ...s, team: { ...s.team, roster }, teamRerollsLeft: s.teamRerollsLeft - 1, rngState: rng.state }
}

export function rerollPlayer(s: PregameSetup, slot: Slot): PregameSetup {
  if (s.playerRerollsLeft <= 0) return s
  const rng = new Rng(s.rngState)
  const fresh = isPitcherSlot(slot) ? generatePitcher(rng) : generateBatter(rng)
  const roster = setSlot(s.team.roster, slot, fresh)
  return { ...s, team: { ...s.team, roster }, playerRerollsLeft: s.playerRerollsLeft - 1, rngState: rng.state }
}

export function isPitcherSlot(slot: Slot): boolean {
  return slot.kind === 'starter' || slot.kind === 'reliever'
}

export function getSlot(roster: Roster, slot: Slot): Player {
  switch (slot.kind) {
    case 'lineup':
      return roster.lineup[slot.index].player
    case 'bench':
      return roster.bench[slot.index]
    case 'starter':
      return roster.starter
    case 'reliever':
      return roster.relievers[slot.index]
  }
}

function setSlot(roster: Roster, slot: Slot, player: Player): Roster {
  switch (slot.kind) {
    case 'lineup':
      if (player.role !== 'batter') throw new Error('打序只能放打者')
      return { ...roster, lineup: roster.lineup.map((s, i) => (i === slot.index ? { ...s, player } : s)) }
    case 'bench':
      if (player.role !== 'batter') throw new Error('板凳只能放打者')
      return { ...roster, bench: roster.bench.map((b, i) => (i === slot.index ? player : b)) }
    case 'starter':
      if (player.role !== 'pitcher') throw new Error('先發投手只能放投手')
      return { ...roster, starter: player }
    case 'reliever':
      if (player.role !== 'pitcher') throw new Error('後援只能放投手')
      return { ...roster, relievers: roster.relievers.map((p, i) => (i === slot.index ? player : p)) }
  }
}

/**
 * 交換兩格球員。打序之間互換時，球員帶著守備位置一起移動；
 * 板凳換上先發時，接手原本的守備位置。打者和投手不能互換，回傳 null。
 */
export function swapSlots(roster: Roster, a: Slot, b: Slot): Roster | null {
  if (isPitcherSlot(a) !== isPitcherSlot(b)) return null
  if (a.kind === 'lineup' && b.kind === 'lineup') {
    const lineup = [...roster.lineup]
    ;[lineup[a.index], lineup[b.index]] = [lineup[b.index], lineup[a.index]]
    return { ...roster, lineup }
  }
  const pa = getSlot(roster, a)
  const pb = getSlot(roster, b)
  return setSlot(setSlot(roster, a, pb), b, pa)
}
