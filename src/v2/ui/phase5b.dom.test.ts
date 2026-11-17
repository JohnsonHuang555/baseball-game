// @vitest-environment happy-dom
// Phase 5B：觀戰入口、播放控制、跳到結束、返回、錯誤處理、資料不受影響、快速開關
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { settleDue } from '../application/settlementService'
import type { ClubSave, SettledMatch } from '../domain/club'
import { RETENTION_CONFIG } from '../domain/config'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { challengeNextLeague, planChallenge } from '../application/leagueService'
import { runMatch } from '../application/matchRunner'
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
/** 等觀戰畫面出現（第一次要動態載入模組） */
async function untilOverlay(): Promise<void> {
  for (let i = 0; i < 100 && !document.querySelector('.v2-replay-overlay'); i++) await flush(5)
}
const otherTabWrote = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))

/** 測試用球場：動畫立即完成，記錄還在進行中的動畫數（取消後歸零） */
function fakeStage(stats: { active: number; cancels: number; created: number }): () => ReplayStage {
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
      play: anim,
      run: anim,
      cancel: () => void stats.cancels++,
      resize: () => undefined,
      get alignment() {
        return alignment
      },
    }
  }
}

async function mountWithMatches(hours = 1, timeScale = 0) {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const locks = new FakeLockManager()
  const deps = tab(storage, clock, locks)
  await createClubSafely(deps, { clubName: '觀戰隊', clubSeed: 31, clubId: 'club-watch' })
  clock.advance(hours * HOUR)
  await settleDue(deps)
  const stats = { active: 0, cancels: 0, created: 0 }
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'watch-tab', replayStage: fakeStage(stats), replayTimeScale: timeScale })
  await flush()
  return { storage, clock, locks, deps, stats }
}

const club = (storage: MemoryStorage) => JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const lastMatch = (storage: MemoryStorage) => club(storage).recentMatches.at(-1) as SettledMatch

async function openLatestFromReports() {
  $<HTMLButtonElement>('[data-tab="reports"]')!.click()
  $$('.v2-match')[0].click()
  $<HTMLButtonElement>('[data-action="watch"]')!.click()
  await untilOverlay()
}

describe('觀戰入口', () => {
  it('戰報：有完整重播的場次有「觀看比賽」，舊場次說明完整重播已不再保留', async () => {
    await mountWithMatches()
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    const items = $$('.v2-match')
    expect(items.length).toBe(12)
    items[0].click()
    expect($('[data-action="watch"]')).not.toBeNull()
    expect($('.v2-replay-missing')).toBeNull()
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    items[RETENTION_CONFIG.replays].click()
    expect($('[data-action="watch"]')).toBeNull()
    expect(text('.v2-replay-missing')).toBe(V2T.replayNotKept)
  })

  it('首頁：有最近比賽就能「觀看最近比賽」；還沒有比賽時沒有按鈕', async () => {
    await mountWithMatches()
    const btn = $<HTMLButtonElement>('[data-action="watch-latest"]')!
    expect(btn.textContent).toBe(V2T.watchLatest)
    expect(btn.disabled).toBe(false)
    btn.click()
    await untilOverlay()
    expect($('.v2-replay-overlay')).not.toBeNull()
    expect(text('.v2-replay-title')).toContain(V2T.matchNo(12))
  })
})

