// @vitest-environment happy-dom
// Phase 6D：網站只有 V2。入口（/、舊網址 /#v2、重新整理、不重複初始化）、沒有任何 V1 入口、
// V1 舊資料不被讀取也不被清除、從入口走一遍 V2 主要流程
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage, type KeyValueStorage, type LockManagerLike } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, tab } from '../testkit'
import type { V2App } from './app'
import { LEGACY_V2_HASH, cleanLegacyHash, startV2 } from './entry'
import { V2T } from './strings'
import { WRITER_KEY } from './writerGuard'

const apps: V2App[] = []
afterEach(() => {
  apps.splice(0).forEach((a) => a.close())
  document.body.replaceChildren()
})

const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''

/** 假的網址與瀏覽紀錄：記下 replaceState 的呼叫 */
function fakeUrl(hash: string) {
  const calls: string[] = []
  const location = { hash, pathname: '/baseball/', search: '?ref=1' }
  const history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
      calls.push(String(url))
      location.hash = ''
    },
  }
  return { location, history, calls }
}

interface Env {
  storage: KeyValueStorage
  clock: ManualClock
  locks: LockManagerLike
}
const newEnv = (storage: KeyValueStorage = new MemoryStorage()): Env => ({ storage, clock: new ManualClock(), locks: new FakeLockManager() })

function start(env: Env, hash = '', root = document.createElement('div')) {
  if (!root.isConnected) document.body.append(root)
  const url = fakeUrl(hash)
  const app = startV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: `t-${apps.length}`, location: url.location, history: url.history })
  if (!apps.includes(app)) apps.push(app)
  return { app, root, url }
}

async function createClub(name = '入口測試隊') {
  const input = $<HTMLInputElement>('#v2-club-name')!
  input.value = name
  $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  $<HTMLButtonElement>('.v2-modal-close')?.click()
  await flush()
}

/** V1 的遊玩入口與文字：首頁模式選擇、錦標賽、自由練習（練習賽）、教學、球團史 */
function expectNoV1(): void {
  for (const sel of ['.home-screen', '.home-buttons', '.v2-entry', '.v1-label', '.v2-back', '.trophy-btn', '.species-picker', '.home-cards', '.tut-bubble']) expect($(sel)).toBeNull()
  const all = document.body.textContent ?? ''
  for (const word of ['錦標賽', '自由練習', '快速比賽', '球團史', '重看教學', 'V1', '回到首頁']) expect(all).not.toContain(word)
}

