import { describe, expect, it } from 'vitest'
import { ALIGNMENT_SPOTS, Game, fenceDistance, fielderFor, homeRunStats, replay, type Alignment, type GameEvent, type GameSetup, type Tactic } from './game'
import { generateBatter, generatePitcher, generateTeam } from './generate'
import { applyGrowth, gameGrowth, performance } from './growth'
import { Rng } from './rng'
import { TRAITS, conflicts, type TraitId } from './traits'
import type { Pitcher, Team } from './types'

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

  it('AI 的投手累過頭會自動換下：大多數比賽 AI 都會用到後援', () => {
    let used = 0
    for (let seed = 1; seed <= 100; seed++) {
      const s = setup(seed)
      const g = playOut(new Game(s))
      if (g.teams.away.relievers.length < s.away.roster.relievers.length) used++
    }
    expect(used).toBeGreaterThan(70)
  })
})

describe('親自出手（計量條）', () => {
  /** 推進到某一方進攻、打席剛開始、而且是關鍵時刻 */
  function findTakeOver(kind: 'swing' | 'aimPitch', from = 1): Game {
    for (let seed = from; seed < from + 400; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        if (g.balls + g.strikes === 0 && g.takeOver() === kind) return g
        g.step()
      }
    }
    throw new Error('找不到情境')
  }

  /** 從關鍵時刻出手一次，回傳這個打席的結果類型 */
  function playAt(kind: 'swing' | 'aimPitch', timing: number, from: number): string {
    const g = findTakeOver(kind, from)
    const pa = g.paIndex
    g.issue({ type: kind, timing })
    const events = g.step()
    while (!g.over && g.paIndex === pa && !events.some((e) => e.type === 'play')) events.push(...g.step())
    const play = events.find((e) => e.type === 'play')
    return play?.type === 'play' ? play.kind : 'none'
  }

  const HITS = new Set(['single', 'double', 'triple', 'homeRun'])
  const hitRate = (kind: 'swing' | 'aimPitch', timing: number) => {
    const kinds = Array.from({ length: 120 }, (_, i) => playAt(kind, timing, i * 3 + 1))
    return kinds.filter((k) => HITS.has(k)).length / kinds.length
  }

  it('任何時候都能用（關鍵時刻或教練暫停），每個打席一次，進攻是出棒、守備是決勝球', () => {
    // 比賽剛開始、不是關鍵時刻，主隊守備也能投決勝球
    const start = new Game(setup(1))
    expect(start.isCrunchTime()).toBe(false)
    expect(start.takeOver()).toBe('aimPitch')
    // 打席中途（已經有球數）也可以
    while (start.balls + start.strikes === 0) start.step()
    if (!start.over && start.paIndex === 0) expect(start.takeOver()).not.toBeNull()

    const g = findTakeOver('swing')
    g.issue({ type: 'swing', timing: 0.8 })
    expect(g.takeOver()).toBeNull()
    expect(() => g.issue({ type: 'swing', timing: 0.8 })).toThrow()
    expect(findTakeOver('aimPitch').fieldingSide).toBe('home')
    expect(() => new Game(setup(1)).issue({ type: 'swing', timing: 0.8 })).toThrow()
  })

  it('目標區：打擊越好越寬；投手體力越低越窄', () => {
    const g = findTakeOver('swing')
    const zone = g.meterZone('swing')
    g.batter.ratings.contact = 9
    const wide = g.meterZone('swing')
    g.batter.ratings.contact = 2
    const narrow = g.meterZone('swing')
    expect(wide.good).toBeGreaterThan(narrow.good)
    expect(zone.perfect).toBeLessThan(zone.good)

    const p = findTakeOver('aimPitch')
    const fresh = p.meterZone('aimPitch')
    p.fielding.pitchCount += 80
    expect(p.meterZone('aimPitch').good).toBeLessThan(fresh.good)
  })

  it('完美出棒的安打率明顯高於太晚出棒，但不是保證安打', () => {
    const perfect = hitRate('swing', 0.8)
    const late = hitRate('swing', 1)
    expect(perfect).toBeGreaterThan(late + 0.2)
    expect(perfect).toBeLessThan(1)
  })

  it('完美的決勝球被打出安打的機率低於失手的球', () => {
    expect(hitRate('aimPitch', 0.8)).toBeLessThan(hitRate('aimPitch', 0.2))
  })

  it('出手紀錄可以重播出一樣的比賽（ADR-0001）', () => {
    const g = findTakeOver('swing')
    g.issue({ type: 'swing', timing: 0.734 })
    playOut(g)
    const again = playOut(replay(setup(findSeed(g)), g.commands))
    expect(again.score).toEqual(g.score)
    expect(again.linescore).toEqual(g.linescore)
  })

  /** 找出這場比賽用的種子（setup 的種子等於 Game 建立時的種子） */
  function findSeed(g: Game): number {
    for (let seed = 1; seed < 500; seed++) {
      const s = setup(seed)
      if (s.home.name === g.teams.home.name && s.away.name === g.teams.away.name) return seed
    }
    throw new Error('找不到種子')
  }
})

