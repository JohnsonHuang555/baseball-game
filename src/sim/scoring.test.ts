// @vitest-environment node
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import golden from './__golden__/sim-golden.json'
import { goldenCases, goldenPrint, playGolden } from './__golden__/cases'
import { replay, type RunnerMove } from './game'
import { Scorekeeper, type PlayInput } from './scoring'
import { resolveSetup } from '../v2/application/matchRunner'

const batter = (id: string, to: RunnerMove['to']): RunnerMove => ({ runnerId: id, from: 0, to })
const runner = (id: string, from: 1 | 2 | 3, to: RunnerMove['to']): RunnerMove => ({ runnerId: id, from, to })
const play = (s: Scorekeeper, p: Partial<PlayInput> & Pick<PlayInput, 'kind' | 'batterId' | 'moves'>) =>
  s.play({ pitcherId: 'P1', ballType: null, outsBefore: 0, ...p })

describe('Golden：加入統計前後比賽完全一樣', () => {
  const cases = goldenCases()
  it.each(cases.map((c) => [c.id, c] as const))('%s', (id, c) => {
    expect(goldenPrint(c)).toEqual((golden as Record<string, unknown>)[id])
  })
})

describe('整場比賽的記分不變量（160 場，9 種規則版本）', () => {
  const games = goldenCases().map((c) => ({ c, ...playGolden(c) }))

  it('打者：PA = AB + BB + HBP + SF + SH；安打、得分、打點對得起記分板與 PlayerLine', () => {
    for (const { game } of games) {
      for (const side of ['home', 'away'] as const) {
        let h = 0
        let r = 0
        for (const id of game.rosterIds(side)) {
          const b = game.stats[id]?.batting
          if (!b) continue
          expect(b.pa).toBe(b.ab + b.bb + b.hbp + b.sf + b.sh)
          expect(b.h).toBeGreaterThanOrEqual(b.d + b.t + b.hr)
          expect(b.ibb).toBeLessThanOrEqual(b.bb)
          expect(b.hbp).toBe(0)
          h += b.h
          r += b.r
          // 自動教練與內建 AI 都在打席開始時換人，所以跟舊的 PlayerLine 完全一致
          const old = game.box[id]
          expect([b.pa, b.h, b.hr, b.rbi, b.so]).toEqual(old ? [old.pa, old.hits, old.hr, old.rbi, old.so] : [0, 0, 0, 0, 0])
        }
        expect(h).toBe(game.hits[side])
        expect(r).toBe(game.score[side])
      }
    }
  })

  it('投手：失分加總等於對手得分、ER ≤ R、出局數等於守備的出局數（含盜壘刺殺）', () => {
    for (const { game } of games) {
      for (const side of ['home', 'away'] as const) {
        const other = side === 'home' ? 'away' : 'home'
        let r = 0
        let outs = 0
        let k = 0
        let oldK = 0
        let bf = 0
        for (const id of game.rosterIds(side)) {
          const p = game.stats[id]?.pitching
          if (!p) continue
          expect(p.er).toBeLessThanOrEqual(p.r)
          expect(p.hr).toBeLessThanOrEqual(p.h)
          expect(p.outs).toBeGreaterThanOrEqual(game.box[id]?.outs ?? 0)
          r += p.r
          outs += p.outs
          k += p.k
          bf += p.bf
          oldK += game.box[id]?.k ?? 0
        }
        expect(r).toBe(game.score[other])
        expect(k).toBe(oldK)
        let pa = 0
        for (const id of game.rosterIds(other)) pa += game.stats[id]?.batting?.pa ?? 0
        expect(bf).toBe(pa)
        // 主隊投手守完每一個上半局；客隊投手守完下半局，最後一個下半局可能是再見（還沒三出局）
        const expected =
          side === 'home' ? 3 * game.inning : 3 * (game.inning - 1) + (game.half === 'bottom' ? (game.winner === 'home' ? game.outs : 3) : 0)
        expect(outs).toBe(expected)
      }
    }
  })

  it('有失誤或延長賽的比賽才可能有非自責分；沒有就 ER = R', () => {
    let unearnedGames = 0
    for (const { game } of games) {
      for (const side of ['home', 'away'] as const) {
        const other = side === 'home' ? 'away' : 'home'
        let r = 0
        let er = 0
        for (const id of game.rosterIds(side)) {
          r += game.stats[id]?.pitching?.r ?? 0
          er += game.stats[id]?.pitching?.er ?? 0
        }
        if (game.errors[side] === 0 && game.inning <= 9) expect(er).toBe(r)
        if (er < r) unearnedGames++
        void other
      }
    }
    expect(unearnedGames).toBeGreaterThan(0)
  })

  it('出場：先發打線、先發投手一定有紀錄；沒出場的板凳沒有', () => {
    for (const { c, game } of games) {
      for (const side of ['home', 'away'] as const) {
        const roster = c.setup[side].roster
        for (const s of roster.lineup) expect(game.stats[s.player.id]?.batting).not.toBeNull()
        expect(game.stats[roster.starter.id]?.pitching).not.toBeNull()
        for (const p of roster.relievers) {
          const line = game.stats[p.id]
          if (line) expect(line.pitching).not.toBeNull()
        }
      }
    }
  })

  it('用 replay 重現，記分完全一樣', () => {
    for (const { c, game } of games.slice(0, 40)) {
      const again = replay(resolveSetup(c.setup, c.ai), game.commands)
      expect(again.stats).toEqual(game.stats)
    }
  })
})

