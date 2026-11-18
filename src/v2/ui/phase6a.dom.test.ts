// @vitest-environment happy-dom
// Phase 6A 的畫面：首頁層級、目前建議、新手任務（完成、收合、重新整理）、升級預覽與回饋、聯盟目標、唯讀分頁、挑戰中
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { updateSettings } from '../application/settlementService'
import type { ClubSave } from '../domain/club'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { leveled, upgradeCost } from '../domain/progression'
import { recordOf } from '../domain/roster'
import { openV2, type V2App } from './app'
import type { ReplayStage } from './replayView'
import { V2T } from './strings'
import { WRITER_KEY } from './writerGuard'

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
const click = async (sel: string) => {
  $<HTMLButtonElement>(sel)!.click()
  await flush()
}
const task = (id: string) => $(`[data-task="${id}"]`)?.dataset.done
const otherTabWrote = (key: string | null = CLUB_STORAGE_KEY) => window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: null }))

/** 記錄寫入次數的儲存 */
class CountingStorage extends MemoryStorage {
  writes = 0
  override setItem(key: string, value: string): void {
    if (key === CLUB_STORAGE_KEY) this.writes++
    super.setItem(key, value)
  }
}

interface Env {
  storage: CountingStorage
  clock: ManualClock
  locks?: FakeLockManager
}

async function open(env: Env, tabId = 'tab-a'): Promise<void> {
  app?.close()
  document.body.replaceChildren()
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId, replayStage: stage, replayTimeScale: 0 })
  await flush()
  // 關掉「歡迎回來」摘要與遷移提示
  $$('.v2-modal-close').forEach((b) => b.click())
  await flush()
}

