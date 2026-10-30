import { describe, expect, it } from 'vitest'
import { bestArrangement, offPositionCount, synergyLevels } from './arrange'
import { generateRoster } from './generate'
import { Rng } from './rng'
import { swapPositions } from './setup'
import type { Roster } from './types'

describe('最多羈絆排法', () => {
  it('二游互換造成的非本職會被排回來，黃金二遊重新成立', () => {
    const r = generateRoster(new Rng(4))
    const idx = (p: string) => r.lineup.findIndex((s) => s.position === p)
    const broken: Roster = swapPositions(r, idx('2B'), idx('SS'))
    expect(synergyLevels(broken.lineup, broken.captain, []).middle).toBe(0)
    const best = bestArrangement(broken, [])!
    expect(best).not.toBeNull()
    expect(synergyLevels(best.roster.lineup, best.roster.captain, []).middle).toBe(1)
    expect(offPositionCount(best.roster.lineup)).toBe(0)
    expect(best.moves.length).toBeGreaterThan(0)
  })

  it('已經是最好的排法就不提議；結果一定是 9 先發、2 板凳，守位不重複', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateRoster(new Rng(seed))
      const best = bestArrangement(r, [])
      if (!best) continue
      const before = Object.values(synergyLevels(r.lineup, r.captain, [])).reduce<number>((a, b) => a + b, 0)
      const after = Object.values(synergyLevels(best.roster.lineup, best.roster.captain, [])).reduce<number>((a, b) => a + b, 0)
      expect(after).toBeGreaterThanOrEqual(before)
      expect(best.roster.lineup).toHaveLength(9)
      expect(best.roster.bench).toHaveLength(2)
      expect(new Set(best.roster.lineup.map((s) => s.position)).size).toBe(9)
    }
  })
})
