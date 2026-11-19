// @vitest-environment node
/// <reference types="vite/client" />
// 自責分（ER）的驗證（PR #18 review P2）：
// 1. 規格裡的 10 種情境，各用一段「正式引擎真的會產生」的事件序列做單元測試；
// 2. 用大量真實模擬比賽「挖」出每一種情境，用跟 Scorekeeper 無關的獨立計算（只看事件流）交叉比對，
//    證明單元測試的序列真的會發生、而且整場比賽裡每一分的判斷都一致；
// 3. 已知限制（失誤造成的額外推進）量化出現頻率，不宣稱完全符合 OBR 9.16。
import { describe, expect, it } from 'vitest'
import { goldenCases, playGolden, type GoldenCase } from './__golden__/cases'
import type { GameEvent, RunnerMove, Side } from './game'
import { generateTeam } from './generate'
import { Rng } from './rng'
import { Scorekeeper, type PlayInput, type RunRecord } from './scoring'
import type { MatchAi } from '../v2/application/matchRunner'

const batter = (id: string, to: RunnerMove['to']): RunnerMove => ({ runnerId: id, from: 0, to })
const runner = (id: string, from: 1 | 2 | 3, to: RunnerMove['to']): RunnerMove => ({ runnerId: id, from, to })
const play = (s: Scorekeeper, p: Partial<PlayInput> & Pick<PlayInput, 'kind' | 'batterId' | 'moves'>) => s.play({ pitcherId: 'P1', ballType: null, outsBefore: 0, ...p })
const er = (s: Scorekeeper, id = 'P1') => s.lines[id]?.pitching?.er ?? 0
const r = (s: Scorekeeper, id = 'P1') => s.lines[id]?.pitching?.r ?? 0

