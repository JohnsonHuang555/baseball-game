import { describe, expect, it } from 'vitest'
import { generateBatter } from './generate'
import { fieldingAtPosition, isOffPosition, positionPenalty } from './positions'
import { Rng } from './rng'

describe('本職守位', () => {
  it('本職與指定打擊不扣；同為內野或外野 −1；內外野互換 −2；非捕手守捕手 −3', () => {
    expect(positionPenalty('SS', 'SS')).toBe(0)
    expect(positionPenalty('LF', 'DH')).toBe(0)
    expect(positionPenalty('2B', 'SS')).toBe(1)
    expect(positionPenalty('CF', 'LF')).toBe(1)
    expect(positionPenalty('1B', 'LF')).toBe(2)
    expect(positionPenalty('C', '1B')).toBe(2)
    expect(positionPenalty('SS', 'C')).toBe(3)
  })

  it('實際守備值最低 1', () => {
    const b = { ...generateBatter(new Rng(1)), primary: 'CF' as const }
    expect(fieldingAtPosition({ ...b, ratings: { ...b.ratings, fielding: 6 } }, 'C')).toBe(3)
    expect(fieldingAtPosition({ ...b, ratings: { ...b.ratings, fielding: 2 } }, 'C')).toBe(1)
    expect(isOffPosition(b, 'CF')).toBe(false)
    expect(isOffPosition(b, 'RF')).toBe(true)
  })
})
