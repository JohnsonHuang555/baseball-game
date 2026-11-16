// 放置時間的計算：只看「時間錨點」與現在時間，不靠 setInterval 累加，所以重新整理、背景分頁、
// 離線都算得一樣。現在時間一律由呼叫端（Clock）傳進來，這裡沒有 Date.now()。
//
// 規則（見 ADR-0008）：
// 1. 累積：elapsed = now − anchor，封頂 MAX_OFFLINE_MS；應打場數 = floor(elapsed / MATCH_INTERVAL_MS)，最多 MAX_BATCH_MATCHES。
// 2. 保留：結算 n 場後 anchor = max(anchor, now − MAX_OFFLINE_MS) + n × MATCH_INTERVAL_MS，
//    不足一場的餘數留在 anchor 與 now 之間；超過封頂的時間在這一步捨棄（錨點往前拉到 now − MAX_OFFLINE_MS）。
// 3. 時間倒退（now < anchor）：0 場，錨點不動。錨點不往回拉，調慢時鐘再調回來不會多出場次。
import type { IdleState } from '../domain/club'
import { IDLE_CONFIG } from '../domain/config'

export const { MATCH_INTERVAL_MS, MAX_OFFLINE_MS, MAX_BATCH_MATCHES } = IDLE_CONFIG

/** 時間來源：正式環境用系統時間，測試換成可控制的時鐘 */
export interface Clock {
  now(): number
}

export interface DueMatches {
  /** 現在應該結算幾場 */
  matches: number
  /** 錨點到現在實際經過的時間（倒退時是負數） */
  elapsedMs: number
  /** 封頂之後算進場次的時間 */
  countedMs: number
  /** 超過離線上限、會被捨棄的時間 */
  discardedMs: number
  /** 系統時間比錨點還早 */
  rewound: boolean
  /** 距離下一場打完還要多久（0～MATCH_INTERVAL_MS） */
  nextMatchInMs: number
}

export class ClockError extends Error {
  override name = 'ClockError'
}

function checkNow(now: number): void {
  if (!Number.isFinite(now)) throw new ClockError(`時間不合法：${now}`)
}

/** 現在應該打完幾場 */
export function dueMatches(idle: Pick<IdleState, 'anchorMs'>, now: number, maxMatches = MAX_BATCH_MATCHES): DueMatches {
  checkNow(now)
  const elapsedMs = now - idle.anchorMs
  if (elapsedMs < 0) {
    return { matches: 0, elapsedMs, countedMs: 0, discardedMs: 0, rewound: true, nextMatchInMs: MATCH_INTERVAL_MS }
  }
  const countedMs = Math.min(elapsedMs, MAX_OFFLINE_MS)
  const matches = Math.min(Math.floor(countedMs / MATCH_INTERVAL_MS), Math.max(0, Math.floor(maxMatches)))
  return {
    matches,
    elapsedMs,
    countedMs,
    discardedMs: elapsedMs - countedMs,
    rewound: false,
    nextMatchInMs: MATCH_INTERVAL_MS - (countedMs % MATCH_INTERVAL_MS),
  }
}

/** 結算了 settled 場之後的新錨點（settled 可以比應打場數少，例如批次被中斷） */
export function advanceAnchor(anchorMs: number, now: number, settled: number): number {
  checkNow(now)
  if (!Number.isSafeInteger(settled) || settled < 0) throw new RangeError(`結算場數不合法：${settled}`)
  // 時間倒退時沒有任何場次可以結算，錨點維持原樣
  if (now < anchorMs) {
    if (settled > 0) throw new RangeError('時間倒退時不能結算場次')
    return anchorMs
  }
  const floor = Math.max(anchorMs, now - MAX_OFFLINE_MS)
  const next = floor + settled * MATCH_INTERVAL_MS
  if (next > now) throw new RangeError(`結算的場次超過經過的時間：${settled} 場`)
  return next
}
