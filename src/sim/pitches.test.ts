import { describe, expect, it } from 'vitest'
import { GUESS_ZONE, Game, replay, type GameEvent, type GameSetup, type Tactic } from './game'
import { generatePitcher, generateTeam } from './generate'
import { aiPitch, coldZone, hotZone, isBreaking, repertoire, spotZones, stance, type PitchGuess } from './pitches'
import { Rng } from './rng'

function setup(seed: number): GameSetup {
  return { home: generateTeam(new Rng(seed * 2 + 1)), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide: 'home' }
}

/** 推進到玩家可以親自出手的時候：swing 是主隊進攻、throw 是主隊守備 */
function findTakeOver(kind: 'swing' | 'throw', seed: number, rules?: number): Game | null {
  const g = new Game({ ...setup(seed), rules })
  while (!g.over) {
    if (g.balls + g.strikes === 0 && g.takeOver() === kind) return g
    g.step()
  }
  return null
}

/** 下一個指令後推進到這一球結束，回傳事件 */
function playPitch(g: Game, tactic: Tactic): GameEvent[] {
  g.issue(tactic)
  return g.step()
}

const HITS = new Set(['single', 'double', 'triple', 'homeRun'])

describe('球種與九宮格', () => {
  const pitchers = Array.from({ length: 200 }, (_, i) => generatePitcher(new Rng(i + 1)))

  it('每位投手一定有直球，再加 1～3 種不重複的變化球；同一位投手每次算出來都一樣', () => {
    const counts = new Set<number>()
    for (const p of pitchers) {
      const kinds = repertoire(p)
      expect(kinds[0]).toBe('fastball')
      expect(kinds.length).toBeGreaterThanOrEqual(2)
      expect(kinds.length).toBeLessThanOrEqual(4)
      expect(new Set(kinds).size).toBe(kinds.length)
      expect(repertoire(p)).toEqual(kinds)
      counts.add(kinds.length)
    }
    expect(counts.size).toBe(3)
  })

  it('九宮格：右打者的內角在左邊，左打者相反；正中間不屬於任何區塊', () => {
    expect(spotZones(0, 'R')).toEqual(['high', 'in'])
    expect(spotZones(0, 'L')).toEqual(['high', 'out'])
    expect(spotZones(8, 'R')).toEqual(['low', 'out'])
    expect(spotZones(4, 'R')).toEqual([])
    expect(spotZones(5, 'L')).toEqual(['in'])
  })

  it('熱區和弱點在正對面', () => {
    const g = new Game(setup(1))
    const b = g.batter
    const opposite = { high: 'low', low: 'high', in: 'out', out: 'in' }
    expect(coldZone(b)).toBe(opposite[hotZone(b)])
  })

  it('兩打站在投手的對側', () => {
    const g = new Game(setup(1))
    const b = { ...g.batter, bats: 'S' as const }
    expect(stance(b, { ...g.pitcher, throws: 'R' })).toBe('L')
    expect(stance(b, { ...g.pitcher, throws: 'L' })).toBe('R')
  })

  it('AI 配球：球數落後多投直球，兩好球後多投變化球；只投自己會的球種', () => {
    const rate = (balls: number, strikes: number) => {
      let fast = 0
      for (let i = 0; i < 2000; i++) {
        const p = pitchers[i % pitchers.length]
        const kind = aiPitch(7, i, p, balls, strikes)
        expect(repertoire(p)).toContain(kind)
        if (kind === 'fastball') fast++
      }
      return fast / 2000
    }
    expect(rate(3, 0)).toBeGreaterThan(rate(0, 2) + 0.25)
  })
})

describe('配球對決：出棒', () => {
  it('停得偏早往拉打方向飛、偏晚往推打方向飛', () => {
    // 右打者拉打是左外野（負角度）
    const angles = (side: -1 | 1) => {
      const out: number[] = []
      for (let seed = 1; seed <= 300; seed++) {
        const g = findTakeOver('swing', seed)
        if (!g) continue
        const zone = g.meterZone('swing')
        const pull = stance(g.batter, g.pitcher) === 'R' ? -1 : 1
        for (const e of playPitch(g, { type: 'swing', timing: zone.center + side * zone.good * 0.9 })) {
          if (e.type === 'play' && e.ball) out.push(e.ball.angle * pull)
        }
      }
      return out.reduce((a, b) => a + b, 0) / out.length
    }
    // 換算成「往拉打方向」的角度：偏早是正的、偏晚是負的
    expect(angles(-1)).toBeGreaterThan(10)
    expect(angles(1)).toBeLessThan(-10)
  })

  it('猜中直球或變化球，黃色區變寬；猜錯變窄', () => {
    const g = findTakeOver('swing', 1)!
    const plain = g.meterZone('swing').good
    const right: PitchGuess = isBreaking(g.nextPitch()) ? 'breaking' : 'fastball'
    const wrong: PitchGuess = right === 'breaking' ? 'fastball' : 'breaking'
    expect(g.guessRight(right)).toBe(true)
    expect(g.meterZone('swing', right).good).toBeCloseTo(plain * GUESS_ZONE.right)
    expect(g.meterZone('swing', wrong).good).toBeCloseTo(plain * GUESS_ZONE.wrong)
  })

  it('猜球只有新規則可以用；舊規則照舊', () => {
    const old = findTakeOver('swing', 1, 4)!
    expect(() => old.issue({ type: 'swing', timing: 0.8, guess: 'fastball' })).toThrow()
    expect(old.meterZone('swing', 'fastball')).toEqual(old.meterZone('swing'))
  })

  it('親自出棒的這一球會標出對方投的球種', () => {
    const g = findTakeOver('swing', 2)!
    const kind = g.nextPitch()
    const pitch = playPitch(g, { type: 'swing', timing: 0.8 }).find((e) => e.type === 'pitch')
    expect(pitch?.type === 'pitch' && pitch.pitch).toBe(kind)
  })
})

