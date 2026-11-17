// 直播播放器：依真實時間播放進行中的那一場。不碰 DOM、不碰存檔。
//
// - 比賽的進度只由時間決定：開賽後經過 t 毫秒，就該播到 schedule.positionAt(t) 那一格。
//   進入觀戰時直接跳到目前的進度（不會從第一球開始播一場已經打了兩分鐘的比賽）。
// - 暫停只停「自己的畫面」：比賽時間照走。繼續時同步到當下的進度，不補播中間錯過的球。
// - 每一格的動畫要在這一格的時間段內播完（畫面依剩餘時間縮放動畫長度）；播完了就等到下一格的時間。
// - 到了預定結束時間就顯示最終比分。獎勵仍然只在結算時發放（結算由一般的放置流程負責，這裡不觸發任何寫入）。
// - 時間倒退（現在比開賽時間早）：顯示「即將開始」並等待，不宣稱正在直播
import { abortableWait, type ReplayPresenter, type ReplayState, type ReplayTimeline } from './replayPlayer'
import type { LiveSchedule } from './liveMatch'

export type LiveStatus = 'idle' | 'waiting' | 'live' | 'paused' | 'ended' | 'error' | 'disposed'

/** 直播用的時間：now 是現在時間，sleep 等待（中斷時丟 AbortError）；測試可以換成虛擬時鐘 */
export interface LiveClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export function systemLiveClock(now: () => number = () => Date.now()): LiveClock {
  return { now, sleep: (ms, signal) => abortableWait(ms, signal) }
}

export interface LiveSource {
  matchIndex: number
  matchId: string
  startsAt: number
  endsAt: number
  timeline: ReplayTimeline
  schedule: LiveSchedule
}

export interface LiveView {
  status: LiveStatus
  /** 畫面已經播完幾格 */
  position: number
  total: number
  /** 畫面目前顯示的狀態 */
  state: ReplayState
  startsAt: number
  endsAt: number
}

export class LivePlayer {
  private status: LiveStatus = 'idle'
  private displayed = 0
  private loopId = 0
  private current: AbortController | null = null
  private readonly listeners = new Set<(v: LiveView) => void>()
  private running: Promise<void> | null = null

  constructor(
    readonly source: LiveSource,
    private readonly presenter: ReplayPresenter,
    private readonly clock: LiveClock,
  ) {}

  get view(): LiveView {
    return {
      status: this.status,
      position: this.displayed,
      total: this.source.timeline.frames.length,
      state: this.stateAt(this.displayed),
      startsAt: this.source.startsAt,
      endsAt: this.source.endsAt,
    }
  }

  /** 現在（真實時間）比賽應該進行到第幾格 */
  livePosition(now = this.clock.now()): number {
    return this.source.schedule.positionAt(now - this.source.startsAt)
  }

  subscribe(fn: (v: LiveView) => void): () => void {
    if (this.status === 'disposed') return () => undefined
    this.listeners.add(fn)
    fn(this.view)
    return () => this.listeners.delete(fn)
  }

  /** 開始看（同步到目前進度）；已經在看就不做事 */
  start(): void {
    if (this.status === 'idle' || this.status === 'paused') this.startLoop()
  }

  /** 暫停自己的畫面（比賽照走） */
  pause(): void {
    if (this.status !== 'live' && this.status !== 'waiting') return
    this.stopLoop()
    this.status = 'paused'
    this.presenter.show(this.stateAt(this.displayed), this.displayed)
    this.emit()
  }

  /** 繼續看：同步到當下的進度 */
  resume(): void {
    if (this.status === 'paused') this.startLoop()
  }

  dispose(): void {
    if (this.status === 'disposed') return
    this.stopLoop()
    this.status = 'disposed'
    this.listeners.clear()
  }

  /** 測試用：等目前的迴圈結束 */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private stateAt(position: number): ReplayState {
    const frames = this.source.timeline.frames
    return position <= 0 ? this.source.timeline.initial : position >= frames.length ? this.source.timeline.final : frames[position - 1].after
  }

  private stopLoop(): void {
    this.loopId++
    this.current?.abort()
    this.current = null
  }

  private startLoop(): void {
    this.stopLoop()
    const id = this.loopId
    this.running = this.loop(id).catch(() => {
      if (id !== this.loopId) return
      this.status = 'error'
      this.loopId++
      this.emit()
    })
  }

  private async loop(id: number): Promise<void> {
    const { schedule, startsAt, endsAt } = this.source
    const frames = this.source.timeline.frames
    let synced = false
    while (id === this.loopId) {
      const now = this.clock.now()
      const controller = new AbortController()
      this.current = controller
      if (now < startsAt) {
        // 還沒開賽（時間倒退）：等到開賽
        this.setStatus('waiting')
        if (!synced) {
          this.displayed = 0
          this.presenter.show(this.stateAt(0), 0)
          synced = true
        }
        if (!(await this.idle(this.clock.sleep(startsAt - now, controller.signal), id))) return
        continue
      }
      if (now >= endsAt) {
        this.displayed = frames.length
        this.status = 'ended'
        this.current = null
        this.presenter.show(this.source.timeline.final, frames.length)
        this.emit()
        return
      }
      this.setStatus('live')
      const target = this.livePosition(now)
      const elapsed = now - startsAt
      // 畫面跑得比比賽快（這一格的動畫提早播完）：等到下一格的時間
      if (synced && target < this.displayed) {
        if (!(await this.idle(this.clock.sleep(schedule.startOf(this.displayed) - elapsed, controller.signal), id))) return
        continue
      }
      // 剛進來、繼續、或畫面落後（例如背景分頁）：直接跳到目前的進度
      if (!synced || target !== this.displayed) {
        this.displayed = target
        this.presenter.show(this.stateAt(target), target)
        this.emit()
        synced = true
      }
      const frame = frames[target]
      const budgetMs = Math.max(0, schedule.endOf(target) - elapsed)
      try {
        await this.presenter.playFrame(frame, { speed: () => 1, signal: controller.signal, before: this.stateAt(target), budgetMs })
      } catch (e) {
        if (id !== this.loopId || controller.signal.aborted) return
        throw e
      }
      if (id !== this.loopId) return
      this.displayed = target + 1
      this.emit()
    }
  }

  /** 等待；被中斷（暫停、關閉）時回傳 false */
  private async idle(p: Promise<void>, id: number): Promise<boolean> {
    try {
      await p
    } catch {
      return false
    }
    return id === this.loopId
  }

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return
    this.status = s
    this.emit()
  }

  private emit(): void {
    if (this.status === 'disposed') return
    const v = this.view
    for (const l of this.listeners) l(v)
  }
}
