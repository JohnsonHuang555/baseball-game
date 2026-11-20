// Phase 9 PR 4：MVP 用的正式事件（盜壘、勝利打點）從事件流收集，不影響比賽本身
import { describe, expect, it } from 'vitest'
import { RULES_VERSION, replay, type GameEvent, type GameSetup, type PlayKind, type Side } from '../../sim/game'
import { generateTeam } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { matchRecordOf } from '../domain/boxScore'
import { batOf } from '../domain/stats'
import { WinningRbiTracker, runMatch, runMatchWithGame } from './matchRunner'

const setupFor = (i: number, userSide: Side = 'home'): GameSetup => ({ home: generateTeam(new Rng(300 + i), 5.8), away: generateTeam(new Rng(700 + i), 5.8), seed: 9000 + i, userSide, rules: RULES_VERSION })
const play = (batterId: string, runs: number, kind: PlayKind = 'single'): GameEvent => ({ type: 'play', kind, batterId, ball: null, moves: [], runs, notation: null })
const end = (half: 'top' | 'bottom', inning = 1): GameEvent => ({ type: 'halfInningEnd', inning, half })

describe('勝利打點（事件流）', () => {
  it('取得「之後沒再被追平」領先的那個打席；被追平就清掉，再次超前的才算', () => {
    // 我方是主隊：上半局對手先得 1 分，下半局 a 追平、b 超前；第 2 局對手追平；第 2 局下 c 超前
    const t = new WinningRbiTracker('home', 'top')
    t.collect([play('o1', 1), end('top')])
    t.collect([play('a', 1)])
    expect(t.batterId).toBeNull()
    t.collect([play('b', 2), end('bottom'), play('o2', 1)])
    expect(t.batterId).toBe('b')
    t.collect([play('o3', 1), end('top', 2)])
    expect(t.batterId).toBeNull()
    t.collect([play('c', 1, 'sacrificeFly')])
    expect(t.batterId).toBe('c')
  })

  it('靠失誤或雙殺打取得領先：沒有打點，不記勝利打點', () => {
    const t = new WinningRbiTracker('away', 'top')
    t.collect([play('a', 1, 'error')])
    expect(t.batterId).toBeNull()
    const u = new WinningRbiTracker('away', 'top')
    u.collect([play('a', 1, 'doublePlay')])
    expect(u.batterId).toBeNull()
  })

  it('真實比賽：贏球才有勝利打點，而且一定是我方有打擊紀錄的打者；輸球一定是 null', () => {
    let wins = 0
    for (let i = 0; i < 60; i++) {
      for (const side of ['home', 'away'] as const) {
        const r = runMatch(setupFor(i, side))
        const lines = matchRecordOf(r, side).lines
        if (r.winner === side) {
          wins++
          if (r.mvpFacts!.winningRbi) expect(lines.bat.some((x) => x[0] === r.mvpFacts!.winningRbi)).toBe(true)
        } else expect(r.mvpFacts!.winningRbi).toBeNull()
      }
    }
    expect(wins).toBeGreaterThan(20)
  })
})

describe('盜壘（事件流）', () => {
  it('每位跑者的成功／失敗加總 = 戰術摘要的盜壘次數；只有我方', () => {
    let attempts = 0
    for (let i = 0; i < 80; i++) {
      const r = runMatch(setupFor(i))
      const steals = Object.values(r.mvpFacts!.steals)
      expect(steals.reduce((a, s) => a + s[0] + s[1], 0)).toBe(r.tactics!.steals[0])
      expect(steals.reduce((a, s) => a + s[0], 0)).toBe(r.tactics!.steals[1])
      const ours = new Set(r.players.filter((p) => p.side === 'home').map((p) => p.playerId))
      for (const id of Object.keys(r.mvpFacts!.steals)) expect(ours.has(id)).toBe(true)
      attempts += r.tactics!.steals[0]
    }
    expect(attempts).toBeGreaterThan(5)
  })
})

describe('收集事實不影響比賽', () => {
  it('Replay 重播的比分、指令跟原本一樣（MVP 只讀事件，不消耗亂數、不下指令）', () => {
    for (let i = 0; i < 20; i++) {
      const { result, game } = runMatchWithGame(setupFor(i))
      const again = replay(result.replay.setup, result.replay.commands)
      expect(again.score).toEqual(result.score)
      expect(game.commands.length).toBe(result.replay.commands.length)
    }
  })

  it('lines 的打點加總對得起比分（評分用的資料是正式的）', () => {
    const r = runMatch(setupFor(3))
    const lines = matchRecordOf(r, 'home').lines
    const runs = lines.bat.reduce((a, [, ...c]) => a + batOf(c).r, 0)
    expect(runs).toBe(r.score.home)
  })
})