describe('全壘打數據', () => {
  /** 收集很多場比賽的全壘打，連同打者的力量 */
  function collect(): { ball: NonNullable<Extract<GameEvent, { type: 'play' }>['ball']>; power: number }[] {
    const out: { ball: NonNullable<Extract<GameEvent, { type: 'play' }>['ball']>; power: number }[] = []
    for (let seed = 1; seed <= 200; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        const power = g.batter.ratings.power
        for (const e of g.step()) if (e.type === 'play' && e.kind === 'homeRun' && e.ball) out.push({ ball: e.ball, power })
      }
    }
    return out
  }
  const all = collect()

  it('仰角在 24～34 度，初速在合理範圍，同一顆球每次算出一樣的數字', () => {
    expect(all.length).toBeGreaterThan(50)
    for (const { ball } of all) {
      const s = homeRunStats(ball)
      expect(s.launchAngle).toBeGreaterThanOrEqual(24)
      expect(s.launchAngle).toBeLessThanOrEqual(34)
      expect(s.exitVelocityMph).toBeGreaterThan(90)
      expect(s.exitVelocityMph).toBeLessThan(125)
      expect(homeRunStats(ball)).toEqual(s)
    }
  })

  it('力量大的打者，全壘打平均飛得比較遠', () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const strong = all.filter((h) => h.power >= 7).map((h) => h.ball.distance)
    const weak = all.filter((h) => h.power <= 4).map((h) => h.ball.distance)
    expect(avg(strong)).toBeGreaterThan(avg(weak))
  })
})

describe('全壘打牆', () => {
  it('兩邊淺、中間深：標竿約 101 公尺，中外野約 122 公尺', () => {
    expect(fenceDistance(45)).toBeCloseTo(330)
    expect(fenceDistance(-45)).toBeCloseTo(330)
    expect(fenceDistance(0)).toBeCloseTo(400)
    expect(fenceDistance(20)).toBeGreaterThan(fenceDistance(40))
  })

  it('全壘打一定飛過該方向的牆，其他擊球一定落在牆前', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        for (const e of g.step()) {
          if (e.type !== 'play' || !e.ball) continue
          const fence = fenceDistance(e.ball.angle)
          if (e.kind === 'homeRun') expect(e.ball.distance).toBeGreaterThan(fence)
          else expect(e.ball.distance).toBeLessThan(fence)
        }
      }
    }
  })
})

