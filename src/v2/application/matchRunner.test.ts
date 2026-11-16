// @vitest-environment node
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import { Game, RULES_VERSION, replay, type GameSetup, type Side } from '../../sim/game'
import { generateTeam } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { Pitcher, Team } from '../../sim/types'
import { AutoCoach, BalancedPolicy, alignmentFor } from './autoCoach'
import { MatchConfigError, MatchStepLimitError, defaultAi, runMatch, runMatchWithGame, type MatchAi, type MatchResult } from './matchRunner'

function setup(seed: number, userSide: Side = 'home'): GameSetup {
  return { home: generateTeam(new Rng(seed * 2 + 1)), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide }
}

const awayCoached: MatchAi = { home: { kind: 'builtin' }, away: { kind: 'autoCoach', style: 'balanced' } }

/** 把整隊的投手都改成體力最差：一定會碰到疲勞換投 */
function tired(team: Team): Team {
  const weak = (p: Pitcher): Pitcher => ({ ...p, ratings: { ...p.ratings, stamina: 0 }, traits: p.traits.filter((t) => t !== 'ironArm') })
  return { ...team, roster: { ...team.roster, starter: weak(team.roster.starter), relievers: team.roster.relievers.map(weak) } }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** 比分、記分板與個人成績彼此對得起來 */
function expectLegal(r: MatchResult): void {
  expect(r.innings).toBeGreaterThanOrEqual(9)
  expect(r.score.home).not.toBe(r.score.away)
  expect(r.winner).toBe(r.score.home > r.score.away ? 'home' : 'away')
  for (const side of ['home', 'away'] as const) {
    const other: Side = side === 'home' ? 'away' : 'home'
    expect(r.score[side]).toBeGreaterThanOrEqual(0)
    expect(sum(r.linescore[side])).toBe(r.score[side])
    for (const runs of r.linescore[side]) expect(Number.isInteger(runs) && runs >= 0).toBe(true)
    const batters = r.players.filter((p) => p.side === side && p.role === 'batter')
    const pitchers = r.players.filter((p) => p.side === side && p.role === 'pitcher')
    expect(sum(batters.map((p) => p.line.hits))).toBe(r.hits[side])
    expect(sum(batters.map((p) => p.line.rbi))).toBeLessThanOrEqual(r.score[side])
    // 投手的失分加起來就是對手的得分；抓到的出局數不超過對手打過的半局數 × 3
    expect(sum(pitchers.map((p) => p.line.runs))).toBe(r.score[other])
    expect(sum(pitchers.map((p) => p.line.outs))).toBeLessThanOrEqual(r.linescore[other].length * 3)
    expect(pitchers.length).toBeGreaterThanOrEqual(1)
    for (const { line } of batters) {
      for (const v of Object.values(line)) expect(Number.isInteger(v) && v >= 0).toBe(true)
      expect(line.hits).toBeLessThanOrEqual(line.pa)
      expect(line.hr).toBeLessThanOrEqual(line.hits)
      expect(line.so).toBeLessThanOrEqual(line.pa)
    }
  }
  // 客隊每個半局都打完；主隊在第 9 局以後可能不用打或打不完
  expect(r.linescore.away.length).toBe(r.innings)
  expect(r.linescore.home.length).toBeGreaterThanOrEqual(r.innings - 1)
}

describe('runMatch：整場自動比賽', () => {
  const results = Array.from({ length: 200 }, (_, i) => runMatch(setup(i + 1, i % 2 ? 'home' : 'away')))

  it('每場都打完九局以上，延長賽也能分出勝負', () => {
    for (const r of results) expect(r.innings).toBeGreaterThanOrEqual(9)
    const extra = results.filter((r) => r.innings > 9)
    expect(extra.length).toBeGreaterThan(0)
    for (const r of extra) expectLegal(r)
  })

  it('比分與球員統計都合法', () => {
    for (const r of results) expectLegal(r)
  })

  it('規則版本明確寫在結果裡', () => {
    for (const r of results) {
      expect(r.replay.rulesVersion).toBe(RULES_VERSION)
      expect(r.replay.setup.rules).toBe(RULES_VERSION)
    }
    expect(runMatch({ ...setup(1), rules: 4 }).replay.setup.rules).toBe(4)
  })

  it('精彩事件：全壘打都對得上球員統計，再見只出現在主隊勝的比賽', () => {
    for (const r of results) {
      const hrs = r.highlights.filter((h) => h.kind === 'homeRun').length
      expect(hrs).toBe(sum(r.players.map((p) => (p.role === 'batter' ? p.line.hr : 0))))
      const walkOffs = r.highlights.filter((h) => h.kind === 'walkOff')
      expect(walkOffs.length).toBeLessThanOrEqual(1)
      if (walkOffs.length) expect(r.winner).toBe('home')
      for (const h of r.highlights) expect(h.inning).toBeLessThanOrEqual(r.innings)
    }
    expect(results.some((r) => r.highlights.some((h) => h.kind === 'walkOff'))).toBe(true)
  })

  it('結果可以序列化（之後可以交給 Web Worker 或存檔）', () => {
    const r = results[0]
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})

describe('可重現性', () => {
  it('相同種子、陣容與策略，結果完全一樣', () => {
    for (let i = 1; i <= 20; i++) {
      expect(runMatch(setup(i))).toEqual(runMatch(setup(i)))
      expect(runMatch(setup(i), awayCoached)).toEqual(runMatch(setup(i), awayCoached))
    }
  })

  it('不同種子會打出不同的結果', () => {
    const teams = setup(1)
    const lines = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(runMatch({ ...teams, seed: 1000 + i }).linescore)))
    expect(lines.size).toBeGreaterThan(10)
  })

  it('交給 V1 的 replay() 重播，比分、記分板與個人成績都一樣', () => {
    for (let i = 1; i <= 30; i++) {
      const { result, game } = runMatchWithGame(setup(i), i % 2 ? defaultAi('home') : awayCoached)
      const again = replay(result.replay.setup, result.replay.commands)
      expect(again.over).toBe(true)
      expect(again.stepIndex).toBe(result.steps)
      expect(again.score).toEqual(result.score)
      expect(again.linescore).toEqual(result.linescore)
      expect(again.box).toEqual(game.box)
      expect(again.commands).toEqual(result.replay.commands)
    }
  })
})

describe('自動換投', () => {
  it('雙方投手體力差時，兩隊都會自動換投（自動教練在主隊或客隊都一樣）', () => {
    for (const ai of [defaultAi('home'), awayCoached]) {
      for (let i = 1; i <= 10; i++) {
        const s = setup(i)
        const r = runMatch({ ...s, home: tired(s.home), away: tired(s.away) }, ai)
        const changes = r.highlights.filter((h) => h.kind === 'pitchingChange')
        expect(changes.some((h) => h.side === 'home')).toBe(true)
        expect(changes.some((h) => h.side === 'away')).toBe(true)
        expectLegal(r)
      }
    }
  })

  it('自動教練換投時，投手已經到疲勞門檻或後段左右相剋', () => {
    for (let i = 1; i <= 50; i++) {
      const game = new Game({ ...setup(i), rules: RULES_VERSION })
      const coach = new AutoCoach(new BalancedPolicy())
      while (!game.over) {
        const team = game.teams[game.userSide]
        const before = { id: team.pitcher.id, fatigued: game.isFatigued(team), late: game.inning >= 7 }
        coach.act(game)
        if (team.pitcher.id !== before.id) expect(before.fatigued || before.late).toBe(true)
        game.step()
      }
    }
  })
})

describe('自動教練', () => {
  it('同一個打席不會重複下指令，排著的戰術最多一個', () => {
    for (let i = 1; i <= 50; i++) {
      const { result } = runMatchWithGame(setup(i))
      const seen = new Set<string>()
      for (const c of result.replay.commands) {
        const key = `${c.stepIndex}:${JSON.stringify(c.tactic)}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      const queuedPerStep = new Map<number, number>()
      for (const c of result.replay.commands) {
        if (['steal', 'bunt', 'hitAndRun'].includes(c.tactic.type)) queuedPerStep.set(c.stepIndex, (queuedPerStep.get(c.stepIndex) ?? 0) + 1)
      }
      for (const n of queuedPerStep.values()) expect(n).toBe(1)
    }
  })

  it('同一個打席多次呼叫 act()，只有第一次會下指令', () => {
    const game = new Game({ ...setup(3), rules: RULES_VERSION })
    const coach = new AutoCoach(new BalancedPolicy())
    while (!game.over) {
      coach.act(game)
      const n = game.commands.length
      expect(coach.act(game)).toEqual([])
      expect(game.commands.length).toBe(n)
      game.step()
    }
  })

  it('佈陣跟引擎內建 AI 是同一套判斷', () => {
    for (let i = 1; i <= 20; i++) {
      const game = new Game({ ...setup(i), rules: RULES_VERSION })
      const coach = new AutoCoach(new BalancedPolicy())
      while (!game.over) {
        // 引擎內建 AI 守備時，打席開始的佈陣就是 alignmentFor 算出來的
        if (game.fieldingSide !== game.userSide && game.balls + game.strikes === 0 && !game.queued) expect(game.alignment).toBe(alignmentFor(game))
        coach.act(game)
        game.step()
      }
    }
  })
})

describe('錯誤處理', () => {
  it('超過最大步數就丟錯，不會默默給比分', () => {
    expect(() => runMatch(setup(1), undefined, { maxSteps: 50 })).toThrow(MatchStepLimitError)
  })

  it('雙方 AI 設定不合法、規則版本不支援時丟錯', () => {
    expect(() => runMatch(setup(1), { home: { kind: 'autoCoach' }, away: { kind: 'autoCoach' } })).toThrow(MatchConfigError)
    expect(() => runMatch(setup(1), { home: { kind: 'builtin' }, away: { kind: 'builtin' } })).toThrow(MatchConfigError)
    expect(() => runMatch({ ...setup(1), rules: RULES_VERSION + 1 })).toThrow(MatchConfigError)
  })
})

describe('批次與執行環境', () => {
  it('批次模擬 1,000 場都會結束', () => {
    let total = 0
    for (let i = 1; i <= 1000; i++) {
      const r = runMatch(setup(i, i % 2 ? 'home' : 'away'))
      expect(r.steps).toBeLessThan(1000)
      total += r.steps
    }
    expect(total).toBeGreaterThan(0)
  }, 60_000)

  it('沒有 DOM 也能跑，V2 模組也沒有引用畫面', () => {
    expect(typeof document).toBe('undefined')
    expect(typeof window).toBe('undefined')
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true })
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(2)
    for (const source of Object.values(sources)) {
      expect(source).not.toMatch(/from '[^']*\/ui\//)
      expect(source).not.toMatch(/\b(document|window|requestAnimationFrame)\./)
    }
  })
})
