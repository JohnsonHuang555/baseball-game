// @vitest-environment happy-dom
// Phase 5B：首頁「目前比賽」、直播觀戰（中途加入、暫停只停畫面、同步、比賽結束、下一場）、歷史 Box Score、晉級挑戰的觀看
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, MINUTE, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { upgrade } from '../application/economyService'
import { challengeNextLeague, planChallenge } from '../application/leagueService'
import { currentLiveMatch, liveTimeline } from '../application/liveMatch'
import type { LiveClock } from '../application/livePlayer'
import { runMatch } from '../application/matchRunner'
import { settleDue } from '../application/settlementService'
import type { ClubSave } from '../domain/club'
import { stableJson } from '../domain/fingerprint'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { openV2, type V2App } from './app'
import type { ReplayStage } from './replayView'
import { V2T } from './strings'

let app: V2App | null = null
afterEach(() => {
  app?.close()
  app = null
  document.body.replaceChildren()
})

const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''
const otherTabWrote = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
const club = (storage: MemoryStorage) => JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave

async function untilOverlay(): Promise<void> {
  for (let i = 0; i < 100 && !document.querySelector('.v2-replay-overlay'); i++) await flush(5)
}
const screen = () => $('.v2-replay')!
const position = () => Number(screen().dataset.position!.split('/')[0])

/** 測試用球場：動畫立即完成，記錄還在進行中的動畫數 */
function fakeStage(stats: { active: number; created: number }): () => ReplayStage {
  return () => {
    stats.created++
    let alignment: ReplayStage['alignment'] = 'normal'
    const anim = () => {
      stats.active++
      return Promise.resolve().then(() => void stats.active--)
    }
    return {
      elements: [document.createElement('canvas')],
      setColors: () => undefined,
      align: (a) => ((alignment = a), anim()),
      sync: () => undefined,
      pitch: anim,
      pitchResult: anim,
      play: anim,
      run: anim,
      cancel: () => undefined,
      resize: () => undefined,
      get alignment() {
        return alignment
      },
    }
  }
}

/** 虛擬時鐘：直播的等待會推進時間（不用真的等 5 分鐘）；gate.stopAt 設定時，時間停在那裡等測試推進 */
function virtualLive(clock: ManualClock, gate: { stopAt?: number } = {}): LiveClock {
  return {
    now: () => clock.now(),
    async sleep(ms, signal) {
      const abort = () => Object.assign(new Error('aborted'), { name: 'AbortError' })
      if (signal.aborted) throw abort()
      const target = clock.now() + Math.max(0, ms)
      if (gate.stopAt !== undefined && target > gate.stopAt) {
        clock.set(Math.max(clock.now(), gate.stopAt))
        await new Promise((r) => setTimeout(r, 5))
      } else {
        clock.set(target)
        await new Promise((r) => setTimeout(r, 0))
      }
      if (signal.aborted) throw abort()
    },
  }
}

/** 建立球團並打到 12 分鐘（第 0、1 場打完，第 2 場 10:00 開打、15:00 結束）；預設時間停在 12:00 */
async function mountAt12() {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const locks = new FakeLockManager()
  const deps = tab(storage, clock, locks)
  await createClubSafely(deps, { clubName: '直播隊', clubSeed: 2468, clubId: 'club-live-ui' })
  const c = deps.store.loadClub()!
  const rich = { funds: 5_000_000, experience: 500_000 }
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: rich, earned: rich } }, c.revision)
  clock.set(T0 + 12 * MINUTE)
  await settleDue(deps)
  const stats = { active: 0, created: 0 }
  const gate: { stopAt?: number } = { stopAt: T0 + 12 * MINUTE }
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'live-tab', replayStage: fakeStage(stats), replayTimeScale: 0, liveClock: virtualLive(clock, gate) })
  await flush()
  return { storage, clock, locks, deps, stats, gate }
}