describe('安打的落點', () => {
  it('滾地安打穿過內野手之間，平飛與長打落在外野手之間或邊線（依當時的佈陣）', () => {
    const gapTo = (angle: number, spots: number[]) => Math.min(...spots.map((s) => Math.abs(s - angle)))
    let checked = 0
    for (let seed = 1; seed <= 100; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        const spots = ALIGNMENT_SPOTS[g.alignment]
        const INFIELD = (['3B', 'SS', '2B', '1B'] as const).map((p) => spots[p][0])
        const OUTFIELD = (['LF', 'CF', 'RF'] as const).map((p) => spots[p][0])
        for (const e of g.step()) {
          if (e.type !== 'play' || !e.ball || !['single', 'double', 'triple'].includes(e.kind)) continue
          checked++
          // 一壘安打（滾地或落在外野手前方）要避開內野手；二、三壘安打要穿過外野手之間
          if (e.kind === 'single') expect(gapTo(e.ball.angle, INFIELD)).toBeGreaterThanOrEqual(4)
          else expect(gapTo(e.ball.angle, OUTFIELD)).toBeGreaterThanOrEqual(5)
        }
      }
    }
    expect(checked).toBeGreaterThan(500)
  })
})

describe('守備佈陣與擊球傾向', () => {
  type Strategy = (g: Game) => Alignment | null
  /** 玩家（主隊）每次守備的打席開始都依策略佈陣，回傳對手所有場內擊球的結果 */
  function playWith(strategy: Strategy, games = 250): Extract<GameEvent, { type: 'play' }>[] {
    const plays: Extract<GameEvent, { type: 'play' }>[] = []
    for (let seed = 1; seed <= games; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        if (g.fieldingSide === 'home' && g.balls + g.strikes === 0) {
          const a = strategy(g)
          if (a && a !== g.alignment) g.issue({ type: 'alignment', alignment: a })
        }
        const userFielding = g.fieldingSide === 'home'
        for (const e of g.step()) if (userFielding && e.type === 'play' && e.ball) plays.push(e)
      }
    }
    return plays
  }
  const HITS = new Set(['single', 'double', 'triple', 'homeRun'])
  const hitRate = (plays: { kind: string }[]) => plays.filter((p) => HITS.has(p.kind)).length / plays.length

  it('每位打者都有擊球方向傾向，大約偏左、偏右各三成', () => {
    const rng = new Rng(9)
    const ts = Array.from({ length: 2000 }, () => generateBatter(rng).tendency)
    const share = (t: string) => ts.filter((x) => x === t).length / ts.length
    expect(share('left')).toBeGreaterThan(0.22)
    expect(share('right')).toBeGreaterThan(0.22)
    expect(share('even')).toBeGreaterThan(0.3)
  })

  it('偏左的打者，擊球平均偏向左外野', () => {
    const angles = { left: [] as number[], right: [] as number[] }
    for (let seed = 1; seed <= 100; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        const t = g.batter.tendency
        for (const e of g.step()) if (e.type === 'play' && e.ball && t !== 'even') angles[t].push(e.ball.angle)
      }
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(avg(angles.left)).toBeLessThan(-5)
    expect(avg(angles.right)).toBeGreaterThan(5)
  })

  it('只有守備時能佈陣，打席結束就恢復標準', () => {
    const g = new Game(setup(1))
    expect(g.fieldingSide).toBe('home')
    g.issue({ type: 'alignment', alignment: 'shiftLeft' })
    expect(g.alignment).toBe('shiftLeft')
    const pa = g.paIndex
    while (g.paIndex === pa) g.step()
    expect(g.alignment).toBe('normal')
    while (g.fieldingSide === 'home') g.step()
    expect(() => g.issue({ type: 'alignment', alignment: 'shiftLeft' })).toThrow()
  })

  it('猜對方向的佈陣讓對手安打變少，猜錯方向反而變多', () => {
    const toward = (g: Game): Alignment => (g.batter.tendency === 'left' ? 'shiftLeft' : g.batter.tendency === 'right' ? 'shiftRight' : 'normal')
    const away = (g: Game): Alignment => (g.batter.tendency === 'left' ? 'shiftRight' : g.batter.tendency === 'right' ? 'shiftLeft' : 'normal')
    const normal = hitRate(playWith(() => null))
    expect(hitRate(playWith(toward))).toBeLessThan(normal - 0.02)
    expect(hitRate(playWith(away))).toBeGreaterThan(normal + 0.02)
  })

  it('內野前進：滾地球出局時，三壘跑者沒被迫進壘就回不來', () => {
    const plays = playWith(() => 'infieldIn', 150)
    const grounders = plays.filter((p) => p.kind === 'groundOut' && p.moves.some((m) => m.from === 3))
    expect(grounders.length).toBeGreaterThan(5)
    for (const p of grounders) {
      const home = p.moves.find((m) => m.from === 3)!
      const forced = p.moves.some((m) => m.from === 1) && p.moves.some((m) => m.from === 2)
      if (home.to === 4) expect(forced).toBe(true)
    }
  })

  it('外野後退：被打的安打裡，長打比例明顯變少', () => {
    const extra = (plays: { kind: string }[]) => {
      const hits = plays.filter((p) => HITS.has(p.kind) && p.kind !== 'homeRun')
      return hits.filter((p) => p.kind !== 'single').length / hits.length
    }
    expect(extra(playWith(() => 'outfieldBack', 150))).toBeLessThan(extra(playWith(() => null, 150)) * 0.7)
  })
})

