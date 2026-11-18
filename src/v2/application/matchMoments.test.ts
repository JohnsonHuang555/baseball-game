// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { GameEvent, RunnerMove, Side } from '../../sim/game'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { ClubRepository } from '../infrastructure/clubRepository'
import { planMatches } from './batchRunner'
import { liveTimeline } from './liveMatch'
import { clutchSituation, frameMoment, headlineKind, inningStage, MOMENT_PRIORITY } from './matchMoments'
import type { ReplayState } from './replayPlayer'

function state(p: Partial<ReplayState> & { home?: number; away?: number }): ReplayState {
  const { home = 0, away = 0, ...rest } = p
  return {
    inning: 1,
    half: 'top',
    outs: 0,
    balls: 0,
    strikes: 0,
    score: { home, away },
    linescore: { home: [], away: [0] },
    hits: { home: 0, away: 0 },
    errors: { home: 0, away: 0 },
    bases: [null, null, null],
    battingSide: rest.half === 'bottom' ? 'home' : 'away',
    batterId: 'b',
    pitcherId: 'p',
    alignment: 'normal',
    over: false,
    winner: null,
    ...rest,
  }
}

const pitch = (result: 'inPlay' | 'calledStrike' | 'swingingStrike' = 'inPlay'): GameEvent => ({ type: 'pitch', result, balls: 0, strikes: 2 })
const play = (kind: Extract<GameEvent, { type: 'play' }>['kind'], runs = 0, moves: RunnerMove[] = [], distance = 300): GameEvent => ({
  type: 'play',
  kind,
  batterId: 'b',
  ball: kind === 'strikeout' || kind === 'walk' ? null : { type: 'fly', angle: 0, distance, fielder: 'CF' },
  moves,
  runs,
  notation: kind === 'doublePlay' ? '6-4-3' : null,
})
const after = (before: ReplayState, runs: number, extra: Partial<ReplayState> = {}): ReplayState => ({
  ...before,
  score: { ...before.score, [before.battingSide]: before.score[before.battingSide] + runs },
  ...extra,
})
const moment = (before: ReplayState, events: GameEvent[], runs: number, extra: Partial<ReplayState> = {}, user: Side = 'home') =>
  frameMoment(before, { events, after: after(before, runs, extra) }, user)

describe('得分、追平、逆轉', () => {
  it('一般得分：領先中再得分只算 score', () => {
    const m = moment(state({ inning: 3, half: 'bottom', home: 2, away: 1 }), [pitch(), play('single', 1)], 1)
    expect(m.kinds).toEqual(['score'])
    expect(m.primary).toBe('score')
    expect(m.ours).toBe(true)
    expect(m.score).toEqual({ us: 3, them: 1 })
  })

  it('追平：落後得分後同分', () => {
    const m = moment(state({ inning: 5, half: 'bottom', home: 1, away: 3 }), [pitch(), play('double', 2)], 2)
    expect(m.kinds).toEqual(['tieGame', 'score'])
    expect(headlineKind(m)).toBe('tieGame')
  })

  it('取得領先（同分時得分）與逆轉（落後時得分後領先）分開', () => {
    const lead = moment(state({ inning: 4, half: 'bottom', home: 2, away: 2 }), [pitch(), play('single', 1)], 1)
    expect(lead.primary).toBe('takeLead')
    expect(lead.comeback).toBe(false)
    expect(headlineKind(lead)).toBe('takeLead')
    const back = moment(state({ inning: 6, half: 'bottom', home: 1, away: 2 }), [pitch(), play('triple', 2)], 2)
    expect(back.kinds).toEqual(['takeLead', 'score'])
    expect(back.comeback).toBe(true)
    expect(headlineKind(back)).toBe('comeback')
  })

  it('沒有得分：沒有主要演出', () => {
    const m = moment(state({ inning: 2 }), [pitch(), play('flyOut')], 0)
    expect(m.primary).toBeNull()
    expect(m.kinds).toEqual([])
  })

  it('對手得分與全壘打：分類一樣，但 ours = false', () => {
    const m = moment(state({ inning: 3, half: 'top', home: 2, away: 1 }), [pitch(), play('homeRun', 2)], 2)
    expect(m.ours).toBe(false)
    expect(m.battingSide).toBe('away')
    expect(m.kinds).toEqual(['homeRun', 'takeLead', 'score'])
    expect(m.comeback).toBe(true)
    expect(m.score).toEqual({ us: 2, them: 3 })
  })
})

