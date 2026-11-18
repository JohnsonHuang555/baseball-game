// 比賽時間軸：把一場比賽（MatchReplay）轉成逐格的事件與狀態，給觀戰畫面播放。
// 直播（livePlayer.ts，依真實時間）與晉級挑戰賽的觀看（這裡的 ReplayPlayer，可以暫停、調速度、直接看結果）共用。
//
// - 不碰 DOM、不碰存檔、不碰球團：輸入是一份複製的 MatchReplay，輸出只有時間軸與播放狀態。
// - 時間軸用 V1 的 Game 照「setup + commands」逐步重現（跟 sim/game.ts 的 replay() 同一套規則），
//   但連 issue() 本身產生的事件（換投、代打、故意四壞）也一起收集，畫面才能如實播出。
// - 開啟時一次算完整場：同一份 Replay 每次的時間軸都相同，跳到結束、重新播放只是移動位置，不重新模擬。
//   之後要支援逐局跳轉，只要用 frame 的 inning / half 找到位置即可。
// - 算完會跟戰報摘要（比分、勝負、局數）核對，不一致就當成錯誤，不播放不可信的內容。
import { Game, LEVERAGE_THRESHOLD, RULES_VERSION, type Alignment, type Command, type GameEvent, type Half, type Side } from '../../sim/game'
import type { Player } from '../../sim/types'
import { DEFAULT_MAX_STEPS, type MatchReplay } from './matchRunner'

export type ReplayErrorCode = 'corrupt' | 'unsupported-version' | 'mismatch'

