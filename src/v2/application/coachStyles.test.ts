// @vitest-environment node
// Phase 9 PR 2：四種戰術風格的決策。
// 前半用最小的比賽狀態替身逐一確認每個決策點（換投、後段守成、守備替補、盜壘門檻、保護強打、觸擊、打帶跑、代跑）；
// 後半用真正的引擎打同一組種子，確認四種風格實際下了不同的指令、而且同樣的輸入一定得到同樣的結果
import { describe, expect, it } from 'vitest'
import { generateRoster, generateTeam } from '../../sim/generate'
import { RULES_VERSION, type Game, type Side, type Tactic } from '../../sim/game'
import { Rng } from '../../sim/rng'
import type { Batter, Pitcher } from '../../sim/types'
import { AUTO_COACH_VERSION, COACH_PRESETS, COACH_STYLES, createPolicy, pitchingChangeAt, type CoachStyle } from './autoCoach'
import { runMatch, type MatchAi } from './matchRunner'

const roster = generateRoster(new Rng(77))
const bat = (over: Partial<Batter['ratings']> = {}, extra: Partial<Batter> = {}): Batter => ({ ...structuredClone(roster.lineup[0].player), ...extra, ratings: { contact: 5, power: 5, speed: 5, fielding: 5, ...over } })
const pit = (over: Partial<Pitcher['ratings']> = {}, extra: Partial<Pitcher> = {}): Pitcher => ({ ...structuredClone(roster.starter), traits: [], ...extra, ratings: { stuff: 5, control: 5, stamina: 5, ...over } })

interface Stub {
  defense?: boolean
  inning?: number
  lead?: number
  outs?: number
  bases?: (Batter | null)[]
  pitchCount?: number
  limit?: number
  relievers?: Pitcher[]
  batter?: Batter
  bench?: Batter[]
  lineup?: { player: Batter; position: string }[]
  steal?: number
  bunt?: number
}

/** 自動教練會讀到的比賽狀態（只放決策會用到的欄位） */
function game(s: Stub): Game {
  const us: Side = 'home'
  const lead = s.lead ?? 0
  const batter = s.batter ?? bat()
  const lineup = s.lineup ?? Array.from({ length: 9 }, (_, i) => ({ player: i === 0 ? batter : bat(), position: i === 8 ? 'DH' : 'CF' }))
  const team = {
    pitcher: pit(),
    relievers: s.relievers ?? [pit(), pit()],
    pitchCount: s.pitchCount ?? 0,
    pitcherSincePa: 0,
    lineup,
    battingIndex: 0,
    bench: s.bench ?? [],
  }
  return {
    over: false,
    balls: 0,
    strikes: 0,
    userSide: us,
    fieldingSide: s.defense ? us : 'away',
    battingSide: s.defense ? 'away' : us,
    fielding: team,
    batting: team,
    paIndex: 5,
    inning: s.inning ?? 3,
    score: { home: Math.max(0, lead), away: Math.max(0, -lead) },
    outs: s.outs ?? 0,
    bases: s.bases ?? [null, null, null],
    batter,
    alignment: 'normal',
    platoonOn: false,
    positionsOn: false,
    fatigueLimit: () => s.limit ?? 100,
    matchup: () => 'neutral',
    stealChance: () => s.steal ?? 0,
    buntChance: () => s.bunt ?? 0.7,
    spotFielding: (spot: { player: Batter }) => spot.player.ratings.fielding,
  } as unknown as Game
}
const decide = (style: CoachStyle, g: Game): Tactic | null => {
  const policy = createPolicy(style, { align: false })
  return policy.next(g)
}