describe('全壘打', () => {
  it('一般全壘打：帶回幾分、距離', () => {
    const m = moment(state({ inning: 2, half: 'bottom', home: 3, away: 0, bases: ['r1', null, null] }), [pitch(), play('homeRun', 2, [], 412)], 2)
    expect(m.primary).toBe('homeRun')
    expect(m.homeRun).toEqual({ batterId: 'b', runs: 2, distance: 412 })
  })

  it('滿貫全壘打：優先於逆轉、得分', () => {
    const m = moment(state({ inning: 5, half: 'bottom', home: 1, away: 3, bases: ['a', 'b', 'c'] }), [pitch(), play('homeRun', 4)], 4)
    expect(m.kinds).toEqual(['grandSlam', 'homeRun', 'takeLead', 'score'])
    expect(m.primary).toBe('grandSlam')
  })
})

describe('再見', () => {
  const over = { over: true, winner: 'home' as Side }
  it('再見安打：九局下比賽在這一格結束、這一分讓主隊贏', () => {
    const before = state({ inning: 9, half: 'bottom', home: 2, away: 2, bases: [null, 'r2', null], outs: 2 })
    const m = moment(before, [pitch(), play('single', 1), { type: 'gameOver', winner: 'home' }], 1, over)
    expect(m.walkOff).toBe(true)
    expect(m.primary).toBe('walkOff')
    expect(headlineKind(m)).toBe('walkOff')
    expect(m.final).toBe(true)
  })

  it('再見全壘打、再見滿貫全壘打：只有一個主要演出，標題合併', () => {
    const solo = moment(state({ inning: 10, half: 'bottom', home: 4, away: 4 }), [pitch(), play('homeRun', 1), { type: 'gameOver', winner: 'home' }], 1, over)
    expect(solo.primary).toBe('walkOff')
    expect(headlineKind(solo)).toBe('walkOffHomeRun')
    const slam = moment(state({ inning: 9, half: 'bottom', home: 1, away: 4, bases: ['a', 'b', 'c'], outs: 2 }), [pitch(), play('homeRun', 4), { type: 'gameOver', winner: 'home' }], 4, over)
    expect(slam.kinds).toEqual(['walkOff', 'grandSlam', 'homeRun', 'takeLead', 'score'])
    expect(slam.primary).toBe('walkOff')
    expect(headlineKind(slam)).toBe('walkOffGrandSlam')
    expect(slam.homeRun?.runs).toBe(4)
    expect(slam.score).toEqual({ us: 5, them: 4 })
  })

  it('九局下得分但比賽沒有在這一格結束：不是再見', () => {
    const m = moment(state({ inning: 9, half: 'bottom', home: 1, away: 4 }), [pitch(), play('double', 1)], 1)
    expect(m.walkOff).toBe(false)
    expect(m.primary).toBe('score')
  })

  it('原本就領先時比賽結束（例如九局上的最後一個出局）：不是再見', () => {
    const m = moment(state({ inning: 9, half: 'top', home: 5, away: 2, outs: 2 }), [pitch(), play('groundOut'), { type: 'gameOver', winner: 'home' }], 0, { over: true, winner: 'home' })
    expect(m.walkOff).toBe(false)
    expect(m.final).toBe(true)
  })

  it('延長賽的再見：一樣是再見；對手（客隊）在延長上半超前不是再見', () => {
    const m = moment(state({ inning: 11, half: 'bottom', home: 3, away: 3, bases: [null, null, 'r3'] }), [pitch(), play('sacrificeFly', 1), { type: 'gameOver', winner: 'home' }], 1, over)
    expect(m.walkOff).toBe(true)
    const top = moment(state({ inning: 11, half: 'top', home: 3, away: 3 }), [pitch(), play('homeRun', 1)], 1)
    expect(top.walkOff).toBe(false)
    expect(top.primary).toBe('homeRun')
    expect(top.ours).toBe(false)
  })

  it('對手（主隊）再見：分類一樣是 walkOff，但 ours = false', () => {
    const m = moment(state({ inning: 9, half: 'bottom', home: 2, away: 2, bases: [null, 'r2', null] }), [pitch(), play('single', 1), { type: 'gameOver', winner: 'home' }], 1, over, 'away')
    expect(m.walkOff).toBe(true)
    expect(m.ours).toBe(false)
  })
})

describe('三振、雙殺', () => {
  it('揮棒落空與站著不動', () => {
    const swing = moment(state({}), [pitch('swingingStrike'), play('strikeout')], 0)
    expect(swing.strikeout).toBe('swinging')
    const look = moment(state({}), [pitch('calledStrike'), play('strikeout')], 0)
    expect(look.strikeout).toBe('looking')
  })

  it('三振是第三個出局：endsHalf，接半局轉場', () => {
    const m = moment(state({ outs: 2 }), [pitch('swingingStrike'), play('strikeout'), { type: 'halfInningEnd', inning: 1, half: 'top' }], 0)
    expect(m.endsHalf).toBe(true)
    expect(m.strikeout).toBe('swinging')
  })

  it('雙殺：出局的跑者來自模擬的跑壘結果', () => {
    const moves: RunnerMove[] = [
      { runnerId: 'r1', from: 1, to: 'out' },
      { runnerId: 'b', from: 0, to: 'out' },
    ]
    const m = moment(state({ bases: ['r1', null, null] }), [pitch(), play('doublePlay', 0, moves)], 0)
    expect(m.doublePlay).toEqual({ outs: ['r1', 'b'], notation: '6-4-3' })
  })
})