/** 這份 Replay 不能播放：資料損壞、規則版本不支援，或重播結果跟戰報對不起來 */
export class ReplayError extends Error {
  override name = 'ReplayError'
  constructor(
    readonly code: ReplayErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 某一刻的比賽狀態（畫面只畫這些，全部來自模擬） */
export interface ReplayState {
  inning: number
  half: Half
  outs: number
  balls: number
  strikes: number
  score: Record<Side, number>
  /** 每局比分（下半局還沒打的局不會有值） */
  linescore: Record<Side, number[]>
  hits: Record<Side, number>
  errors: Record<Side, number>
  /** 一、二、三壘上的跑者編號 */
  bases: (string | null)[]
  battingSide: Side
  /** 比賽結束時是 null */
  batterId: string | null
  pitcherId: string | null
  alignment: Alignment
  over: boolean
  winner: Side | null
}

/** 時間軸的一格：一次推進（約一球）連同這一步之前下的指令所產生的事件 */
export interface ReplayFrame {
  /** 第幾格（0 起算） */
  index: number
  /** Game 的 stepIndex（推進前） */
  step: number
  /** 這一格開始時的投手（這一格裡換投的話，事件會告訴畫面換人） */
  throwerId: string
  /** 關鍵時刻：V1 在這種時候用正常速度播放 */
  important: boolean
  events: GameEvent[]
  /** 這一格結束後的狀態 */
  after: ReplayState
}

export interface ReplayTimeline {
  /** 我方是主隊還是客隊 */
  userSide: Side
  teamNames: Record<Side, string>
  /** 開賽前的狀態 */
  initial: ReplayState
  frames: ReplayFrame[]
  /** 最後的狀態（等於最後一格的 after） */
  final: ReplayState
  /** 這場比賽出現過的所有球員（比賽當時的快照，包含之後被釋出的球員） */
  players: ReadonlyMap<string, Player>
  rulesVersion: number
}

/** 戰報摘要裡用來核對的欄位（我方視角） */
export interface ReplayExpectation {
  userSide: Side
  runsFor: number
  runsAgainst: number
  won: boolean
  innings: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 結構檢查：只檢查重播需要的部分，不合格丟 ReplayError（不會丟其他錯誤） */
function validateReplay(value: unknown): MatchReplay {
  if (!isObj(value)) throw new ReplayError('corrupt', '重播資料不存在或格式不對')
  const { setup, commands, rulesVersion } = value
  if (!isObj(setup) || !isObj(setup.home) || !isObj(setup.away)) throw new ReplayError('corrupt', '重播缺少比賽設定')
  if (setup.userSide !== 'home' && setup.userSide !== 'away') throw new ReplayError('corrupt', '重播的主客場設定不合法')
  if (typeof setup.seed !== 'number' || !Number.isFinite(setup.seed)) throw new ReplayError('corrupt', '重播的種子不合法')
  if (!Number.isInteger(rulesVersion) || setup.rules !== rulesVersion) throw new ReplayError('corrupt', '重播的規則版本紀錄對不起來')
  if ((rulesVersion as number) < 1 || (rulesVersion as number) > RULES_VERSION) {
    throw new ReplayError('unsupported-version', `這場比賽使用規則版本 ${rulesVersion}，目前的程式只支援 1～${RULES_VERSION}`)
  }
  for (const side of ['home', 'away'] as const) {
    const team = setup[side] as Record<string, unknown>
    const roster = team.roster
    if (typeof team.name !== 'string' || !isObj(roster) || !Array.isArray(roster.lineup) || roster.lineup.length !== 9 || !isObj(roster.starter)) {
      throw new ReplayError('corrupt', '重播的陣容資料不完整')
    }
  }
  if (!Array.isArray(commands)) throw new ReplayError('corrupt', '重播缺少指令紀錄')
  let last = 0
  for (const c of commands) {
    if (!isObj(c) || !Number.isSafeInteger(c.stepIndex) || (c.stepIndex as number) < last || !isObj(c.tactic) || typeof c.tactic.type !== 'string') {
      throw new ReplayError('corrupt', '重播的指令紀錄格式不對')
    }
    last = c.stepIndex as number
  }
  return value as unknown as MatchReplay
}

function snapshot(game: Game): ReplayState {
  return {
    inning: game.inning,
    half: game.half,
    outs: game.outs,
    balls: game.balls,
    strikes: game.strikes,
    score: { ...game.score },
    linescore: { home: [...game.linescore.home], away: [...game.linescore.away] },
    hits: { ...game.hits },
    errors: { ...game.errors },
    bases: game.bases.map((b) => b?.id ?? null),
    battingSide: game.battingSide,
    batterId: game.over ? null : game.batter.id,
    pitcherId: game.over ? null : game.pitcher.id,
    alignment: game.alignment,
    over: game.over,
    winner: game.winner,
  }
}

/**
 * 把一份 Replay 轉成時間軸。不改輸入：先深拷貝再交給 Game。
 * expected 有給就核對比分、勝負、局數；任何問題都丟 ReplayError
 */
export function buildTimeline(value: unknown, expected?: ReplayExpectation, options: { maxSteps?: number } = {}): ReplayTimeline {
  const source = validateReplay(value)
  let replay: MatchReplay
  try {
    replay = structuredClone(source)
  } catch {
    throw new ReplayError('corrupt', '重播資料無法複製')
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  let game: Game
  try {
    game = new Game(replay.setup)
  } catch (e) {
    throw new ReplayError('corrupt', `重播的比賽設定無法建立比賽：${(e as Error).message}`)
  }
  const players = new Map<string, Player>()
  for (const side of ['home', 'away'] as const) {
    const r = replay.setup[side].roster
    for (const p of [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers]) players.set(p.id, p)
  }
  const initial = snapshot(game)
  const frames: ReplayFrame[] = []
  const commands: readonly Command[] = replay.commands
  let c = 0
  try {
    while (!game.over) {
      if (game.stepIndex >= maxSteps) throw new ReplayError('corrupt', `重播超過 ${maxSteps} 步還沒結束`)
      const step = game.stepIndex
      const events: GameEvent[] = []
      // 這一步之前的指令（跟 V1 replay() 相同的時機）；指令不合法代表資料壞了或規則不相容，不略過
      const throwerBefore = game.pitcher.id
      while (c < commands.length && commands[c].stepIndex === step) events.push(...game.issue(commands[c++].tactic))
      if (game.over) {
        // 指令本身結束了比賽（例如滿壘故意四壞的再見）：這些事件自成一格
        frames.push({ index: frames.length, step, throwerId: throwerBefore, important: true, events, after: snapshot(game) })
        break
      }
      const throwerId = throwerBefore
      const important = game.leverage() >= LEVERAGE_THRESHOLD
      events.push(...game.step())
      frames.push({ index: frames.length, step, throwerId, important, events, after: snapshot(game) })
    }
  } catch (e) {
    if (e instanceof ReplayError) throw e
    throw new ReplayError('corrupt', `重播時發生錯誤：${(e as Error).message}`)
  }
  if (c !== commands.length) throw new ReplayError('corrupt', '重播結束後還有沒用到的指令，紀錄可能損壞')
  const final = snapshot(game)
  if (expected) {
    const other: Side = expected.userSide === 'home' ? 'away' : 'home'
    const ok =
      expected.userSide === game.userSide &&
      final.score[expected.userSide] === expected.runsFor &&
      final.score[other] === expected.runsAgainst &&
      (final.winner === expected.userSide) === expected.won &&
      final.inning === expected.innings
    if (!ok) {
      throw new ReplayError('mismatch', `重播結果 ${final.score.away}:${final.score.home} 跟戰報 ${expected.runsFor}:${expected.runsAgainst}（我方）對不起來`)
    }
  }
  return {
    userSide: game.userSide,
    teamNames: { home: replay.setup.home.name, away: replay.setup.away.name },
    initial,
    frames,
    final,
    players,
    rulesVersion: replay.rulesVersion,
  }
}

// ---- 播放器 ----

export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'completed' | 'error' | 'disposed'

export const REPLAY_SPEEDS = [1, 2, 4] as const
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number]
/** 預設 2×：V1 一般比賽是 1×，但觀戰看的是已經打完的比賽，1× 一場要十幾分鐘 */
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 2

/** 播放一格時給畫面的資訊：速度用函式讀，播放中切換速度下一段動畫就生效 */
export interface FrameContext {
  speed: () => ReplaySpeed
  /** 暫停、跳過、重新播放、關閉時中斷這一格的動畫 */
  signal: AbortSignal
  /** 這一格開始前的狀態 */
  before: ReplayState
  /** 直播：這一格的動畫要在幾毫秒內播完（依剩餘時間縮放）；沒有就照 speed 播 */
  budgetMs?: number
  /**
   * 直播：只「呈現」這一格的事件（投球、擊球、跑壘、大字、文字），不提交這一格之後的狀態
   * （比分條、出局、好壞球、壘上、比賽結束）。狀態由播放器在這一格排定的結束時間到了才用 commit() 提交
   */
  presentOnly?: boolean
  /**
   * 直播（Phase 6B）：這一格要演哪一段。prelude（懸念）：投球飛向本壘、關鍵打席、換投公告，在這一格正式提交「之前」播，
   * 不能揭露結果；reveal（揭曉）：投球結果、擊球軌跡、跑壘、大字、得分提示，在這一格正式提交「之後」播。
   * 沒有給（晉級挑戰賽）就照順序演完整一格
   */
  phase?: 'prelude' | 'reveal'
  /** 直播：這是最後一格的揭曉，在比賽結束時間（endsAt）之後、跟最終勝負一起演出 */
  final?: boolean
}

/** 畫面這一側：播放一格動畫、直接顯示某個狀態（跳轉、暫停中斷後） */
export interface ReplayPresenter {
  playFrame(frame: ReplayFrame, ctx: FrameContext): Promise<void>
  /** 不播動畫，直接把畫面設成這個狀態（中斷進行中的動畫）；position 是已經播完幾格 */
  show(state: ReplayState, position: number): void
  /**
   * 直播：正式提交某個時間點的比賽狀態（比分條、壘上、局數），不中斷進行中的效果（大字、數據卡）。
   * 沒有實作就用 show()
   */
  commit?(state: ReplayState, position: number, opts?: CommitOptions): void
}

export interface CommitOptions {
  /**
   * 接下來會演這一格的揭曉（擊球軌跡、跑壘）：畫面可以等球落地、跑者到壘時才把比分條換成這個狀態。
   * 只能「晚一點顯示」已經提交的狀態，不能更早
   */
  reveal?: boolean
}

export interface ReplayView {
  status: ReplayStatus
  /** 已經播完幾格 */
  position: number
  total: number
  speed: ReplaySpeed
  /** 目前畫面應該顯示的狀態（已播完的最後一格之後） */
  state: ReplayState
  error: ReplayError | null
}

/**
 * 播放狀態機：idle →(play) playing ⇄(pause/resume) paused；播完 → completed；restart 回到開頭繼續播；
 * skipToEnd 直接到 completed；dispose 之後所有操作都無效，也不再通知畫面。
 * 同一時間只有一個播放迴圈：每次開始播放都換一個新的迴圈代號，舊的迴圈發現代號不同就停下來
 */
export class ReplayPlayer {
  private status: ReplayStatus = 'idle'
  private position = 0
  private speed: ReplaySpeed = DEFAULT_REPLAY_SPEED
  private loopId = 0
  private current: AbortController | null = null
  private readonly listeners = new Set<(v: ReplayView) => void>()
  private error: ReplayError | null = null
  private running: Promise<void> | null = null

  constructor(
    readonly timeline: ReplayTimeline,
    private readonly presenter: ReplayPresenter,
  ) {
    presenter.show(timeline.initial, 0)
  }

  /** 播放器建立失敗時用：直接是 error 狀態 */
  static failed(error: ReplayError): ReplayView {
    return { status: 'error', position: 0, total: 0, speed: DEFAULT_REPLAY_SPEED, state: emptyState(), error }
  }

  get view(): ReplayView {
    return { status: this.status, position: this.position, total: this.timeline.frames.length, speed: this.speed, state: this.stateAt(this.position), error: this.error }
  }

  subscribe(fn: (v: ReplayView) => void): () => void {
    if (this.status === 'disposed') return () => undefined
    this.listeners.add(fn)
    fn(this.view)
    return () => this.listeners.delete(fn)
  }

  /** 開始播放；已經在播放就什麼都不做；暫停中等於 resume；播完了要用 restart */
  play(): void {
    if (this.status === 'idle' || this.status === 'paused') this.startLoop()
  }

  pause(): void {
    if (this.status !== 'playing') return
    this.status = 'paused'
    this.stopLoop()
    // 中斷的那一格不算播完：畫面回到已播完的位置，繼續時從這一格重新播
    this.presenter.show(this.stateAt(this.position), this.position)
    this.emit()
  }

  resume(): void {
    if (this.status === 'paused') this.startLoop()
  }

  setSpeed(speed: ReplaySpeed): void {
    if (this.status === 'disposed' || !REPLAY_SPEEDS.includes(speed)) return
    this.speed = speed
    this.emit()
  }

  /** 從頭播放（播完、暫停、播放中都可以） */
  restart(): void {
    if (this.status === 'disposed' || this.status === 'error') return
    this.stopLoop()
    this.position = 0
    this.presenter.show(this.timeline.initial, 0)
    this.startLoop()
  }

  /** 直接跳到比賽結束：不留下任何播放中的動畫 */
  skipToEnd(): void {
    if (this.status === 'disposed' || this.status === 'error') return
    this.stopLoop()
    this.position = this.timeline.frames.length
    this.status = 'completed'
    this.presenter.show(this.timeline.final, this.position)
    this.emit()
  }

  /** 結束觀戰：中斷動畫、停止迴圈，之後不再通知畫面 */
  dispose(): void {
    if (this.status === 'disposed') return
    this.stopLoop()
    this.status = 'disposed'
    this.listeners.clear()
  }

  /** 測試用：等目前的播放迴圈跑完（或被中斷） */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private stateAt(position: number): ReplayState {
    return position === 0 ? this.timeline.initial : this.timeline.frames[position - 1].after
  }

  private stopLoop(): void {
    this.loopId++
    this.current?.abort()
    this.current = null
  }

  private startLoop(): void {
    this.stopLoop()
    const id = this.loopId
    this.status = 'playing'
    this.emit()
    this.running = this.loop(id)
  }

  private async loop(id: number): Promise<void> {
    const frames = this.timeline.frames
    while (id === this.loopId && this.position < frames.length) {
      const controller = new AbortController()
      this.current = controller
      const frame = frames[this.position]
      try {
        await this.presenter.playFrame(frame, { speed: () => this.speed, signal: controller.signal, before: this.stateAt(this.position) })
      } catch (e) {
        // 被中斷（暫停、跳過、關閉）：不推進。其他錯誤：畫面壞了，停在 error，不影響球團
        if (id !== this.loopId || controller.signal.aborted) return
        this.status = 'error'
        this.error = new ReplayError('corrupt', `播放畫面時發生錯誤：${(e as Error).message}`)
        this.loopId++
        this.emit()
        return
      }
      if (id !== this.loopId || controller.signal.aborted) return
      this.position++
      this.emit()
    }
    if (id === this.loopId && this.position >= frames.length) {
      this.status = 'completed'
      this.current = null
      this.presenter.show(this.timeline.final, this.position)
      this.emit()
    }
  }

  private emit(): void {
    if (this.status === 'disposed') return
    const v = this.view
    for (const l of this.listeners) l(v)
  }
}

function emptyState(): ReplayState {
  return {
    inning: 1,
    half: 'top',
    outs: 0,
    balls: 0,
    strikes: 0,
    score: { home: 0, away: 0 },
    linescore: { home: [], away: [0] },
    hits: { home: 0, away: 0 },
    errors: { home: 0, away: 0 },
    bases: [null, null, null],
    battingSide: 'away',
    batterId: null,
    pitcherId: null,
    alignment: 'normal',
    over: false,
    winner: null,
  }
}

/** 等待 ms 毫秒（速度已經換算好），中斷時丟 AbortError；不留下計時器 */
export interface WaitTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (t: ReturnType<typeof setTimeout>) => void
}
// 用箭頭函式包起來：瀏覽器的 setTimeout 不能當成別的物件的方法呼叫（會丟 Illegal invocation）
const DEFAULT_TIMERS: WaitTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) }

export function abortableWait(ms: number, signal: AbortSignal, timers: WaitTimers = DEFAULT_TIMERS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const t = timers.set(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      timers.clear(t)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(): Error {
  const e = new Error('播放被中斷')
  e.name = 'AbortError'
  return e
}

/** 動畫 Promise 跟中斷訊號賽跑：中斷時馬上丟 AbortError（動畫本身由畫面另外取消） */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