describe('換投', () => {
  it('均衡、強攻、機動：到疲勞門檻才換；守備型提早 15 球', () => {
    for (const style of ['balanced', 'power', 'speed'] as const) {
      expect(decide(style, game({ defense: true, pitchCount: 99 }))).toBeNull()
      expect(decide(style, game({ defense: true, pitchCount: 100 }))).toMatchObject({ type: 'changePitcher' })
    }
    expect(decide('defense', game({ defense: true, pitchCount: 84 }))).toBeNull()
    expect(decide('defense', game({ defense: true, pitchCount: 85 }))).toMatchObject({ type: 'changePitcher' })
  })

  it('負數的下限：體力很差的投手（門檻 50）不會被提早到 35 球就換，最早 30 球（60%）；自訂 −30 也一樣', () => {
    expect(pitchingChangeAt(50, -15)).toBe(35)
    const p = createPolicy('defense', { fatigueMargin: -30, align: false })
    expect(p.next(game({ defense: true, pitchCount: 29, limit: 50 }))).toBeNull()
    expect(p.next(game({ defense: true, pitchCount: 30, limit: 50 }))).toMatchObject({ type: 'changePitcher' })
  })

  it('後段守成（只有守備型）：8 局後領先 1～3 分、投手用掉七成體力就換；9 局起有終結者先用終結者', () => {
    const closer = pit({ stuff: 4, control: 4 }, { id: 'closer', traits: ['closer'] })
    const ace = pit({ stuff: 8, control: 8 }, { id: 'ace' })
    const relievers = [ace, closer]
    expect(decide('defense', game({ defense: true, inning: 8, lead: 2, pitchCount: 70, relievers }))).toEqual({ type: 'changePitcher', relieverIndex: 0 })
    expect(decide('defense', game({ defense: true, inning: 9, lead: 1, pitchCount: 70, relievers }))).toEqual({ type: 'changePitcher', relieverIndex: 1 })
    // 體力還夠、沒有領先、領先太多、還沒到 8 局：不換
    expect(decide('defense', game({ defense: true, inning: 9, lead: 1, pitchCount: 69, relievers }))).toBeNull()
    expect(decide('defense', game({ defense: true, inning: 9, lead: 0, pitchCount: 80, relievers }))).toBeNull()
    expect(decide('defense', game({ defense: true, inning: 9, lead: 4, pitchCount: 80, relievers }))).toBeNull()
    expect(decide('defense', game({ defense: true, inning: 7, lead: 2, pitchCount: 80, relievers }))).toBeNull()
    for (const style of ['balanced', 'power', 'speed'] as const) expect(decide(style, game({ defense: true, inning: 9, lead: 1, pitchCount: 80, relievers }))).toBeNull()
  })
})

describe('守備替補（只有守備型）', () => {
  it('7 局後領先 1～3 分：板凳上守備至少好 2 的人換上差最多的那一格；指定打擊不換', () => {
    const lineup = Array.from({ length: 9 }, (_, i) => ({ player: bat({ fielding: i === 3 ? 3 : 6 }), position: i === 8 ? 'DH' : 'SS' }))
    lineup[8].player.ratings.fielding = 1
    const bench = [bat({ fielding: 7 }), bat({ fielding: 9 })]
    const g = game({ defense: true, inning: 7, lead: 2, lineup, bench })
    expect(decide('defense', g)).toEqual({ type: 'defensiveSub', benchIndex: 1, lineupIndex: 3 })
    expect(decide('balanced', g)).toBeNull()
    expect(decide('defense', game({ defense: true, inning: 6, lead: 2, lineup, bench }))).toBeNull()
    expect(decide('defense', game({ defense: true, inning: 8, lead: 0, lineup, bench }))).toBeNull()
    // 好不到 2 就不換
    expect(decide('defense', game({ defense: true, inning: 8, lead: 1, lineup, bench: [bat({ fielding: 4 })] }))).toBeNull()
  })
})

