// 直播播放器：依真實時間播放進行中的那一場。不碰 DOM、不碰存檔。
//
// 時間契約（Phase 5B 起，Phase 6B 補上「結果揭露」）：
// - 提交狀態（commit）：開賽後經過 t 毫秒，正式的比賽狀態是「結束時間 ≤ t 的那些格」之後的狀態，
//   也就是 stateAt(schedule.positionAt(t))。第 i 格在 endOf(i) 才提交；最後一格的最終比分與勝敗要到 endsAt 才揭曉。
// - 呈現事件分兩段（見 liveMatch.ts）：第 i 個時間段 [startOf(i), endOf(i)) 先演「第 i − 1 格的揭曉」
//   （投球結果、擊球軌跡、跑壘、大字、得分／追平／逆轉提示——第 i − 1 格在 startOf(i) = endOf(i − 1) 已經提交），
//   再演「第 i 格的懸念」（投手準備、投球飛向本壘、關鍵打席、換投公告——不揭露結果），球剛好在 endOf(i) 到達本壘。
//   所以任何揭露結果的畫面都不會早於那一格的提交時間。
// - 每一段的動畫時間預算來自排程：揭曉用 revealShare 那一份，懸念用到 endOf(i) 為止的剩餘時間；
//   特效太長時由畫面縮短或省略，不會讓比賽落後真實時間。
// - 最後一格（比賽結束的那一球）：在 endsAt 提交最終狀態，接著演它的揭曉（再見、最後一個出局），最後顯示勝負。
// 其他規則：
// - 進入觀戰時直接同步到目前的進度（不會從第一球開始播一場已經打了兩分鐘的比賽）。
// - 動畫因為背景分頁、系統負載或時間跳動而落後：直接同步到當下，不補播中間的事件、也不補演錯過的揭曉。
// - 暫停只停「自己的畫面」：比賽時間照走。繼續時用當下時間重新同步，不重演暫停前的特效。
// - 獎勵仍然只在結算時發放（結算由一般的放置流程負責，這裡不觸發任何寫入、不改比賽計畫與結果）。
// - 時間倒退（現在比開賽時間早）：顯示「即將開始」並等待，不宣稱正在直播
import { abortableWait, type CommitOptions, type ReplayPresenter, type ReplayState, type ReplayTimeline } from './replayPlayer'
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

/** 最後一格的揭曉（再見、最後一個出局）在 endsAt 之後最多演多久，之後顯示勝負 */
export const FINAL_REVEAL_MS = 4500

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
  private commitTo(position: number, opts?: CommitOptions): void {
    this.displayed = position
    const state = this.stateAt(position)
    if (this.presenter.commit) this.presenter.commit(state, position, opts)
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
    /** 已經演過懸念的那一格；同一格不重演 */
    let presented = -1
    /** 剛提交、還沒演揭曉的那一格（同步、跳過時清掉：不補演錯過的揭曉） */
    let pendingReveal = -1
    const play = async (index: number, controller: AbortController, phase: 'prelude' | 'reveal', budgetMs: number, final = false): Promise<boolean> => {
      try {
        await this.presenter.playFrame(frames[index], { speed: () => 1, signal: controller.signal, before: this.stateAt(index), budgetMs: Math.max(0, budgetMs), presentOnly: true, phase, final })
      } catch (e) {
        if (id !== this.loopId || controller.signal.aborted) return false
        throw e
      }
      return id === this.loopId
    }
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
        const last = frames.length - 1
        const revealLast = synced && this.displayed === last && last >= 0
        if (revealLast) {
          // 一路看到最後一球：提交最終狀態，演最後一格的揭曉（再見、最後一個出局），最後顯示勝負
          this.commitTo(frames.length, { reveal: true })
          if (!(await play(last, controller, 'reveal', FINAL_REVEAL_MS, true))) return
        }
        // 揭曉演完（或一進來就已經結束）才進入 ended、顯示勝負面板
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
        // 剛進來、繼續、或畫面落後超過一格：直接同步到當下，不補播中間的事件、不補演錯過的揭曉
        this.syncTo(target)
        synced = true
        pendingReveal = -1
      } else if (target === this.displayed + 1) {
        // 上一格排定的結束時間到了：正式提交，接著演它的揭曉（動畫效果不中斷）
        this.commitTo(target, { reveal: true })
        pendingReveal = target - 1
      }
      if (presented !== target) {
        presented = target
        if (pendingReveal === target - 1 && pendingReveal >= 0) {
          // 這個時間段的前段：上一格的揭曉
          const window = schedule.endOf(target) - schedule.startOf(target)
          const revealBudget = Math.min(window * schedule.revealShare(target), schedule.endOf(target) - (now - startsAt))
          pendingReveal = -1
          if (!(await play(target - 1, controller, 'reveal', revealBudget))) return
        }
        // 後段：這一格的懸念，球在 endOf(target) 到達本壘
        if (!(await play(target, controller, 'prelude', schedule.endOf(target) - (this.clock.now() - startsAt)))) return
      }
      // 動畫早播完：等到這一格排定的結束時間才提交（不提前揭露這一格的結果）
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