describe('AI 的守備佈陣', () => {
  /** 掃過很多場比賽，在每個打席開始時檢查 */
  function eachAtBat(check: (g: Game) => void, games = 120, rules?: number): void {
    for (let seed = 1; seed <= games; seed++) {
      const g = new Game({ ...setup(seed), rules })
      let pa = -1
      while (!g.over) {
        if (g.paIndex !== pa && g.balls + g.strikes === 0) {
          pa = g.paIndex
          check(g)
        }
        g.step()
      }
    }
  }

  it('玩家進攻時，AI 對有明顯方向的強打者佈陣，弱打者維持標準（打席開始前就看得到）', () => {
    let shifted = 0
    eachAtBat((g) => {
      if (g.battingSide !== 'home' || g.bases[2] || g.inning >= 8) return
      const b = g.batter
      const strong = b.ratings.contact + b.ratings.power >= 11
      const expected = strong && b.tendency === 'left' ? 'shiftLeft' : strong && b.tendency === 'right' ? 'shiftRight' : 'normal'
      expect(g.alignment).toBe(expected)
      if (expected !== 'normal') shifted++
    })
    expect(shifted).toBeGreaterThan(50)
  })

  it('AI 在後段一分都不能給、三壘有人且少於兩出局時內野前進', () => {
    let seen = 0
    eachAtBat((g) => {
      if (g.battingSide !== 'home') return
      const lead = g.score.away - g.score.home
      if (g.bases[2] && g.outs < 2 && g.inning >= 7 && lead >= 0 && lead <= 1) {
        expect(g.alignment).toBe('infieldIn')
        seen++
      }
    }, 300)
    expect(seen).toBeGreaterThan(3)
  })

  it('玩家守備時，打席開始一律是標準站位，由玩家自己決定', () => {
    eachAtBat((g) => {
      if (g.fieldingSide === 'home') expect(g.alignment).toBe('normal')
    })
  })

  it('舊規則（版本 1）的比賽，AI 不佈陣', () => {
    eachAtBat((g) => expect(g.alignment).toBe('normal'), 60, 1)
  })

  it('對手偏移佈陣時觸擊比較容易成功', () => {
    const g = new Game(setup(1))
    // 打擊差、沒有觸擊特性，成功率才不會一開始就碰到上限
    g.batter.ratings.contact = 3
    g.batter.traits = []
    const base = g.buntChance()
    g.alignment = 'shiftLeft'
    expect(g.buntChance()).toBeGreaterThan(base)
    g.alignment = 'infieldIn'
    expect(g.buntChance()).toBeLessThan(base)
  })
})