describe('Scorekeeper：打者', () => {
  it('打數：保送、高飛犧牲打、犧牲觸擊不算；失誤上壘算打數不算安打', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'walk', batterId: 'A', moves: [batter('A', 1)] })
    play(s, { kind: 'intentionalWalk', batterId: 'B', moves: [batter('B', 1), runner('A', 1, 2)] })
    play(s, { kind: 'sacrificeBunt', batterId: 'C', moves: [batter('C', 'out'), runner('B', 1, 2), runner('A', 2, 3)] })
    play(s, { kind: 'sacrificeFly', batterId: 'D', outsBefore: 1, moves: [batter('D', 'out'), runner('A', 3, 4)] })
    play(s, { kind: 'error', batterId: 'E', outsBefore: 2, moves: [batter('E', 1), runner('B', 2, 3)] })
    const L = (id: string) => s.lines[id].batting!
    expect(L('A')).toMatchObject({ pa: 1, ab: 0, bb: 1, ibb: 0, r: 1 })
    expect(L('B')).toMatchObject({ pa: 1, ab: 0, bb: 1, ibb: 1 })
    expect(L('C')).toMatchObject({ pa: 1, ab: 0, sh: 1 })
    expect(L('D')).toMatchObject({ pa: 1, ab: 0, sf: 1, rbi: 1 })
    expect(L('E')).toMatchObject({ pa: 1, ab: 1, h: 0, roe: 1, rbi: 0 })
  })

  it('一、二、三壘安打與全壘打；滾地雙殺才算 GIDP、雙殺不給打點', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'single', batterId: 'A', moves: [batter('A', 1)] })
    play(s, { kind: 'double', batterId: 'A', moves: [batter('A', 2)] })
    play(s, { kind: 'triple', batterId: 'A', moves: [batter('A', 3)] })
    play(s, { kind: 'homeRun', batterId: 'A', moves: [batter('A', 4), runner('A', 3, 4)] })
    play(s, { kind: 'doublePlay', batterId: 'B', ballType: 'ground', moves: [runner('X', 1, 'out'), batter('B', 'out'), runner('Y', 3, 4)] })
    play(s, { kind: 'doublePlay', batterId: 'C', ballType: 'fly', moves: [batter('C', 'out'), runner('Z', 3, 'out')] })
    expect(s.lines.A.batting).toMatchObject({ pa: 4, ab: 4, h: 4, d: 1, t: 1, hr: 1 })
    expect(s.lines.B.batting).toMatchObject({ ab: 1, gidp: 1, rbi: 0 })
    expect(s.lines.C.batting).toMatchObject({ ab: 1, gidp: 0 })
  })

  it('第三個出局那一球的得分不算', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'groundOut', batterId: 'A', outsBefore: 2, moves: [batter('A', 'out'), runner('R', 3, 4)] })
    expect(s.lines.A.batting!.rbi).toBe(0)
    expect(s.lines.R?.batting?.r ?? 0).toBe(0)
    expect(s.lines.P1.pitching).toMatchObject({ r: 0, outs: 1 })
  })

  it('代打接手兩好球被三振：三振與打數記給原打者', () => {
    const s = new Scorekeeper()
    s.appearBatter('A')
    s.pinchHit('A', 'PH', 2)
    play(s, { kind: 'strikeout', batterId: 'PH', moves: [batter('PH', 'out')] })
    expect(s.lines.A.batting).toMatchObject({ pa: 1, ab: 1, so: 1 })
    expect(s.lines.PH.batting).toMatchObject({ pa: 0, ab: 0, so: 0 })
    // 一好球時換上：結果算代打者
    s.pinchHit('B', 'PH2', 1)
    play(s, { kind: 'strikeout', batterId: 'PH2', moves: [batter('PH2', 'out')] })
    expect(s.lines.PH2.batting).toMatchObject({ pa: 1, so: 1 })
  })
})

