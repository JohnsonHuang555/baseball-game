// @vitest-environment happy-dom
// Phase 7B 的畫面：首頁目標卡與聯盟卡的競技積分（只讀存檔）、比賽列表與戰報的積分變化（舊比賽「未記錄」）、
// 降級對話框（只開一次、重畫與重新整理不重開、跟歡迎回來的順序）、晉級對話框的積分說明、聯盟之路的歷史最高聯盟
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import type { ChallengeOutcome } from '../application/leagueService'
import type { ClubSave, SettledMatch } from '../domain/club'
import { leagueAtTier, type LeagueState } from '../domain/league'
import { LEAGUES, RANKED_CONFIG } from '../domain/leagueConfig'
import { openV2, SEEN_RELEGATIONS_KEY, type V2App } from './app'
import { dialogDebug } from './dialog'
import { challengeResultModal } from './leagueView'
import { openMatchReport } from './reportView'

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
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
const mobile = () => {
  const real = globalThis.matchMedia
  globalThis.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  return () => (globalThis.matchMedia = real)
}

interface Env {
  storage: MemoryStorage
  clock: ManualClock
  locks: FakeLockManager
}

async function create(edit?: (c: ClubSave) => ClubSave): Promise<Env> {
  const env = { storage: new MemoryStorage(), clock: new ManualClock(T0), locks: new FakeLockManager() }
  const deps = tab(env.storage, env.clock, env.locks)
  await createClubSafely(deps, { clubName: '積分隊', clubSeed: 11, clubId: 'club-p7b' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  return env
}

/** 打開 App（手機版）；closeAll：關掉一開始的對話框（歡迎回來等） */
async function open(env: Env, closeAll = true): Promise<void> {
  const restore = mobile()
  try {
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'tab-p7b' })
    await flush()
    if (closeAll) {
      $$('.v2-modal-close').forEach((b) => b.click())
      await flush()
    }
  } finally {
    restore()
  }
}
const saved = (env: Env) => JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const at = (tier: number, extra: Partial<LeagueState> = {}) => (c: ClubSave): ClubSave => ({ ...c, league: leagueAtTier(c.league, tier, extra) })
/** 已經從職業降回挑戰者（歷史最高傳奇、降過兩次的話 relegations 跟著調） */
const relegatedTo2 = (c: ClubSave): ClubSave => ({
  ...c,
  league: { ...leagueAtTier(c.league, 3), tier: 2, relegations: 1, lastRelegation: { fromTier: 3, toTier: 2, matchIndex: 0, at: T0 }, points: RANKED_CONFIG.initialPoints },
})
/** 全隊能力 1：在高聯盟幾乎每場都輸（比賽仍是正式模擬） */
const weak = (c: ClubSave): ClubSave => ({ ...c, players: c.players.map((r) => ({ ...r, player: { ...r.player, ratings: Object.fromEntries(Object.keys(r.player.ratings).map((k) => [k, 1])) } as unknown as typeof r.player })) })