describe('配球對決：投球', () => {
  it('只能投自己會的球種、九宮格 0～8、準確度 0～1', () => {
    const g = findTakeOver('throw', 1)!
    const kinds = repertoire(g.pitcher)
    const missing = (['slider', 'curve', 'change', 'splitter'] as const).find((k) => !kinds.includes(k))
    if (missing) expect(() => g.issue({ type: 'throw', pitch: missing, spot: 0, accuracy: 1 })).toThrow()
    expect(() => g.issue({ type: 'throw', pitch: 'fastball', spot: 9, accuracy: 1 })).toThrow()
    expect(() => g.issue({ type: 'throw', pitch: 'fastball', spot: 0, accuracy: 1.2 })).toThrow()
    expect(() => g.issue({ type: 'aimPitch', timing: 0.8 })).toThrow()
    g.issue({ type: 'throw', pitch: 'fastball', spot: 0, accuracy: 1 })
    expect(g.takeOver()).toBeNull()
  })

  it('手勢門檻：控球越好越寬鬆，體力越低越嚴', () => {
    const g = findTakeOver('throw', 1)!
    g.pitcher.ratings.control = 9
    const good = g.gestureZone().good
    g.pitcher.ratings.control = 2
    expect(g.gestureZone().good).toBeGreaterThan(good)
    const fresh = g.gestureZone().good
    g.fielding.pitchCount += 80
    expect(g.gestureZone().good).toBeGreaterThan(fresh)
    expect(g.gradeGesture(1)).toBe('perfect')
    expect(g.gradeGesture(0)).toBe('miss')
  })

  it('同一個打席連投同一種球，對投手比較不利；換打者就重新算', () => {
    const g = findTakeOver('throw', 3)!
    const before = g.pitchEdge('fastball', 0)
    const pa = g.paIndex
    playPitch(g, { type: 'throw', pitch: 'fastball', spot: 0, accuracy: 1 })
    if (g.paIndex === pa) expect(g.pitchEdge('fastball', 0)).toBeCloseTo(before - 0.2)
    else expect(g.pitchEdge('fastball', 0)).not.toBe(before - 0.2)
    expect(g.previousThrow === null || g.paIndex === pa).toBe(true)
  })

  it('投在打者弱點的角落、畫得準，比畫歪的正中間球更少被打安打', () => {
    const hitRate = (good: boolean) => {
      let hits = 0
      let n = 0
      for (let seed = 1; seed <= 400; seed++) {
        const g = findTakeOver('throw', seed)
        if (!g) continue
        const hand = stance(g.batter, g.pitcher)
        const cold = coldZone(g.batter)
        const corner = [0, 2, 6, 8].find((s) => spotZones(s, hand).includes(cold))!
        const events = playPitch(g, good ? { type: 'throw', pitch: 'fastball', spot: corner, accuracy: 1 } : { type: 'throw', pitch: 'fastball', spot: 4, accuracy: 0 })
        n++
        if (events.some((e) => e.type === 'play' && HITS.has(e.kind))) hits++
      }
      return hits / n
    }
    expect(hitRate(true)).toBeLessThan(hitRate(false) - 0.1)
  })

  it('不選位置也能投：沒有位置的加減，畫得準還是比畫歪好', () => {
    const g = findTakeOver('throw', 1)!
    expect(g.pitchEdge('fastball', undefined, true)).toBeCloseTo(0.5 + (repertoire(g.pitcher)[1] === 'fastball' ? 0.05 : 0))
    const hitRate = (accuracy: number) => {
      let hits = 0
      let n = 0
      for (let seed = 1; seed <= 400; seed++) {
        const game = findTakeOver('throw', seed)
        if (!game) continue
        n++
        if (playPitch(game, { type: 'throw', pitch: 'fastball', accuracy }).some((e) => e.type === 'play' && HITS.has(e.kind))) hits++
      }
      return hits / n
    }
    expect(hitRate(1)).toBeLessThan(hitRate(0) - 0.1)
  })

  it('配球的紀錄可以重播出一樣的比賽（ADR-0001）', () => {
    const g = findTakeOver('throw', 5)!
    g.issue({ type: 'throw', pitch: repertoire(g.pitcher).at(-1)!, spot: 6, accuracy: 0.83 })
    g.step()
    // 新的紀錄不帶位置
    while (!g.over && g.takeOver() !== 'throw') g.step()
    if (!g.over) g.issue({ type: 'throw', pitch: 'fastball', accuracy: 0.9 })
    while (!g.over && g.takeOver() !== 'swing') g.step()
    if (!g.over) g.issue({ type: 'swing', timing: 0.74, guess: 'breaking' })
    while (!g.over) g.step()
    const again = replay(setup(5), g.commands)
    while (!again.over) again.step()
    expect(again.score).toEqual(g.score)
    expect(again.linescore).toEqual(g.linescore)
  })
})