describe('左右投打相剋', () => {
  it('打者大多右打、也有左打與兩打；投手大多右投', () => {
    const rng = new Rng(11)
    const bats = Array.from({ length: 2000 }, () => generateBatter(rng).bats)
    const share = (h: string) => bats.filter((b) => b === h).length / bats.length
    expect(share('R')).toBeGreaterThan(0.5)
    expect(share('L')).toBeGreaterThan(0.25)
    expect(share('S')).toBeGreaterThan(0.03)
    const throws = Array.from({ length: 2000 }, () => generatePitcher(rng).throws)
    expect(throws.filter((t) => t === 'R').length / throws.length).toBeGreaterThan(0.6)
  })

  it('兩打永遠站對側；同手是同側', () => {
    const g = new Game(setup(1))
    const b = { ...g.batter }
    const p = { ...g.pitcher, throws: 'R' as const }
    expect(g.matchup({ ...b, bats: 'S' }, p)).toBe('opposite')
    expect(g.matchup({ ...b, bats: 'R' }, p)).toBe('same')
    expect(g.matchup({ ...b, bats: 'L' }, p)).toBe('opposite')
  })

  it('同側對決的安打率明顯低於對側；舊規則（版本 2）沒有差別', () => {
    const rate = (rules?: number) => {
      const r = { same: [0, 0], opposite: [0, 0] }
      for (let seed = 1; seed <= 250; seed++) {
        const g = new Game({ ...setup(seed), rules })
        while (!g.over) {
          const m = g.matchup()
          for (const e of g.step()) {
            if (e.type !== 'play' || e.kind === 'walk' || e.kind === 'intentionalWalk') continue
            r[m][1]++
            if (['single', 'double', 'triple', 'homeRun'].includes(e.kind)) r[m][0]++
          }
        }
      }
      return { same: r.same[0] / r.same[1], opposite: r.opposite[0] / r.opposite[1] }
    }
    const now = rate()
    expect(now.opposite - now.same).toBeGreaterThan(0.02)
    const old = rate(2)
    expect(Math.abs(old.opposite - old.same)).toBeLessThan(0.015)
  })
})

describe('個人成績與錦標賽成長', () => {
  const games = Array.from({ length: 60 }, (_, i) => playOut(new Game(setup(i + 1))))

  it('個人安打加總等於球隊安打；投手抓的出局數至少 24 個', () => {
    for (const g of games) {
      for (const side of ['home', 'away'] as const) {
        const ids = [...g.rosterIds(side)]
        const hits = ids.reduce((n, id) => n + (g.box[id]?.hits ?? 0), 0)
        expect(hits).toBe(g.hits[side])
        const other = side === 'home' ? 'away' : 'home'
        const outs = [...g.rosterIds(other)].reduce((n, id) => n + (g.box[id]?.outs ?? 0), 0)
        expect(outs).toBeGreaterThanOrEqual(24)
      }
    }
  })

  it('每場最多一位 MVP（+1），其他成長都是 +0.5，而且不超過 10', () => {
    for (const g of games) {
      const growth = gameGrowth(g, 'home')
      expect(growth.filter((x) => x.mvp).length).toBeLessThanOrEqual(1)
      for (const x of growth) {
        expect(x.amount).toBeLessThanOrEqual(x.mvp ? 1 : 0.5)
        const p = g.player(x.playerId)!
        expect((p.ratings as unknown as Record<string, number>)[x.rating] + x.amount).toBeLessThanOrEqual(10)
      }
    }
    expect(games.filter((g) => gameGrowth(g, 'home').some((x) => x.mvp)).length).toBeGreaterThan(40)
  })

  it('MVP 是表現分最高的人：有全壘打的打者長力量', () => {
    for (const g of games) {
      const growth = gameGrowth(g, 'home')
      const mvp = growth.find((x) => x.mvp)
      if (!mvp) continue
      const p = g.player(mvp.playerId)!
      const best = Math.max(...[...g.rosterIds('home')].filter((id) => g.box[id]).map((id) => performance(g.player(id)!, g.box[id])))
      expect(performance(p, g.box[p.id])).toBe(best)
      if (p.role === 'batter') expect(mvp.rating).toBe(g.box[p.id].hr > 0 ? 'power' : 'contact')
    }
  })

  it('applyGrowth 只改到成長名單上的球員，上限 10', () => {
    const roster = setup(3).home.roster
    const target = roster.lineup[0].player
    const grown = applyGrowth(roster, [{ playerId: target.id, rating: 'contact', amount: 1, mvp: true }])
    expect(grown.lineup[0].player.ratings.contact).toBe(Math.min(10, target.ratings.contact + 1))
    expect(grown.lineup[1].player).toBe(roster.lineup[1].player)
    expect(roster.lineup[0].player.ratings.contact).toBe(target.ratings.contact)
  })
})