describe('Scorekeeper：投手、失分與自責分', () => {
  it('IP 來源：打席出局＋盜壘刺殺', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'single', batterId: 'A', moves: [batter('A', 1)] })
    s.steal([runner('A', 1, 'out')], 'P1', 0)
    play(s, { kind: 'strikeout', batterId: 'B', outsBefore: 1, moves: [batter('B', 'out')] })
    expect(s.lines.P1.pitching).toMatchObject({ outs: 2, bf: 2, h: 1, k: 1 })
  })

  it('繼承跑者：換投後得分記在放他上壘的投手', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'walk', batterId: 'A', moves: [batter('A', 1)] })
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'homeRun', batterId: 'B', pitcherId: 'P2', moves: [runner('A', 1, 4), batter('B', 4)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 1, bb: 1, bf: 1, outs: 0 })
    expect(s.lines.P2.pitching).toMatchObject({ r: 1, er: 1, h: 1, hr: 1, bf: 1 })
  })

  it('失誤上壘的跑者得分是非自責分；失誤那一球的得分也是', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'single', batterId: 'A', moves: [batter('A', 1)] })
    play(s, { kind: 'error', batterId: 'B', moves: [batter('B', 2), runner('A', 1, 4)] })
    play(s, { kind: 'single', batterId: 'C', moves: [batter('C', 1), runner('B', 2, 4)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 2, er: 0 })
  })

  it('因失誤延長的半局：重建後已經三出局，之後的得分都是非自責分', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'groundOut', batterId: 'A', outsBefore: 0, moves: [batter('A', 'out')] })
    play(s, { kind: 'flyOut', batterId: 'B', outsBefore: 1, moves: [batter('B', 'out')] })
    play(s, { kind: 'error', batterId: 'C', outsBefore: 2, moves: [batter('C', 1)] })
    play(s, { kind: 'single', batterId: 'D', outsBefore: 2, moves: [batter('D', 1), runner('C', 1, 2)] })
    play(s, { kind: 'homeRun', batterId: 'E', outsBefore: 2, moves: [runner('C', 2, 4), runner('D', 1, 4), batter('E', 4)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 3, er: 0 })
    // 下一個半局重新計算
    s.halfEnd()
    play(s, { kind: 'homeRun', batterId: 'F', moves: [batter('F', 4)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 4, er: 1 })
  })

  it('後援投手不享有他上場前的失誤機會；前一位投手的跑者照完整半局重建', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'groundOut', batterId: 'A', moves: [batter('A', 'out')] })
    play(s, { kind: 'groundOut', batterId: 'B', outsBefore: 1, moves: [batter('B', 'out')] })
    play(s, { kind: 'error', batterId: 'C', outsBefore: 2, moves: [batter('C', 1)] })
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'walk', batterId: 'D', pitcherId: 'P2', outsBefore: 2, moves: [batter('D', 1), runner('C', 1, 2)] })
    play(s, { kind: 'homeRun', batterId: 'E', pitcherId: 'P2', outsBefore: 2, moves: [runner('C', 2, 4), runner('D', 1, 4), batter('E', 4)] })
    // C：失誤上壘 → P1 非自責；D、E：P2 上場後沒有失誤，重建出局數 2 → 自責
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 0 })
    expect(s.lines.P2.pitching).toMatchObject({ r: 2, er: 2 })
  })

  it('後援上場後自己的失誤延長半局，之後的得分對他是非自責分', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'walk', batterId: 'A', outsBefore: 2, moves: [batter('A', 1)] })
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'error', batterId: 'B', pitcherId: 'P2', outsBefore: 2, moves: [batter('B', 1), runner('A', 1, 2)] })
    play(s, { kind: 'double', batterId: 'C', pitcherId: 'P2', outsBefore: 2, moves: [runner('A', 2, 4), runner('B', 1, 4), batter('C', 2)] })
    // A 屬於 P1，重建出局數 = 2 + 1 = 3 → 非自責；B 是失誤上壘
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 0 })
    expect(s.lines.P2.pitching).toMatchObject({ r: 1, er: 0 })
  })

  it('打席中途換投：投手落後球數時的保送記給前一位投手', () => {
    const s = new Scorekeeper()
    s.pitcherIn('P1', 'P2', 3, 1)
    play(s, { kind: 'walk', batterId: 'A', pitcherId: 'P2', moves: [batter('A', 1)] })
    expect(s.lines.P1.pitching).toMatchObject({ bb: 1, bf: 1 })
    expect(s.lines.P2.pitching).toMatchObject({ bb: 0, bf: 0 })
    play(s, { kind: 'homeRun', batterId: 'B', pitcherId: 'P2', moves: [runner('A', 1, 4), batter('B', 4)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 1 })
    // 1-2 換投被保送：算新投手
    s.pitcherIn('P2', 'P3', 1, 2)
    play(s, { kind: 'walk', batterId: 'C', pitcherId: 'P3', moves: [batter('C', 1)] })
    expect(s.lines.P3.pitching).toMatchObject({ bb: 1, bf: 1 })
  })

  it('代跑者接手原跑者的責任與自責與否', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'error', batterId: 'A', moves: [batter('A', 1)] })
    s.pinchRun('A', 'PR')
    play(s, { kind: 'double', batterId: 'B', moves: [runner('PR', 1, 4), batter('B', 2)] })
    expect(s.lines.PR.batting).toMatchObject({ r: 1, pa: 0 })
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 0 })
  })

  it('延長賽放在二壘的跑者得分是非自責分', () => {
    const s = new Scorekeeper()
    s.halfEnd()
    s.placeRunner('G', 'P1')
    play(s, { kind: 'single', batterId: 'A', moves: [runner('G', 2, 4), batter('A', 1)] })
    expect(s.lines.P1.pitching).toMatchObject({ r: 1, er: 0, h: 1 })
    expect(s.lines.A.batting!.rbi).toBe(1)
  })
})
