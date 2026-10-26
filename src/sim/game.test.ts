import { describe, expect, it } from 'vitest'
import { Game, fielderFor, replay, type GameEvent, type GameSetup, type Tactic } from './game'
import { generateTeam } from './generate'
import { Rng } from './rng'
import type { Team } from './types'

function setup(seed: number): GameSetup {
  return { home: generateTeam(new Rng(seed * 2 + 1)), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide: 'home' }
}

/** 教練不下任何指令，跑完整場 */
function playOut(game: Game): Game {
  let guard = 0
  while (!game.over) {
    game.step()
    if (++guard > 5000) throw new Error('比賽沒有結束')
  }
  return game
}

describe('整場比賽', () => {
  const games = Array.from({ length: 300 }, (_, i) => playOut(new Game(setup(i + 1))))

  it('每場都會結束，且有勝負', () => {
    for (const g of games) {
      expect(g.over).toBe(true)
      expect(g.score.home).not.toBe(g.score.away)
      expect(g.winner).toBe(g.score.home > g.score.away ? 'home' : 'away')
    }
  })

  it('至少打滿九局', () => {
    for (const g of games) expect(g.inning).toBeGreaterThanOrEqual(9)
  })

  it('記分板的 H、E 等於安打與失誤的次數；失誤記在守備方', () => {
    for (let i = 1; i <= 50; i++) {
      const g = new Game(setup(i))
      const count = { hits: { home: 0, away: 0 }, errors: { home: 0, away: 0 } }
      while (!g.over) {
        const batting = g.battingSide
        const fielding = g.fieldingSide
        for (const e of g.step()) {
          if (e.type !== 'play') continue
          if (['single', 'double', 'triple', 'homeRun'].includes(e.kind)) count.hits[batting]++
          if (e.kind === 'error') count.errors[fielding]++
        }
      }
      expect(g.hits).toEqual(count.hits)
      expect(g.errors).toEqual(count.errors)
    }
  })

  it('比分等於每局得分加總', () => {
    for (const g of games) {
      expect(g.linescore.home.reduce((a, b) => a + b, 0)).toBe(g.score.home)
      expect(g.linescore.away.reduce((a, b) => a + b, 0)).toBe(g.score.away)
    }
  })

  it('每隊每場平均得分接近真實棒球（約 3～6 分）', () => {
    const runs = games.reduce((sum, g) => sum + g.score.home + g.score.away, 0) / (games.length * 2)
    expect(runs).toBeGreaterThan(3)
    expect(runs).toBeLessThan(6)
  })

  it('每場平均用球數合理（約 220～340 球）', () => {
    const pitches = games.reduce((sum, g) => sum + g.teams.home.pitchCount + g.teams.away.pitchCount, 0)
    // 換投會把 pitchCount 歸零，所以用 stepIndex 估算
    const steps = games.reduce((sum, g) => sum + g.stepIndex, 0) / games.length
    expect(pitches).toBeGreaterThan(0)
    expect(steps).toBeGreaterThan(220)
    expect(steps).toBeLessThan(340)
  })

  function decisionsPerGame(frequency: 'few' | 'many'): number {
    let total = 0
    for (let i = 1; i <= 200; i++) {
      const g = new Game(setup(i))
      let lastPa = -1
      while (!g.over) {
        if (g.paIndex !== lastPa && g.decisionReasons(frequency).includes('leverage')) {
          total++
          lastPa = g.paIndex
        }
        g.step()
      }
    }
    return total / 200
  }

  it('決策點預設（少）一場大約 1～3 次，而且只出現在第 7 局以後', () => {
    const few = decisionsPerGame('few')
    expect(few).toBeGreaterThan(0.8)
    expect(few).toBeLessThan(3.5)
    const g = new Game(setup(1))
    while (!g.over) {
      if (g.decisionReasons('few').includes('leverage')) expect(g.inning).toBeGreaterThanOrEqual(7)
      g.step()
    }
  })

  it('決策點設成「多」時大約 3～8 次', () => {
    const many = decisionsPerGame('many')
    expect(many).toBeGreaterThan(3)
    expect(many).toBeLessThan(8)
  })

  it('九局下主隊領先就提早結束，不打下半局', () => {
    const early = games.find((g) => g.inning === 9 && g.linescore.home.length === 8)
    expect(early).toBeDefined()
    expect(early!.winner).toBe('home')
  })
})