describe('自責分：10 種情境（引擎會產生的事件序列）', () => {
  it('1. 無失誤半局：ER = R', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'walk', batterId: 'A', moves: [batter('A', 1)] })
    play(s, { kind: 'double', batterId: 'B', moves: [runner('A', 1, 3), batter('B', 2)] })
    play(s, { kind: 'groundOut', batterId: 'C', ballType: 'ground', moves: [batter('C', 'out'), runner('A', 3, 4), runner('B', 2, 3)] })
    play(s, { kind: 'single', batterId: 'D', outsBefore: 1, moves: [runner('B', 3, 4), batter('D', 1)] })
    expect([r(s), er(s)]).toEqual([2, 2])
  })

  it('2. 失誤上壘的跑者得分：非自責', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'error', batterId: 'A', ballType: 'ground', moves: [batter('A', 1)] })
    play(s, { kind: 'double', batterId: 'B', moves: [runner('A', 1, 4), batter('B', 2)] })
    expect([r(s), er(s)]).toEqual([1, 0])
  })

  it('3. 兩出局後失誤，接著全壘打：重建後已經三出局，全部非自責', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'strikeout', batterId: 'A', moves: [batter('A', 'out')] })
    play(s, { kind: 'flyOut', batterId: 'B', outsBefore: 1, ballType: 'fly', moves: [batter('B', 'out')] })
    play(s, { kind: 'single', batterId: 'C', outsBefore: 2, moves: [batter('C', 1)] })
    play(s, { kind: 'error', batterId: 'D', outsBefore: 2, ballType: 'ground', moves: [runner('C', 1, 2), batter('D', 1)] })
    play(s, { kind: 'homeRun', batterId: 'E', outsBefore: 2, moves: [runner('C', 2, 4), runner('D', 1, 4), batter('E', 4)] })
    expect([r(s), er(s)]).toEqual([3, 0])
  })

  it('4. 失誤讓跑者多推進：目前不扣掉多推進的壘包（已知限制，可能高估 ER）', () => {
    // 外野失誤：一壘跑者推進兩個壘到三壘（引擎 reachOnError 的外野規則），下一棒高飛犧牲打送回
    const s = new Scorekeeper()
    play(s, { kind: 'single', batterId: 'A', moves: [batter('A', 1)] })
    play(s, { kind: 'error', batterId: 'B', ballType: 'fly', moves: [runner('A', 1, 3), batter('B', 1)] })
    play(s, { kind: 'sacrificeFly', batterId: 'C', ballType: 'fly', moves: [batter('C', 'out'), runner('A', 3, 4)] })
    // 正式記錄員會把失誤當出局、A 留在一壘，高飛球不會讓他回來 → 非自責；這裡算自責
    expect([r(s), er(s)]).toEqual([1, 1])
    expect(s.runLog[0]).toMatchObject({ reach: 'batted', errorBases: 2, earned: true })
  })

  it('5. 雙殺機會發生失誤：失誤只算一個出局機會（不假設會成雙殺）', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'single', batterId: 'A', moves: [batter('A', 1)] })
    // 一壘有人、無人出局的滾地球被失誤
    play(s, { kind: 'error', batterId: 'B', ballType: 'ground', moves: [runner('A', 1, 2), batter('B', 1)] })
    play(s, { kind: 'strikeout', batterId: 'C', moves: [batter('C', 'out')] })
    // 重建：失誤 = 1 出局，C 三振 = 2 出局，所以 D 的全壘打時重建出局數是 2，A、D 是自責；B 失誤上壘非自責
    play(s, { kind: 'homeRun', batterId: 'D', outsBefore: 1, moves: [runner('A', 2, 4), runner('B', 1, 4), batter('D', 4)] })
    expect([r(s), er(s)]).toEqual([3, 2])
  })

  it('6. 換投前留下的繼承跑者得分：算前一位投手', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'double', batterId: 'A', moves: [batter('A', 2)] })
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'single', batterId: 'B', pitcherId: 'P2', moves: [runner('A', 2, 4), batter('B', 1)] })
    expect([r(s, 'P1'), er(s, 'P1'), r(s, 'P2'), er(s, 'P2')]).toEqual([1, 1, 0, 0])
  })

  it('7. 換投前後都有失誤：前一位投手照完整半局重建；後援只算他上場後的失誤', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'error', batterId: 'A', ballType: 'ground', moves: [batter('A', 1)] })
    play(s, { kind: 'walk', batterId: 'B', moves: [runner('A', 1, 2), batter('B', 1)] })
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'strikeout', batterId: 'C', pitcherId: 'P2', moves: [batter('C', 'out')] })
    play(s, { kind: 'error', batterId: 'D', pitcherId: 'P2', outsBefore: 1, ballType: 'ground', moves: [runner('A', 2, 3), runner('B', 1, 2), batter('D', 1)] })
    // 1 出局、滿壘：P1 視角重建出局 = 1 + 2 = 3；P2 視角 = 1 + 1 = 2
    play(s, { kind: 'homeRun', batterId: 'E', pitcherId: 'P2', outsBefore: 1, moves: [runner('A', 3, 4), runner('B', 2, 4), runner('D', 1, 4), batter('E', 4)] })
    // A 失誤上壘、B 在 P1 的重建裡已經是第三出局之後 → P1：2 分 0 自責；D 失誤上壘、E 在 P2 視角重建 2 出局 → P2：2 分 1 自責
    expect([r(s, 'P1'), er(s, 'P1'), r(s, 'P2'), er(s, 'P2')]).toEqual([2, 0, 2, 1])
  })

  it('8. 延長賽二壘跑者得分：非自責，算放上去時在場的投手', () => {
    const s = new Scorekeeper()
    s.halfEnd()
    s.placeRunner('G', 'P1')
    s.pitcherIn('P1', 'P2', 0, 0)
    play(s, { kind: 'double', batterId: 'A', pitcherId: 'P2', moves: [runner('G', 2, 4), batter('A', 2)] })
    play(s, { kind: 'single', batterId: 'B', pitcherId: 'P2', moves: [runner('A', 2, 4), batter('B', 1)] })
    expect([r(s, 'P1'), er(s, 'P1'), r(s, 'P2'), er(s, 'P2')]).toEqual([1, 0, 1, 1])
  })

  it('9. 高飛犧牲打與失誤：重建後那個接殺就是第三出局，回來的分非自責', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'groundOut', batterId: 'A', ballType: 'ground', moves: [batter('A', 'out')] })
    play(s, { kind: 'double', batterId: 'B', outsBefore: 1, moves: [batter('B', 2)] })
    play(s, { kind: 'error', batterId: 'C', outsBefore: 1, ballType: 'ground', moves: [runner('B', 2, 3), batter('C', 1)] })
    // 實際 1 出局；重建是 2 出局，高飛犧牲打的接殺 = 第三出局 → B 不會回來
    play(s, { kind: 'sacrificeFly', batterId: 'D', outsBefore: 1, ballType: 'fly', moves: [batter('D', 'out'), runner('B', 3, 4)] })
    expect([r(s), er(s)]).toEqual([1, 0])
    expect(s.runLog[0]).toMatchObject({ reconstructedOuts: 2, outsAdded: 1, earned: false })
  })

  it('9b. 雙殺打的同一球回來的分：重建後雙殺就是第三出局 → 非自責', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'error', batterId: 'A', ballType: 'ground', moves: [batter('A', 1)] })
    play(s, { kind: 'double', batterId: 'B', moves: [runner('A', 1, 3), batter('B', 2)] })
    play(s, { kind: 'walk', batterId: 'C', moves: [batter('C', 1)] })
    // 0 出局滿壘（重建 1 出局）：滾地雙殺，三壘的 A 回來（失誤上壘）、二壘 B 到三壘
    play(s, { kind: 'doublePlay', batterId: 'D', ballType: 'ground', moves: [runner('C', 1, 'out'), batter('D', 'out'), runner('B', 2, 3), runner('A', 3, 4)] })
    // 2 出局（重建 3 出局）：B 被單打送回 → 非自責
    play(s, { kind: 'single', batterId: 'E', outsBefore: 2, moves: [runner('B', 3, 4), batter('E', 1)] })
    expect([r(s), er(s)]).toEqual([2, 0])
  })

  it('9c. 雙殺打同一球回來的分：重建後雙殺的第二個出局就是第三出局 → 非自責', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'error', batterId: 'A', ballType: 'ground', moves: [batter('A', 1)] })
    play(s, { kind: 'triple', batterId: 'B', moves: [runner('A', 1, 4), batter('B', 3)] })
    play(s, { kind: 'walk', batterId: 'C', moves: [batter('C', 1)] })
    // 0 出局（重建 1 出局），一、三壘：滾地雙殺，三壘的 B（安打上壘）同一球回來 —— 引擎 groundOut 的雙殺分支會這樣跑
    play(s, { kind: 'doublePlay', batterId: 'D', ballType: 'ground', moves: [runner('C', 1, 'out'), batter('D', 'out'), runner('B', 3, 4)] })
    expect([r(s), er(s)]).toEqual([2, 0])
    expect(s.runLog[1]).toMatchObject({ runnerId: 'B', reach: 'batted', reconstructedOuts: 1, outsAdded: 2, earned: false })
  })

  it('10. 第三個出局那一球跑者沒有得分（失分、自責都不算）', () => {
    const s = new Scorekeeper()
    play(s, { kind: 'triple', batterId: 'A', outsBefore: 2, moves: [batter('A', 3)] })
    play(s, { kind: 'groundOut', batterId: 'B', outsBefore: 2, ballType: 'ground', moves: [batter('B', 'out'), runner('A', 3, 4)] })
    expect([r(s), er(s)]).toEqual([0, 0])
    expect(s.runLog).toEqual([])
  })
})