describe('進攻：盜壘、保護強打、觸擊、打帶跑、代跑', () => {
  const runner = bat({ speed: 6 })
  it('盜壘門檻：機動 0.70、均衡 0.75、強攻 0.85', () => {
    const at = (steal: number) => game({ bases: [runner, null, null], steal })
    expect(COACH_STYLES.map((s) => decide(s, at(0.72))?.type ?? null)).toEqual([null, null, 'steal', null])
    expect(COACH_STYLES.map((s) => decide(s, at(0.8))?.type ?? null)).toEqual(['steal', null, 'steal', 'steal'])
    expect(COACH_STYLES.map((s) => decide(s, at(0.86))?.type ?? null)).toEqual(['steal', 'steal', 'steal', 'steal'])
  })

  it('機動型比分差 4 分還會跑，其他 3 分', () => {
    const g = game({ bases: [runner, null, null], steal: 0.9, lead: -4 })
    expect(decide('speed', g)).toMatchObject({ type: 'steal' })
    expect(decide('balanced', g)).toBeNull()
  })

  it('強攻型保護強打：長打 7 以上的打者打擊時不盜壘', () => {
    const slugger = bat({ power: 8 })
    const g = game({ bases: [runner, null, null], steal: 0.9, batter: slugger })
    expect(decide('power', g)).toBeNull()
    expect(decide('balanced', g)).toMatchObject({ type: 'steal' })
    expect(decide('power', game({ bases: [runner, null, null], steal: 0.9, batter: bat({ power: 6 }) }))).toMatchObject({ type: 'steal' })
  })

  it('犧牲觸擊：強攻型從不觸擊；均衡 8 局起平手或落後 1 分；機動 7 局起、領先 1 分也觸擊', () => {
    const weak = bat({ contact: 5, power: 5 })
    const at = (inning: number, lead: number) => game({ inning, lead, bases: [runner, null, null], batter: weak, steal: 0 })
    expect(decide('power', at(9, 0))).toBeNull()
    expect(decide('balanced', at(8, 0))).toEqual({ type: 'bunt' })
    expect(decide('balanced', at(7, 0))).toBeNull()
    expect(decide('balanced', at(8, 1))).toBeNull()
    expect(decide('speed', at(7, 1))).toEqual({ type: 'bunt' })
    expect(decide('speed', at(6, 0))).toBeNull()
    // 打者夠強（打擊＋長打 11）：均衡不觸擊、機動還會
    const ok = game({ inning: 8, bases: [runner, null, null], batter: bat({ contact: 6, power: 5 }), steal: 0 })
    expect(decide('balanced', ok)).toBeNull()
    expect(decide('speed', ok)).toEqual({ type: 'bunt' })
  })

  it('打帶跑（只有機動型）：一壘有人、跑者速度 6 以上、打者打擊 6 以上、跑者成功率 0.55 以上但不到盜壘門檻', () => {
    expect(decide('speed', game({ bases: [bat({ speed: 5 }), null, null], batter: bat({ contact: 7 }), steal: 0.6 }))).toBeNull()
    const g = game({ bases: [runner, null, null], batter: bat({ contact: 7 }), steal: 0.6 })
    expect(decide('speed', g)).toEqual({ type: 'hitAndRun' })
    for (const style of ['balanced', 'power', 'defense'] as const) expect(decide(style, g)).toBeNull()
    expect(decide('speed', game({ bases: [runner, null, null], batter: bat({ contact: 5 }), steal: 0.6 }))).toBeNull()
    expect(decide('speed', game({ bases: [runner, null, null], batter: bat({ contact: 7 }), steal: 0.5 }))).toBeNull()
    expect(decide('speed', game({ bases: [runner, null, null], batter: bat({ contact: 7 }), steal: 0.6, outs: 2 }))).toBeNull()
  })

  it('代跑（只有機動型）：7 局後比分差 1 分內，慢跑者（速度 4 以下）換成快至少 3 的板凳', () => {
    const slow = bat({ speed: 3 })
    const bench = [bat({ speed: 5 }), bat({ speed: 8 })]
    const g = game({ inning: 7, lead: -1, bases: [slow, null, null], bench })
    expect(decide('speed', g)).toEqual({ type: 'pinchRun', base: 1, benchIndex: 1 })
    expect(decide('balanced', g)).toBeNull()
    // 一出局（不會觸擊）：還沒 7 局、比分差 2 分、跑者不慢都不代跑
    expect(decide('speed', game({ inning: 6, lead: 0, outs: 1, bases: [slow, null, null], bench }))).toBeNull()
    expect(decide('speed', game({ inning: 8, lead: 2, outs: 1, bases: [slow, null, null], bench }))).toBeNull()
    expect(decide('speed', game({ inning: 8, lead: 0, outs: 1, bases: [bat({ speed: 5 }), null, null], bench }))).toBeNull()
  })

  it('同樣的狀態一定得到同樣的決定（不抽亂數、不改狀態）', () => {
    const g = game({ inning: 9, lead: 0, bases: [runner, null, null], steal: 0.6, batter: bat({ contact: 7 }) })
    const before = JSON.stringify(g)
    for (const style of COACH_STYLES) expect(decide(style, g)).toEqual(decide(style, g))
    expect(JSON.stringify(g)).toBe(before)
  })
})