async function untilEnded(): Promise<void> {
  for (let i = 0; i < 800 && screen().dataset.status !== 'ended'; i++) await flush(3)
}

describe('首頁「目前比賽」', () => {
  it('顯示進行中那一場：我方、對手、比分、局數、出局、剩餘時間，跟直播用同一份時間軸；沒有「觀看最近比賽」', async () => {
    const { storage, clock } = await mountAt12()
    expect($('[data-live-card]')).not.toBeNull()
    const info = currentLiveMatch(club(storage), clock.now())
    expect(info.matchIndex).toBe(2)
    const { timeline, schedule } = liveTimeline(info.plan)
    const pos = schedule.positionAt(clock.now() - info.startsAt)
    const s = pos === 0 ? timeline.initial : timeline.frames[pos - 1].after
    expect(text('[data-live-score="us"]')).toBe(String(s.score[timeline.userSide]))
    expect($('[data-live-inning]')!.dataset.liveInning).toBe(`${s.inning}${s.half}`)
    expect($('[data-live-outs]')!.dataset.liveOuts).toBe(String(s.outs))
    expect(Number($('[data-live-remain]')!.dataset.liveRemain)).toBe(180)
    expect(text('[data-action="watch-live"]')).toBe(V2T.liveWatch)
    expect($('[data-action="watch-latest"]')).toBeNull()
  })
})