const stage = (): ReplayStage => {
  let alignment: ReplayStage['alignment'] = 'normal'
  const anim = () => Promise.resolve()
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

/** 建好一個新球團，edit 可以直接改存檔 */
async function setup(edit?: (c: ClubSave) => ClubSave, webLocks = true): Promise<Env> {
  const locks = webLocks ? new FakeLockManager() : undefined
  const env: Env = { storage: new CountingStorage(), clock: new ManualClock(T0), locks }
  const deps = tab(env.storage, env.clock, locks)
  await createClubSafely(deps, { clubName: '新手隊', clubSeed: 42, clubId: 'club-6a' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  await open(env)
  return env
}
const load = (env: Env) => JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const give = (c: ClubSave, funds: number, experience: number, where: 'assets' | 'unclaimed' = 'assets'): ClubSave => {
  const n = structuredClone(c)
  n.economy[where].funds += funds
  n.economy[where].experience += experience
  n.economy.earned.funds += funds
  n.economy.earned.experience += experience
  return n
}

describe('首頁層級', () => {
  it('電腦版（1024 寬以上）三欄：比賽、建議與下一個目標／球隊與收益／聯盟、任務、最近比賽（Phase 7 加入下一個目標）', async () => {
    await setup()
    const cols = $$('.v2-dashboard > .v2-dash-col').map((c) => [...c.children].map((s) => s.className.split(' ').find((x) => x.startsWith('v2-') && x !== 'v2-card')))
    expect(cols).toEqual([['v2-live-card', 'v2-next', 'v2-goal'], ['v2-growth', 'v2-rewards'], ['v2-league', 'v2-onboard', 'v2-recent']])
  })

  it('新球團：目前比賽在最上面，接著目前建議、下一個目標、新手任務；沒有近期比賽、沒有收益', async () => {
    // 手機版一欄（測試環境的視窗預設 1024 寬，這裡讓版面判斷成手機）
    const realMatchMedia = globalThis.matchMedia
    globalThis.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
    try {
      await setup()
    } finally {
      globalThis.matchMedia = realMatchMedia
    }
    const order = $$('.v2-dashboard > section').map((s) => s.className.split(' ').find((c) => c.startsWith('v2-') && c !== 'v2-card'))
    expect(order).toEqual(['v2-live-card', 'v2-next', 'v2-goal', 'v2-onboard', 'v2-growth', 'v2-league', 'v2-rewards', 'v2-recent'])
    expect(text('[data-live-remain]')).toContain('5:00')
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('watch')
    // 最接近的升級目標：差多少經驗、資金
    const cost = upgradeCost(1)!
    expect(text('.v2-next-goal')).toBe(V2T.nextWatchGoal(text('.v2-next-goal').split('：')[1].split(' 升級')[0], cost.experience, cost.funds))
    expect(text('.v2-recent .v2-empty')).toBe(V2T.noMatches)
    expect(text('.v2-rewards')).toContain(V2T.rewardsEmpty)
    expect($<HTMLButtonElement>('.v2-claim')!.disabled).toBe(true)
    expect($('[data-onboarding]')!.dataset.onboarding).toBe('1/6')
    expect(task('club')).toBe('true')
    // 只有一個主要建議
    expect($$('[data-suggestion]')).toHaveLength(1)
  })

  it('打開首頁、重繪、每秒更新都不寫入存檔', async () => {
    const env = await setup()
    const before = env.storage.writes
    for (let i = 0; i < 5; i++) {
      app!.show('lineup')
      app!.show('home')
      otherTabWrote()
      await flush(5)
    }
    expect(env.storage.writes).toBe(before)
  })

  it('長球團名稱、很大的資金與未領取收益都正常顯示', async () => {
    await setup((c) => ({ ...give(give(c, 98_765_432, 1_234_567), 5_432_100, 9_999, 'unclaimed'), clubName: '超長球團名稱測試十二字隊' }))
    expect(text('.v2-title')).toBe('超長球團名稱測試十二字隊')
    expect(text('.v2-growth .v2-stat.funds .v2-stat-value')).toBe((98_765_432).toLocaleString('zh-Hant'))
    expect(text('.v2-rewards .v2-reward.funds')).toContain('5,432,100')
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('claim')
    expect(text('.v2-next-why')).toContain('5,432,100')
  })
})

describe('新手任務', () => {
  it('完整新手流程：觀戰 → 第一場打完 → 領取 → 升級 → 換陣容；每一步自動打勾，最後全部完成', async () => {
    const env = await setup()
    // 觀戰（不用看完）
    await click('[data-action="watch-live"]')
    await flush()
    expect($('.v2-replay-overlay')).not.toBeNull()
    await click('[data-action="replay-back"]')
    expect(task('watch')).toBe('true')
    // 第一場打完：收益還沒領，領取任務沒有完成
    env.clock.set(T0 + 6 * MINUTE)
    await app!.controller.settle('manual')
    await flush()
    expect(task('firstMatch')).toBe('true')
    expect(task('claim')).toBe('false')
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('claim')
    // 建議與任務相同：任務不另外放按鈕
    expect($('[data-task="claim"] [data-action="task-claim"]')).toBeNull()
    expect(text('[data-task="claim"] .v2-task-tag')).toBe(V2T.onboardSuggested)
    await click('[data-action="next-claim"]')
    expect(task('claim')).toBe('true')
    // 累積到可以升級
    env.clock.set(T0 + 2 * HOUR)
    await app!.controller.settle('manual')
    await flush()
    await click('[data-action="next-claim"]')
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('upgrade')
    await click('[data-action="next-upgrade"]')
    expect($('.v2-upgrade-preview')).not.toBeNull()
    await click('.v2-upgrade-btn')
    await flush()
    expect(text('.v2-upgrade-done')).toContain(V2T.upgradeEffective)
    $$('.v2-modal-close').forEach((b) => b.click())
    await flush()
    expect(task('upgrade')).toBe('true')
    // 換陣容（交換棒次）
    const c = load(env)
    const roster = structuredClone(c.roster)
    ;[roster.lineup[0], roster.lineup[1]] = [roster.lineup[1], roster.lineup[0]]
    await updateSettings(tab(env.storage, env.clock, env.locks), { roster })
    otherTabWrote()
    await flush()
    expect($('.v2-onboard.all-done')).not.toBeNull()
    expect(text('.v2-onboard')).toContain(V2T.onboardAllDone)
    expect($$('[data-task]')).toHaveLength(0)
    // 收起之後就不再出現（重新整理也一樣）
    await click('[data-action="toggle-onboarding"]')
    expect($('.v2-onboard')).toBeNull()
    await open(env)
    expect($('.v2-onboard')).toBeNull()
  })

  it('收合後重新整理：維持收合（只剩一行進度），展開後任務還在、進度沒有被重設', async () => {
    const env = await setup()
    await click('[data-action="watch-live"]')
    await click('[data-action="replay-back"]')
    await click('[data-action="toggle-onboarding"]')
    expect($('.v2-onboard.collapsed')).not.toBeNull()
    expect($$('[data-task]')).toHaveLength(0)
    await open(env)
    expect($('.v2-onboard.collapsed')).not.toBeNull()
    expect($('[data-onboarding]')!.dataset.onboarding).toBe('2/6')
    await click('[data-action="toggle-onboarding"]')
    expect(task('watch')).toBe('true')
    expect(load(env).onboarding).toMatchObject({ watchedLive: true, collapsed: false })
  })

  it('只儲存一模一樣的陣容不算完成；任務不阻擋其他功能（還沒完成也能挑戰聯盟）', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    const env = await setup((c) => ({ ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle, nextMatchIndex: n } }))
    await updateSettings(tab(env.storage, env.clock, env.locks), { roster: structuredClone(load(env).roster) })
    otherTabWrote()
    await flush()
    expect(task('lineup')).toBe('false')
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('challenge')
    expect($<HTMLButtonElement>('[data-action="challenge"]')!.disabled).toBe(false)
  })
})

describe('目前建議', () => {
  it('前往聯盟挑戰：只把焦點帶到挑戰按鈕，不替玩家挑戰；挑戰進行中按鈕停用', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    const env = await setup((c) => ({ ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle, nextMatchIndex: n } }))
    const seq = load(env).league.nextChallengeSeq
    expect(text('.v2-league')).toContain(V2T.leagueReady)
    await click('[data-action="next-challenge"]')
    expect(document.activeElement?.getAttribute('data-action')).toBe('challenge')
    expect(load(env).league.nextChallengeSeq).toBe(seq)
    // 挑戰進行中
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    expect(app!.controller.state.challenging).toBe(true)
    expect(text('[data-action="challenge"]')).toBe(V2T.challenging)
    expect($<HTMLButtonElement>('[data-action="next-challenge"]')!.disabled).toBe(true)
    await flush()
    expect(load(env).league.nextChallengeSeq).toBe(seq + 1)
  })

  it('唯讀分頁：不建議需要寫入的操作，任務的收合按鈕停用', async () => {
    const env = await setup((c) => give(give(c, 100_000, 5_000), 10, 10, 'unclaimed'), false)
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('claim')
    env.storage.setItem(WRITER_KEY, 'tab-b')
    otherTabWrote(WRITER_KEY)
    await flush()
    expect($('[data-suggestion]')!.dataset.suggestion).toBe('watch')
    expect($<HTMLButtonElement>('[data-action="toggle-onboarding"]')!.disabled).toBe(true)
  })
})

