// 進行中的比賽（Live Match）：固定比賽計畫、推算目前是哪一場、把一場比賽的逐格事件對應到 5 分鐘的比賽時間。
//
// 時間語意（沿用 idleEngine 的規則，見 ADR-0008）：
// - 結算後 idle.anchorMs 就是第 idle.nextMatchIndex 場的開始時間，這一場在 anchor + MATCH_INTERVAL_MS 結束、才能結算。
// - 比賽一場接一場，沒有空檔；離線超過 8 小時的時間捨棄（錨點往前拉）。
//
// 固定比賽計畫（為什麼不用最新的球團）：
// 原本的比賽計畫在結算時才用「最新的球團」建立，比賽進行中升級、換陣容會改變這一場的結果。
// 現在規則是：任何會改變比賽計畫輸入的操作（換陣容／戰術、升級、招募、釋出、晉級），都在 ClubLock 裡
// 「先結算到期的比賽 → 用修改前的狀態固定進行中那一場的計畫（liveMatch）→ 再套用修改」。
// 球團只會被寫入操作改變，所以「修改前的狀態」就是那一場開賽當下的狀態；沒有任何修改時，用目前的球團算出來的計畫
// 也就是開賽時的計畫。因此不管有沒有人在看、在哪個分頁看、什麼時候加入，同一場比賽的計畫與結果都一樣。
import type { GameEvent } from '../../sim/game'
import type { ClubSave } from '../domain/club'
import { planMatch, type MatchPlan } from './batchRunner'
import { MATCH_INTERVAL_MS, advanceAnchor, dueMatches } from './idleEngine'
import { runMatch } from './matchRunner'
import { buildTimeline, type ReplayFrame, type ReplayTimeline } from './replayPlayer'

/** 第 matchIndex 場要用的計畫：已經固定就用固定的，否則用目前的球團算（兩者在開賽後一定相同） */
export function planFor(club: ClubSave, matchIndex: number): MatchPlan {
  const live = club.liveMatch
  if (live && live.matchIndex === matchIndex) return structuredClone(live.plan)
  return planMatch(club, matchIndex)
}

/**
 * 把進行中那一場（idle.nextMatchIndex，呼叫前要先結算到期的比賽）的計畫固定下來（不改輸入）。
 * 已經固定就原樣回傳；修改球團的操作一定要在套用修改「之前」呼叫
 */
export function freezeLiveMatch(club: ClubSave): ClubSave {
  const index = club.idle.nextMatchIndex
  if (club.liveMatch?.matchIndex === index) return club
  return { ...club, liveMatch: { matchIndex: index, plan: planMatch(club, index) } }
}

export interface LiveMatchInfo {
  matchIndex: number
  matchId: string
  /** 預定開始、結束時間 */
  startsAt: number
  endsAt: number
  plan: MatchPlan
  /** 計畫已經固定在存檔裡（否則是用目前的球團推算的，兩者相同） */
  frozen: boolean
}

/**
 * 現在正在進行的是哪一場、什麼時候開始與結束。用跟結算相同的函式推算：
 * 還沒結算的到期比賽（例如唯讀分頁不能結算）也算進去，進行中那一場是 nextMatchIndex + 到期場數。
 * 時間倒退（now 比錨點還早）時，回傳的比賽 startsAt 在未來：畫面顯示倒數，不宣稱正在直播
 */
export function currentLiveMatch(club: ClubSave, now: number): LiveMatchInfo {
  const due = dueMatches(club.idle, now)
  const matchIndex = club.idle.nextMatchIndex + due.matches
  const startsAt = due.rewound ? club.idle.anchorMs : advanceAnchor(club.idle.anchorMs, now, due.matches)
  const plan = planFor(club, matchIndex)
  return { matchIndex, matchId: plan.matchId, startsAt, endsAt: startsAt + MATCH_INTERVAL_MS, plan, frozen: club.liveMatch?.matchIndex === matchIndex }
}