describe('觀戰畫面', () => {
  it('播放 → 暫停 → 4× → 繼續 → 跳到結束：比分跟戰報一致；返回後還在戰報分頁、戰報對話框還在', async () => {
    const { storage, stats } = await mountWithMatches(1, 1)
    const m = lastMatch(storage)
    await openLatestFromReports()
    const screen = $('.v2-replay')!
    expect(screen.dataset.status).toBe('playing')
    // 有在畫球場動畫（投球、打擊）
    expect(stats.created).toBe(1)
    const toggle = $<HTMLButtonElement>('[data-action="replay-toggle"]')!
    expect(toggle.textContent).toBe(V2T.replayPause)
    toggle.click()
    expect(screen.dataset.status).toBe('paused')
    const paused = screen.dataset.position
    await flush(10)
    expect(screen.dataset.position).toBe(paused)
    $<HTMLButtonElement>('[data-speed="4"]')!.click()
    expect($('[data-speed="4"]')!.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    expect(screen.dataset.status).toBe('playing')
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    expect(screen.dataset.status).toBe('completed')
    expect(text('[data-score="us"]')).toBe(String(m.result.runsFor))
    expect(text('[data-score="them"]')).toBe(String(m.result.runsAgainst))
    expect($('.v2-replay-final')!.hidden).toBe(false)
    expect(text('.v2-replay-verdict')).toBe(m.result.won ? V2T.win : V2T.loss)
    expect(stats.cancels).toBeGreaterThan(0)
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
    expect($('[data-tab="reports"]')!.getAttribute('aria-current')).toBe('true')
    expect($('.v2-report')).not.toBeNull()
  })

  it('全部播完（不跳過）：比分、出局數照模擬更新，最後跟戰報一致', async () => {
    const { storage } = await mountWithMatches(1, 0)
    const m = lastMatch(storage)
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    for (let i = 0; i < 400 && $('.v2-replay')?.dataset.status !== 'completed'; i++) await flush(5)
    expect($('.v2-replay')!.dataset.status).toBe('completed')
    expect(text('[data-score="us"]')).toBe(String(m.result.runsFor))
    expect(text('[data-score="them"]')).toBe(String(m.result.runsAgainst))
    expect($$('.v2-replay-log li').length).toBeGreaterThan(5)
    expect($<HTMLButtonElement>('[data-action="replay-toggle"]')!.textContent).toBe(V2T.replayAgain)
  })

  it('觀戰不寫入任何東西：完整播放、重播、跳過之後，存檔一個字都沒變', async () => {
    const { storage } = await mountWithMatches(1, 0)
    const before = storage.getItem(CLUB_STORAGE_KEY)
    const fields = (c: ClubSave) => ({ ...c })
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    for (let i = 0; i < 400 && $('.v2-replay')?.dataset.status !== 'completed'; i++) await flush(5)
    $<HTMLButtonElement>('[data-action="replay-restart"]')!.click()
    await flush(5)
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    const after = club(storage)
    const b = JSON.parse(before!) as ClubSave
    for (const k of ['schemaVersion', 'revision', 'players', 'roster', 'economy', 'idle', 'league', 'record', 'recentMatches', 'replays'] as const) {
      expect(fields(after)[k]).toEqual(fields(b)[k])
    }
  })

  it('觀戰中背景結算擠掉了這場的重播：已經開啟的畫面照樣播完；存檔的變化跟「沒有觀戰、只結算」完全相同', async () => {
    const { storage, clock, deps } = await mountWithMatches(1, 1)
    // 對照組：同一份存檔、同樣的時間，只結算不觀戰
    const control = new MemoryStorage()
    control.setItem(CLUB_STORAGE_KEY, storage.getItem(CLUB_STORAGE_KEY)!)
    const controlDeps = tab(control, clock, new FakeLockManager())
    const m = lastMatch(storage)
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    clock.advance(HOUR)
    await settleDue(deps)
    await settleDue(controlDeps)
    expect(club(storage).replays.some((r) => r.matchId === m.matchId)).toBe(false)
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    expect(text('[data-score="us"]')).toBe(String(m.result.runsFor))
    expect(text('[data-score="them"]')).toBe(String(m.result.runsAgainst))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(control.getItem(CLUB_STORAGE_KEY))
  })

  it('觀戰畫面裡沒有任何球員操作或領取按鈕；空白鍵控制播放，Esc 返回，關閉後還原原本的按鍵', async () => {
    await mountWithMatches(1, 1)
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    const overlay = $('.v2-replay-overlay')!
    expect(overlay.querySelectorAll('.v2-claim, .v2-upgrade-btn, [data-action="release"], [data-action="recruit"], [data-action="challenge"]')).toHaveLength(0)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))
    expect($('.v2-replay')!.dataset.status).toBe('paused')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
    expect($('.v2-dashboard')).not.toBeNull()
  })

  it('快速開關觀戰 10 次：不留下任何觀戰畫面、播放迴圈或進行中的動畫', async () => {
    const { stats } = await mountWithMatches(1, 1)
    for (let i = 0; i < 10; i++) {
      $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
      $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
      await flush(3)
      expect($$('.v2-replay-overlay')).toHaveLength(1)
      $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
      await flush(3)
    }
    expect($$('.v2-replay-overlay')).toHaveLength(0)
    expect(stats.created).toBe(10)
    await flush(10)
    expect(stats.active).toBe(0)
  })

  it('離開 V2：開著的觀戰畫面一起關掉', async () => {
    await mountWithMatches(1, 1)
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    app!.close()
    app = null
    expect($('.v2-replay-overlay')).toBeNull()
  })

  it('壞掉或不支援的重播：顯示可以理解的錯誤，可以返回，V2 照常運作、存檔不變', async () => {
    const { storage, deps } = await mountWithMatches()
    const c = deps.store.loadClub()!
    const replays = c.replays.map((r, i) => (i === c.replays.length - 1 ? { ...r, replay: { ...r.replay, rulesVersion: 99, setup: { ...r.replay.setup, rules: 99 } } } : r))
    deps.store.saveClub({ ...c, replays }, c.revision)
    otherTabWrote()
    await flush()
    const before = storage.getItem(CLUB_STORAGE_KEY)
    $<HTMLButtonElement>('[data-action="watch-latest"]')!.click()
    await untilOverlay()
    expect(text('.v2-replay-error h3')).toBe(V2T.replayErrorTitle)
    expect(text('.v2-replay-error')).toContain(V2T.replayErrorText('unsupported-version'))
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
    expect($('.v2-dashboard')).not.toBeNull()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
  })
})