describe('網站入口：只有 V2', () => {
  it('開 / 直接進 V2：不需要點任何按鈕，網址不動', async () => {
    const env = newEnv()
    const { url } = start(env)
    await flush()
    expect($('.v2-screen')).not.toBeNull()
    expect($('.v2-create')).not.toBeNull()
    expect(text('.v2-title')).toBe(V2T.modeTitle)
    expect(url.calls).toEqual([])
    expectNoV1()
  })

  it('舊網址 /#v2 也進 V2，並把 #v2 清掉（保留路徑與查詢字串，不重新載入）', async () => {
    const env = newEnv()
    const { url } = start(env, LEGACY_V2_HASH)
    await flush()
    expect($('.v2-screen')).not.toBeNull()
    expect(url.calls).toEqual(['/baseball/?ref=1'])
    expect(url.location.hash).toBe('')
  })

  it('其他 hash 不動', () => {
    const url = fakeUrl('#something')
    expect(cleanLegacyHash(url.location, url.history)).toBe(false)
    expect(url.calls).toEqual([])
  })

  it('同一個 root 重複啟動、hashchange、返回鍵：都不會建立第二個 V2', async () => {
    const env = newEnv()
    const { app, root } = start(env, LEGACY_V2_HASH)
    await flush()
    await createClub()
    const again = start(env, LEGACY_V2_HASH, root)
    expect(again.app).toBe(app)
    window.dispatchEvent(new Event('hashchange'))
    window.dispatchEvent(new Event('popstate'))
    await flush()
    expect(root.querySelectorAll('.v2-screen')).toHaveLength(1)
    expect(root.querySelectorAll('.v2-nav')).toHaveLength(1)
    expect($('.v2-dashboard')).not.toBeNull()
  })

  it('重新整理：同一份存檔再啟動一次，直接回到自己的球團（不會回到 V1，也不會重建）', async () => {
    const env = newEnv()
    const first = start(env)
    await flush()
    await createClub('重新整理隊')
    const saved = env.storage.getItem(CLUB_STORAGE_KEY)
    first.app.close()
    document.body.replaceChildren()
    start(env)
    await flush()
    expect($('.v2-create')).toBeNull()
    expect(text('.v2-title')).toBe('重新整理隊')
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).clubId).toBe(JSON.parse(saved!).clubId)
    expectNoV1()
  })

  it('有球團時也沒有任何 V1 入口；四個分頁都在', async () => {
    start(newEnv())
    await flush()
    await createClub()
    for (const t of ['home', 'lineup', 'tactics', 'reports']) {
      $<HTMLButtonElement>(`[data-tab="${t}"]`)!.click()
      await flush(2)
      expectNoV1()
    }
    expect($$('.v2-nav-btn').map((b) => b.dataset.tab)).toEqual(['home', 'lineup', 'tactics', 'reports'])
  })

  it('入口程式只載入共用樣式與 V2；V1 的畫面模組已經刪除', () => {
    const src = (p: string) => resolve(__dirname, '../..', p)
    const main = readFileSync(src('main.ts'), 'utf8')
    const imports = [...main.matchAll(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
    expect(imports).toEqual(['./ui/shared.css', './v2/ui/entry'])
    for (const f of ['ui/tournamentScreen.ts', 'ui/practice.ts', 'ui/setupScreen.ts', 'ui/gameScreen.ts', 'ui/tutorial.ts', 'ui/clubHistory.ts', 'ui/save.ts', 'ui/progress.ts', 'sim/tournament.ts'])
      expect(existsSync(src(f)), f).toBe(false)
    // V2 仍需要的共用模組都在
    for (const f of ['sim/game.ts', 'sim/rng.ts', 'ui/field.ts', 'ui/pitchCam.ts', 'ui/playAnimation.ts', 'ui/sound.ts', 'v2/application/replayPlayer.ts', 'v2/application/livePlayer.ts'])
      expect(existsSync(src(f)), f).toBe(true)
  })

  it('沒有任何程式（含測試）引用已刪除的 V1 模組或樣式（之後合併其他分支時也會擋下）', () => {
    const SRC = resolve(__dirname, '../..')
    const V1 = ['ui/gameScreen', 'ui/tournamentScreen', 'ui/practice', 'ui/setupScreen', 'ui/decisionPanel', 'ui/tutorial', 'ui/tutorialSteps', 'ui/clubHistory', 'ui/customTeams', 'ui/save', 'ui/progress', 'ui/cards', 'ui/restScreen', 'ui/replaceList', 'ui/growthPanel', 'ui/meter', 'ui/pitchCall', 'ui/gesture', 'ui/synergyResult', 'sim/tournament', 'sim/rest', 'sim/prices', 'sim/growth', 'style.css', 'theme.css', 'team.css', 'match.css', 'decision.css', 'screens.css', 'desktop.css', 'v2/ui/entry.ts#v2EntryButton']
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(d, e.name)) : [resolve(d, e.name)]))
    const offenders: string[] = []
    for (const file of walk(SRC).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(file, 'utf8')
      for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        const target = relative(SRC, resolve(dirname(file), m[1])).replace(/\.ts$/, '').replace(/\\/g, '/')
        if (V1.includes(target)) offenders.push(`${relative(SRC, file)} → ${m[1]}`)
      }
      if (/v2EntryButton|v1Label|showTitle\(|openTournament|showPractice/.test(code) && !file.endsWith('entry.dom.test.ts')) offenders.push(`${relative(SRC, file)}：V1 入口`)
    }
    expect(offenders).toEqual([])
  })
})

