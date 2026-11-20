// V2 Headless Match Runner：不經過畫面，用既有的 Game 引擎自動打完一整場。
// 雙方 AI 設定透過 Adapter 對到模擬引擎（src/sim）：AutoCoach 那一方當作 userSide，由自動教練下指令；
// 另一方是引擎內建的 AI。結果只由 setup（含種子、規則版本）與雙方 AI 設定決定，
// 回傳的 replay 就是模擬引擎的 { setup, commands }，用 replay() 可以逐步重現。
import { Game, RULES_VERSION, type Command, type GameEvent, type GameSetup, type Half, type PlayerLine, type Side } from '../../sim/game'
import type { ScoreLine } from '../../sim/scoring'
import { emptyTactics, type MatchTactics } from '../domain/matchTactics'
import type { MvpFacts } from '../domain/mvp'
import { AUTO_COACH_VERSION, AutoCoach, COACH_PRESETS, createPolicy, type CoachParams, type CoachStyle } from './autoCoach'

/** 一方的 AI：自動教練（可選風格），或引擎內建的對手 AI */
export type SideAi = { kind: 'autoCoach'; style?: CoachStyle; params?: Partial<CoachParams> } | { kind: 'builtin' }

export type MatchAi = Record<Side, SideAi>

export interface MatchOptions {
  /** 最多推進幾步（一步約一球），必須是大於 0 的安全整數；超過就丟 MatchStepLimitError，不會產生比分 */
  maxSteps?: number
}

/**
 * 一般比賽約 250～350 步；延長賽每局約 30～80 步。
 * 2,000 步大約等於 25 局以上的延長賽，正常規則下不會碰到，碰到代表模擬有 bug
 */
export const DEFAULT_MAX_STEPS = 2000

export interface PlayerStat {
  playerId: string
  name: string
  side: Side
  role: 'batter' | 'pitcher'
  line: PlayerLine
  /** 完整的正式記分（Phase 8）：有出場就有，包含沒有打席的代跑、守備替補 */
  stats: ScoreLine
}

export type HighlightKind = 'homeRun' | 'clutchHit' | 'walkOff' | 'pitchingChange'

export interface Highlight {
  kind: HighlightKind
  inning: number
  half: Half
  /** 這件事是哪一隊做的（換投是守備方） */
  side: Side
  /** 主角：打者，或換上場的投手 */
  playerId: string
  /** 換投時被換下的投手 */
  outId?: string
  runs: number
  /**
   * 這個事件發生當下的比分（已經算進這個事件本身的得分）：全壘打、安打、再見是打完那一球的比分，
   * 換投是換投那一刻的比分。由事件流逐一累加，不是整步推進完才讀的比分
   */
  score: { home: number; away: number }
}

/** 重現整場比賽所需的資訊：setup 已經寫明 userSide 與規則版本，直接交給 sim/game.ts 的 replay() 即可 */
export interface MatchReplay {
  setup: GameSetup & { rules: number }
  commands: Command[]
  ai: MatchAi
  rulesVersion: number
  coachVersion: number
}

export interface MatchResult {
  score: { home: number; away: number }
  winner: Side
  /** 打到第幾局（9 以上，大於 9 就是延長賽） */
  innings: number
  linescore: { home: number[]; away: number[] }
  hits: { home: number; away: number }
  errors: { home: number; away: number }
  players: PlayerStat[]
  highlights: Highlight[]
  /** step() 的次數 */
  steps: number
  replay: MatchReplay
  /** 我方的戰術摘要（Phase 9 PR 2 起；測試注入的假結果可以沒有） */
  tactics?: MatchTactics
  /** 我方 MVP 評分用、lines 沒有的事實：盜壘、勝利打點（Phase 9 PR 4 起；從事件流收集，不影響模擬） */
  mvpFacts?: MvpFacts
}

export class MatchConfigError extends Error {
  override name = 'MatchConfigError'
}

/** 模擬超過步數上限：明確回報，不默默給比分 */
export class MatchStepLimitError extends Error {
  override name = 'MatchStepLimitError'
  constructor(
    readonly maxSteps: number,
    readonly state: { inning: number; half: Half; score: { home: number; away: number } },
  ) {
    super(`比賽超過 ${maxSteps} 步還沒結束（第 ${state.inning} 局${state.half === 'top' ? '上' : '下'}，${state.score.away}:${state.score.home}）`)
  }
}

/** 預設：setup.userSide 那一方用均衡的自動教練，另一方用引擎內建 AI */
export function defaultAi(userSide: Side = 'home'): MatchAi {
  const other: Side = userSide === 'home' ? 'away' : 'home'
  return { [userSide]: { kind: 'autoCoach', style: 'balanced' }, [other]: { kind: 'builtin' } } as MatchAi
}

/**
 * 把 GameSetup 與雙方 AI 對到模擬引擎（src/sim）的設定（Adapter）：
 * 引擎同一場只有一個 userSide，所以 Phase 1 只能有一方是 autoCoach，另一方一定是 builtin。
 * 規則版本沒給就用目前版本，並且明確寫進設定，之後改版也能照原規則重現
 */
