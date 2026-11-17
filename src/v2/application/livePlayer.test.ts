// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { newClub } from '../domain/club'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { MINUTE } from '../testkit'
import { planMatch } from './batchRunner'
import { liveTimeline } from './liveMatch'
import { LivePlayer, type LiveClock, type LiveSource } from './livePlayer'
import type { FrameContext, ReplayPresenter, ReplayState } from './replayPlayer'
import { MemoryStorage, CLUB_STORAGE_KEY } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from './clubLifecycle'
import { currentLiveMatch } from './liveMatch'
import { settleDue } from './settlementService'

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
    /** 演過懸念的格（Phase 6B 起每一格分懸念、揭曉兩段） */
    played: [] as number[],
    /** 演過揭曉的格 */
    revealed: [] as number[],
    shown: [] as number[],
    async playFrame(frame: { index: number }, ctx?: FrameContext) {
      if (ctx?.phase === 'reveal') p.revealed.push(frame.index)
      else p.played.push(frame.index)
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
    // 每一格的揭曉都演一次（最後一格在 endsAt 之後）
    expect(p.revealed).toEqual(s.timeline.frames.map((f) => f.index))
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

/**
 * 記錄每一次「提交狀態」（commit／show）與「呈現事件」（playFrame）發生的虛擬時間。
 * animMs：每一格動畫要花多少虛擬時間（比排定時間短，就是「動畫提早播完」）；hold：讓某一格的動畫卡住，測試手動放行
 */
function auditPresenter(c: ReturnType<typeof clock>, animMs = 0) {
  const p = {
    commits: [] as { at: number; position: number; state: ReplayState; kind: 'commit' | 'show' }[],
    frames: [] as { at: number; index: number; ctx: FrameContext }[],
    hold: null as null | ((index: number) => Promise<void> | null),
    async playFrame(frame: { index: number }, ctx: FrameContext) {
      p.frames.push({ at: c.t, index: frame.index, ctx })
      const held = p.hold?.(frame.index)
      if (held) await held
      else if (animMs > 0) await c.sleep(Math.min(animMs, ctx.budgetMs ?? animMs), ctx.signal)
    },
    show(state: ReplayState, position: number) {
      p.commits.push({ at: c.t, position, state, kind: 'show' })
    },
    commit(state: ReplayState, position: number) {
      p.commits.push({ at: c.t, position, state, kind: 'commit' })
    },
  }
  return p as typeof p & ReplayPresenter
}

/** 每一次提交的狀態都不能超過那一刻的真實進度；最終比分與比賽結束只能在 endsAt 之後 */
function expectNoFuture(s: LiveSource, commits: { at: number; position: number; state: ReplayState }[]) {
  for (const x of commits) {
    expect(x.position).toBeLessThanOrEqual(s.schedule.positionAt(x.at - s.startsAt))
    if (x.state.over || x.position >= s.timeline.frames.length) expect(x.at).toBeGreaterThanOrEqual(s.endsAt)
  }
}

describe('LivePlayer：呈現事件與提交狀態分開（不提前揭露未來）', () => {
  it('動畫比排定時間短：不能提前提交下一格；每一格都在自己的結束時間才提交', async () => {
    const s = source()
    const c = clock(START + 30_000)
    const p = auditPresenter(c, 10) // 每格動畫只要 10 ms，遠比排定時間短
    const player = new LivePlayer(s, p, c)
    // 播放器對外的狀態（比分條用的）也不能超過真實時間
    const views: { at: number; position: number; state: ReplayState }[] = []
    player.subscribe((v) => views.push({ at: c.t, position: v.position, state: v.state }))
    player.start()
    await player.settled()
    expectNoFuture(s, p.commits)
    expectNoFuture(s, views)
    // 動畫一播完就提交的話，提交時間會落在 startOf(i) + 10ms；正確的是等到 endOf(i)
    for (const x of p.commits.filter((k) => k.kind === 'commit')) {
      expect(x.at).toBe(s.startsAt + s.schedule.endOf(x.position - 1))
    }
  })

  it('動畫提早播完之後，會等待到正確時間才前進；等待期間狀態維持在這一格開始時', async () => {
    const s = source()
    const start = START + 60_000
    const c = clock(start)
    c.stopAt = start
    const p = auditPresenter(c, 0)
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    const target = s.schedule.positionAt(60_000)
    expect(p.frames.map((f) => f.index)).toEqual([target])
    // 動畫已經播完，但時間還在這一格裡：位置與狀態都還是這一格開始時
    expect(player.view.position).toBe(target)
    expect(player.view.state).toEqual(s.timeline.frames[target - 1].after)
    // 時間走到這一格的結束：才提交
    c.stopAt = s.startsAt + s.schedule.endOf(target)
    await tick()
    expect(player.view.position).toBe(target + 1)
    expect(p.commits.at(-1)).toMatchObject({ kind: 'commit', position: target + 1, at: s.startsAt + s.schedule.endOf(target) })
    player.dispose()
  })

  it('最後一格提早播完：最終比分、比賽結束與勝敗要到 endsAt 才揭曉', async () => {
    const s = source()
    const last = s.timeline.frames.length - 1
    const c = clock(s.startsAt + s.schedule.startOf(last) + 1)
    c.stopAt = s.endsAt - 1
    const p = auditPresenter(c, 0)
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    expect(p.frames.map((f) => f.index)).toEqual([last])
    expect(player.view.status).toBe('live')
    expect(player.view.state.over).toBe(false)
    expect(player.view.state).toEqual(s.timeline.frames[last - 1].after)
    expect(p.commits.every((x) => !x.state.over)).toBe(true)
    // endsAt 的前一毫秒還是 live
    c.t = s.endsAt - 1
    await tick()
    expect(player.view.status).toBe('live')
    c.stopAt = Infinity
    await player.settled()
    expect(player.view.status).toBe('ended')
    expect(c.t).toBeGreaterThanOrEqual(s.endsAt)
    expect(player.view.state).toEqual(s.timeline.final)
    expectNoFuture(s, p.commits)
  })

  it('動畫卡住時時間突然往前跳：同步到當下，不補播中間的事件', async () => {
    const s = source()
    const c = clock(START + 30_000)
    c.stopAt = c.t
    const p = auditPresenter(c)
    let release: () => void = () => {}
    const first = s.schedule.positionAt(30_000)
    p.hold = (i) => (i === first ? new Promise<void>((r) => (release = r)) : null)
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    // 動畫卡住的時候，時間跳到 2:30
    c.t = START + 150_000
    c.stopAt = c.t
    release()
    await tick()
    const now = s.schedule.positionAt(150_000)
    expect(player.view.position).toBe(now)
    expect(p.commits.at(-1)).toMatchObject({ kind: 'show', position: now })
    // 中間的格沒有被播
    expect(p.frames.map((f) => f.index)).toEqual([first, now])
    expectNoFuture(s, p.commits)
    player.dispose()
  })

  it('暫停後恢復：用當下時間重新同步，不補播暫停期間的事件', async () => {
    const s = source()
    const c = clock(START + 20_000)
    c.stopAt = c.t
    const p = auditPresenter(c)
    const player = new LivePlayer(s, p, c)
    player.start()
    await tick()
    player.pause()
    const pausedAt = player.view.position
    c.t = START + 200_000
    c.stopAt = c.t
    await tick()
    expect(player.view.position).toBe(pausedAt)
    player.resume()
    await tick()
    const now = s.schedule.positionAt(200_000)
    expect(player.view.position).toBe(now)
    expect(p.frames.map((f) => f.index)).toEqual([s.schedule.positionAt(20_000), now])
    expectNoFuture(s, p.commits)
    player.dispose()
  })

  it('快速關閉：動畫中、等待中關閉都會中斷，之後不再呈現或提交', async () => {
    const s = source()
    // 1. 動畫進行中關閉：這一格的動畫被中斷
    {
      const c = clock(START + 10_000)
      c.stopAt = c.t
      const p = auditPresenter(c)
      p.hold = () => new Promise<void>(() => {})
      const player = new LivePlayer(s, p, c)
      player.start()
      await tick()
      const ctx = p.frames.at(-1)!.ctx
      expect(ctx.signal.aborted).toBe(false)
      player.dispose()
      expect(ctx.signal.aborted).toBe(true)
      const before = [p.frames.length, p.commits.length]
      c.stopAt = Infinity
      await tick()
      expect([p.frames.length, p.commits.length]).toEqual(before)
    }
    // 2. 動畫播完、等待排定時間時關閉：等待被中斷（不留下計時器）
    {
      const c = clock(START + 10_000)
      c.stopAt = c.t
      const pending: { signal: AbortSignal; done: boolean }[] = []
      const sleep = c.sleep.bind(c)
      c.sleep = (ms: number, signal: AbortSignal) => {
        const entry = { signal, done: false }
        pending.push(entry)
        return sleep(ms, signal).finally(() => (entry.done = true))
      }
      const p = auditPresenter(c)
      const player = new LivePlayer(s, p, c)
      player.start()
      await tick(2)
      player.dispose()
      await tick()
      expect(pending.length).toBeGreaterThan(0)
      expect(pending.every((x) => x.done)).toBe(true)
      expect(pending.at(-1)!.signal.aborted).toBe(true)
      const before = [p.frames.length, p.commits.length]
      c.stopAt = Infinity
      c.t = s.endsAt + 1
      await tick()
      expect([p.frames.length, p.commits.length]).toEqual(before)
    }
  })
})

describe('完整觀看與不觀看：最終結算結果相同', () => {
  it('從開賽看到結束的最終狀態 = 不看、時間到了直接結算的結果', async () => {
    const storage = new MemoryStorage()
    const mc = new ManualClock(T0)
    const d = tab(storage, mc, new FakeLockManager())
    await createClubSafely(d, { clubName: '完整觀看隊', clubSeed: 135, clubId: 'club-watch-all' })
    const club = d.store.loadClub()!
    const info = currentLiveMatch(club, T0)
    const { timeline, schedule } = liveTimeline(info.plan)
    const s: LiveSource = { matchIndex: 0, matchId: info.matchId, startsAt: info.startsAt, endsAt: info.endsAt, timeline, schedule }
    const c = clock(T0)
    const p = auditPresenter(c, 5)
    const player = new LivePlayer(s, p, c)
    player.start()
    await player.settled()
    expectNoFuture(s, p.commits)
    // 不觀看：直接在結束時間結算
    mc.set(info.endsAt)
    const report = await settleDue(d)
    const m = report.settled[0]
    const fin = player.view.state
    expect(fin.score[timeline.userSide]).toBe(m.result.runsFor)
    expect(fin.score[timeline.userSide === 'home' ? 'away' : 'home']).toBe(m.result.runsAgainst)
    expect(fin.linescore).toEqual(m.box!.linescore)
    expect((fin.winner === timeline.userSide)).toBe(m.result.won)
    expect(storage.getItem(CLUB_STORAGE_KEY)).toContain('"nextMatchIndex":1')
  })
})