describe('首頁：下一個目標與聯盟卡的競技積分', () => {
  it('職業聯盟：積分、保級安全、離危險區幾分、降級風險；晉級條件照舊，沒有「晉級區」', async () => {
    await open(await create(at(3, { points: 58 })))
    const goal = $('.v2-goal')!
    const ranked = goal.querySelector<HTMLElement>('.v2-ranked')!
    expect(ranked.dataset.points).toBe('58')
    expect(ranked.dataset.zone).toBe('safe')
    expect(ranked.textContent).toContain('保級安全')
    expect(ranked.textContent).toContain(`高於危險區 ${58 - RANKED_CONFIG.dangerThreshold} 分`)
    expect(goal.querySelectorAll('.v2-goal-conds li')).toHaveLength(2)
    expect(goal.textContent).toContain(`積分歸零會降回${LEAGUES[2].name}`)
    expect(goal.textContent).not.toMatch(/晉級區|示意|尚未上線/)
    // 首頁聯盟卡也顯示同一個積分
    expect($('.v2-league .v2-ranked')!.dataset.points).toBe('58')
  })

  it('危險區：紅框、降級危險區標籤、歸零會降回哪一級', async () => {
    await open(await create(at(4, { points: 14 })))
    const ranked = $('.v2-goal .v2-ranked')!
    expect(ranked.dataset.zone).toBe('danger')
    expect(ranked.classList.contains('danger')).toBe(true)
    expect(ranked.textContent).toContain('降級危險區')
    expect(ranked.textContent).toContain(`積分歸零會降回${LEAGUES[3].name}`)
  })

  it('挑戰者 0 分：保底，不顯示降級風險', async () => {
    await open(await create(at(2, { points: 0 })))
    const ranked = $('.v2-goal .v2-ranked')!
    expect(ranked.dataset.zone).toBe('floor')
    expect(ranked.textContent).not.toContain('降級危險區')
    expect($('.v2-goal')!.textContent).not.toContain('積分歸零會降回')
  })

  it('傳奇：最高聯盟、積分、保級狀態、本聯盟近期戰績、離危險區幾分', async () => {
    const env = await create(at(4, { points: 31 }))
    env.clock.advance(HOUR)
    await open(env)
    const goal = $('.v2-goal')!
    const c = saved(env)
    expect(goal.querySelector('.v2-goal-conds')).toBeNull()
    expect(goal.textContent).toContain('最高的聯盟')
    expect(goal.querySelector<HTMLElement>('.v2-ranked')!.dataset.points).toBe(String(c.league.points))
    expect(goal.querySelector('.v2-goal-form')!.textContent).toMatch(/本聯盟最近 \d+ 場/)
    expect(goal.textContent).toMatch(/高於危險區 \d+ 分|在危險區/)
  })

  it('結算後首頁的積分 = 存檔的積分；最近比賽的 ±分 = 那場存下的變化', async () => {
    const env = await create(at(3, { points: 50 }))
    env.clock.advance(2 * HOUR)
    await open(env)
    const c = saved(env)
    expect($('.v2-goal .v2-ranked')!.dataset.points).toBe(String(c.league.points))
    expect($('.v2-league .v2-ranked')!.dataset.points).toBe(String(c.league.points))
    const latest = c.recentMatches.at(-1)!
    const chip = $('.v2-recent .v2-match .v2-pts-chip')!
    const d = latest.ranked!.delta
    expect(chip.textContent).toBe(d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0')
  })
})

describe('戰報：積分變化與舊比賽', () => {
  const match = (c: ClubSave, ranked?: SettledMatch['ranked'], leagueTier = 3): SettledMatch => ({
    matchId: `${c.clubId}#0`,
    matchIndex: 0,
    seed: 1,
    result: { userSide: 'home', opponentName: '對手', runsFor: 1, runsAgainst: 3, won: false, innings: 9, highlights: [], rulesVersion: 1, coachVersion: 1, leagueTier },
    earnedFunds: 10,
    earnedExperience: 1,
    settledAt: T0,
    playedAt: T0,
    ...(ranked ? { ranked } : {}),
  })

  it('有紀錄：前後積分、變化、降級；沒有紀錄（7B 以前）：顯示「未記錄」，不推算；新秀、業餘不顯示', async () => {
    const env = await create(at(3))
    const c = saved(env)
    let close = openMatchReport(match(c, { tier: 3, before: 2, after: 0, delta: -2, protected: false, protectionRemaining: 0, relegatedTo: 2 }), c)
    let report = $('.v2-report-ranked')!
    expect(report.textContent).toContain('2 → 0')
    expect(report.textContent).toContain(`從${LEAGUES[3].name}降到${LEAGUES[2].name}`)
    close()
    close = openMatchReport(match(c), c)
    report = $('.v2-report-ranked')!
    expect(report.textContent).toContain('未記錄')
    close()
    close = openMatchReport(match(c, undefined, 1), c)
    expect($('.v2-report-ranked')).toBeNull()
    close()
    expect(dialogDebug().layers).toBe(0)
  })

  it('最近比賽列表：舊比賽顯示「積分未記錄」', async () => {
    const env = await create((c) => ({ ...at(3)(c), recentMatches: [match(c)] }))
    await open(env)
    expect($('.v2-recent .v2-pts-chip')!.textContent).toBe('積分未記錄')
  })
})

describe('降級對話框', () => {
  it('打開時有新的降級：顯示原本與新的聯盟、原因、保留的東西、新目標；Escape 關閉後重畫、重新整理都不會再開', async () => {
    const env = await create(relegatedTo2)
    await open(env, false)
    const modal = $('.v2-relegation-modal')!
    expect(modal).toBeTruthy()
    expect(modal.querySelector('.v2-relegation-title')!.textContent).toBe(`降到${LEAGUES[2].name}`)
    expect(modal.textContent).toContain(`${LEAGUES[3].name}的競技積分降到 0`)
    expect(modal.textContent).toContain('全部球員、陣容與戰術')
    expect(modal.textContent).toContain('資金、經驗與未領取收益')
    expect(modal.textContent).toContain(`重返${LEAGUES[3].name}`)
    expect(modal.querySelectorAll('.v2-lg-badge')).toHaveLength(2)
    // 已讀只在玩家真的關掉時才寫入
    expect(env.storage.getItem(SEEN_RELEGATIONS_KEY)).toBeNull()
    key('Escape')
    await flush()
    expect($('.v2-relegation-modal')).toBeNull()
    expect(JSON.parse(env.storage.getItem(SEEN_RELEGATIONS_KEY)!)).toEqual({ clubId: 'club-p7b', count: 1 })
    // 重畫（切分頁再回來）
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    await flush()
    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    await flush()
    expect($('.v2-relegation-modal')).toBeNull()
    // 重新整理
    app!.close()
    document.body.replaceChildren()
    await open(env, false)
    expect($('.v2-relegation-modal')).toBeNull()
  })

  it('「查看聯盟之路」：關掉降級對話框、打開聯盟之路；目前在挑戰者、職業顯示已到達（歷史最高）', async () => {
    const env = await create(relegatedTo2)
    await open(env, false)
    $<HTMLButtonElement>('[data-action="relegation-road"]')!.click()
    await flush()
    expect($('.v2-relegation-modal')).toBeNull()
    expect($('.v2-road-modal')).toBeTruthy()
    const state = (t: number) => $(`.v2-road-card[data-tier="${t}"]`)!.className
    expect(state(2)).toContain('current')
    expect(state(3)).toContain('reached')
    expect(state(4)).toContain('locked')
    expect($('.v2-road-where')!.textContent).toContain(`歷史最高：${LEAGUES[3].name}`)
  })

  it('離線結算中途真的降級：先顯示歡迎回來，關掉後才顯示降級（只顯示一次）', async () => {
    const env = await create((c) => weak(at(4, { points: 6 })(c)))
    env.clock.advance(8 * HOUR)
    await open(env, false)
    const c = saved(env)
    expect(c.league.relegations).toBeGreaterThanOrEqual(1)
    expect($('.v2-relegation-modal')).toBeNull()
    // 歡迎回來（離線摘要）先開
    const welcome = $$('.v2-modal-close')
    expect(welcome.length).toBeGreaterThan(0)
    welcome.forEach((b) => b.click())
    await flush()
    const modal = $('.v2-relegation-modal')!
    expect(modal).toBeTruthy()
    // 連降兩級：找得到兩次的比賽紀錄就合併；第一次已經超出近期比賽保留範圍時，只說最後一次並照實註明還有幾次沒有細節
    if (c.league.relegations > 1) expect(modal.textContent).toMatch(new RegExp(`離線期間降級 ${c.league.relegations} 次|另外還有 ${c.league.relegations - 1} 次較早的降級`))
    // 不會出現同一個聯盟「降到」自己
    expect(modal.textContent).not.toContain(`${LEAGUES[c.league.tier].name}的競技積分降到 0，從下一場比賽開始在${LEAGUES[c.league.tier].name}`)
    $$('.v2-relegation-modal button').find((b) => b.textContent === '回到首頁')!.click()
    await flush()
    expect($('.v2-relegation-modal')).toBeNull()
    expect(dialogDebug().layers).toBe(0)
  })

  it('App 關閉時一起清掉降級對話框，而且不算已讀：下次打開還會通知', async () => {
    const env = await create(relegatedTo2)
    await open(env, false)
    expect(dialogDebug().layers).toBeGreaterThan(0)
    app!.close()
    app = null
    expect(dialogDebug().layers).toBe(0)
    expect($$('.v2-relegation-modal')).toHaveLength(0)
    expect(env.storage.getItem(SEEN_RELEGATIONS_KEY)).toBeNull()
    document.body.replaceChildren()
    await open(env, false)
    expect($$('.v2-relegation-modal')).toHaveLength(1)
  })

  it('對話框開著時重畫好幾次：只有一個對話框（不重入）', async () => {
    await open(await create(relegatedTo2), false)
    for (const t of ['lineup', 'home', 'reports', 'home']) {
      $<HTMLButtonElement>(`[data-tab="${t}"]`)!.click()
      await flush()
    }
    expect($$('.v2-relegation-modal')).toHaveLength(1)
  })

  it('localStorage 寫不進去：關掉後同一個 App 內不再彈出（記憶體記住）；重新整理才會再通知一次', async () => {
    class NoSeenStorage extends MemoryStorage {
      override setItem(k: string, v: string): void {
        if (k === SEEN_RELEGATIONS_KEY) throw new Error('quota')
        super.setItem(k, v)
      }
    }
    const env = { storage: new NoSeenStorage(), clock: new ManualClock(T0), locks: new FakeLockManager() }
    const deps = tab(env.storage, env.clock, env.locks)
    await createClubSafely(deps, { clubName: '積分隊', clubSeed: 11, clubId: 'club-p7b' })
    const c = deps.store.loadClub()!
    deps.store.saveClub(relegatedTo2(c), c.revision)
    await open(env, false)
    key('Escape')
    await flush()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    await flush()
    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    await flush()
    expect($('.v2-relegation-modal')).toBeNull()
  })

  it('降級後已經重新晉級（另一台裝置、沒有已讀紀錄）：不通知', async () => {
    const env = await create((c) => {
      const r = relegatedTo2(c)
      // 挑戰者 → 職業：重新晉級（晉級次數 +1）
      return { ...r, league: { ...r.league, tier: 3, promotions: r.league.promotions + 1, points: RANKED_CONFIG.initialPoints, protectionRemaining: 0 } }
    })
    await open(env, false)
    expect($('.v2-relegation-modal')).toBeNull()
  })
})

describe('晉級對話框', () => {
  const outcome = (toTier: number, reward = { funds: 1, experience: 1 }): ChallengeOutcome =>
    ({
      club: {} as ClubSave,
      duplicate: false,
      settledMatches: 0,
      challenge: { seq: 0, fromTier: toTier - 1, toTier, won: true, runsFor: 5, runsAgainst: 3, opponentName: '強敵', innings: 9, at: T0, matchIndexAt: 0, reward, requestKey: 'x' },
    }) as ChallengeOutcome

  it('升上挑戰者：說明積分從 50 開始與保護；升上職業：多一行降級風險；重返：首次獎勵已領過', () => {
    let close = challengeResultModal(outcome(2), '隊', () => {})
    let text = $('.v2-challenge-modal')!.textContent!
    expect(text).toContain(`競技積分從 ${RANKED_CONFIG.initialPoints} 分開始`)
    expect(text).not.toContain('有降級風險')
    close()
    close = challengeResultModal(outcome(3), '隊', () => {})
    text = $('.v2-challenge-modal')!.textContent!
    expect(text).toContain(`${LEAGUES[3].name}有降級風險：積分歸零會降回${LEAGUES[2].name}`)
    close()
    close = challengeResultModal(outcome(4, { funds: 0, experience: 0 }), '隊', () => {})
    expect($('.v2-challenge-modal')!.textContent).toContain('首次晉級獎勵已經領過')
    close()
    close = challengeResultModal(outcome(1), '隊', () => {})
    expect($('.v2-challenge-modal')!.textContent).not.toContain('競技積分')
    close()
    expect(dialogDebug().layers).toBe(0)
  })
})

describe('降級通知的基準', () => {
  it('第一次在這個裝置打開、沒有要通知的事：把目前的降級次數記成基準（之後的降級才能算出確切次數）', async () => {
    const env = await create(at(3))
    await open(env, false)
    expect(JSON.parse(env.storage.getItem(SEEN_RELEGATIONS_KEY)!)).toEqual({ clubId: 'club-p7b', count: 0 })
  })
})

describe('危險區 Toast（PR #17 review P3）', () => {
  /** 收集這段期間出現過的 Toast 文字（新的 Toast 會取代舊的，所以用 MutationObserver 記下每一則） */
  function toasts() {
    const seen: string[] = []
    const mo = new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains('toast')) seen.push(n.textContent ?? '')
    })
    mo.observe(document.body, { childList: true })
    return { list: seen, ranked: () => seen.filter((t) => t.includes('危險區')), stop: () => mo.disconnect() }
  }
  /** 模擬另一個分頁改了存檔：直接改儲存，發 storage 事件，App 重新讀取並重畫 */
  async function otherTab(env: Env, edit: (c: ClubSave) => ClubSave) {
    const c = saved(env)
    env.storage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ ...edit(c), revision: c.revision + 1 }))
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
  }
  const points = (p: number) => (c: ClubSave): ClubSave => ({ ...c, league: { ...c.league, points: p } })

  it('職業 21 → 19：只提示一次進入危險區；同樣的資料再重畫不再提示', async () => {
    const env = await create(at(3, { points: 21 }))
    await open(env)
    const t = toasts()
    await otherTab(env, points(19))
    expect(t.ranked()).toEqual([`進入降級危險區：積分 19 / ${RANKED_CONFIG.maxPoints}`])
    await otherTab(env, (c) => c)
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    await flush()
    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    await flush()
    expect(t.ranked()).toHaveLength(1)
    t.stop()
  })

  it('職業 19 → 22：只提示一次離開危險區', async () => {
    const env = await create(at(3, { points: 19 }))
    await open(env)
    const t = toasts()
    await otherTab(env, points(22))
    await otherTab(env, (c) => c)
    expect(t.ranked()).toEqual([`已離開危險區・積分 22 / ${RANKED_CONFIG.maxPoints}`])
    t.stop()
  })

  it('挑戰者 0 分（保底）不提示；新秀、業餘沒有積分，不提示', async () => {
    for (const [tier, from, to] of [
      [2, 25, 0],
      [1, null, null],
      [0, null, null],
    ] as const) {
      const env = await create(at(tier, from === null ? {} : { points: from }))
      await open(env)
      const t = toasts()
      await otherTab(env, (c) => (to === null ? { ...c, record: { ...c.record } } : points(to)(c)))
      expect(t.ranked()).toEqual([])
      t.stop()
      app?.close()
      app = null
      document.body.replaceChildren()
    }
  })

  it('晉級後積分重設（危險區 → 新聯盟 50 分）：不當成離開危險區', async () => {
    const env = await create(at(3, { points: 12 }))
    await open(env)
    const t = toasts()
    await otherTab(env, (c) => ({ ...c, league: { ...c.league, tier: 4, highestTier: 4, promotions: 4, rewardedTiers: [1, 2, 3, 4], points: 50, protectionRemaining: 20 } }))
    expect(t.ranked()).toEqual([])
    t.stop()
  })

  it('降級後積分重設（危險區 → 新聯盟 50 分）：不當成離開危險區', async () => {
    const env = await create(at(4, { points: 2 }))
    await open(env)
    const t = toasts()
    await otherTab(env, (c) => ({ ...c, league: { ...c.league, tier: 3, relegations: 1, lastRelegation: { fromTier: 4, toTier: 3, matchIndex: 0, at: T0 }, points: 50 } }))
    expect(t.ranked()).toEqual([])
    t.stop()
  })

  it('App 關閉之後，存檔再變也不會提示', async () => {
    const env = await create(at(3, { points: 21 }))
    await open(env)
    const t = toasts()
    app!.close()
    app = null
    await otherTab(env, points(19))
    expect(t.list).toEqual([])
    t.stop()
  })
})