export function resolveSetup(setup: GameSetup, ai: MatchAi): MatchReplay['setup'] {
  const coached = (['home', 'away'] as const).filter((s) => ai[s]?.kind === 'autoCoach')
  const builtin = (['home', 'away'] as const).filter((s) => ai[s]?.kind === 'builtin')
  if (coached.length !== 1 || builtin.length !== 1) {
    throw new MatchConfigError('Phase 1 的引擎同一場只能有一方是 autoCoach、另一方是 builtin（V1 內建 AI）')
  }
  const rules = setup.rules ?? RULES_VERSION
  if (!Number.isInteger(rules) || rules < 1 || rules > RULES_VERSION) {
    throw new MatchConfigError(`不支援的規則版本：${rules}（目前 1～${RULES_VERSION}）`)
  }
  if (!Number.isFinite(setup.seed)) throw new MatchConfigError(`種子不合法：${setup.seed}`)
  return { ...setup, userSide: coached[0], rules }
}

export interface MatchRun {
  result: MatchResult
  /** 打完的 Game：需要賽後計算（例如 synergyLog）時用；不可序列化 */
  game: Game
}

/** 自動打完一整場，連同打完的 Game 一起回傳 */
export function runMatchWithGame(setup: GameSetup, ai: MatchAi = defaultAi(setup.userSide), options: MatchOptions = {}): MatchRun {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  // NaN、Infinity、0、負數、小數都不行：NaN 會讓上限永遠不成立，Infinity 等於沒有上限
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new MatchConfigError(`maxSteps 必須是大於 0 的安全整數：${maxSteps}`)
  }
  const resolved = resolveSetup(setup, ai)
  const game = new Game(resolved)
  const sideAi = ai[resolved.userSide] as Extract<SideAi, { kind: 'autoCoach' }>
  const coach = new AutoCoach(createPolicy(sideAi.style, sideAi.params))
  const ours = resolved.userSide
  const ourIds = game.rosterIds(ours)
  const style = sideAi.style ?? 'balanced'
  const tactics = emptyTactics(style, isCustomParams(style, sideAi.params))
  const facts: MvpFacts = { steals: {}, winningRbi: null }
  const tally = (events: readonly GameEvent[]) => {
    for (const e of events) {
      if (e.type === 'steal' && ourIds.has(e.runnerId)) {
        tactics.steals[0]++
        if (e.success) tactics.steals[1]++
        const s = (facts.steals[e.runnerId] ??= [0, 0])
        s[e.success ? 0 : 1]++
      } else if (e.type === 'play' && e.kind === 'sacrificeBunt' && ourIds.has(e.batterId)) tactics.bunts[1]++
      else if (e.type === 'substitution' && e.side === ours) {
        if (e.kind === 'pitcher') {
          tactics.pitchingChanges++
          tactics.starterOutInning ??= game.inning
        } else if (e.kind === 'defense') tactics.defensiveSubs++
        else if (e.kind === 'pinchHit') tactics.pinchHits++
        else tactics.pinchRuns++
      }
    }
  }
  const highlights = new HighlightCollector({ inning: game.inning, half: game.half, score: game.score })
  const lead = new WinningRbiTracker(ours, game.half)
  const collect = (events: readonly GameEvent[]) => {
    highlights.collect(events)
    lead.collect(events)
    // 事件累加出來的比分一定要跟引擎一致；不一致代表事件流少了得分，與其給錯的精彩事件不如直接報錯
    if (highlights.score.home !== game.score.home || highlights.score.away !== game.score.away) {
      throw new Error(`精彩事件的比分 ${highlights.score.away}:${highlights.score.home} 跟比賽 ${game.score.away}:${game.score.home} 對不起來`)
    }
  }

  while (!game.over) {
    if (game.stepIndex >= maxSteps) {
      throw new MatchStepLimitError(maxSteps, { inning: game.inning, half: game.half, score: { ...game.score } })
    }
    const before = game.commands.length
    const issued = coach.act(game)
    for (const c of game.commands.slice(before)) {
      if (c.tactic.type === 'bunt') tactics.bunts[0]++
      else if (c.tactic.type === 'hitAndRun') tactics.hitAndRuns++
    }
    tally(issued)
    collect(issued)
    const stepped = game.step()
    tally(stepped)
    collect(stepped)
  }

  const result: MatchResult = {
    score: { ...game.score },
    winner: game.winner!,
    innings: game.inning,
    linescore: { home: [...game.linescore.home], away: [...game.linescore.away] },
    hits: { ...game.hits },
    errors: { ...game.errors },
    players: playerStats(game),
    highlights: highlights.list,
    steps: game.stepIndex,
    replay: {
      setup: resolved,
      commands: game.commands.map((c) => ({ ...c })),
      ai,
      rulesVersion: resolved.rules,
      coachVersion: AUTO_COACH_VERSION,
    },
    tactics,
    mvpFacts: { ...facts, winningRbi: game.winner === ours ? lead.batterId : null },
  }
  return { result, game }
}