describe('失誤與雙殺', () => {
  const plays: Extract<GameEvent, { type: 'play' }>[] = []
  for (let i = 1; i <= 300; i++) {
    const g = new Game(setup(i))
    while (!g.over) for (const e of g.step()) if (e.type === 'play') plays.push(e)
  }

  it('失誤每隊每場大約 0.2～0.9 次，失誤時打者安全上壘', () => {
    const errors = plays.filter((p) => p.kind === 'error')
    const perTeamGame = errors.length / 600
    expect(perTeamGame).toBeGreaterThan(0.2)
    expect(perTeamGame).toBeLessThan(0.9)
    for (const e of errors) {
      const batterMove = e.moves.find((m) => m.from === 0)!
      expect(batterMove.to === 1 || batterMove.to === 2).toBe(true)
      expect(e.ball).not.toBeNull()
    }
  })

  it('雙殺有守備記號，而且有多種方式（滾地、平飛回壘不及、本壘觸殺）', () => {
    const dps = plays.filter((p) => p.kind === 'doublePlay')
    expect(dps.length).toBeGreaterThan(100)
    for (const dp of dps) {
      expect(dp.notation).toMatch(/^[1-9](-[1-9]){0,2}$/)
      expect(dp.moves.filter((m) => m.to === 'out')).toHaveLength(2)
    }
    const notations = new Set(dps.map((d) => d.notation))
    expect(notations).toContain('6-4-3')
    expect(notations).toContain('4-6-3')
    expect(notations).toContain('5-4-3')
    expect([...notations].some((n) => n!.endsWith('-2'))).toBe(true)
    expect(dps.some((d) => d.ball!.type === 'line')).toBe(true)
  })

  it('每顆擊球都有處理的守備員，外野高飛球不會由內野手處理', () => {
    for (const p of plays) {
      if (!p.ball) continue
      expect(p.ball.fielder).toBeDefined()
      if (p.ball.type === 'fly' && p.ball.distance >= 200) expect(['LF', 'CF', 'RF']).toContain(p.ball.fielder)
    }
  })
})

describe('守備能力', () => {
  /** 把一隊所有野手的守備設成同一個值 */
  function withFielding(team: Team, value: number): Team {
    const roster = team.roster
    return {
      ...team,
      roster: {
        ...roster,
        lineup: roster.lineup.map((s) => ({ ...s, player: { ...s.player, ratings: { ...s.player.ratings, fielding: value } } })),
      },
    }
  }

  function playStats(fielding: number) {
    let errors = 0
    let hits = 0
    let inPlay = 0
    for (let i = 1; i <= 300; i++) {
      const s = setup(i)
      const g = new Game({ ...s, home: withFielding(s.home, fielding) })
      while (!g.over) {
        for (const e of g.step()) {
          // 只看主隊守備時（上半局）的結果
          if (e.type !== 'play' || g.half !== 'top' || !e.ball) continue
          inPlay++
          if (e.kind === 'error') errors++
          if (['single', 'double', 'triple'].includes(e.kind)) hits++
        }
      }
    }
    return { errorRate: errors / inPlay, hitRate: hits / inPlay }
  }

  it('守備差的隊伍失誤較多、被打出的安打也較多', () => {
    const good = playStats(9)
    const bad = playStats(1)
    expect(bad.errorRate).toBeGreaterThan(good.errorRate * 2)
    expect(bad.hitRate).toBeGreaterThan(good.hitRate)
  })

  it('捕手守備越好，對方盜壘成功率越低', () => {
    const g = new Game(setup(4))
    while (!(g.battingSide === 'away' && g.bases[0] && !g.bases[1])) g.step()
    const catcher = g.fielding.lineup.find((s) => s.position === 'C')!
    catcher.player = { ...catcher.player, ratings: { ...catcher.player.ratings, fielding: 1 } }
    const weak = g.stealChance(1)
    catcher.player = { ...catcher.player, ratings: { ...catcher.player.ratings, fielding: 10 } }
    expect(g.stealChance(1)).toBeLessThan(weak)
  })

  it('守備替補：板凳球員接手守位與棒次，只能在守備時下', () => {
    const g = new Game(setup(4))
    while (g.fieldingSide !== 'home') g.step()
    const index = g.teams.home.lineup.findIndex((s) => s.position === 'SS')
    const benchPlayer = g.teams.home.bench[0]
    const events = g.issue({ type: 'defensiveSub', benchIndex: 0, lineupIndex: index })
    expect(g.teams.home.lineup[index].player).toBe(benchPlayer)
    expect(g.teams.home.lineup[index].position).toBe('SS')
    expect(events[0]).toMatchObject({ type: 'substitution', kind: 'defense' })
    const dh = g.teams.home.lineup.findIndex((s) => s.position === 'DH')
    expect(() => g.issue({ type: 'defensiveSub', benchIndex: 0, lineupIndex: dh })).toThrow()
  })
})