// ---- 真實比賽交叉比對 ----

interface Mined {
  c: GoldenCase
  runs: readonly RunRecord[]
  events: GameEvent[]
  /** 獨立從事件流算出來的每一分 */
  reference: RefRun[]
}

interface RefRun {
  half: number
  runnerId: string
  responsible: string
  mound: string
  reach: 'batted' | 'error' | 'tiebreak'
  outsBefore: number
  outsAdded: number
  /** 這半局到這一球之前、責任投手上場後的失誤上壘次數 */
  errorsSinceEntry: number
  kind: string
  /** 這半局在這一球之前，是不是已經有兩出局後的失誤（同一位投手） */
  twoOutError: boolean
}

/**
 * 跟 Scorekeeper 無關的獨立計算：只看事件流（打席、盜壘、換投、半局結束）與雙方先發投手，
 * 自己追蹤出局數、壘上跑者、跑者由哪位投手放上壘、每位投手上場後的失誤次數
 */
function referenceRuns(c: GoldenCase, events: readonly GameEvent[]): RefRun[] {
  const mound: Record<Side, string> = { home: c.setup.home.roster.starter.id, away: c.setup.away.roster.starter.id }
  let half = 0
  let top = true
  let outs = 0
  const errorTimes: number[] = [] // 本半局每次失誤是在第幾個打席
  const entryPa = new Map<string, number>() // 投手在本半局第幾個打席之前上場
  const lastBatter: Record<Side, string | null> = { home: null, away: null }
  let pa = 0
  let inning = 1
  const onBase = new Map<string, { responsible: string; reach: RefRun['reach'] }>()
  const out: RefRun[] = []
  const twoOutErrorBy = new Set<string>()
  const startHalf = () => {
    outs = 0
    errorTimes.length = 0
    entryPa.clear()
    onBase.clear()
    twoOutErrorBy.clear()
    pa = 0
    const batting: Side = top ? 'away' : 'home'
    // 延長賽：上一棒（這一隊上一個打席的打者）放在二壘
    if (inning >= 10 && lastBatter[batting]) onBase.set(lastBatter[batting]!, { responsible: mound[top ? 'home' : 'away'], reach: 'tiebreak' })
  }
  for (const e of events) {
    const fielding: Side = top ? 'home' : 'away'
    const batting: Side = top ? 'away' : 'home'
    if (e.type === 'substitution' && e.kind === 'pitcher') {
      mound[e.side] = e.inId
      entryPa.set(e.inId, pa)
    } else if (e.type === 'substitution' && e.kind === 'pinchRun') {
      const info = onBase.get(e.outId)
      onBase.delete(e.outId)
      if (info) onBase.set(e.inId, info)
    } else if (e.type === 'steal') {
      for (const m of e.moves) if (m.to === 'out') {
        onBase.delete(m.runnerId)
        outs++
      }
    } else if (e.type === 'play') {
      const p = mound[fielding]
      const outsAdded = e.moves.filter((m) => m.to === 'out').length
      const counts = outs + outsAdded < 3
      for (const m of e.moves) {
        const info = m.from === 0 ? { responsible: p, reach: (e.kind === 'error' ? 'error' : 'batted') as RefRun['reach'] } : onBase.get(m.runnerId)!
        onBase.delete(m.runnerId)
        if (m.to === 'out') continue
        if (m.to === 4) {
          if (counts) {
            const since = entryPa.get(info.responsible) ?? -1
            out.push({
              half,
              runnerId: m.runnerId,
              responsible: info.responsible,
              mound: p,
              reach: info.reach,
              outsBefore: outs,
              outsAdded,
              errorsSinceEntry: errorTimes.filter((t) => t >= since).length,
              kind: e.kind,
              twoOutError: twoOutErrorBy.has(info.responsible) && (entryPa.get(p) ?? -1) <= Math.min(...errorTimes),
            })
          }
          continue
        }
        onBase.set(m.runnerId, info)
      }
      if (e.kind === 'error') {
        errorTimes.push(pa)
        if (outs === 2) twoOutErrorBy.add(p)
      }
      outs += outsAdded
      lastBatter[batting] = e.batterId
      pa++
    } else if (e.type === 'halfInningEnd') {
      half++
      if (!top) inning++
      top = !top
      startHalf()
    }
  }
  return out
}

