// @vitest-environment happy-dom
// 戰報的日期分組（Code review P3）：用比賽本身的時間分組，不是結算時間、也不是重新開啟遊戲的時間。
// 時間都用本地時間建立（new Date(年, 月, 日, 時, 分)），跟 dayLabel 一樣以裝置時區的日界判斷
import { describe, expect, it } from 'vitest'
import { IDLE_CONFIG } from '../domain/config'
import type { SettledMatch } from '../domain/club'
import type { ControllerState } from './clubController'
import { dayLabel, matchTime, renderReports } from './reportView'
import { V2T } from './strings'

const at = (y: number, mon: number, d: number, h = 12, min = 0) => new Date(y, mon - 1, d, h, min).getTime()
const STEP = IDLE_CONFIG.MATCH_INTERVAL_MS

function match(matchIndex: number, settledAt: number, playedAt?: number): SettledMatch {
  return {
    matchId: `m${matchIndex}`,
    matchIndex,
    seed: matchIndex,
    earnedFunds: 100,
    earnedExperience: 12,
    settledAt,
    ...(playedAt !== undefined ? { playedAt } : {}),
    result: { won: true, runsFor: 3, runsAgainst: 1, opponentName: '測試隊', innings: 9, leagueTier: 0, highlights: [], userSide: 'home' },
  } as unknown as SettledMatch
}

/** 戰報分頁的日期標題與每組的場次（新到舊） */
function groups(matches: SettledMatch[], now: number): [string, number[]][] {
  const page = renderReports({ club: { recentMatches: matches } } as unknown as ControllerState, () => undefined, now)
  const out: [string, number[]][] = []
  for (const node of page.querySelector('.v2-report-list')!.children) {
    if (node.classList.contains('v2-day-label')) out.push([node.textContent!, []])
    else out[out.length - 1][1].push(Number(/第 (\d+) 場/.exec(node.getAttribute('aria-label')!)![1]))
  }
  return out
}

describe('dayLabel', () => {
  it('今天、昨天', () => {
    const now = at(2026, 11, 18, 15, 0)
    expect(dayLabel(at(2026, 11, 18, 0, 0), now)).toBe(V2T.today)
    expect(dayLabel(at(2026, 11, 18, 14, 59), now)).toBe(V2T.today)
    expect(dayLabel(at(2026, 11, 17, 23, 59), now)).toBe(V2T.yesterday)
    expect(dayLabel(at(2026, 11, 17, 0, 0), now)).toBe(V2T.yesterday)
    expect(dayLabel(at(2026, 11, 16, 23, 59), now)).toBe('11/16')
  })

  it('跨日：只差幾分鐘，但過了午夜就是昨天', () => {
    const now = at(2026, 11, 18, 0, 3)
    expect(dayLabel(at(2026, 11, 17, 23, 58), now)).toBe(V2T.yesterday)
    expect(dayLabel(at(2026, 11, 18, 0, 1), now)).toBe(V2T.today)
  })

  it('跨月', () => {
    const now = at(2026, 3, 1, 9, 0)
    expect(dayLabel(at(2026, 2, 28, 22, 0), now)).toBe(V2T.yesterday)
    expect(dayLabel(at(2026, 2, 27, 22, 0), now)).toBe('2/27')
  })

  it('跨年：昨天照樣寫昨天，更早的加上年份', () => {
    const now = at(2027, 1, 1, 0, 10)
    expect(dayLabel(at(2026, 12, 31, 23, 55), now)).toBe(V2T.yesterday)
    expect(dayLabel(at(2026, 12, 30, 20, 0), now)).toBe('2026/12/30')
    expect(dayLabel(at(2027, 1, 1, 0, 0), now)).toBe(V2T.today)
  })

  it('時間在未來（裝置時鐘稍微不準）也算今天', () => {
    const now = at(2026, 11, 18, 12, 0)
    expect(dayLabel(now + 60_000, now)).toBe(V2T.today)
  })
})

describe('戰報依比賽時間分組', () => {
  it('離線很久才回來：同一次結算的比賽依各自的比賽時間分到昨天與今天，不會全部算成今天', () => {
    // 昨晚 22:00 離開，今天 01:00 才重新開啟：36 場在今天 01:00 一起結算
    const reopened = at(2026, 11, 18, 1, 0)
    const left = at(2026, 11, 17, 22, 0)
    const ms = Array.from({ length: 36 }, (_, i) => match(i, reopened, left + (i + 1) * STEP))
    // 22:05 ~ 23:55 是昨天（23 場），00:00 ~ 01:00 是今天（13 場）
    const g = groups(ms, at(2026, 11, 18, 9, 0))
    expect(g.map(([d]) => d)).toEqual([V2T.today, V2T.yesterday])
    expect(g[0][1]).toHaveLength(13)
    expect(g[1][1]).toHaveLength(23)
    expect(g[0][1][0]).toBe(36)
    expect(g[1][1].at(-1)).toBe(1)
  })

  it('依實際的比賽時間，不受之後重新開啟遊戲的時間影響：三天後打開，標題變成日期', () => {
    const ms = [match(0, at(2026, 11, 17, 21, 5), at(2026, 11, 17, 21, 5)), match(1, at(2026, 11, 18, 8, 0), at(2026, 11, 17, 21, 10))]
    expect(groups(ms, at(2026, 11, 18, 9, 0))).toEqual([[V2T.yesterday, [2, 1]]])
    expect(groups(ms, at(2026, 11, 20, 9, 0))).toEqual([['11/17', [2, 1]]])
  })

  it('跨月、跨年的列表：依日期由新到舊分組', () => {
    const ms = [
      match(0, 0, at(2026, 12, 30, 20, 0)),
      match(1, 0, at(2026, 12, 31, 23, 55)),
      match(2, 0, at(2027, 1, 1, 0, 0)),
      match(3, 0, at(2027, 1, 1, 0, 5)),
    ]
    expect(groups(ms, at(2027, 1, 1, 0, 10))).toEqual([
      [V2T.today, [4, 3]],
      [V2T.yesterday, [2]],
      ['2026/12/30', [1]],
    ])
  })

  it('存檔升級前的比賽（沒有 playedAt）：用同一次結算的最後一場往前推估，不全部算在結算那天', () => {
    // 舊存檔：12 場在今天 00:30 一起結算，最後一場 00:30 打完，往前每場 5 分鐘
    const settled = at(2026, 11, 18, 0, 30)
    const ms = Array.from({ length: 12 }, (_, i) => match(100 + i, settled))
    expect(matchTime(ms[11], ms)).toBe(settled)
    expect(matchTime(ms[0], ms)).toBe(settled - 11 * STEP)
    const g = groups(ms, at(2026, 11, 18, 10, 0))
    // 00:30、00:25 … 00:00 是今天（7 場），23:55 … 23:35 是昨天（5 場）
    expect(g.map(([d, xs]) => [d, xs.length])).toEqual([
      [V2T.today, 7],
      [V2T.yesterday, 5],
    ])
  })

  it('新舊比賽混在一起：有 playedAt 的照 playedAt，沒有的才推估', () => {
    const settled = at(2026, 11, 18, 0, 30)
    const ms = [match(1, settled), match(2, settled), match(3, at(2026, 11, 18, 9, 0), at(2026, 11, 18, 8, 55))]
    expect(matchTime(ms[0], ms)).toBe(settled - STEP)
    expect(matchTime(ms[1], ms)).toBe(settled)
    expect(matchTime(ms[2], ms)).toBe(at(2026, 11, 18, 8, 55))
  })
})
