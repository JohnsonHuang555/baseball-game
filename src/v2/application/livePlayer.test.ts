// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { newClub } from '../domain/club'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { MINUTE } from '../testkit'
import { planMatch } from './batchRunner'
import { liveTimeline } from './liveMatch'
import { LivePlayer, type LiveClock, type LiveSource } from './livePlayer'
import type { ReplayPresenter } from './replayPlayer'

const club = newClub({ clubId: 'club-lp', clubName: '播放器隊', clubSeed: 9, roster: generateRoster(new Rng(9)), now: 0 })
const START = 1_000_000

function source(): LiveSource {
  const plan = planMatch(club, 0)
  const { timeline, schedule } = liveTimeline(plan)
  return { matchIndex: 0, matchId: plan.matchId, startsAt: START, endsAt: START + 5 * MINUTE, timeline, schedule }
}

/** 虛擬時鐘：sleep 會推進時間；stopAt 之後時間停住（讓測試控制） */
function clock(t: number) {
  const c = {
    t,
    stopAt: Infinity,
    sleeps: 0,
    now: () => c.t,
    async sleep(ms: number, signal: AbortSignal) {
      c.sleeps++
      if (signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' })
      c.t = Math.min(c.t + Math.max(0, ms), Math.max(c.t, c.stopAt))
      await new Promise((r) => setTimeout(r, 0))
      if (signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' })
    },
  }
  return c as typeof c & LiveClock
}

function presenter() {
  const p = {
    played: [] as number[],
    shown: [] as number[],
    async playFrame(frame: { index: number }) {
      p.played.push(frame.index)
    },
    show(_s: unknown, position: number) {
      p.shown.push(position)
    },
  }
  return p as typeof p & ReplayPresenter
}
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('LivePlayer', () => {
  it('中途加入：直接從目前的那一格開始播，不從第一球開始', async () => {
    const s = source()
    const c = clock(START + 2 * MINUTE)
    c.stopAt = c.t
    const p = presenter()
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    const target = s.schedule.positionAt(2 * MINUTE)
    expect(p.shown[0]).toBe(target)
    expect(p.played[0]).toBe(target)
    expect(player.view.status).toBe('live')
    player.dispose()
  })

  it('暫停只停畫面：時間照走；繼續時同步到當下進度（不補播錯過的格）', async () => {
    const s = source()
    const c = clock(START + MINUTE)
    c.stopAt = c.t
    const p = presenter()
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    player.pause()
    expect(player.view.status).toBe('paused')
    const playedBefore = p.played.length
    c.t = START + 3 * MINUTE
    c.stopAt = c.t
    await tick()
    expect(p.played.length).toBe(playedBefore)
    player.resume()
    await tick()
    const target = s.schedule.positionAt(3 * MINUTE)
    expect(p.shown.at(-1)).toBe(target)
    expect(p.played.at(-1)).toBe(target)
    // 中間錯過的格沒有被播
    expect(p.played.filter((i) => i > s.schedule.positionAt(MINUTE) + 1 && i < target)).toEqual([])
    player.dispose()
  })

  it('播到結束時間：顯示最終狀態，狀態變成 ended，不再推進；每一格依序播一次', async () => {
    const s = source()
    const c = clock(START)
    const p = presenter()
    const player = new LivePlayer(s, p, c)
    player.start()
    await player.settled()
    expect(player.view.status).toBe('ended')
    expect(player.view.state).toEqual(s.timeline.final)
    expect(p.played).toEqual(s.timeline.frames.map((f) => f.index))
    expect(c.t).toBe(s.endsAt)
  })

  it('已經結束才打開：直接顯示最終比分', async () => {
    const s = source()
    const p = presenter()
    const player = new LivePlayer(s, p, clock(START + 6 * MINUTE))
    player.start()
    await player.settled()
    expect(player.view.status).toBe('ended')
    expect(p.played).toEqual([])
  })

  it('時間倒退（比開賽時間早）：等待，不宣稱直播', async () => {
    const s = source()
    const c = clock(START - MINUTE)
    c.stopAt = c.t
    const p = presenter()
    const player = new LivePlayer(s, p, c)
    const statuses: string[] = []
    player.subscribe((v) => statuses.push(v.status))
    player.start()
    await tick()
    expect(player.view.status).toBe('waiting')
    expect(p.played).toEqual([])
    player.dispose()
  })

  it('連按開始、暫停中連按繼續：只有一個迴圈；dispose 後不再通知、不再播放', async () => {
    const s = source()
    const c = clock(START + MINUTE)
    c.stopAt = c.t
    const p = presenter()
    const player = new LivePlayer(s, p, c)
    let notified = 0
    player.subscribe(() => notified++)
    player.start()
    player.start()
    await tick()
    const once = p.played.length
    expect(once).toBe(1)
    player.pause()
    player.resume()
    player.resume()
    await tick()
    expect(p.played.length).toBe(2)
    player.dispose()
    const n = notified
    c.stopAt = Infinity
    player.start()
    player.resume()
    await tick()
    expect(notified).toBe(n)
    expect(p.played.length).toBe(2)
  })
})