/** 比 Golden 更多的比賽：規則 9、各種種子，含疲勞換投 */
function corpus(): GoldenCase[] {
  const extra: GoldenCase[] = []
  for (let seed = 161; seed <= 900; seed++) {
    const userSide: Side = seed % 2 ? 'home' : 'away'
    const other: Side = userSide === 'home' ? 'away' : 'home'
    const ai = { [userSide]: { kind: 'autoCoach', style: 'balanced' }, [other]: { kind: 'builtin' } } as MatchAi
    extra.push({ id: `x${seed}`, setup: { home: generateTeam(new Rng(seed * 3 + 1)), away: generateTeam(new Rng(seed * 3 + 2)), seed: seed * 104729, userSide, rules: 9 }, ai })
  }
  return [...goldenCases(), ...extra]
}

describe('真實模擬比賽：每一分的自責判斷跟獨立計算一致（900 場）', () => {
  const games: Mined[] = corpus().map((c) => {
    const { game, events } = playGolden(c)
    return { c, runs: game.runLog, events, reference: referenceRuns(c, events) }
  })
  const all = games.flatMap((g) => g.runs.map((run, i) => ({ run, ref: g.reference[i], g })))

  it('逐分比對：得分的人、失分記給誰、上壘方式、出局數、重建出局數都跟事件流一致', () => {
    for (const g of games) {
      expect(g.runs.length).toBe(g.reference.length)
      g.runs.forEach((run, i) => {
        const ref = g.reference[i]
        expect([run.half, run.runnerId, run.pitcherId, run.moundId, run.reach, run.outsBefore, run.outsAdded]).toEqual([ref.half, ref.runnerId, ref.responsible, ref.mound, ref.reach, ref.outsBefore, ref.outsAdded])
        expect(run.reconstructedOuts).toBe(ref.outsBefore + ref.errorsSinceEntry)
        // 自責的定義：不是失誤／延長賽上壘、不是失誤那一球、重建後這一球結束時還不到三出局
        expect(run.earned).toBe(ref.reach === 'batted' && ref.kind !== 'error' && ref.outsBefore + ref.errorsSinceEntry + ref.outsAdded < 3)
      })
    }
  })

  /** 每一種情境在真實比賽裡出現的次數：單元測試的序列都真的會發生 */
  it('情境 1～10 都會在正式引擎出現', () => {
    const count = {
      noErrorRuns: all.filter(({ ref }) => ref.reach === 'batted' && ref.errorsSinceEntry === 0).length,
      errorRunner: all.filter(({ run }) => run.reach === 'error').length,
      twoOutErrorThenRuns: all.filter(({ ref }) => ref.twoOutError).length,
      extraAdvance: all.filter(({ run }) => run.errorBases > 0).length,
      inherited: all.filter(({ run }) => run.pitcherId !== run.moundId).length,
      inheritedWithErrors: all.filter(({ run, ref }) => run.pitcherId !== run.moundId && ref.errorsSinceEntry > 0).length,
      tiebreak: all.filter(({ run }) => run.reach === 'tiebreak').length,
      sacFlyAfterError: all.filter(({ run }) => run.kind === 'sacrificeFly' && run.reconstructedOuts > run.outsBefore).length,
      dpRunAfterError: all.filter(({ run }) => run.kind === 'doublePlay' && run.reconstructedOuts > run.outsBefore).length,
      // 修正前會被誤算成自責的分：重建後這一球就是第三出局（高飛犧牲打、雙殺打）
      thirdOutInReconstruction: all.filter(({ run }) => run.reach === 'batted' && run.reconstructedOuts < 3 && run.reconstructedOuts + run.outsAdded >= 3).length,
      groundErrorWithRunnerOnFirst: games.reduce((n, g) => n + g.events.filter((e) => e.type === 'play' && e.kind === 'error' && e.ball?.type === 'ground' && e.moves.some((m) => m.from === 1)).length, 0),
    }
    for (const [k, v] of Object.entries(count)) expect(v, k).toBeGreaterThan(0)
  })

  it('無失誤的半局（沒有延長賽跑者）：每一分都是自責', () => {
    for (const { run, ref } of all) if (ref.errorsSinceEntry === 0 && run.reach === 'batted' && run.kind !== 'error') expect(run.earned).toBe(true)
  })

  it('失誤上壘、延長賽二壘跑者得分一律非自責；兩出局後失誤，之後同一位投手的失分都非自責', () => {
    for (const { run, ref } of all) {
      if (run.reach !== 'batted') expect(run.earned).toBe(false)
      if (ref.twoOutError) expect(run.earned).toBe(false)
    }
  })

  it('延長賽二壘跑者就是這一隊上一個打席的打者', () => {
    // 參考計算自己決定 tiebreak 跑者（上一棒）；逐分比對已經檢查過 reach 一致，這裡確認真的有比賽用到
    expect(all.some(({ ref }) => ref.reach === 'tiebreak')).toBe(true)
  })

  it('已知限制的影響：失誤多推進後得分、仍算自責的分數占全部失分的比例', () => {
    const total = all.length
    const affected = all.filter(({ run }) => run.errorBases > 0 && run.earned).length
    const earned = all.filter(({ run }) => run.earned).length
    // 寫進文件的數字（docs/phase8-statistics-spec.md §6）：只要比例沒有大幅改變就不用更新
    expect(affected / total).toBeLessThan(0.02)
    console.info(`[ER 限制] ${games.length} 場、${total} 分（自責 ${earned}）：失誤多推進後得分、仍算自責 ${affected} 分（${((affected / total) * 100).toFixed(2)}%）`)
  })
})