describe('AI 的左右相剋調度', () => {
  type Sub = Extract<GameEvent, { type: 'substitution' }>
  /** 跑很多場，收集 AI（客隊）的換人與當時的情況 */
  function aiSubs(rules?: number, games = 300) {
    const found: { e: Sub; g: Game; inning: number; diff: number }[] = []
    for (let seed = 1; seed <= games; seed++) {
      const g = new Game({ ...setup(seed), rules })
      while (!g.over) {
        const inning = g.inning
        const diff = Math.abs(g.score.home - g.score.away)
        for (const e of g.step()) if (e.type === 'substitution' && e.side === 'away') found.push({ e, g, inning, diff })
      }
    }
    return found
  }

  it('AI 會換上同手的後援對付對側的打者，也會派對側的代打', () => {
    const subs = aiSubs()
    expect(subs.filter((s) => s.e.kind === 'pinchHit').length).toBeGreaterThan(10)
    // 換投包含體力用盡的換投，所以只檢查有出現
    expect(subs.filter((s) => s.e.kind === 'pitcher').length).toBeGreaterThan(10)
  })

  /** 打席開始時 AI 的調度：出現在同一步的比賽結果（play）之後，比賽狀態已經是下一個打席 */
  function platoonMoves(seeds: number, onMove: (e: Sub, g: Game) => void, before?: (g: Game) => void) {
    for (let seed = 1; seed <= seeds; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        before?.(g)
        const events = g.step()
        const playAt = events.findIndex((e) => e.type === 'play' || e.type === 'steal')
        events.forEach((e, i) => {
          if (i > playAt && playAt >= 0 && e.type === 'substitution' && e.side === 'away') onMove(e, g)
        })
      }
    }
  }

  it('AI 派的代打一定是對側，只在第 7 局後、比分差 2 分以內', () => {
    let n = 0
    platoonMoves(300, (e, g) => {
      if (e.kind !== 'pinchHit') return
      n++
      expect(g.inning).toBeGreaterThanOrEqual(7)
      expect(Math.abs(g.score.home - g.score.away)).toBeLessThanOrEqual(2)
      expect(g.batter.id).toBe(e.inId)
      expect(g.matchup()).toBe('opposite')
    })
    expect(n).toBeGreaterThan(10)
  })

  it('AI 換上的後援跟打者同手（同側），而且至少留一位後援', () => {
    let n = 0
    platoonMoves(300, (e, g) => {
      if (e.kind !== 'pitcher') return
      n++
      expect(g.pitcher.id).toBe(e.inId)
      expect(g.matchup()).toBe('same')
      expect(g.teams.away.relievers.length).toBeGreaterThanOrEqual(1)
    })
    expect(n).toBeGreaterThan(5)
  })

  it('玩家換代打，AI 可能立刻換投回應', () => {
    let responses = 0
    for (let seed = 1; seed <= 300; seed++) {
      const g = new Game(setup(seed))
      while (!g.over) {
        if (g.battingSide === 'home' && g.balls + g.strikes === 0 && g.inning >= 7 && g.teams.home.bench.length > 0) {
          const events = g.issue({ type: 'pinchHit', benchIndex: 0 })
          if (events.some((e) => e.type === 'substitution' && e.side === 'away')) responses++
        }
        g.step()
      }
    }
    expect(responses).toBeGreaterThan(3)
  })

  it('舊規則（版本 3）的比賽，AI 不做左右相剋調度', () => {
    const subs = aiSubs(3, 150)
    expect(subs.filter((s) => s.e.kind === 'pinchHit').length).toBe(0)
  })

  it('加了 AI 調度後，平均得分仍在合理範圍', () => {
    let runs = 0
    const n = 300
    for (let seed = 1; seed <= n; seed++) runs += playOut(new Game(setup(seed))).score.away
    expect(runs / n).toBeGreaterThan(3)
    expect(runs / n).toBeLessThan(6)
  })
})