// ---- 逐格事件 ↔ 比賽時間 ----
//
// 每一格分成兩段（Phase 6B，見 ADR-0014）：
// - 懸念（prelude）：投手準備、投球飛向本壘、盜壘起跑、換投公告。不揭露這一格的結果，排在這一格正式提交「之前」。
// - 揭曉（reveal）：投球結果、擊球軌跡、跑壘、大字、得分、追平／逆轉／再見。排在這一格正式提交「之後」。
// 所以第 i 格的時間段 [startOf(i), endOf(i)) 裡播的是「第 i − 1 格的揭曉」＋「第 i 格的懸念」，
// endOf(i) 是第 i 格的正式提交時間（球剛好在這一刻到達本壘）。最後一格的揭曉在比賽結束時間（endsAt）之後，
// 跟最終勝負一起演出。時間段的長度依這兩段的權重分配，總長仍然是 durationMs

/** 一格裡「揭曉前」的動畫大概要多久（相對權重，跟 V1 的動畫節奏同比例） */
export function preludeWeight(events: readonly GameEvent[]): number {
  let w = 0
  for (const e of events) {
    if (e.type === 'pitch') w += 0.6
    else if (e.type === 'steal') w += 0.5
    else if (e.type === 'substitution') w += 0.8
  }
  return w
}

/** 一格裡「揭曉後」的動畫大概要多久（相對權重） */
export function revealWeight(events: readonly GameEvent[]): number {
  let w = 0
  for (const e of events) {
    if (e.type === 'pitch') w += e.result === 'inPlay' ? 0 : 0.3
    else if (e.type === 'play') w += 1.45 + (e.ball?.distance ?? 0) * 0.0026 + (e.kind === 'homeRun' ? 1.4 : e.kind === 'strikeout' ? 0.5 : 0)
    else if (e.type === 'steal') w += 0.95
    else if (e.type === 'halfInningEnd') w += 0.9
  }
  return w
}

/** 一格事件在畫面上大概要播多久（懸念＋揭曉） */
export function frameWeight(events: readonly GameEvent[]): number {
  return Math.max(0.3, preludeWeight(events) + revealWeight(events))
}

/** 把一場比賽的每一格對應到 [0, durationMs) 的時間段 */
export class LiveSchedule {
  /** 第 i 格的結束時間＝正式提交時間（相對開賽，毫秒） */
  readonly ends: number[]
  /** 第 i 個時間段裡，第 i − 1 格的揭曉佔的比例（0～1） */
  private readonly shares: number[]

  constructor(
    readonly frames: readonly ReplayFrame[],
    readonly durationMs: number = MATCH_INTERVAL_MS,
  ) {
    const pre = frames.map((f) => preludeWeight(f.events))
    const post = frames.map((f) => revealWeight(f.events))
    const weights = frames.map((_, i) => Math.max(0.3, pre[i] + (i > 0 ? post[i - 1] : 0)))
    this.shares = frames.map((_, i) => {
      const r = i > 0 ? post[i - 1] : 0
      return r + pre[i] > 0 ? r / (r + pre[i]) : 0
    })
    const total = weights.reduce((a, b) => a + b, 0)
    let acc = 0
    this.ends = weights.map((w) => {
      acc += w
      return Math.round((acc / total) * durationMs)
    })
    if (this.ends.length) this.ends[this.ends.length - 1] = durationMs
  }

  /** 第 i 個時間段開頭，留給第 i − 1 格揭曉的比例 */
  revealShare(i: number): number {
    return this.shares[i] ?? 0
  }

  startOf(i: number): number {
    return i === 0 ? 0 : this.ends[i - 1]
  }

  endOf(i: number): number {
    return this.ends[i]
  }

  /** 開賽後 elapsedMs 時正在播的那一格（等於已經播完的格數）；比賽已經結束時是 frames.length */
  positionAt(elapsedMs: number): number {
    if (elapsedMs <= 0) return 0
    if (elapsedMs >= this.durationMs) return this.frames.length
    // 二分搜尋：第一個 end > elapsed 的格
    let lo = 0
    let hi = this.ends.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.ends[mid] > elapsedMs) hi = mid
      else lo = mid + 1
    }
    return lo
  }
}

export interface LiveTimeline {
  timeline: ReplayTimeline
  schedule: LiveSchedule
}

/** 用固定的計畫跑一次（跟結算同一套計算），轉成可以依時間播放的時間軸 */
export function liveTimeline(plan: MatchPlan): LiveTimeline {
  const result = runMatch(plan.setup, plan.ai)
  const timeline = buildTimeline(result.replay)
  return { timeline, schedule: new LiveSchedule(timeline.frames) }
}
