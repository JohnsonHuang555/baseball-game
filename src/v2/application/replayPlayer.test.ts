// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RULES_VERSION } from '../../sim/game'
import { newClub } from '../domain/club'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { planMatch } from './batchRunner'
import { HighlightCollector, runMatch, type MatchResult } from './matchRunner'
import {
  DEFAULT_REPLAY_SPEED,
  ReplayError,
  ReplayPlayer,
  abortableWait,
  buildTimeline,
  type FrameContext,
  type ReplayFrame,
  type ReplayPresenter,
  type ReplayState,
} from './replayPlayer'

const club = newClub({ clubId: 'club-replay', clubName: '重播隊', clubSeed: 77, roster: generateRoster(new Rng(77)), now: 0 })

/** 用 V2 的比賽計畫實際打完幾場 */
const results: MatchResult[] = Array.from({ length: 12 }, (_, i) => {
  const plan = planMatch(club, i)
  return runMatch(plan.setup, plan.ai)
})
const expectOf = (r: MatchResult) => {
  const side = r.replay.setup.userSide
  const other = side === 'home' ? 'away' : 'home'
  return { userSide: side, runsFor: r.score[side], runsAgainst: r.score[other], won: r.winner === side, innings: r.innings }
}

describe('buildTimeline：重播正確性', () => {
  it('比分、每局比分、安打、失誤、局數、勝負都跟原本的比賽一致；事件流跟原本一模一樣', () => {
    for (const r of results) {
      const t = buildTimeline(r.replay, expectOf(r))
      expect(t.final.score).toEqual(r.score)
      expect(t.final.linescore).toEqual(r.linescore)
      expect(t.final.hits).toEqual(r.hits)
      expect(t.final.errors).toEqual(r.errors)
      expect(t.final.inning).toBe(r.innings)
      expect(t.final.winner).toBe(r.winner)
      expect(t.frames.at(-1)!.after).toEqual(t.final)
      // 用原本收集精彩事件的方式跑一遍時間軸的事件：結果必須完全相同（代表沒有少任何事件、順序也一樣）
      const collector = new HighlightCollector({ inning: 1, half: 'top', score: { home: 0, away: 0 } })
      for (const f of t.frames) collector.collect(f.events)
      expect(collector.list).toEqual(r.highlights)
      expect(collector.score).toEqual(r.score)
    }
  })

  it('同一份 Replay 算兩次完全相同；不修改原始資料', () => {
    const r = results[0]
    const before = JSON.stringify(r.replay)
    const a = buildTimeline(r.replay)
    const b = buildTimeline(r.replay)
    expect(a.frames).toEqual(b.frames)
    expect(a.final).toEqual(b.final)
    expect(JSON.stringify(r.replay)).toBe(before)
  })

  it('球員名單用比賽當時的快照：之後的升級、釋出不影響（時間軸只看 Replay）', () => {
    const r = results[1]
    const t = buildTimeline(r.replay)
    const ours = r.replay.setup[r.replay.setup.userSide].roster
    for (const s of ours.lineup) expect(t.players.get(s.player.id)).toEqual(s.player)
    expect(t.teamNames[r.replay.setup.userSide]).toBe('重播隊')
  })

  it('壞掉的資料、不支援的規則版本、跟戰報對不起來：丟 ReplayError（不會丟其他錯誤）', () => {
    const r = results[2]
    const bad: [unknown, string][] = [
      [null, 'corrupt'],
      [{}, 'corrupt'],
      [{ ...r.replay, commands: 'x' }, 'corrupt'],
      [{ ...r.replay, setup: { ...r.replay.setup, home: { name: 'x', roster: {} } } }, 'corrupt'],
      [{ ...r.replay, rulesVersion: RULES_VERSION + 1, setup: { ...r.replay.setup, rules: RULES_VERSION + 1 } }, 'unsupported-version'],
      [{ ...r.replay, rulesVersion: 3 }, 'corrupt'],
      [{ ...r.replay, commands: [...r.replay.commands, { stepIndex: 99999, tactic: { type: 'alignment', alignment: 'normal' } }] }, 'corrupt'],
      [{ ...r.replay, commands: [{ stepIndex: 0, tactic: { type: 'pinchHit', benchIndex: 9 } }] }, 'corrupt'],
    ]
    for (const [value, code] of bad) {
      const error = (() => {
        try {
          buildTimeline(value)
        } catch (e) {
          return e
        }
      })()
      expect(error).toBeInstanceOf(ReplayError)
      expect((error as ReplayError).code).toBe(code)
    }
    const wrong = { ...expectOf(r), runsFor: expectOf(r).runsFor + 1 }
    expect(() => buildTimeline(r.replay, wrong)).toThrow(expect.objectContaining({ code: 'mismatch' }))
  })

  it('舊規則版本的比賽照原規則重播', () => {
    const plan = planMatch(club, 20)
    for (const rules of [1, 5, RULES_VERSION]) {
      const r = runMatch({ ...plan.setup, rules }, plan.ai)
      const t = buildTimeline(r.replay, expectOf(r))
      expect(t.rulesVersion).toBe(rules)
      expect(t.final.score).toEqual(r.score)
    }
  })
})