describe('V1 舊資料：不讀、不清、不覆蓋 V2', () => {
  const V1_DATA: Record<string, string> = {
    'dice-baseball.tournament.v2': '{"round":"qf","setup":{"team":{"name":"V1 舊隊"}}}',
    'dice-baseball.tournament.v1': '{"old":true}',
    'dice-baseball.progress': '{"trophies":[1,2],"cleared":3,"legends":[],"runs":[]}',
    'dice-baseball.customTeams': '[{"name":"自訂隊"}]',
    'dice-baseball.tutorial.home': '1',
    'dice-baseball.teamName': 'V1 隊名',
  }

  function withV1(storage: KeyValueStorage = new MemoryStorage()) {
    for (const [k, v] of Object.entries(V1_DATA)) storage.setItem(k, v)
    return storage
  }
  const v1Untouched = (storage: KeyValueStorage) => {
    for (const [k, v] of Object.entries(V1_DATA)) expect(storage.getItem(k), k).toBe(v)
  }

  it('只有 V1 舊資料：不會自動建立 V2 球團，舊資料原樣保留；建立球團後也不動', async () => {
    const env = newEnv(withV1())
    start(env)
    await flush()
    expect($('.v2-create')).not.toBeNull()
    expect(env.storage.getItem(CLUB_STORAGE_KEY)).toBeNull()
    v1Untouched(env.storage)
    await createClub('新球團')
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).clubName).toBe('新球團')
    v1Untouched(env.storage)
    expect(document.body.textContent).not.toContain('V1 舊隊')
  })

  it('V1 與 V2 資料同時存在：載入的是原本的 V2 球團，存檔內容不變', async () => {
    const env = newEnv()
    start(env)
    await flush()
    await createClub('原本的球團')
    apps.splice(0).forEach((a) => a.close())
    document.body.replaceChildren()
    const before = env.storage.getItem(CLUB_STORAGE_KEY)
    withV1(env.storage)
    start(env)
    await flush()
    expect(text('.v2-title')).toBe('原本的球團')
    expect(env.storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    v1Untouched(env.storage)
  })
})

describe('從入口走一遍 V2 主要流程', () => {
  it('建立 → 重新整理 → 自動結算 → 領取 → 升級 → 招募 → 陣容 → 戰術 → 戰報與 Box Score → 新手任務', async () => {
    const env = newEnv()
    const first = start(env)
    await flush()
    await createClub('流程隊')
    expect($('[data-onboarding]')).not.toBeNull()
    first.app.close()
    document.body.replaceChildren()
    const { app } = start(env)
    await flush()
    expect(text('.v2-title')).toBe('流程隊')

    // 5 分鐘一場：20 分鐘後結算 4 場
    env.clock.advance(20 * 60 * 1000)
    await app.controller.settle('manual')
    await flush()
    let saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.idle.nextMatchIndex).toBe(4)
    const earned = saved.economy.unclaimed
    expect(earned.funds).toBeGreaterThan(0)

    $<HTMLButtonElement>('.v2-claim')!.click()
    $<HTMLButtonElement>('.v2-claim')?.click()
    await flush()
    saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    expect(saved.economy.assets).toEqual(earned)

    // 資源加多一點（同時算進收入，帳才對得起來）再升級與招募
    const deps = tab(env.storage, env.clock, env.locks)
    const club = deps.store.loadClub()!
    const rich = { funds: 100_000, experience: 10_000 }
    deps.store.saveClub({ ...club, economy: { ...club.economy, assets: rich, earned: { funds: club.economy.earned.funds + rich.funds - earned.funds, experience: club.economy.earned.experience + rich.experience - earned.experience } } }, club.revision)
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()

    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    $$('.v2-develop')[0].click()
    $<HTMLButtonElement>('.v2-upgrade-btn')!.click()
    await flush()
    expect(text('.v2-detail-name .v2-level')).toBe('Lv.2')
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()

    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    $<HTMLButtonElement>('[data-action="recruit"]')!.click()
    $<HTMLButtonElement>('.v2-recruit [data-role="batter"]')!.click()
    $$('.v2-cand')[0].click()
    $<HTMLButtonElement>('[data-action="recruit-confirm"]')!.click()
    await flush()
    expect($('.v2-recruit-card')).not.toBeNull()
    $<HTMLButtonElement>('[data-action="go-lineup"]')!.click()
    await flush()
    saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.players).toHaveLength(15)

    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    $$('.v2-player')[0].click()
    $$('.v2-player')[9].click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    const benchFirst = saved.roster.bench[0]
    saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.roster.lineup[0].playerId).toBe(benchFirst)

    const tacticsBefore = JSON.stringify(saved.strategy.coach)
    $<HTMLButtonElement>('[data-tab="tactics"]')!.click()
    $$('.v2-seg-btn')[2].click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(JSON.stringify(saved.strategy.coach)).not.toBe(tacticsBefore)

    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    expect($$('.v2-match')).toHaveLength(4)
    $$('.v2-match')[0].click()
    expect($('.v2-linescore')).not.toBeNull()
    expect($$('.v2-box li').length).toBeGreaterThan(9)
    $<HTMLButtonElement>('.v2-modal-close')!.click()

    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    await flush()
    const progress = $('[data-onboarding]')!.dataset.onboarding!
    expect(Number(progress.split('/')[0])).toBeGreaterThan(1)
    expectNoV1()
  })
})