describe('真正的比賽：四種風格下了不同的指令', () => {
  /** 同一組種子、同樣的我方與對手，只換戰術風格 */
  function play(style: CoachStyle, games = 80) {
    const out = []
    for (let i = 0; i < games; i++) {
      const userSide: Side = i % 2 ? 'away' : 'home'
      const other: Side = userSide === 'home' ? 'away' : 'home'
      const ours = generateTeam(new Rng(400 + (i % 20)), 6)
      for (const b of [...ours.roster.lineup.map((s) => s.player), ...ours.roster.bench]) b.ratings.speed = Math.min(10, b.ratings.speed + 2)
      const opp = generateTeam(new Rng(900 + i), 6)
      const setup = { home: userSide === 'home' ? ours : opp, away: userSide === 'away' ? ours : opp, seed: 3000 + i, userSide, rules: RULES_VERSION }
      out.push(runMatch(setup, { [userSide]: { kind: 'autoCoach', style }, [other]: { kind: 'builtin' } } as MatchAi))
    }
    return out
  }
  const runs = Object.fromEntries(COACH_STYLES.map((s) => [s, play(s)])) as Record<CoachStyle, ReturnType<typeof play>>
  const sum = (style: CoachStyle, f: (t: NonNullable<(typeof runs)['balanced'][number]['tactics']>) => number) => runs[style].reduce((n, r) => n + f(r.tactics!), 0)

  it('戰術摘要記下的風格就是這場用的風格，教練版本是 2', () => {
    for (const style of COACH_STYLES) {
      expect(runs[style].every((r) => r.tactics!.style === style && !r.tactics!.custom)).toBe(true)
      expect(runs[style].every((r) => r.replay.coachVersion === AUTO_COACH_VERSION)).toBe(true)
    }
    expect(AUTO_COACH_VERSION).toBe(2)
  })

  it('同一組種子，四種風格的指令紀錄都不一樣', () => {
    const fp = (style: CoachStyle) => JSON.stringify(runs[style].map((r) => r.replay.commands))
    expect(new Set(COACH_STYLES.map(fp)).size).toBe(4)
  })

  it('行為差異：機動型跑最多、強攻型跑最少也不觸擊；只有機動型打帶跑與代跑；只有守備型做守備替補、換投最多', () => {
    const steals = (s: CoachStyle) => sum(s, (t) => t.steals[0])
    expect(steals('speed')).toBeGreaterThan(steals('balanced'))
    expect(steals('balanced')).toBeGreaterThan(steals('power'))
    expect(sum('power', (t) => t.bunts[0])).toBe(0)
    expect(sum('speed', (t) => t.hitAndRuns)).toBeGreaterThan(0)
    for (const s of ['balanced', 'power', 'defense'] as const) {
      expect(sum(s, (t) => t.hitAndRuns)).toBe(0)
      expect(sum(s, (t) => t.pinchRuns)).toBe(0)
    }
    for (const s of ['balanced', 'power', 'speed'] as const) expect(sum(s, (t) => t.defensiveSubs)).toBe(0)
    expect(sum('defense', (t) => t.defensiveSubs)).toBeGreaterThan(0)
    expect(sum('defense', (t) => t.pitchingChanges)).toBeGreaterThan(sum('balanced', (t) => t.pitchingChanges))
  })

  it('戰術摘要跟指令紀錄對得上（觸擊、打帶跑、代跑、守備替補的次數就是下過的指令數）', () => {
    for (const style of COACH_STYLES) {
      for (const r of runs[style]) {
        const n = (type: Tactic['type']) => r.replay.commands.filter((c) => c.tactic.type === type).length
        expect(r.tactics!.bunts[0]).toBe(n('bunt'))
        expect(r.tactics!.hitAndRuns).toBe(n('hitAndRun'))
        expect(r.tactics!.pinchRuns).toBe(n('pinchRun'))
        expect(r.tactics!.defensiveSubs).toBe(n('defensiveSub'))
        expect(r.tactics!.pitchingChanges).toBe(n('changePitcher'))
        expect(r.tactics!.steals[1]).toBeLessThanOrEqual(r.tactics!.steals[0])
      }
    }
  })

  it('確定性：同樣的設定再打一次，指令、比分、摘要都一樣；摘要不額外消耗比賽亂數（比分跟沒記摘要的重播一致）', () => {
    for (const style of COACH_STYLES) {
      const again = play(style, 10)
      expect(again.map((r) => [r.score, r.replay.commands, r.tactics])).toEqual(runs[style].slice(0, 10).map((r) => [r.score, r.replay.commands, r.tactics]))
    }
  })

  it('預設參數表沒有被意外改動（守備 −15、機動 0.70、強攻 0.85）', () => {
    expect([COACH_PRESETS.defense.fatigueMargin, COACH_PRESETS.speed.stealMin, COACH_PRESETS.power.stealMin]).toEqual([-15, 0.7, 0.85])
  })
})