/** 自動打完一整場，只回傳可序列化的結果（可以直接丟給 Web Worker 或存起來） */
export function runMatch(setup: GameSetup, ai?: MatchAi, options?: MatchOptions): MatchResult {
  return runMatchWithGame(setup, ai, options).result
}

/** 每位有上場紀錄的球員（打席、投球或出場），依主隊、客隊排序 */
function playerStats(game: Game): PlayerStat[] {
  const stats: PlayerStat[] = []
  for (const side of ['home', 'away'] as const) {
    for (const id of game.rosterIds(side)) {
      const line = game.box[id]
      const score = game.stats[id]
      const player = game.player(id)
      if ((!line && !score) || !player) continue
      stats.push({
        playerId: id,
        name: player.name,
        side,
        role: player.role,
        line: line ? { ...line } : { pa: 0, hits: 0, hr: 0, rbi: 0, so: 0, outs: 0, runs: 0, k: 0 },
        stats: structuredClone(score ?? { batting: null, pitching: null }),
      })
    }
  }
  return stats
}

/**
 * 從事件流挑出精彩事件。事件不帶局數和比分，所以自己跟著事件推進：
 * halfInningEnd 換半局（同一步裡半局結束之後的事件，例如下個半局開始時的換投，算在下個半局），
 * play 的 runs 加到當時的進攻方，每個精彩事件記的就是它發生當下的比分
 */
export class HighlightCollector {
  readonly list: Highlight[] = []
  readonly score: { home: number; away: number }
  private inning: number
  private half: Half

  constructor(start: { inning: number; half: Half; score: { home: number; away: number } }) {
    this.inning = start.inning
    this.half = start.half
    this.score = { ...start.score }
  }

  collect(events: readonly GameEvent[]): void {
    events.forEach((e, i) => {
      const batting: Side = this.half === 'top' ? 'away' : 'home'
      if (e.type === 'play') this.score[batting] += e.runs
      const base = { inning: this.inning, half: this.half, score: { ...this.score } }
      if (e.type === 'halfInningEnd') {
        if (e.half === 'top') this.half = 'bottom'
        else {
          this.half = 'top'
          this.inning++
        }
      } else if (e.type === 'play') {
        if (e.kind === 'homeRun') this.list.push({ ...base, kind: 'homeRun', side: batting, playerId: e.batterId, runs: e.runs })
        else if (e.runs >= 2 && HITS.has(e.kind)) this.list.push({ ...base, kind: 'clutchHit', side: batting, playerId: e.batterId, runs: e.runs })
      } else if (e.type === 'substitution' && e.kind === 'pitcher') {
        this.list.push({ ...base, kind: 'pitchingChange', side: e.side, playerId: e.inId, outId: e.outId, runs: 0 })
      } else if (e.type === 'gameOver') {
        // 再見：打完這一球主隊就超前、比賽直接結束（中間沒有半局結束）
        const prev = events[i - 1]
        if (e.winner === 'home' && prev?.type === 'play' && prev.runs > 0) {
          this.list.push({ ...base, kind: 'walkOff', side: 'home', playerId: prev.batterId, runs: prev.runs })
        }
      }
    })
  }
}

const HITS: ReadonlySet<string> = new Set(['single', 'double', 'triple'])

/** 進階設定跟風格的預設不同嗎（只看有給的欄位） */
export function isCustomParams(style: CoachStyle, params: Partial<CoachParams> | undefined): boolean {
  if (!params) return false
  const preset = COACH_PRESETS[style] as unknown as Record<string, unknown>
  return Object.entries(params).some(([k, v]) => v !== undefined && preset[k] !== v)
}

/**
 * 勝利打點：我方從「沒領先」變成「領先」的那個打席的打者；對手之後追平或超前就清掉。
 * 失誤、雙殺打帶來的得分不算打點，取得領先也不記（null）。比賽結束我方贏，留下來的就是勝利打點
 */
export class WinningRbiTracker {
  batterId: string | null = null
  private half: Half
  private diff = 0

  constructor(
    private readonly ours: Side,
    half: Half,
  ) {
    this.half = half
  }

  collect(events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'halfInningEnd') {
        this.half = e.half === 'top' ? 'bottom' : 'top'
        continue
      }
      if (e.type !== 'play' || e.runs === 0) continue
      const batting: Side = this.half === 'top' ? 'away' : 'home'
      const before = this.diff
      this.diff += batting === this.ours ? e.runs : -e.runs
      if (batting === this.ours && before <= 0 && this.diff > 0) this.batterId = e.kind === 'error' || e.kind === 'doublePlay' ? null : e.batterId
      else if (batting !== this.ours && before > 0 && this.diff <= 0) this.batterId = null
    }
  }
}