/** 記錄 addEventListener／removeEventListener：看關閉後還剩多少監聽器 */
function eventTracker() {
  const live = new Map<string, Set<unknown>>()
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener(type: string, l: unknown) {
      if (!live.has(type)) live.set(type, new Set())
      live.get(type)!.add(l)
    },
    removeEventListener(type: string, l: unknown) {
      live.get(type)?.delete(l)
    },
    dispatch(type: string, e: unknown) {
      for (const l of [...(live.get(type) ?? [])]) (l as (e: unknown) => void)(e)
    },
    count: () => [...live.values()].reduce((n, set) => n + set.size, 0),
    types: () => [...live].filter(([, set]) => set.size).map(([t]) => t),
  }
}

/** 記錄同時持有的鎖：關閉後不應該還有鎖沒放 */
class CountingLocks implements LockManagerLike {
  private readonly inner = new FakeLockManager()
  active = 0
  acquired = 0
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    return this.inner.request(name, options, async () => {
      this.active++
      this.acquired++
      try {
        return await callback()
      } finally {
        this.active--
      }
    })
  }
}

describe('入口的生命週期：close 後可以重新啟動', () => {
  function startWith(env: Env, root: HTMLElement, extra: { events?: ReturnType<typeof eventTracker>; tickMs?: number; noLocks?: boolean; tabId?: string } = {}) {
    const url = fakeUrl('')
    const deps = extra.noLocks ? tab(env.storage, env.clock) : tab(env.storage, env.clock, env.locks)
    const app = startV2(root, {
      deps,
      tickMs: extra.tickMs ?? 0,
      tabId: extra.tabId ?? `life-${Math.random()}`,
      location: url.location,
      history: url.history,
      events: extra.events as never,
      doc: extra.events as never,
    })
    if (!apps.includes(app)) apps.push(app)
    return app
  }
  const newRoot = () => {
    const root = document.createElement('div')
    document.body.append(root)
    return root
  }

  it('同一個 root 重複啟動：回傳同一個 App，只有一份畫面與一組監聽器', async () => {
    const env = newEnv()
    const root = newRoot()
    const events = eventTracker()
    const a = startWith(env, root, { events })
    const listeners = events.count()
    const b = startWith(env, root, { events })
    await flush()
    expect(b).toBe(a)
    expect(root.querySelectorAll('.v2-screen')).toHaveLength(1)
    expect(events.count()).toBe(listeners)
  })

  it('close() 之後用同一個 root 重新啟動：建立新的 App，畫面只有一份', async () => {
    const env = newEnv()
    const root = newRoot()
    const first = startWith(env, root)
    await flush()
    await createClub('重啟隊')
    first.close()
    expect(first.closed).toBe(true)
    const second = startWith(env, root)
    await flush()
    expect(second).not.toBe(first)
    expect(second.closed).toBe(false)
    expect(root.querySelectorAll('.v2-screen')).toHaveLength(1)
    expect(text('.v2-title')).toBe('重啟隊')
    // 再呼叫一次拿到的是新的，不是已關閉的
    expect(startWith(env, root)).toBe(second)
  })

  it('重新啟動後的 Controller 可以正常結算、領取、切換分頁', async () => {
    const env = newEnv()
    const root = newRoot()
    const first = startWith(env, root)
    await flush()
    await createClub()
    first.close()
    const second = startWith(env, root)
    await flush()
    env.clock.advance(15 * 60 * 1000)
    await second.controller.settle('manual')
    await flush()
    let saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.idle.nextMatchIndex).toBe(3)
    const res = await second.controller.claim()
    expect(res.ok).toBe(true)
    await flush()
    saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    expect(saved.economy.assets.funds).toBeGreaterThan(0)
    second.show('reports')
    expect($$('.v2-match')).toHaveLength(3)
  })

  it('重複 close() 不會出錯；關閉後的 App 不再更新畫面', async () => {
    const env = newEnv()
    const root = newRoot()
    const app = startWith(env, root)
    await flush()
    await createClub()
    app.close()
    expect(() => app.close()).not.toThrow()
    expect(app.closed).toBe(true)
    env.clock.advance(10 * 60 * 1000)
    await app.controller.settle('manual')
    await flush()
    // 關閉後不結算、不寫入
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).idle.nextMatchIndex).toBe(0)
  })

  it('舊 App 晚一點才關閉（或再關一次），不會清掉新 App 的快取', async () => {
    const env = newEnv()
    const root = newRoot()
    const old = startWith(env, root)
    await flush()
    old.close()
    const fresh = startWith(env, root)
    await flush()
    old.close()
    expect(startWith(env, root)).toBe(fresh)
    expect(fresh.closed).toBe(false)
    expect(root.querySelectorAll('.v2-screen')).toHaveLength(1)
  })

  it('不同 root 各自獨立：關掉一個不影響另一個', async () => {
    const env = newEnv()
    const r1 = newRoot()
    const r2 = newRoot()
    const a = startWith(env, r1)
    const b = startWith(env, r2)
    expect(a).not.toBe(b)
    a.close()
    expect(startWith(env, r2)).toBe(b)
    expect(b.closed).toBe(false)
  })

  it('關閉後沒有留下監聽器（visibilitychange、focus、storage）與計時器', async () => {
    const env = newEnv()
    const root = newRoot()
    const events = eventTracker()
    const created: unknown[] = []
    const cleared = new Set<unknown>()
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = { fn, ms }
      created.push(id)
      return id as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: unknown) => {
      cleared.add(id)
    }) as typeof clearInterval)
    try {
      const app = startWith(env, root, { events, tickMs: 1000 })
      await flush()
      expect(events.types().sort()).toEqual(['focus', 'storage', 'visibilitychange'])
      expect(created).toHaveLength(1)
      app.close()
      expect(events.count()).toBe(0)
      expect(created.every((id) => cleared.has(id))).toBe(true)
      // 重新啟動：又是剛好一組
      const again = startWith(env, root, { events, tickMs: 1000 })
      await flush()
      expect(created).toHaveLength(2)
      expect(events.types().sort()).toEqual(['focus', 'storage', 'visibilitychange'])
      again.close()
      expect(events.count()).toBe(0)
      expect(created.every((id) => cleared.has(id))).toBe(true)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  it('關閉時中斷結算並放掉多分頁鎖：新的 App 可以馬上拿到鎖寫入', async () => {
    const locks = new CountingLocks()
    const env: Env = { storage: new MemoryStorage(), clock: new ManualClock(), locks }
    const root = newRoot()
    const first = startWith(env, root)
    await flush()
    await createClub()
    env.clock.advance(8 * 60 * 60 * 1000)
    const settling = first.controller.settle('manual')
    first.close()
    await settling
    await flush()
    expect(locks.active).toBe(0)
    const second = startWith(env, root)
    await flush()
    // 新的 App 啟動時已經結算到最新；再領取一次確認拿得到鎖、寫得進去
    const before = locks.acquired
    expect((await second.controller.claim()).ok).toBe(true)
    await flush()
    expect(locks.acquired).toBeGreaterThan(before)
    expect(locks.active).toBe(0)
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    // 已經打完的場次照樣存檔，沒有重複：96 場（8 小時上限）
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).idle.nextMatchIndex).toBe(96)
  })

  it('沒有 Web Locks（單一可寫分頁）：關閉時放掉自己的可寫標記，重新啟動的 App 可以寫入', async () => {
    const env = newEnv()
    const root = newRoot()
    const first = startWith(env, root, { noLocks: true, tabId: 'tab-old' })
    await flush()
    expect(env.storage.getItem(WRITER_KEY)).toBe('tab-old')
    first.close()
    expect(env.storage.getItem(WRITER_KEY)).toBeNull()
    const second = startWith(env, root, { noLocks: true, tabId: 'tab-new' })
    await flush()
    expect(env.storage.getItem(WRITER_KEY)).toBe('tab-new')
    await createClub('單分頁隊')
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).clubName).toBe('單分頁隊')
    // 舊 App 再關一次：別人的標記不動
    first.close()
    expect(env.storage.getItem(WRITER_KEY)).toBe('tab-new')
    second.close()
  })
})