describe('直播觀戰', () => {
  it('中途加入：直接是目前的進度，不是從第一球開始；暫停只停畫面，繼續時同步到當下進度', async () => {
    const { clock, gate, storage } = await mountAt12()
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    await flush()
    expect(screen().dataset.status).toBe('live')
    const info = currentLiveMatch(club(storage), clock.now())
    const { schedule } = liveTimeline(info.plan)
    // 已經播完的格數：目前那一格（可能剛好播完）
    expect(position() - schedule.positionAt(2 * MINUTE)).toBeGreaterThanOrEqual(0)
    expect(position() - schedule.positionAt(2 * MINUTE)).toBeLessThanOrEqual(1)
    expect(position()).toBeGreaterThan(10)
    // 暫停：比賽時間照走（推進 1 分鐘），畫面不動
    $<HTMLButtonElement>('[data-action="live-toggle"]')!.click()
    expect(screen().dataset.status).toBe('paused')
    expect($('.v2-live-paused')!.hidden).toBe(false)
    const paused = position()
    gate.stopAt = T0 + 13 * MINUTE
    clock.set(T0 + 13 * MINUTE)
    await flush(10)
    expect(position()).toBe(paused)
    // 繼續：跳到 13:00 的進度（不補播中間錯過的球）
    $<HTMLButtonElement>('[data-action="live-toggle"]')!.click()
    await flush(10)
    expect(screen().dataset.status).toBe('live')
    expect(position() - schedule.positionAt(3 * MINUTE)).toBeGreaterThanOrEqual(0)
    expect(position() - schedule.positionAt(3 * MINUTE)).toBeLessThanOrEqual(1)
    expect(position()).toBeGreaterThan(paused + 5)
  })

  it('動畫早播完也不提前揭露：得分那一格播完時，比分條仍是這一格開始時的比分，排定時間到了才更新', async () => {
    const { storage, clock, gate } = await mountAt12()
    const info = currentLiveMatch(club(storage), clock.now())
    const { timeline, schedule } = liveTimeline(info.plan)
    const us = timeline.userSide
    const j = timeline.frames.findIndex((f, i) => i > 0 && f.events.some((e) => e.type === 'play' && e.runs > 0))
    expect(j).toBeGreaterThan(0)
    const at = info.startsAt + schedule.startOf(j) + 1
    clock.set(at)
    gate.stopAt = at
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    await flush(20)
    // 這一格的動畫（投球、擊球、得分大字）已經播完，但時間還沒到這一格的結束
    const before = timeline.frames[j - 1].after
    const after = timeline.frames[j].after
    expect(after.score).not.toEqual(before.score)
    expect(position()).toBe(j)
    expect(text('[data-score="us"]')).toBe(String(before.score[us]))
    expect(text('[data-score="them"]')).toBe(String(before.score[us === 'home' ? 'away' : 'home']))
    // 時間走到這一格的結束：才提交得分後的比分
    gate.stopAt = info.startsAt + schedule.endOf(j)
    clock.set(gate.stopAt)
    await flush(20)
    expect(position()).toBeGreaterThanOrEqual(j + 1)
    expect(text('[data-score="us"]')).toBe(String(timeline.frames[position() - 1].after.score[us]))
  })

  it('最後一格：endsAt 之前不顯示最終比分、勝敗與比賽結束；到 endsAt 才揭曉', async () => {
    const { storage, clock, gate } = await mountAt12()
    const info = currentLiveMatch(club(storage), clock.now())
    const { timeline, schedule } = liveTimeline(info.plan)
    const last = timeline.frames.length - 1
    const at = info.startsAt + schedule.startOf(last) + 1
    clock.set(at)
    gate.stopAt = info.endsAt - 1
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    await flush(30)
    expect(clock.now()).toBeLessThan(info.endsAt)
    expect(screen().dataset.status).toBe('live')
    expect($('.v2-replay-final')!.hidden).toBe(true)
    expect($('.v2-replay-verdict')).toBeNull()
    expect(text('.v2-replay-log')).not.toContain('比賽結束')
    expect(text('.v2-replay-last')).not.toContain('比賽結束')
    const prev = timeline.frames[last - 1].after
    expect(text('[data-score="us"]')).toBe(String(prev.score[timeline.userSide]))
    gate.stopAt = undefined
    await untilEnded()
    expect(clock.now()).toBeGreaterThanOrEqual(info.endsAt)
    expect($('.v2-replay-final')!.hidden).toBe(false)
    expect(text('[data-score="us"]')).toBe(String(timeline.final.score[timeline.userSide]))
  })

  it('一直看到比賽結束：顯示最終比分；結算後的戰報比分跟直播一樣；可以接著看下一場', async () => {
    const { storage, gate } = await mountAt12()
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    gate.stopAt = undefined
    await untilEnded()
    expect(screen().dataset.status).toBe('ended')
    const us = text('[data-score="us"]')
    const them = text('[data-score="them"]')
    expect($('.v2-replay-final')!.hidden).toBe(false)
    // 獎勵還沒發：要等結算（下一步「觀看下一場」會先結算）
    expect(club(storage).recentMatches.some((x) => x.matchIndex === 2)).toBe(false)
    $<HTMLButtonElement>('[data-action="live-next"]')!.click()
    await flush(20)
    const m = club(storage).recentMatches.find((x) => x.matchIndex === 2)!
    expect(String(m.result.runsFor)).toBe(us)
    expect(String(m.result.runsAgainst)).toBe(them)
    expect(text('.v2-replay-title')).toContain(V2T.matchNo(4))
  })

  it('觀戰只會記一次新手任務旗標，其他一個字都沒變；第二次觀戰完全不寫入；比賽照樣在時間到時結算', async () => {
    const { storage, deps, clock } = await mountAt12()
    const before = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(before.onboarding.watchedLive).toBe(false)
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    await flush(10)
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
    expect($('.v2-dashboard')).not.toBeNull()
    const after = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    // 只有 onboarding.watchedLive 與 revision 改變（liveMatch、比賽、經濟都沒動）
    expect({ ...after, onboarding: before.onboarding, revision: before.revision }).toEqual(before)
    expect(after.onboarding).toEqual({ ...before.onboarding, watchedLive: true })
    expect(after.revision).toBe(before.revision + 1)
    expect($('[data-task="watch"]')!.dataset.done).toBe('true')
    const once = storage.getItem(CLUB_STORAGE_KEY)
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    await flush(10)
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(once)
    clock.set(T0 + 15 * MINUTE)
    expect((await settleDue(deps)).settled.map((m) => m.matchIndex)).toEqual([2])
  })

  it('觀戰中升級球員：進行中的比賽不受影響（直播與結算都是開賽時的陣容）', async () => {
    const { storage, deps, gate } = await mountAt12()
    const plan = currentLiveMatch(club(storage), T0 + 12 * MINUTE).plan
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    const id = club(storage).roster.lineup[0].playerId
    for (let lv = 1; lv < 8; lv++) await upgrade(deps, { opSeq: club(storage).economy.nextOpSeq, playerId: id, expectedLevel: lv })
    otherTabWrote()
    expect(stableJson(club(storage).liveMatch!.plan)).toBe(stableJson(plan))
    gate.stopAt = undefined
    await untilEnded()
    const us = text('[data-score="us"]')
    $<HTMLButtonElement>('[data-action="live-next"]')!.click()
    await flush(20)
    const settled = club(storage)
    expect(String(settled.recentMatches.find((x) => x.matchIndex === 2)!.result.runsFor)).toBe(us)
    const rep = settled.replays.find((r) => r.matchId === plan.matchId)!.replay
    expect(stableJson(rep.setup)).toBe(stableJson(plan.setup))
  })

  it('沒有重播、跳到結束、調速度；空白鍵暫停，Esc 離開；觀戰畫面沒有球員操作或領取按鈕', async () => {
    await mountAt12()
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    const overlay = $('.v2-replay-overlay')!
    expect(overlay.querySelectorAll('[data-speed], [data-action="replay-restart"], [data-action="replay-skip"]')).toHaveLength(0)
    expect(overlay.querySelectorAll('.v2-claim, .v2-upgrade-btn, [data-action="release"], [data-action="recruit"], [data-action="challenge"]')).toHaveLength(0)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect(screen().dataset.status).toBe('paused')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
  })

  it('快速開關觀戰 10 次、離開 V2：不留下觀戰畫面、播放迴圈或進行中的動畫', async () => {
    const { stats } = await mountAt12()
    for (let i = 0; i < 10; i++) {
      $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
      $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
      await untilOverlay()
      expect($$('.v2-replay-overlay')).toHaveLength(1)
      $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
      await flush(3)
    }
    expect($$('.v2-replay-overlay')).toHaveLength(0)
    expect(stats.created).toBe(10)
    await flush(10)
    expect(stats.active).toBe(0)
    $<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    await untilOverlay()
    app!.close()
    app = null
    expect($('.v2-replay-overlay')).toBeNull()
  })
})