describe('聯盟目標', () => {
  it('還差什麼：場數還差幾場、勝率目前多少與門檻、冷卻還要幾場', async () => {
    await setup((c) => ({ ...c, league: { ...c.league, matches: 18, wins: 11, losses: 7, recent: 'WWWWWWWWWWWLLLLLLL', challengeReadyAt: 0 }, idle: { ...c.idle, nextMatchIndex: 18 } }))
    const need = PROMOTION_CONFIG.minMatches
    expect(text('[data-need="matches"]')).toContain(V2T.leagueMatchesLine(18, need))
    expect(text('[data-need="matches"]')).toContain(`還差 ${need - 18} 場`)
    expect(text('[data-need="rate"]')).toContain(V2T.leagueRateLine(11 / 18, 18, PROMOTION_CONFIG.winRate, PROMOTION_CONFIG.window))
    expect(text('.v2-league')).toContain(V2T.leagueLongTerm)
    expect($('[data-action="challenge"]')).toBeNull()
  })

  it('冷卻中：說明再完成幾場', async () => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    await setup((c) => ({ ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window), challengeReadyAt: n + 4 }, idle: { ...c.idle, nextMatchIndex: n } }))
    expect(text('[data-need="cooldown"]')).toContain(V2T.leagueCooldownLine(4))
    expect($('[data-action="challenge"]')).toBeNull()
  })
})

describe('升級預覽', () => {
  it('數字來自 progression：只列有提升的能力與變化量；升級後顯示成功與生效場次', async () => {
    const env = await setup((c) => give(c, 100_000, 5_000))
    const id = load(env).roster.lineup[0].playerId
    const { openPlayerDetail } = await import('./playerView')
    openPlayerDetail(app!.controller, id)
    await flush()
    const r = recordOf(load(env), id)!
    const now = leveled(r.player, 1)
    const next = leveled(r.player, 2)
    const gains = Object.keys(now.ratings).filter((k) => (next.ratings as never)[k] > (now.ratings as never)[k])
    expect($$('[data-gain]').map((li) => li.dataset.gain).sort()).toEqual(gains.sort())
    for (const k of gains) {
      const from = (now.ratings as unknown as Record<string, number>)[k]
      const to = (next.ratings as unknown as Record<string, number>)[k]
      expect(text(`[data-gain="${k}"]`)).toContain(`${from.toFixed(2)} → ${to.toFixed(2)}`)
    }
    expect(text('.v2-preview-levels')).toBe(V2T.upgradeLevels(1, 2))
    expect(text('.v2-upgrade-preview')).toContain(V2T.upgradeEffective)
    await click('.v2-upgrade-btn')
    await flush()
    const saved = load(env)
    expect(recordOf(saved, id)!.level).toBe(2)
    expect(text('.v2-upgrade-done')).toContain(V2T.upgradeDone(r.player.name, 2))
    expect(text('.v2-upgrade-done')).toContain(V2T.upgradeEffectiveFrom(saved.idle.nextMatchIndex + 2))
    // 進行中那一場已經固定（用升級前的能力），新能力從下一場開始
    expect(saved.liveMatch?.matchIndex).toBe(saved.idle.nextMatchIndex)
    expect(saved.strategy.effectiveFromMatch).toBe(0)
  })
})
