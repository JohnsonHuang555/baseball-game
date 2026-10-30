// 陣容調整的羈絆計算：各羈絆目前的階級，以及「最多羈絆排法」
import type { RelicId } from './items'
import { positionPenalty } from './positions'
import { captainIn, positionSynergies, synergyTiers, type SynergyKey, type SynergyTier } from './synergy'
import { POSITIONS, type Batter, type LineupSpot, type Position, type Roster } from './types'

/** 每個羈絆目前的階級：流派羈絆 0～2，守位羈絆成立是 1 */
export function synergyLevels(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): Record<SynergyKey, SynergyTier> {
  const tiers = synergyTiers(lineup, captainIn(lineup, captain), relics)
  const pos = positionSynergies(lineup)
  return { ...tiers, middle: pos.middle ? 1 : 0, battery: pos.battery ? 1 : 0 }
}

/** 先發裡守非本職的人數 */
export function offPositionCount(lineup: readonly LineupSpot[]): number {
  return lineup.filter((s) => positionPenalty(s.player.primary, s.position) > 0).length
}

/** 「最多羈絆排法」的一項改動 */
export type ArrangeMove =
  | { type: 'in'; player: Batter; out: Batter; position: Position; native: boolean }
  | { type: 'move'; player: Batter; from: Position; to: Position; native: boolean }

export interface Arrangement {
  roster: Roster
  moves: ArrangeMove[]
}

const LEVEL_WEIGHT = 100
const PENALTY_WEIGHT = 10

/**
 * 從先發加板凳中排出羈絆最多的陣容：先比羈絆階級加總，再比守非本職的懲罰，最後比改動最少。
 * 上場的人接下場那人的棒次，其他人的棒次不動；隊長被換下就沒有隊長。比現在好才回傳，否則 null
 */
export function bestArrangement(roster: Roster, relics: readonly RelicId[]): Arrangement | null {
  const pool = [...roster.lineup.map((s) => s.player), ...roster.bench]
  const current = new Map(roster.lineup.map((s) => [s.player.id, s.position]))
  const score = (lineup: readonly LineupSpot[]) => {
    const levels = synergyLevels(lineup, roster.captain, relics)
    const total = Object.values(levels).reduce<number>((a, b) => a + b, 0)
    const penalty = lineup.reduce((sum, s) => sum + positionPenalty(s.player.primary, s.position), 0)
    const changes = lineup.filter((s) => current.get(s.player.id) !== s.position).length
    return total * LEVEL_WEIGHT - penalty * PENALTY_WEIGHT - changes
  }
  let best: { lineup: LineupSpot[]; score: number } = { lineup: roster.lineup, score: score(roster.lineup) }
  for (const chosen of combinations(pool, 9)) {
    // 守位羈絆要的守位先限定本職，四種組合各排一次，取分數最高的
    for (const needMiddle of [false, true]) {
      for (const needBattery of [false, true]) {
        const assigned = assignPositions(chosen, current, { needMiddle, needBattery })
        if (!assigned) continue
        const s = score(assigned)
        if (s > best.score) best = { lineup: assigned, score: s }
      }
    }
  }
  if (best.lineup === roster.lineup) return null
  return withBattingOrder(roster, best.lineup)
}

/** 依原本的棒次排回去：留下的人棒次不動，上場的人接下場那人的棒次 */
function withBattingOrder(roster: Roster, chosen: LineupSpot[]): Arrangement {
  const byId = new Map(chosen.map((s) => [s.player.id, s.position]))
  const incoming = chosen.filter((s) => !roster.lineup.some((o) => o.player.id === s.player.id))
  const moves: ArrangeMove[] = []
  const lineup = roster.lineup.map((spot) => {
    const position = byId.get(spot.player.id)
    if (position) {
      if (position !== spot.position) moves.push({ type: 'move', player: spot.player, from: spot.position, to: position, native: positionPenalty(spot.player.primary, position) === 0 })
      return { player: spot.player, position }
    }
    const next = incoming.shift()!
    moves.push({ type: 'in', player: next.player, out: spot.player, position: next.position, native: positionPenalty(next.player.primary, next.position) === 0 })
    return next
  })
  const ids = new Set(lineup.map((s) => s.player.id))
  const bench = [...roster.lineup.map((s) => s.player), ...roster.bench].filter((p) => !ids.has(p.id))
  const captain = roster.captain && ids.has(roster.captain) ? roster.captain : undefined
  // 上場的人放前面說明，再來是換守位的
  moves.sort((a, b) => Number(a.type === 'move') - Number(b.type === 'move'))
  return { roster: { ...roster, lineup, bench, captain }, moves }
}

/**
 * 9 人分配 9 個守位，讓守非本職的懲罰最小（不得已才換守位）。
 * needMiddle、needBattery 時，二游、捕手只能由本職擔任；排不出來回傳 null
 */
function assignPositions(players: readonly Batter[], current: ReadonlyMap<string, Position>, need: { needMiddle: boolean; needBattery: boolean }): LineupSpot[] | null {
  const n = players.length
  const cost = (p: Batter, pos: Position): number => {
    const native = p.primary === pos
    if (!native && ((need.needMiddle && (pos === '2B' || pos === 'SS')) || (need.needBattery && pos === 'C'))) return Infinity
    return positionPenalty(p.primary, pos) * PENALTY_WEIGHT + (current.get(p.id) === pos ? 0 : 1)
  }
  // dp[mask]：前 popcount(mask) 個守位分給 mask 裡的球員時的最小成本
  const size = 1 << n
  const dp = new Array<number>(size).fill(Infinity)
  const from = new Array<number>(size).fill(-1)
  dp[0] = 0
  for (let mask = 0; mask < size; mask++) {
    if (dp[mask] === Infinity) continue
    const k = popcount(mask)
    if (k >= POSITIONS.length) continue
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue
      const c = dp[mask] + cost(players[i], POSITIONS[k])
      const next = mask | (1 << i)
      if (c < dp[next]) {
        dp[next] = c
        from[next] = i
      }
    }
  }
  if (dp[size - 1] === Infinity) return null
  const spots: LineupSpot[] = []
  for (let mask = size - 1; mask; ) {
    const i = from[mask]
    spots.push({ player: players[i], position: POSITIONS[popcount(mask) - 1] })
    mask &= ~(1 << i)
  }
  return spots.reverse()
}

function popcount(x: number): number {
  let c = 0
  for (; x; x &= x - 1) c++
  return c
}

function* combinations<T>(items: readonly T[], k: number, start = 0, picked: T[] = []): Generator<T[]> {
  if (picked.length === k) {
    yield [...picked]
    return
  }
  for (let i = start; i <= items.length - (k - picked.length); i++) {
    picked.push(items[i])
    yield* combinations(items, k, i + 1, picked)
    picked.pop()
  }
}