describe('特性', () => {
  it('大約四分之三的球員至少有一個特性，好特性比壞特性多', () => {
    const rng = new Rng(77)
    const players = Array.from({ length: 3000 }, (_, i) => (i % 3 ? generateBatter(rng) : generatePitcher(rng)))
    const withTrait = players.filter((p) => p.traits.length > 0).length / players.length
    expect(withTrait).toBeGreaterThan(0.68)
    expect(withTrait).toBeLessThan(0.85)
    const tiers = players.flatMap((p) => p.traits.map((t) => TRAITS[t].tier))
    expect(tiers.filter((t) => t === 'blue').length).toBeGreaterThan(tiers.filter((t) => t === 'red').length)
    // 新的特性都抽得到
    const seen = new Set(players.flatMap((p) => p.traits))
    for (const id of Object.keys(TRAITS)) expect(seen.has(id as keyof typeof TRAITS)).toBe(true)
  })

  it('互斥的特性不會同時出現', () => {
    const rng = new Rng(5)
    for (let i = 0; i < 3000; i++) {
      const p = i % 2 ? generateBatter(rng) : generatePitcher(rng)
      for (const a of p.traits) for (const b of p.traits) expect(conflicts(a, b)).toBe(false)
    }
  })

  /** 把某一隊的投手全部加上（或拿掉）某個特性，跑很多場統計被打出的結果 */
  function pitchWith(trait: TraitId | null, games = 200) {
    let homers = 0
    let grounders = 0
    let outs = 0
    for (let seed = 1; seed <= games; seed++) {
      const s = setup(seed)
      const strip = (p: Pitcher): Pitcher => ({ ...p, traits: trait ? [trait] : [] })
      const roster = s.home.roster
      const home = { ...s.home, roster: { ...roster, starter: strip(roster.starter), relievers: roster.relievers.map(strip) } }
      const g = new Game({ ...s, home })
      while (!g.over) {
        const homeFielding = g.fieldingSide === 'home'
        for (const e of g.step()) {
          if (!homeFielding || e.type !== 'play') continue
          if (e.kind === 'homeRun') homers++
          if (e.kind === 'groundOut' || e.kind === 'doublePlay') grounders++
          if (['groundOut', 'doublePlay', 'flyOut', 'lineOut', 'sacrificeFly'].includes(e.kind)) outs++
        }
      }
    }
    return { homers, groundShare: grounders / outs }
  }

  it('滾地球投手：滾地球出局比例變高、全壘打變少；被全壘打的投手全壘打變多', () => {
    const plain = pitchWith(null)
    const sinker = pitchWith('groundballer')
    expect(sinker.groundShare).toBeGreaterThan(plain.groundShare + 0.05)
    expect(sinker.homers).toBeLessThan(plain.homers)
    expect(pitchWith('homerProne').homers).toBeGreaterThan(plain.homers)
  })

  it('體力差的投手比較早累；鐵腕比較晚', () => {
    const g = new Game(setup(1))
    const p = { ...g.pitcher, traits: [] as TraitId[] }
    expect(g.fatigueLimit({ ...p, traits: ['lowStamina'] })).toBeLessThan(g.fatigueLimit(p))
    expect(g.fatigueLimit({ ...p, traits: ['ironArm'] })).toBeGreaterThan(g.fatigueLimit(p))
  })
})
