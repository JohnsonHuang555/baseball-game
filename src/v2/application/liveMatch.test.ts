// @vitest-environment node
// 進行中比賽的固定計畫與觀戰同步：用虛擬時鐘驗證同一場比賽不管有沒有人看、什麼時候看、中途改設定，結果都一樣
import { describe, expect, it } from 'vitest'
import { economyViolations, type ClubSave } from '../domain/club'
import { stableJson } from '../domain/fingerprint'
import { resolveRoster, toAssignment } from '../domain/roster'
import { substitute } from '../domain/lineup'
import { leveled } from '../domain/progression'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab } from '../testkit'
import { planMatch } from './batchRunner'
import { createClubSafely } from './clubLifecycle'
import { recruit, upgrade } from './economyService'
import { MATCH_INTERVAL_MS } from './idleEngine'
import { LiveSchedule, currentLiveMatch, freezeLiveMatch, liveTimeline } from './liveMatch'
import { claim, settleDue, summarize, updateSettings } from './settlementService'
import { runMatch } from './matchRunner'

const rich = { funds: 5_000_000, experience: 500_000 }

/** 同一個種子、同一份球團：建立後 12 分鐘（第 0、1 場已經打完，第 2 場在 10 分鐘開打、15 分鐘結束） */
async function baseline(): Promise<string> {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const d = tab(storage, clock, new FakeLockManager())
  await createClubSafely(d, { clubName: '直播隊', clubSeed: 2468, clubId: 'club-live' })
  const c = d.store.loadClub()!
  d.store.saveClub({ ...c, economy: { ...c.economy, assets: rich, earned: rich } }, c.revision)
  clock.advance(12 * MINUTE)
  await settleDue(d)
  return storage.getItem(CLUB_STORAGE_KEY)!
}

function world(raw: string, at = T0 + 12 * MINUTE) {
  const storage = new MemoryStorage()
  storage.setItem(CLUB_STORAGE_KEY, raw)
  const clock = new ManualClock(at)
  const locks = new FakeLockManager()
  const d = tab(storage, clock, locks)
  return { storage, clock, locks, d, load: () => d.store.loadClub()! }
}

/** 「觀戰」：只讀，用目前的存檔推算進行中的比賽與目前進度 */
function watch(club: ClubSave, now: number) {
  const live = currentLiveMatch(club, now)
  const { timeline, schedule } = liveTimeline(live.plan)
  const position = schedule.positionAt(now - live.startsAt)
  const state = position === 0 ? timeline.initial : timeline.frames[position - 1].after
  return { live, timeline, schedule, position, state }
}

/** 第 2 場的結算結果（摘要＋獎勵） */
function match2(club: ClubSave) {
  const m = club.recentMatches.find((x) => x.matchIndex === 2)!
  return { result: m.result, funds: m.earnedFunds, exp: m.earnedExperience, box: m.box }
}

describe('進行中比賽的時間', () => {
  it('新球團：第 0 場在建立時開打、5 分鐘後結束；結算後下一場接著開打', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock(T0)
    const d = tab(storage, clock, new FakeLockManager())
    await createClubSafely(d, { clubName: '新隊', clubSeed: 1, clubId: 'club-new' })
    const c = d.store.loadClub()!
    const live = currentLiveMatch(c, T0)
    expect([live.matchIndex, live.startsAt, live.endsAt]).toEqual([0, T0, T0 + MATCH_INTERVAL_MS])
    // 不結算也推算得出：7 分鐘時進行中的是第 1 場
    expect(currentLiveMatch(c, T0 + 7 * MINUTE)).toMatchObject({ matchIndex: 1, startsAt: T0 + 5 * MINUTE })
    clock.advance(7 * MINUTE)
    await settleDue(d)
    expect(currentLiveMatch(d.store.loadClub()!, clock.now())).toMatchObject({ matchIndex: 1, startsAt: T0 + 5 * MINUTE })
  })

  it('五分鐘週期內不同時間點：開賽瞬間在第 0 格、結束前一刻在最後一格、到結束時間就是比賽結束；時間倒退時顯示還沒開始', async () => {
    const raw = await baseline()
    const { load } = world(raw)
    const c = load()
    const start = T0 + 10 * MINUTE
    expect(watch(c, start).position).toBe(0)
    const nearEnd = watch(c, start + MATCH_INTERVAL_MS - 1)
    expect(nearEnd.position).toBe(nearEnd.timeline.frames.length - 1)
    expect(nearEnd.state.over).toBe(false)
    // 結束時間一到，進行中的是下一場（這一場可以結算了）
    expect(currentLiveMatch(c, start + MATCH_INTERVAL_MS).matchIndex).toBe(3)
    const s = nearEnd.schedule
    expect(s.positionAt(MATCH_INTERVAL_MS)).toBe(s.frames.length)
    // 時間倒退：比錨點還早，比賽的開始時間在未來
    const back = currentLiveMatch(c, start - MINUTE)
    expect(back.startsAt).toBeGreaterThan(start - MINUTE)
  })
})

