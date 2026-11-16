// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, T0 } from '../testkit'
import { ClockError, MATCH_INTERVAL_MS, MAX_BATCH_MATCHES, MAX_OFFLINE_MS, advanceAnchor, dueMatches } from './idleEngine'

const idle = { anchorMs: T0 }
const due = (ms: number) => dueMatches(idle, T0 + ms).matches

describe('應打場數', () => {
  it('建議設定：5 分鐘一場、離線最多 8 小時、一次最多 96 場', () => {
    expect(MATCH_INTERVAL_MS).toBe(5 * MINUTE)
    expect(MAX_OFFLINE_MS).toBe(8 * HOUR)
    expect(MAX_BATCH_MATCHES).toBe(96)
  })

  it('離線 0、4、5、12 分鐘：0、0、1、2 場', () => {
    expect(due(0)).toBe(0)
    expect(due(4 * MINUTE)).toBe(0)
    expect(due(5 * MINUTE)).toBe(1)
    expect(due(12 * MINUTE)).toBe(2)
  })

  it('離線 8 小時：96 場；超過 8 小時仍最多 96 場，多出來的時間捨棄', () => {
    expect(due(8 * HOUR)).toBe(96)
    for (const ms of [8 * HOUR + 1, 8 * HOUR + 4 * MINUTE, 20 * HOUR, 30 * 24 * HOUR]) {
      const d = dueMatches(idle, T0 + ms)
      expect(d.matches).toBe(96)
      expect(d.discardedMs).toBe(ms - 8 * HOUR)
    }
  })

  it('時間倒退：0 場，不會是負數', () => {
    for (const ms of [-1, -5 * MINUTE, -10 * HOUR]) {
      const d = dueMatches(idle, T0 + ms)
      expect(d.matches).toBe(0)
      expect(d.rewound).toBe(true)
    }
  })

  it('不合法的時間直接報錯', () => {
    expect(() => dueMatches(idle, NaN)).toThrow(ClockError)
    expect(() => dueMatches(idle, Infinity)).toThrow(ClockError)
  })
})

describe('時間錨點', () => {
  /** 模擬「每次回來就把到期的都結算掉」，回傳每次結算的場數 */
  function settleAt(times: number[]): { counts: number[]; anchor: number } {
    let anchor = T0
    const counts = times.map((t) => {
      const n = dueMatches({ anchorMs: anchor }, t).matches
      anchor = advanceAnchor(anchor, t, n)
      return n
    })
    return { counts, anchor }
  }

  it('12 分鐘結算 2 場，剩下的 2 分鐘保留；再過 3 分鐘就有第 3 場', () => {
    const { counts, anchor } = settleAt([T0 + 12 * MINUTE, T0 + 15 * MINUTE])
    expect(counts).toEqual([2, 1])
    expect(anchor).toBe(T0 + 15 * MINUTE)
    expect(advanceAnchor(T0, T0 + 12 * MINUTE, 2)).toBe(T0 + 10 * MINUTE)
  })

  it('同一個時間重複結算，不會多出場次', () => {
    const t = T0 + 37 * MINUTE
    expect(settleAt([t, t, t, t]).counts).toEqual([7, 0, 0, 0])
  })

  it('分很多次回來與一次回來，總場數一樣（不足一場的時間不會流失）', () => {
    const many = settleAt(Array.from({ length: 50 }, (_, i) => T0 + (i + 1) * 3 * MINUTE + 17_000))
    const once = settleAt([T0 + 50 * 3 * MINUTE + 17_000])
    expect(many.counts.reduce((a, b) => a + b, 0)).toBe(once.counts[0])
    expect(many.anchor).toBe(once.anchor)
  })

  it('離線超過 8 小時：結算 96 場後錨點到現在，超出的時間不會之後再補', () => {
    const t = T0 + 20 * HOUR
    const { counts, anchor } = settleAt([t, t + 4 * MINUTE, t + 5 * MINUTE])
    expect(counts).toEqual([96, 0, 1])
    expect(anchor).toBe(t + 5 * MINUTE)
  })

  it('時間倒退再回來：錨點不動，不會多出場次，也不會重複', () => {
    const { counts } = settleAt([T0 + 10 * MINUTE, T0 - 3 * HOUR, T0 + 10 * MINUTE, T0 + 15 * MINUTE])
    expect(counts).toEqual([2, 0, 0, 1])
    expect(advanceAnchor(T0, T0 - HOUR, 0)).toBe(T0)
    expect(() => advanceAnchor(T0, T0 - HOUR, 1)).toThrow(RangeError)
  })

  it('批次中斷只結算一部分：錨點只推進結算掉的場次，剩下的下次照樣算得到', () => {
    const t = T0 + 30 * MINUTE
    const anchor = advanceAnchor(T0, t, 2)
    expect(dueMatches({ anchorMs: anchor }, t).matches).toBe(4)
  })

  it('結算場數超過經過的時間就報錯', () => {
    expect(() => advanceAnchor(T0, T0 + 9 * MINUTE, 2)).toThrow(RangeError)
    expect(() => advanceAnchor(T0, T0 + 9 * MINUTE, -1)).toThrow(RangeError)
    expect(() => advanceAnchor(T0, T0 + 9 * MINUTE, 0.5)).toThrow(RangeError)
  })
})