/** 假的畫面：每一格要等測試手動放行（或立即完成），記錄播放與顯示 */
class FakePresenter implements ReplayPresenter {
  played: number[] = []
  shown: { state: ReplayState; position: number }[] = []
  pending: { frame: ReplayFrame; resolve: () => void; ctx: FrameContext }[] = []
  constructor(private readonly auto = false) {}
  playFrame(frame: ReplayFrame, ctx: FrameContext): Promise<void> {
    this.played.push(frame.index)
    if (this.auto) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const entry = { frame, resolve, ctx }
      ctx.signal.addEventListener('abort', () => {
        // 中斷的動畫不再算是播放中的
        this.pending = this.pending.filter((x) => x !== entry)
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
      this.pending.push(entry)
    })
  }
  show(state: ReplayState, position: number): void {
    this.shown.push({ state, position })
  }
  next(): void {
    this.pending.shift()!.resolve()
  }
}
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('ReplayPlayer 狀態機', () => {
  const timeline = buildTimeline(results[3].replay, expectOf(results[3]))

  it('播放、暫停、繼續、播完：位置只在一格播完後才前進；播完後不再推進', async () => {
    const p = new FakePresenter()
    const player = new ReplayPlayer(timeline, p)
    expect(player.view.status).toBe('idle')
    expect(player.view.speed).toBe(DEFAULT_REPLAY_SPEED)
    player.play()
    expect(player.view.status).toBe('playing')
    p.next()
    await tick()
    p.next()
    await tick()
    expect(player.view.position).toBe(2)
    player.pause()
    expect(player.view.status).toBe('paused')
    await tick()
    expect(player.view.position).toBe(2)
    // 暫停時畫面回到已經播完的位置
    expect(p.shown.at(-1)).toEqual({ state: timeline.frames[1].after, position: 2 })
    expect(p.pending).toHaveLength(0)
    player.resume()
    expect(p.played.at(-1)).toBe(2)
    const auto = new ReplayPlayer(timeline, new FakePresenter(true))
    auto.play()
    await auto.settled()
    expect(auto.view).toMatchObject({ status: 'completed', position: timeline.frames.length })
    expect(auto.view.state).toEqual(timeline.final)
    auto.play()
    auto.resume()
    await tick()
    expect(auto.view.status).toBe('completed')
  })

  it('連按播放、暫停中連按繼續：只會有一個播放迴圈', async () => {
    const p = new FakePresenter()
    const player = new ReplayPlayer(timeline, p)
    player.play()
    player.play()
    player.play()
    expect(p.pending).toHaveLength(1)
    player.pause()
    player.resume()
    player.resume()
    player.play()
    await tick()
    expect(p.pending).toHaveLength(1)
    p.next()
    await tick()
    expect(p.pending).toHaveLength(1)
    expect(player.view.position).toBe(1)
  })

  it('改速度：播放中切換，下一段動畫讀到新的速度；不合法的速度不接受', async () => {
    const p = new FakePresenter()
    const player = new ReplayPlayer(timeline, p)
    player.play()
    const ctx = p.pending[0].ctx
    expect(ctx.speed()).toBe(2)
    player.setSpeed(4)
    expect(ctx.speed()).toBe(4)
    player.setSpeed(3 as never)
    expect(player.view.speed).toBe(4)
  })

  it('不同速度、全部播完、直接跳到結束：最後的狀態都一樣', async () => {
    const finals: ReplayState[] = []
    for (const speed of [1, 2, 4] as const) {
      const player = new ReplayPlayer(timeline, new FakePresenter(true))
      player.setSpeed(speed)
      player.play()
      await player.settled()
      finals.push(player.view.state)
    }
    const skipped = new ReplayPlayer(timeline, new FakePresenter())
    skipped.play()
    skipped.skipToEnd()
    finals.push(skipped.view.state)
    for (const f of finals) expect(f).toEqual(timeline.final)
    expect(skipped.view.status).toBe('completed')
  })

  it('跳到結束：中斷播放中的動畫，不留下迴圈；重新播放從頭開始', async () => {
    const p = new FakePresenter()
    const player = new ReplayPlayer(timeline, p)
    player.play()
    const signal = p.pending[0].ctx.signal
    player.skipToEnd()
    expect(signal.aborted).toBe(true)
    await tick()
    expect(p.pending.filter((x) => !x.ctx.signal.aborted)).toHaveLength(0)
    expect(p.shown.at(-1)).toEqual({ state: timeline.final, position: timeline.frames.length })
    player.restart()
    expect(player.view).toMatchObject({ status: 'playing', position: 0 })
    expect(p.shown.at(-1)).toEqual({ state: timeline.initial, position: 0 })
    expect(p.played.at(-1)).toBe(0)
  })

  it('dispose：中斷動畫、不再通知、之後的操作都無效', async () => {
    const p = new FakePresenter()
    const player = new ReplayPlayer(timeline, p)
    const views: string[] = []
    player.subscribe((v) => views.push(v.status))
    player.play()
    const signal = p.pending[0].ctx.signal
    player.dispose()
    expect(signal.aborted).toBe(true)
    const count = views.length
    player.play()
    player.restart()
    player.skipToEnd()
    player.setSpeed(4)
    await tick()
    expect(views).toHaveLength(count)
    expect(player.view.status).toBe('disposed')
    expect(p.played).toHaveLength(1)
  })

  it('畫面播放失敗：停在 error，不再推進', async () => {
    const player = new ReplayPlayer(timeline, {
      playFrame: () => Promise.reject(new Error('canvas 壞了')),
      show: () => undefined,
    })
    player.play()
    await player.settled()
    expect(player.view.status).toBe('error')
    expect(player.view.error).toBeInstanceOf(ReplayError)
    expect(player.view.position).toBe(0)
  })

  it('可以中斷的等待：中斷後清掉計時器', async () => {
    const cleared: unknown[] = []
    const ac = new AbortController()
    const w = abortableWait(10_000, ac.signal, { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => (cleared.push(t), clearTimeout(t)) })
    ac.abort()
    await expect(w).rejects.toMatchObject({ name: 'AbortError' })
    expect(cleared).toHaveLength(1)
  })
})
