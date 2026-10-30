// 本職守位：每名打者最擅長的守位，守別的位置時守備打折
import type { Batter, FieldPosition, Position } from './types'

const INFIELD: ReadonlySet<Position> = new Set(['1B', '2B', '3B', 'SS'])
const OUTFIELD: ReadonlySet<Position> = new Set(['LF', 'CF', 'RF'])

/**
 * 守 position 時守備扣幾分。本職和指定打擊不扣；同為內野或同為外野 −1；
 * 非捕手去守捕手 −3；其他（內外野互換、捕手去守別的位置）−2
 */
export function positionPenalty(primary: FieldPosition, position: Position): number {
  if (position === 'DH' || position === primary) return 0
  if (position === 'C') return 3
  if ((INFIELD.has(position) && INFIELD.has(primary)) || (OUTFIELD.has(position) && OUTFIELD.has(primary))) return 1
  return 2
}

/** 守的不是本職（指定打擊不算） */
export function isOffPosition(b: Batter, position: Position): boolean {
  return positionPenalty(b.primary, position) > 0
}

/** 守這個位置時實際的守備值，最低 1 */
export function fieldingAtPosition(b: Batter, position: Position): number {
  return Math.max(1, b.ratings.fielding - positionPenalty(b.primary, position))
}