describe('fielderFor', () => {
  it('依方向分配內野手', () => {
    expect(fielderFor('ground', -35, 100)).toBe('3B')
    expect(fielderFor('ground', -15, 100)).toBe('SS')
    expect(fielderFor('ground', 15, 100)).toBe('2B')
    expect(fielderFor('ground', 35, 100)).toBe('1B')
    expect(fielderFor('ground', 0, 60)).toBe('P')
  })

  it('穿過內野的滾地球和深遠的飛球由外野手處理', () => {
    expect(fielderFor('ground', -30, 150)).toBe('LF')
    expect(fielderFor('fly', 0, 300)).toBe('CF')
    expect(fielderFor('line', 30, 250)).toBe('RF')
  })
})

describe('確定性（ADR-0001）', () => {
  it('同樣的種子和指令紀錄，重播出一模一樣的比賽', () => {
    const s = setup(99)
    const original = new Game(s)
    const rng = new Rng(5)
    while (!original.over) {
      // 隨機下一些指令，模擬真人教練
      const tactics = original.availableTactics()
      if (tactics.length > 0 && rng.chance(0.05)) original.issue(rng.pick(tactics))
      original.step()
    }
    expect(original.commands.length).toBeGreaterThan(0)
    const copy = replay(s, original.commands)
    expect(copy.score).toEqual(original.score)
    expect(copy.linescore).toEqual(original.linescore)
    expect(copy.stepIndex).toBe(original.stepIndex)
    expect(copy.teams).toEqual(original.teams)
  })

  it('可以重播到比賽中途的某一步', () => {
    const s = setup(3)
    const full = new Game(s)
    for (let i = 0; i < 120; i++) full.step()
    const partial = replay(s, full.commands, 120)
    expect(partial.inning).toBe(full.inning)
    expect(partial.outs).toBe(full.outs)
    expect(partial.bases).toEqual(full.bases)
  })
})

