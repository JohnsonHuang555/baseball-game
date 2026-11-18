// @vitest-environment node
// 候選人跟目前陣容的比較：打者比同守位的先發（用守那個位置的實際守備），投手比先發或最弱的後援
import { describe, expect, it } from 'vitest'
import type { Batter, Pitcher } from '../../sim/types'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { ManualClock, tab } from '../testkit'
import type { ClubSave } from './club'
import { SIMILAR_MARGIN, batterValueAt, bestCandidateIndex, compareCandidate, pitcherValue } from './recruitCompare'
import { recruitCandidates } from './recruitment'
import { resolveRoster } from './roster'

function club(seed = 11): ClubSave {
  return tab(new MemoryStorage(), new ManualClock()).store.createClub({ clubName: '比較', clubSeed: seed, clubId: `c-${seed}`, now: 0 })
}

describe('候選人比較', () => {
  it('打者：跟守本職位置的先發比，守備用守那個位置的實際守備', () => {
    const c = club()
    const r = resolveRoster(c)
    const spot = r.lineup.find((s) => s.position !== 'DH')!
    const base = spot.player
    const cand: Batter = { ...base, id: 'x', name: '候選', primary: spot.position as Batter['primary'], ratings: { ...base.ratings, power: base.ratings.power + 2 } }
    const cmp = compareCandidate(c, cand)
    expect(cmp.target).toMatchObject({ kind: 'starter-at-position', playerId: base.id, position: spot.position })
    expect(cmp.diff).toBeCloseTo(batterValueAt(cand, spot.position) - batterValueAt(base, spot.position))
    expect(cmp.verdict).toBe('stronger')
    expect(cmp.improves).toBe(true)
    expect(cmp.strengths).toEqual(['power'])
  })

  it('守位不是只看總評：同樣的能力，比的是自己本職位置的先發，守非本職會被扣守備', () => {
    const c = club()
    const r = resolveRoster(c)
    const ss = r.lineup.find((s) => s.position === 'SS')!
    const fb = r.lineup.find((s) => s.position === '1B')!
    const asSS: Batter = { ...ss.player, id: 'same', primary: 'SS' }
    const as1B: Batter = { ...ss.player, id: 'same-1b', primary: '1B' }
    expect(compareCandidate(c, asSS)).toMatchObject({ verdict: 'similar', target: { playerId: ss.player.id, position: 'SS' } })
    expect(compareCandidate(c, as1B).target).toMatchObject({ playerId: fb.player.id, position: '1B' })
    // 一壘手去守游擊：守備被扣，綜合能力比本職游擊低
    expect(batterValueAt(as1B, 'SS')).toBeLessThan(batterValueAt(asSS, 'SS'))
  })

  it('投手：比先發強就跟先發比；比較弱就跟最弱的後援比', () => {
    const c = club()
    const r = resolveRoster(c)
    const strong: Pitcher = { ...r.starter, id: 'ace', ratings: { stuff: 10, control: 10, stamina: 10 } }
    const s = compareCandidate(c, strong)
    expect(s.target?.kind).toBe('starting-pitcher')
    expect(s.verdict).toBe('stronger')
    const weak: Pitcher = { ...r.starter, id: 'weak', ratings: { stuff: 1, control: 1, stamina: 1 } }
    const w = compareCandidate(c, weak)
    expect(w.target?.kind).toBe('weakest-reliever')
    const weakest = Math.min(...r.relievers.map(pitcherValue))
    expect(w.targetValue).toBeCloseTo(weakest)
    expect(w.verdict).toBe('weaker')
    expect(w.improves).toBe(false)
    expect(w.weaknesses.length).toBeGreaterThan(0)
  })

  it('相近的範圍：差距小於門檻算相近、不算補強', () => {
    const c = club()
    const r = resolveRoster(c)
    const sp = r.starter
    const close: Pitcher = { ...sp, id: 'close', ratings: { ...sp.ratings, stuff: sp.ratings.stuff + SIMILAR_MARGIN * 2 } }
    const out = compareCandidate(c, close)
    expect(out.verdict).toBe('similar')
    expect(out.improves).toBe(false)
  })

  it('三選一的建議：選差距最大的那位；不改球團', () => {
    const c = club()
    const before = JSON.stringify(c)
    for (const role of ['batter', 'pitcher'] as const) {
      const list = recruitCandidates(c, role)
      const best = bestCandidateIndex(c, list)
      const diffs = list.map((p) => compareCandidate(c, p).diff)
      expect(diffs[best]).toBe(Math.max(...diffs))
    }
    expect(JSON.stringify(c)).toBe(before)
  })
})