describe('晉級挑戰的觀戰', () => {
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
    const stats = { active: 0, cancels: 0, created: 0 }
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'cw-tab', replayStage: fakeStage(stats), replayTimeScale: 0 })
    await flush()
    return { storage, clock, locks, deps }
  }

  for (const want of [true, false]) {
    it(`挑戰${want ? '成功' : '失敗'}：結果對話框可以「觀看挑戰過程」，比分跟挑戰結果一致；觀看不改聯盟進度與獎勵`, async () => {
      const { storage } = await mountEligible(want)
      $<HTMLButtonElement>('[data-action="challenge"]')!.click()
      await flush()
      const verdict = text('.v2-challenge-verdict')
      expect(verdict).toBe(want ? V2T.challengeWin : V2T.challengeLose)
      const saved = club(storage)
      const record = saved.league.challenges.at(-1)!
      const before = storage.getItem(CLUB_STORAGE_KEY)
      $<HTMLButtonElement>('[data-action="watch-challenge"]')!.click()
      await untilOverlay()
      $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
      expect(text('[data-score="us"]')).toBe(String(record.runsFor))
      expect(text('[data-score="them"]')).toBe(String(record.runsAgainst))
      expect(text('.v2-replay-verdict')).toBe(record.won ? V2T.win : V2T.loss)
      $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
      await flush()
      // 回到挑戰結果對話框；存檔一個字都沒變（沒有重新挑戰、沒有重新發獎）
      expect($('.v2-challenge-result')).not.toBeNull()
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    })
  }

  it('重送同一個挑戰請求、重新整理：Replay 還是同一場，首頁可以「觀看上次晉級挑戰」', async () => {
    const { storage, deps, clock, locks } = await mountEligible(true)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    const first = club(storage).challengeReplay
    const dup = await challengeNextLeague(deps, { fromTier: 0, challengeSeq: 0, requestId: 'other' }).catch((e) => e)
    expect(dup.code).toBe('stale-request')
    expect(club(storage).challengeReplay).toEqual(first)
    // 重新整理：重新開一次 V2
    app!.close()
    document.body.replaceChildren()
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, () => undefined, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'cw-tab-2', replayStage: fakeStage({ active: 0, cancels: 0, created: 0 }), replayTimeScale: 0 })
    await flush()
    $<HTMLButtonElement>('[data-action="watch-last-challenge"]')!.click()
    await untilOverlay()
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    const record = club(storage).league.challenges.at(-1)!
    expect(text('[data-score="us"]')).toBe(String(record.runsFor))
  })
})
