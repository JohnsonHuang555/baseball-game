// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { Roster } from '../../sim/types'
import { LineupError, assertValidLineup, autoArrange, lineupIssues, setStartingPitcher, substitute, swapBattingOrder, swapFieldPositions } from './lineup'

const roster = (seed = 3): Roster => generateRoster(new Rng(seed))
const ids = (r: Roster) => [...r.lineup.map((s) => s.player.id), ...r.bench.map((p) => p.id), r.starter.id, ...r.relievers.map((p) => p.id)].sort()

describe('陣容合法性', () => {
  it('產生器給的陣容是合法的', () => {
    for (let s = 1; s <= 20; s++) expect(lineupIssues(roster(s))).toEqual([])
  })

  it('不合法的陣容會列出問題', () => {
    const r = roster()
    const cases: Roster[] = [
      { ...r, lineup: r.lineup.slice(0, 8) },
      { ...r, lineup: r.lineup.map((s, i) => (i === 0 ? { ...s, position: r.lineup[1].position } : s)) },
      { ...r, bench: [r.lineup[0].player, r.bench[1]] },
      { ...r, starter: r.relievers[0] },
      { ...r, relievers: [r.starter, r.relievers[1]] },
      { ...r, lineup: r.lineup.map((s, i) => (i === 0 ? { ...s, player: r.starter as never } : s)) },
      { ...r, captain: r.bench[0].id },
    ]
    for (const c of cases) {
      expect(lineupIssues(c).length).toBeGreaterThan(0)
      expect(() => assertValidLineup(c)).toThrow(LineupError)
    }
  })
})

describe('陣容調整', () => {
  it('每種調整之後都還是合法陣容，球員不重複也不會少', () => {
    const r = roster()
    const results = [substitute(r, 2, 1), swapFieldPositions(r, 0, 5), swapBattingOrder(r, 0, 8), setStartingPitcher(r, 1)]
    for (const x of results) {
      expect(lineupIssues(x)).toEqual([])
      expect(ids(x)).toEqual(ids(r))
    }
  })

  it('板凳換上先發：接手原本的守位與棒次，被換下的人到板凳', () => {
    const r = roster()
    const x = substitute(r, 4, 0)
    expect(x.lineup[4].player.id).toBe(r.bench[0].id)
    expect(x.lineup[4].position).toBe(r.lineup[4].position)
    expect(x.bench[0].id).toBe(r.lineup[4].player.id)
  })

  it('交換守位不動棒次；交換棒次不動守位', () => {
    const r = roster()
    const pos = swapFieldPositions(r, 0, 1)
    expect(pos.lineup[0].player.id).toBe(r.lineup[0].player.id)
    expect(pos.lineup[0].position).toBe(r.lineup[1].position)
    const order = swapBattingOrder(r, 0, 1)
    expect(order.lineup[0].player.id).toBe(r.lineup[1].player.id)
    expect(order.lineup[0].position).toBe(r.lineup[1].position)
  })

  it('換先發投手：跟後援對調', () => {
    const r = roster()
    const x = setStartingPitcher(r, 0)
    expect(x.starter.id).toBe(r.relievers[0].id)
    expect(x.relievers[0].id).toBe(r.starter.id)
  })

  it('隊長被換到板凳：隊長清掉，陣容仍合法', () => {
    const r = roster()
    const i = r.lineup.findIndex((s) => s.player.id === r.captain)
    expect(i).toBeGreaterThanOrEqual(0)
    const x = substitute(r, i, 0)
    expect(x.captain).toBeUndefined()
    expect(lineupIssues(x)).toEqual([])
  })

  it('不存在的位置直接拒絕', () => {
    const r = roster()
    expect(() => substitute(r, 9, 0)).toThrow(RangeError)
    expect(() => substitute(r, 0, 2)).toThrow(RangeError)
    expect(() => setStartingPitcher(r, 5)).toThrow(RangeError)
    expect(() => swapFieldPositions(r, -1, 0)).toThrow(RangeError)
  })

  it('自動排陣（最多羈絆排法）的結果合法；已經最好就回傳 null', () => {
    for (let s = 1; s <= 15; s++) {
      const r = roster(s)
      const best = autoArrange(r)
      if (best) {
        expect(lineupIssues(best.roster)).toEqual([])
        expect(ids(best.roster)).toEqual(ids(r))
        expect(autoArrange(best.roster)).toBeNull()
      }
    }
  })
})
