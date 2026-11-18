// @vitest-environment happy-dom
// App 關閉時的對話框清理（Code review P1）：App.close() 必須用正式流程關掉自己開的所有對話框
// （離開堆疊、移除鍵盤監聽、還原快捷鍵、取消訂閱），不能只移除 DOM；也不能動到另一個 App 的對話框。
// 關閉後在同一個 root 重新 startV2()，對話框與鍵盤要能正常運作
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKeys } from '../../ui/keys'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, MINUTE, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import type { ClubController } from './clubController'
import { dialogDebug } from './dialog'
import { startV2 } from './entry'
import type { V2App } from './app'

const apps: V2App[] = []
afterEach(() => {
  for (const a of apps.splice(0)) a.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setKeys({})
  document.body.replaceChildren()
})

const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T & HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const active = () => document.activeElement as HTMLElement | null
const press = (key: string, shift = false) =>
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))
/** 控制器目前的訂閱數（App 本身＋開著的養成、招募面板） */
const listeners = (c: ClubController) => (c as unknown as { listeners: Set<unknown> }).listeners.size

interface Env {
  storage: MemoryStorage
  clock: ManualClock
  locks: FakeLockManager
}

async function makeClub(clubSeed = 11, funds = 50_000): Promise<Env> {
  const env = { storage: new MemoryStorage(), clock: new ManualClock(), locks: new FakeLockManager() }
  const deps = tab(env.storage, env.clock, env.locks)
  await createClubSafely(deps, { clubName: '關閉測試隊', clubSeed, clubId: `club-close-${clubSeed}` })
  const c = deps.store.loadClub()!
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { funds, experience: 5_000 }, earned: { funds, experience: 5_000 } } }, c.revision)
  return env
}

async function start(env: Env, root?: HTMLElement, tickMs = 0): Promise<{ app: V2App; root: HTMLElement }> {
  const r = root ?? document.body.appendChild(document.createElement('div'))
  const app = startV2(r, { deps: tab(env.storage, env.clock, env.locks), tickMs, tabId: `tab-${Math.random()}`, location: undefined, history: undefined })
  apps.push(app)
  await flush()
  // 開啟時可能有歡迎對話框：先關掉（各測試需要時自己打開）
  for (let i = 0; i < 3 && $('.v2-announce', r.ownerDocument); i++) press('Escape')
  await flush(5)
  return { app, root: r }
}

/** 記錄對話框向控制器訂閱後拿到的取消函式，確認關閉時真的有呼叫（dispose 也會清空訂閱，所以要直接看取消函式） */
function trackSubscriptions(c: ClubController): ReturnType<typeof vi.fn>[] {
  const unsubs: ReturnType<typeof vi.fn>[] = []
  const original = c.subscribe.bind(c)
  vi.spyOn(c, 'subscribe').mockImplementation((listener) => {
    const off = vi.fn(original(listener))
    unsubs.push(off)
    return off
  })
  return unsubs
}

function expectClean(app: V2App): void {
  expect(app.closed).toBe(true)
  expect(dialogDebug()).toEqual({ layers: 0, listening: false })
  expect($$('.v2-modal-overlay')).toHaveLength(0)
  expect(listeners(app.controller)).toBe(0)
}