describe('歷史戰報', () => {
  it('每場都有 Box Score：日期、聯盟、比分、各局比分、安打、打者與投手成績、收益；說明保留範圍；沒有觀看入口', async () => {
    const { storage } = await mountAt12()
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    expect(text('.v2-hint')).toContain('最近 50 場')
    $$('.v2-match')[1].click()
    const m = club(storage).recentMatches[0]
    expect($('.v2-report-meta')!.dataset.league).toBe('0')
    expect(text('.v2-report-meta')).toContain('新秀聯盟')
    expect($$('.v2-linescore tr')).toHaveLength(3)
    const totals = $$('.v2-linescore tr.ours .total').map((x) => x.textContent)
    expect(totals[0]).toBe(String(m.result.runsFor))
    expect(totals[1]).toBe(String(m.box!.hits[m.result.userSide]))
    expect($$('.v2-box li').length).toBe(m.box!.batters.length + m.box!.pitchers.length)
    expect(text('.v2-report')).toContain(V2T.earned(m.earnedFunds, m.earnedExperience))
    expect($('[data-action="watch"]')).toBeNull()
  })
})

describe('晉級挑戰的觀看', () => {
  const eligible = (c: ClubSave): ClubSave => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    return { ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle, nextMatchIndex: n } }
  }
  async function seedFor(want: boolean): Promise<number> {
    for (let seed = 1; seed < 200; seed++) {
      const d = tab(new MemoryStorage(), new ManualClock(), new FakeLockManager())
      await createClubSafely(d, { clubName: '挑戰觀戰隊', clubSeed: seed, clubId: 'club-cw' })
      const plan = planChallenge(eligible(d.store.loadClub()!))
      if ((runMatch(plan.setup, plan.ai).winner === plan.userSide) === want) return seed
    }
    throw new Error('no seed')
  }
  async function mountEligible(want: boolean) {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const deps = tab(storage, clock, locks)
    await createClubSafely(deps, { clubName: '挑戰觀戰隊', clubSeed: await seedFor(want), clubId: 'club-cw' })
    const c = deps.store.loadClub()!
    deps.store.saveClub(eligible(c), c.revision)
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'cw-tab', replayStage: fakeStage({ active: 0, created: 0 }), replayTimeScale: 0 })
    await flush()
    return { storage, clock, locks, deps }
  }

  for (const want of [true, false]) {
    it(`挑戰${want ? '成功' : '失敗'}：先問要不要看過程（不先揭曉）→ 看完才顯示結果；比分跟挑戰紀錄一致；觀看不改任何東西`, async () => {
      const { storage } = await mountEligible(want)
      $<HTMLButtonElement>('[data-action="challenge"]')!.click()
      await flush()
      expect($('.v2-challenge-start')).not.toBeNull()
      expect($('.v2-challenge-verdict')).toBeNull()
      const before = storage.getItem(CLUB_STORAGE_KEY)
      const record = club(storage).league.challenges.at(-1)!
      $<HTMLButtonElement>('[data-action="watch-challenge"]')!.click()
      await untilOverlay()
      expect($('.v2-challenge-verdict')).toBeNull()
      $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
      await flush()
      expect(text('[data-score="us"]')).toBe(String(record.runsFor))
      expect(text('[data-score="them"]')).toBe(String(record.runsAgainst))
      expect(text('.v2-challenge-verdict')).toBe(want ? V2T.challengeWin : V2T.challengeLose)
      $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
      await flush()
      expect($$('.v2-challenge-result')).toHaveLength(1)
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    })
  }

  it('不想看：關掉提問直接看結果；看到一半離開也會顯示結果，結果不會消失', async () => {
    const { storage } = await mountEligible(true)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect(text('.v2-challenge-verdict')).toBe(V2T.challengeWin)
    expect(club(storage).league.tier).toBe(1)
  })

  it('看到一半離開：顯示結果', async () => {
    await mountEligible(false)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    $<HTMLButtonElement>('[data-action="watch-challenge"]')!.click()
    await untilOverlay()
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect(text('.v2-challenge-verdict')).toBe(V2T.challengeLose)
  })

  it('重送同一個請求被拒絕、挑戰途中重新整理：結果已經保存，首頁可以「觀看上次晉級挑戰」', async () => {
    const { storage, deps, clock, locks } = await mountEligible(true)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    const first = club(storage).challengeReplay
    const dup = await challengeNextLeague(deps, { fromTier: 0, challengeSeq: 0, requestId: 'other' }).catch((e) => e)
    expect(dup.code).toBe('stale-request')
    expect(club(storage).challengeReplay).toEqual(first)
    app!.close()
    document.body.replaceChildren()
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'cw-tab-2', replayStage: fakeStage({ active: 0, created: 0 }), replayTimeScale: 0 })
    await flush()
    expect(club(storage).league.tier).toBe(1)
    $<HTMLButtonElement>('[data-action="watch-last-challenge"]')!.click()
    await untilOverlay()
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    expect(text('[data-score="us"]')).toBe(String(club(storage).league.challenges.at(-1)!.runsFor))
  })
})