describe('關鍵打席（只看事件發生前的狀態）', () => {
  it('九局下、落後一分、滿壘、兩出局：最高等級；之後被三振也不影響判定', () => {
    const s = state({ inning: 9, half: 'bottom', home: 3, away: 4, bases: ['a', 'b', 'c'], outs: 2 })
    const c = clutchSituation(s, 'home')!
    expect(c).toMatchObject({ ours: true, level: 'high', deficit: 1, outs: 2, runnersOn: 3 })
    const k = moment(s, [pitch('swingingStrike'), play('strikeout'), { type: 'gameOver', winner: 'away' }], 0, { over: true, winner: 'away' })
    expect(k.primary).toBeNull()
    expect(clutchSituation(s, 'home')).toEqual(c)
  })

  it('七局、同分、二壘有人：一般等級；對手打擊時 ours = false', () => {
    expect(clutchSituation(state({ inning: 7, half: 'bottom', home: 2, away: 2, bases: [null, 'x', null] }), 'home')).toMatchObject({ level: 'normal', ours: true })
    expect(clutchSituation(state({ inning: 8, half: 'top', home: 2, away: 2, bases: [null, null, 'x'] }), 'home')).toMatchObject({ ours: false })
  })

  it('非關鍵：6 局以前、得點圈沒人、打擊方已經領先、落後太多', () => {
    expect(clutchSituation(state({ inning: 6, half: 'bottom', bases: [null, 'x', null] }), 'home')).toBeNull()
    expect(clutchSituation(state({ inning: 9, half: 'bottom', home: 2, away: 3, bases: ['x', null, null] }), 'home')).toBeNull()
    expect(clutchSituation(state({ inning: 8, half: 'bottom', home: 4, away: 3, bases: [null, 'x', null] }), 'home')).toBeNull()
    expect(clutchSituation(state({ inning: 8, half: 'bottom', home: 0, away: 3, bases: [null, 'x', null] }), 'home')).toBeNull()
    expect(clutchSituation(state({ inning: 9, half: 'bottom', bases: [null, 'x', null], over: true }), 'home')).toBeNull()
  })

  it('局間提示', () => {
    expect(inningStage({ inning: 7, half: 'top', over: false })).toBe('late')
    expect(inningStage({ inning: 9, half: 'top', over: false })).toBe('final')
    expect(inningStage({ inning: 10, half: 'top', over: false })).toBe('extra')
    expect(inningStage({ inning: 7, half: 'bottom', over: false })).toBeNull()
    expect(inningStage({ inning: 4, half: 'top', over: false })).toBeNull()
  })

  it('優先序是固定的清單', () => {
    expect(MOMENT_PRIORITY).toEqual(['walkOff', 'grandSlam', 'homeRun', 'takeLead', 'tieGame', 'score'])
  })
})

describe('真實比賽（模擬引擎產生的 100 場）', () => {
  it('分類跟模擬結果一致：每場得分加總等於比分；再見只出現在最後一格，且只有主隊在下半局贏的時候', () => {
    const club = new ClubRepository(new MemoryStorage()).createClub({ clubName: '時刻', clubSeed: 2026, clubId: 'moments', now: 0 })
    const counts: Record<string, number> = {}
    for (const plan of planMatches(club, 0, 100)) {
      const { timeline } = liveTimeline(plan)
      const total = { home: 0, away: 0 }
      let prev = timeline.initial
      for (const f of timeline.frames) {
        const m = frameMoment(prev, f, timeline.userSide)
        total[m.battingSide] += m.runs
        for (const k of m.kinds) counts[k] = (counts[k] ?? 0) + 1
        if (m.walkOff) {
          expect(f).toBe(timeline.frames.at(-1))
          expect(timeline.final.winner).toBe('home')
          expect(prev.half).toBe('bottom')
        }
        // 關鍵打席只用之前的狀態：同一個狀態判定一定相同
        expect(clutchSituation(prev, timeline.userSide)).toEqual(clutchSituation(structuredClone(prev), timeline.userSide))
        prev = f.after
      }
      expect(total).toEqual(timeline.final.score)
    }
    // 100 場裡這些時刻都至少出現過，判定不是空的
    for (const k of ['score', 'tieGame', 'takeLead', 'homeRun', 'walkOff']) expect(counts[k] ?? 0).toBeGreaterThan(0)
  })
})