describe('固定比賽計畫：情境 A～E 的同一場比賽結果都相同', () => {
  it('A 不看、B 從開賽看、C 中途看、D 看到一半離開再回來、E 看的時候升級與換陣容：第 2 場的結果與獎勵完全相同', async () => {
    const raw = await baseline()
    const end = T0 + 15 * MINUTE

    // A：全程不看，結束後結算
    const A = world(raw)
    A.clock.set(end)
    await settleDue(A.d)
    const a = match2(A.load())

    // B：從開賽看到結束（每 20 秒看一次；只讀）
    const B = world(raw, T0 + 10 * MINUTE)
    let lastPos = -1
    for (let t = T0 + 10 * MINUTE; t < end; t += 20_000) {
      const w = watch(B.load(), t)
      expect(w.live.matchIndex).toBe(2)
      expect(w.position).toBeGreaterThanOrEqual(lastPos)
      lastPos = w.position
    }
    const bWatch = watch(B.load(), end - 1)
    B.clock.set(end)
    await settleDue(B.d)
    const b = match2(B.load())
    // 直播看到的最後狀態就是結算的比分
    const fin = bWatch.timeline.final
    expect(fin.score[b.result.userSide]).toBe(b.result.runsFor)

    // C：打到一半（2.5 分鐘）才進來看：直接是目前的進度，不是從第一球開始
    const C = world(raw, T0 + 12.5 * MINUTE)
    const c = watch(C.load(), C.clock.now())
    expect(c.position).toBeGreaterThan(0)
    expect(c.position).toBe(c.schedule.positionAt(2.5 * MINUTE))
    C.clock.set(end)
    await settleDue(C.d)

    // D：看到 11 分鐘離開，14 分鐘重新整理（新的分頁）回來：同一份計畫，進度往前
    const D = world(raw, T0 + 11 * MINUTE)
    const d1 = watch(D.load(), D.clock.now())
    const reopened = tab(D.storage, new ManualClock(T0 + 14 * MINUTE), D.locks)
    const d2 = watch(reopened.store.loadClub()!, T0 + 14 * MINUTE)
    expect(stableJson(d2.live.plan)).toBe(stableJson(d1.live.plan))
    expect(d2.position).toBeGreaterThan(d1.position)
    D.clock.set(end)
    await settleDue(D.d)

    // E：12 分鐘時升級第一棒到 Lv.10、把第一棒換成板凳：進行中的第 2 場不受影響，第 3 場才用新設定
    const E = world(raw)
    const before = watch(E.load(), E.clock.now())
    const id = E.load().roster.lineup[0].playerId
    for (let lv = 1; lv < 10; lv++) await upgrade(E.d, { opSeq: E.load().economy.nextOpSeq, playerId: id, expectedLevel: lv })
    await updateSettings(E.d, { roster: toAssignment(substitute(resolveRoster(E.load()), 1, 0)) })
    const frozen = E.load()
    expect(frozen.liveMatch?.matchIndex).toBe(2)
    expect(stableJson(frozen.liveMatch!.plan)).toBe(stableJson(before.live.plan))
    // 看的畫面也不變
    expect(stableJson(watch(frozen, E.clock.now()).live.plan)).toBe(stableJson(before.live.plan))
    expect(frozen.strategy.effectiveFromMatch).toBe(3)
    E.clock.set(T0 + 20 * MINUTE)
    await settleDue(E.d)
    const e = match2(E.load())
    const rep3 = E.load().replays.find((r) => r.matchId === 'club-live#3')!.replay
    const lineup3 = rep3.setup[rep3.setup.userSide].roster.lineup
    expect(lineup3.find((s) => s.player.id === id)?.player.ratings).toEqual(leveled(E.load().players.find((r) => r.player.id === id)!.player, 10).ratings)
    expect(lineup3[1].player.id).toBe(resolveRoster(raw && JSON.parse(raw)).bench[0].id)

    // 五個情境的第 2 場：比分、勝敗、精彩事件、Box Score、獎勵全部相同
    for (const x of [b, match2(C.load()), match2(D.load()), e]) expect(x).toEqual(a)
    for (const w of [A, B, C, D, E]) expect(economyViolations(w.load().economy)).toEqual([])
  })

  it('觀戰中關閉畫面：比賽照樣完成，結算一次；結算結果等於直播時間軸的結果', async () => {
    const raw = await baseline()
    const W = world(raw)
    const w = watch(W.load(), W.clock.now())
    // 「關閉畫面」：什麼都不做
    W.clock.set(T0 + 15 * MINUTE)
    const r1 = await settleDue(W.d)
    const r2 = await settleDue(W.d)
    expect(r1.settled.map((m) => m.matchIndex)).toEqual([2])
    expect(r2.settled).toHaveLength(0)
    const plan = w.live.plan
    const summary = summarize({ plan, result: runMatch(plan.setup, plan.ai) })
    expect(match2(W.load()).result).toEqual(summary)
  })

  it('不能在預定結束時間之前結算：14:59 沒有東西可以結算，15:00 才結算', async () => {
    const raw = await baseline()
    const W = world(raw)
    W.clock.set(T0 + 15 * MINUTE - 1)
    expect((await settleDue(W.d)).settled).toHaveLength(0)
    W.clock.set(T0 + 15 * MINUTE)
    expect((await settleDue(W.d)).settled.map((m) => m.matchIndex)).toEqual([2])
  })

  it('多分頁：一邊固定計畫（升級）、一邊同時結算：同一場只結算一次，用的是同一份計畫', async () => {
    const raw = await baseline()
    for (const locks of [new FakeLockManager(), undefined]) {
      const storage = new MemoryStorage()
      storage.setItem(CLUB_STORAGE_KEY, raw)
      const clock = new ManualClock(T0 + 12 * MINUTE)
      const t1 = tab(storage, clock, locks)
      const t2 = tab(storage, clock, locks)
      const expected = watch(t1.store.loadClub()!, clock.now()).live.plan
      const id = t1.store.loadClub()!.roster.lineup[0].playerId
      await upgrade(t1, { opSeq: t1.store.loadClub()!.economy.nextOpSeq, playerId: id, expectedLevel: 1 })
      clock.set(T0 + 15 * MINUTE)
      const results = await Promise.allSettled([settleDue(t1), settleDue(t2)])
      const settled = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.settled : []))
      expect(settled.map((m) => m.matchIndex)).toEqual([2])
      const c = t1.store.loadClub()!
      const rep = c.replays.find((r) => r.matchId === 'club-live#2')!.replay
      expect(stableJson(rep.setup)).toBe(stableJson(expected.setup))
    }
  })

  it('離線 8 小時以上再回來：補算 96 場（固定的那一場用固定計畫），然後顯示目前進行中的那一場', async () => {
    const raw = await baseline()
    const W = world(raw)
    // 先固定第 2 場（招募），然後離線 10 小時
    await recruit(W.d, { opSeq: W.load().economy.nextOpSeq, role: 'batter' })
    const frozenPlan = W.load().liveMatch!.plan
    W.clock.advance(10 * HOUR)
    const report = await settleDue(W.d)
    expect(report.settled).toHaveLength(96)
    const c = W.load()
    const rep2 = c.recentMatches.find((m) => m.matchIndex === 2)
    expect(rep2).toBeUndefined() // 近期比賽只留 50 場
    expect(c.liveMatch).toBeNull()
    expect(c.idle.nextMatchIndex).toBe(2 + 96)
    const live = currentLiveMatch(c, W.clock.now())
    expect(live.matchIndex).toBe(98)
    expect(live.startsAt).toBeLessThanOrEqual(W.clock.now())
    expect(live.endsAt).toBeGreaterThan(W.clock.now())
    void frozenPlan
    await claim(W.d, c.economy.nextClaimSeq)
    expect(economyViolations(W.load().economy)).toEqual([])
  })

  it('沒有修改時不寫入：固定計畫只在修改球團時發生；freezeLiveMatch 不改輸入、重複呼叫不變', async () => {
    const raw = await baseline()
    const W = world(raw)
    const c = W.load()
    expect(c.liveMatch).toBeNull()
    const before = JSON.stringify(c)
    const f = freezeLiveMatch(c)
    expect(JSON.stringify(c)).toBe(before)
    expect(f.liveMatch?.matchIndex).toBe(c.idle.nextMatchIndex)
    expect(freezeLiveMatch(f)).toBe(f)
    expect(stableJson(f.liveMatch!.plan)).toBe(stableJson(planMatch(c, c.idle.nextMatchIndex)))
  })
})

describe('LiveSchedule', () => {
  it('每一格依序佔一段時間，最後一格剛好在 5 分鐘結束；位置隨時間單調前進', async () => {
    const raw = await baseline()
    const { timeline, schedule } = liveTimeline(planMatch(JSON.parse(raw), 2))
    expect(schedule.ends.at(-1)).toBe(MATCH_INTERVAL_MS)
    for (let i = 1; i < schedule.ends.length; i++) expect(schedule.ends[i]).toBeGreaterThanOrEqual(schedule.ends[i - 1])
    let prev = 0
    for (let t = 0; t <= MATCH_INTERVAL_MS; t += 1000) {
      const p = schedule.positionAt(t)
      expect(p).toBeGreaterThanOrEqual(prev)
      prev = p
    }
    expect(schedule.positionAt(MATCH_INTERVAL_MS)).toBe(timeline.frames.length)
    expect(new LiveSchedule(timeline.frames, 1000).ends.at(-1)).toBe(1000)
  })
})