describe('App.close() 正式關閉自己的對話框', () => {
  it('開著招募後立刻 close：對話框、堆疊、鍵盤監聽、訂閱都清掉；之後也不會冒出新的對話框', async () => {
    const { app, root } = await start(await makeClub())
    const base = listeners(app.controller)
    const unsubs = trackSubscriptions(app.controller)
    $<HTMLButtonElement>('[data-action="recruit"]', root)!.click()
    $<HTMLButtonElement>('.v2-recruit-buttons [data-role="batter"]')!.click()
    expect(dialogDebug()).toEqual({ layers: 1, listening: true })
    expect(listeners(app.controller)).toBe(base + 1)
    expect(unsubs).toHaveLength(1)
    app.close()
    expect(unsubs[0]).toHaveBeenCalledTimes(1)
    expectClean(app)
    await flush()
    expect($$('.v2-modal-overlay')).toHaveLength(0)
  })

  it('開著球員養成（含釋出的第二次確認）後立刻 close', async () => {
    const env = await makeClub()
    const deps = tab(env.storage, env.clock, env.locks)
    const { recruit } = await import('../application/economyService')
    const c = deps.store.loadClub()!
    const { op } = await recruit(deps, { opSeq: c.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: c.recruitment.count })
    const { app, root } = await start(env)
    $<HTMLButtonElement>('[data-tab="lineup"]', root)!.click()
    const unsubs = trackSubscriptions(app.controller)
    $<HTMLButtonElement>(`.v2-develop[data-player="${op.playerId}"]`, root)!.click()
    $<HTMLButtonElement>('[data-action="release"]')!.click()
    expect($('.v2-release-confirm')).not.toBeNull()
    const before = env.storage.getItem(CLUB_STORAGE_KEY)
    app.close()
    expect(unsubs).toHaveLength(1)
    expect(unsubs[0]).toHaveBeenCalledTimes(1)
    expectClean(app)
    await flush()
    // 關閉不會順便釋出或改存檔
    expect(env.storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
  })

  it('兩層對話框（歡迎回來＋招募）後 close：兩層都正式關閉；歡迎的 onClose 收到 dispose，不會重畫或改狀態', async () => {
    const env = await makeClub()
    // 離開 30 分鐘：打開時結算比賽並跳出「歡迎回來」
    env.clock.advance(30 * MINUTE)
    const root = document.body.appendChild(document.createElement('div'))
    const app = startV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'two-layers', location: undefined, history: undefined })
    apps.push(app)
    await flush()
    expect($('.v2-welcome-modal')).not.toBeNull()
    const dismiss = vi.spyOn(app.controller, 'dismissWelcome')
    $<HTMLButtonElement>('[data-action="recruit"]', root)!.click()
    expect(dialogDebug().layers).toBe(2)
    const html = root.innerHTML
    app.close()
    expectClean(app)
    expect(dismiss).not.toHaveBeenCalled()
    await flush()
    expect(root.innerHTML).toBe(html)
    expect($$('.v2-announce')).toHaveLength(0)
  })

  it('重複 close() 不會出錯', async () => {
    const { app, root } = await start(await makeClub())
    $<HTMLButtonElement>('[data-action="recruit"]', root)!.click()
    app.close()
    expect(() => app.close()).not.toThrow()
    expect(() => app.close()).not.toThrow()
    expectClean(app)
  })

  it('不影響另一個 App：關掉 A，B 的對話框還在而且鍵盤照常；B 再關掉才全部清空', async () => {
    const a = await start(await makeClub(21))
    const b = await start(await makeClub(22))
    $<HTMLButtonElement>('[data-action="recruit"]', a.root)!.click()
    $<HTMLButtonElement>('[data-action="recruit"]', b.root)!.click()
    expect(dialogDebug().layers).toBe(2)
    a.app.close()
    expect(dialogDebug()).toEqual({ layers: 1, listening: true })
    expect($$('.v2-recruit-modal')).toHaveLength(1)
    expect(listeners(b.app.controller)).toBeGreaterThan(0)
    // B 的對話框：Escape 照常關閉
    press('Escape')
    expect(dialogDebug()).toEqual({ layers: 0, listening: false })
    b.app.close()
    expectClean(b.app)
  })

  it('計時器與鍵盤監聽：close 之後沒有殘留的 interval，capture 的 keydown 監聽有加就有移除', async () => {
    const env = await makeClub()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { app, root } = await start(env, undefined, 1000)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    $<HTMLButtonElement>('[data-action="recruit"]', root)!.click()
    app.close()
    expect(vi.getTimerCount()).toBe(0)
    const keydown = (spy: typeof add) => spy.mock.calls.filter(([type, , opt]) => type === 'keydown' && opt === true).length
    expect(keydown(add)).toBe(1)
    expect(keydown(remove)).toBe(1)
    expectClean(app)
  })
})

describe('close 後在同一個 root 重新 startV2()', () => {
  it('建立新的 App；招募可以正常開關，Tab／Shift+Tab 在對話框內循環、Escape 關閉並還原焦點', async () => {
    const env = await makeClub()
    const first = await start(env)
    $<HTMLButtonElement>('[data-action="recruit"]', first.root)!.click()
    first.app.close()
    expectClean(first.app)

    const second = await start(env, first.root)
    expect(second.app).not.toBe(first.app)
    expect(second.app.closed).toBe(false)
    const open = () => {
      const b = $<HTMLButtonElement>('[data-action="recruit"]', second.root)!
      b.focus()
      b.click()
      return b
    }
    // 開：焦點在 ✕；Tab 往下、Shift+Tab 往回，都不離開招募面板
    const opener = open()
    const modal = $('.v2-recruit-modal')!
    expect(active()!.classList.contains('v2-modal-x')).toBe(true)
    const forward: HTMLElement[] = []
    for (let i = 0; i < 6; i++) {
      press('Tab')
      expect(modal.contains(active())).toBe(true)
      forward.push(active()!)
    }
    press('Tab', true)
    expect(active()).toBe(forward[4])
    // 第一個按 Shift+Tab 會跳到最後一個
    $<HTMLButtonElement>('.v2-modal-x')!.focus()
    press('Tab', true)
    expect(modal.contains(active())).toBe(true)
    expect(active()!.classList.contains('v2-modal-x')).toBe(false)
    // 切到候選名單、選一位，再用 Escape 關閉：焦點回到招募按鈕
    $<HTMLButtonElement>('.v2-recruit-buttons [data-role="batter"]')!.click()
    $<HTMLButtonElement>('.v2-cand')!.click()
    press('Escape')
    expect($('.v2-recruit-modal')).toBeNull()
    expect(active()).toBe(opener)
    expect(dialogDebug()).toEqual({ layers: 0, listening: false })
    // 再開一次，用 ✕ 關閉
    open()
    $<HTMLButtonElement>('.v2-modal-x')!.click()
    expect(dialogDebug()).toEqual({ layers: 0, listening: false })
    // 真的簽約一次：新 App 的招募照常運作
    open()
    $<HTMLButtonElement>('.v2-recruit-buttons [data-role="pitcher"]')!.click()
    $<HTMLButtonElement>('.v2-cand')!.click()
    $<HTMLButtonElement>('[data-action="recruit-confirm"]')!.click()
    await flush()
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).recruitment.count).toBe(1)
    second.app.close()
    expectClean(second.app)
  })
})
