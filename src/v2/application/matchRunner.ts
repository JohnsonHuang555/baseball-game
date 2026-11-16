// V2 Headless Match Runner：不經過畫面，用既有的 Game 引擎自動打完一整場。
// 雙方 AI 設定透過 Adapter 對到 V1 引擎：AutoCoach 那一方當作 userSide，由自動教練下指令；
// 另一方是引擎內建的 V1 AI。結果只由 setup（含種子、規則版本）與雙方 AI 設定決定，
// 回傳的 replay 就是 V1 的 { setup, commands }，用 replay() 可以逐步重現。
import { Game, RULES_VERSION, type Command, type GameEvent, type GameSetup, type Half, type PlayerLine, type Side } from '../../sim/game'
import { AUTO_COACH_VERSION, AutoCoach, createPolicy, type CoachParams, type CoachStyle } from './autoCoach'

/** 一方的 AI：自動教練（可選風格），或 V1 引擎內建的對手 AI */
export type SideAi = { kind: 'autoCoach'; style?: CoachStyle; params?: Partial<CoachParams> } | { kind: 'builtin' }

export type MatchAi = Record<Side, SideAi>

export interface MatchOptions {
  /** 最多推進幾步（一步約一球）；超過就丟 MatchStepLimitError，不會產生比分 */
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
  /** 這一步結束後的比分 */
  score: { home: number; away: number }
}

/** 重現整場比賽所需的資訊：setup 已經寫明 userSide 與規則版本，直接交給 V1 的 replay() 即可 */
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
 * 把 GameSetup 與雙方 AI 對到 V1 引擎的設定（Adapter）：
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
  /** 打完的 Game：需要 V1 的賽後計算（例如 gameGrowth、synergyLog）時用；不可序列化 */
  game: Game
}

/** 自動打完一整場，連同打完的 Game 一起回傳 */
export function runMatchWithGame(setup: GameSetup, ai: MatchAi = defaultAi(setup.userSide), options: MatchOptions = {}): MatchRun {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const resolved = resolveSetup(setup, ai)
  const game = new Game(resolved)
  const sideAi = ai[resolved.userSide] as Extract<SideAi, { kind: 'autoCoach' }>
  const coach = new AutoCoach(createPolicy(sideAi.style, sideAi.params))
  const highlights = new HighlightCollector(game)

  while (!game.over) {
    if (game.stepIndex >= maxSteps) {
      throw new MatchStepLimitError(maxSteps, { inning: game.inning, half: game.half, score: { ...game.score } })
    }
    highlights.collect(coach.act(game))
    highlights.collect(game.step())
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
  }
  return { result, game }
}

/** 自動打完一整場，只回傳可序列化的結果（可以直接丟給 Web Worker 或存起來） */
export function runMatch(setup: GameSetup, ai?: MatchAi, options?: MatchOptions): MatchResult {
  return runMatchWithGame(setup, ai, options).result
}

/** 每位有上場紀錄的球員，依主隊、客隊排序 */
function playerStats(game: Game): PlayerStat[] {
  const stats: PlayerStat[] = []
  for (const side of ['home', 'away'] as const) {
    for (const id of game.rosterIds(side)) {
      const line = game.box[id]
      const player = game.player(id)
      if (!line || !player) continue
      stats.push({ playerId: id, name: player.name, side, role: player.role, line: { ...line } })
    }
  }
  return stats
}

/**
 * 從事件流挑出精彩事件。事件不帶局數，所以自己跟著 halfInningEnd 推進局數；
 * 同一步裡半局結束之後的事件（例如下個半局開始時的換投）算在下個半局
 */
class HighlightCollector {
  readonly list: Highlight[] = []
  private inning: number
  private half: Half

  constructor(private readonly game: Game) {
    this.inning = game.inning
    this.half = game.half
  }

  collect(events: readonly GameEvent[]): void {
    const game = this.game
    events.forEach((e, i) => {
      const batting: Side = this.half === 'top' ? 'away' : 'home'
      const base = { inning: this.inning, half: this.half, score: { ...game.score } }
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