describe('戰術指令', () => {
  /** 推進到主隊（玩家）進攻、一壘有人、二壘空、少於兩出局 */
  function findRunnerOnFirst(): Game {
    for (let seed = 1; seed < 200; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        if (g.battingSide === 'home' && g.bases[0] && !g.bases[1] && g.outs < 2 && g.balls + g.strikes === 0) return g
        g.step()
      }
    }
    throw new Error('找不到情境')
  }

  it('盜壘：下一步只處理盜壘，跑者上二壘或出局', () => {
    const g = findRunnerOnFirst()
    const runner = g.bases[0]!
    const outs = g.outs
    g.issue({ type: 'steal', from: 1 })
    const events = g.step()
    const steal = events.find((e) => e.type === 'steal')
    expect(steal).toBeDefined()
    if (steal?.type === 'steal' && steal.success) expect(g.bases[1]).toBe(runner)
    else expect(g.outs).toBe(outs + 1)
    expect(events.some((e) => e.type === 'pitch')).toBe(false)
  })

  it('代打：板凳球員取代目前打者，原打者退場', () => {
    const g = findRunnerOnFirst()
    const benchPlayer = g.teams.home.bench[0]
    const original = g.batter
    g.issue({ type: 'pinchHit', benchIndex: 0 })
    expect(g.batter).toBe(benchPlayer)
    expect(g.teams.home.bench).not.toContain(benchPlayer)
    expect(g.teams.home.lineup.some((s) => s.player === original)).toBe(false)
  })

  it('代跑：板凳球員站上壘包，也接手該棒次', () => {
    const g = findRunnerOnFirst()
    const benchPlayer = g.teams.home.bench[1]
    g.issue({ type: 'pinchRun', base: 1, benchIndex: 1 })
    expect(g.bases[0]).toBe(benchPlayer)
    expect(g.teams.home.lineup.some((s) => s.player === benchPlayer)).toBe(true)
  })

  it('觸擊成功：打者出局、跑者推進', () => {
    let successes = 0
    for (let i = 0; i < 30; i++) {
      const g = findRunnerOnFirst()
      for (let k = 0; k < i; k++) g.step()
      if (!(g.battingSide === 'home' && g.bases[0] && g.outs < 2 && g.balls + g.strikes === 0)) continue
      const runner = g.bases[0]!
      g.issue({ type: 'bunt' })
      const play = g.step().find((e) => e.type === 'play')
      if (play?.type === 'play' && play.kind === 'sacrificeBunt') {
        successes++
        expect(g.bases[1]).toBe(runner)
      }
    }
    expect(successes).toBeGreaterThan(0)
  })

  it('故意四壞：打者直接上一壘，投手用球數 +4', () => {
    for (let seed = 1; seed < 50; seed++) {
      const g = new Game(setup(seed))
      while (!g.over && !(g.fieldingSide === 'home' && g.balls + g.strikes === 0 && !g.bases[0])) g.step()
      if (g.over) continue
      const batter = g.batter
      const count = g.teams.home.pitchCount
      g.issue({ type: 'intentionalWalk' })
      expect(g.bases[0]).toBe(batter)
      expect(g.teams.home.pitchCount).toBe(count + 4)
      return
    }
    throw new Error('找不到情境')
  })

  it('換投：後援上場，用球數歸零', () => {
    const g = new Game(setup(4))
    while (g.fieldingSide !== 'home') g.step()
    const reliever = g.teams.home.relievers[1]
    g.issue({ type: 'changePitcher', relieverIndex: 1 })
    expect(g.pitcher).toBe(reliever)
    expect(g.teams.home.pitchCount).toBe(0)
    expect(g.teams.home.relievers).toHaveLength(1)
  })

  it('不合法的指令會被拒絕（例如守備時盜壘）', () => {
    const g = new Game(setup(4))
    while (g.fieldingSide !== 'home') g.step()
    const steal: Tactic = { type: 'steal', from: 1 }
    expect(() => g.issue(steal)).toThrow()
  })
})

describe('延長賽', () => {
  it('第 10 局起每個半局開始時二壘有跑者', () => {
    for (let seed = 1; seed < 400; seed++) {
      const g = new Game(setup(seed))
      while (!g.over && g.inning < 10) g.step()
      if (g.over) continue
      expect(g.bases[1]).not.toBeNull()
      expect(g.outs).toBe(0)
      return
    }
    throw new Error('400 場都沒有延長賽')
  })
})

describe('投手疲勞', () => {
  it('玩家的投手累了會出現換投決策點', () => {
    const g = new Game(setup(8))
    while (!g.over && !g.decisionReasons().includes('fatigue')) g.step()
    expect(g.over).toBe(false)
    expect(g.fieldingSide).toBe('home')
    expect(g.isFatigued(g.teams.home)).toBe(true)
  })

  it('AI 的投手累過頭會自動換下', () => {
    const g = playOut(new Game(setup(8)))
    expect(g.teams.away.relievers.length).toBeLessThan(2)
  })
})
