// 直播播放器：依真實時間播放進行中的那一場。不碰 DOM、不碰存檔。
//
// 兩件事要分開：
// - 呈現事件（presentation）：第 i 格的時間段 [startOf(i), endOf(i)) 內，播這一格的投球、擊球、跑壘動畫與文字。
//   動畫依剩餘時間縮放，可能比時間段早播完。
// - 提交狀態（commit）：開賽後經過 t 毫秒，正式的比賽狀態是「結束時間 ≤ t 的那些格」播完之後的狀態，
//   也就是 stateAt(schedule.positionAt(t))。比分條、出局、壘上、局數、比賽結束與勝敗只看這個，
//   動畫早播完也要等到 endOf(i) 才提交第 i 格之後的狀態；最後一格的最終比分要到 endsAt 才揭曉。
// 其他規則：
// - 進入觀戰時直接同步到目前的進度（不會從第一球開始播一場已經打了兩分鐘的比賽）。
// - 動畫因為背景分頁、系統負載或時間跳動而落後：直接同步到當下，不補播中間的事件。
// - 暫停只停「自己的畫面」：比賽時間照走。繼續時用當下時間重新同步。
// - 獎勵仍然只在結算時發放（結算由一般的放置流程負責，這裡不觸發任何寫入、不改比賽計畫與結果）。
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
  /** 已經正式提交的格數（= 這一刻比賽應該進行到的格數；永遠不會超過真實時間） */
  position: number
  total: number
  /** 已經提交的比賽狀態（比分條顯示的就是這個） */
  state: ReplayState
  startsAt: number
  endsAt: number
}

export class LivePlayer {
  private status: LiveStatus = 'idle'
  /** 已經提交的格數：只在時間到了才前進 */
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

  /** 正式提交：比分條等狀態換成第 position 格之後的狀態（不中斷進行中的效果） */
  private commitTo(position: number): void {
    this.displayed = position
    const state = this.stateAt(position)
    if (this.presenter.commit) this.presenter.commit(state, position)
    else this.presenter.show(state, position)
    this.emit()
  }

  /** 同步：中斷進行中的動畫，直接把畫面設成這個時間點的狀態（剛進來、繼續、落後） */
  private syncTo(position: number): void {
    this.displayed = position
    this.presenter.show(this.stateAt(position), position)
    this.emit()
  }

  private async loop(id: number): Promise<void> {
    const { schedule, startsAt, endsAt } = this.source
    const frames = this.source.timeline.frames
    let synced = false
    /** 已經呈現（播過動畫）的那一格；同一格不重播 */
    let presented = -1
    while (id === this.loopId) {
      const now = this.clock.now()
      const controller = new AbortController()
      this.current = controller
      if (now < startsAt) {
        // 還沒開賽（時間倒退）：等到開賽
        this.setStatus('waiting')
        if (!synced) {
          this.syncTo(0)
          synced = true
        }
        if (!(await this.idle(this.clock.sleep(startsAt - now, controller.signal), id))) return
        continue
      }
      if (now >= endsAt) {
        // 到了預定結束時間才揭曉最終比分與勝敗
        this.displayed = frames.length
        this.status = 'ended'
        this.current = null
        this.presenter.show(this.source.timeline.final, frames.length)
        this.emit()
        return
      }
      this.setStatus('live')
      const target = this.livePosition(now)
      if (!synced || target > this.displayed + 1 || target < this.displayed) {
        // 剛進來、繼續、或畫面落後超過一格：直接同步到當下，不補播中間的事件
        this.syncTo(target)
        synced = true
      } else if (target === this.displayed + 1) {
        // 上一格排定的結束時間到了：正式提交（動畫效果不中斷）
        this.commitTo(target)
      }
      const elapsed = now - startsAt
      if (presented !== target) {
        presented = target
        const budgetMs = Math.max(0, schedule.endOf(target) - elapsed)
        try {
          await this.presenter.playFrame(frames[target], { speed: () => 1, signal: controller.signal, before: this.stateAt(target), budgetMs, presentOnly: true })
        } catch (e) {
          if (id !== this.loopId || controller.signal.aborted) return
          throw e
        }
        if (id !== this.loopId) return
      }
      // 動畫早播完：等到這一格排定的結束時間才提交（不提前揭露下一格的狀態）
      const wait = startsAt + schedule.endOf(target) - this.clock.now()
      if (wait > 0 && !(await this.idle(this.clock.sleep(wait, controller.signal), id))) return
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
