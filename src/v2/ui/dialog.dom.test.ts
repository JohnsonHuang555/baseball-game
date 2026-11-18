// @vitest-environment happy-dom
// 對話框的焦點與鍵盤（Code review P2）：Tab／Shift+Tab 限制在最上層對話框內、Escape 關閉最上層、
// 關閉後焦點還原（原本的元素不在了就移到合理的替代元素）、多層對話框用任何順序關閉，快捷鍵都不會錯亂。
// 也實際走一遍球員養成（含釋出的第二次確認）與晉級挑戰結果 → 觀戰 → 回到結果
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setKeys } from '../../ui/keys'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { recruit } from '../application/economyService'
import { planChallenge } from '../application/leagueService'
import { runMatch } from '../application/matchRunner'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import type { ClubSave } from '../domain/club'
import { openV2, type V2App } from './app'
import { announceModal, openDialogCount, v2Modal } from './dialog'
import type { ReplayStage } from './replayView'
import { V2T } from './strings'

let app: V2App | null = null
afterEach(() => {
  // 測試失敗時也把對話框關乾淨，不影響下一個測試
  for (let i = 0; i < 5 && openDialogCount(); i++) press('Escape')
  app?.close()
  app = null
  setKeys({})
  document.body.replaceChildren()
})

const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const active = () => document.activeElement as HTMLElement | null
const label = (x: Element | null) => (x as HTMLElement | null)?.dataset.t ?? x?.getAttribute('aria-label') ?? x?.textContent ?? ''

function press(key: string, shift = false): void {
  const target = document.activeElement ?? document.body
  target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))
}

function button(t: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = t
  b.dataset.t = t
  return b
}

/** 畫面上的按鈕（打開對話框的元素） */
function opener(t = 'opener'): HTMLButtonElement {
  const b = button(t)
  document.body.append(b)
  b.focus()
  return b
}

/** 對話框內容：兩顆按鈕＋一顆停用的（不應該被 Tab 走到） */
function body(prefix: string): HTMLElement {
  const box = document.createElement('div')
  const off = button(`${prefix}-off`)
  off.disabled = true
  box.append(button(`${prefix}-1`), off, button(`${prefix}-2`))
  return box
}

describe('v2Modal 的焦點', () => {
  it('打開時焦點在 ✕；Tab 依序走過可以按的元素，從最後一個回到第一個（停用的跳過）', () => {
    opener()
    v2Modal('標題', body('a'))
    expect(label(active())).toBe(V2T.close)
    const seen: string[] = []
    for (let i = 0; i < 4; i++) {
      press('Tab')
      seen.push(label(active()))
    }
    // ✕ → a-1 → a-2 → 底部「關閉」→ 回到 ✕
    expect(seen).toEqual(['a-1', 'a-2', V2T.close, V2T.close])
    expect(active()!.classList.contains('v2-modal-x')).toBe(true)
  })

  it('Shift+Tab 反向：從第一個跳到最後一個', () => {
    opener()
    v2Modal('標題', body('a'))
    press('Tab', true)
    expect(active()!.classList.contains('v2-modal-bottom')).toBe(true)
    press('Tab', true)
    expect(label(active())).toBe('a-2')
    press('Tab', true)
    press('Tab', true)
    expect(active()!.classList.contains('v2-modal-x')).toBe(true)
  })

  it('焦點跑到對話框外面時，Tab 把它拉回對話框', () => {
    const outside = opener('outside')
    v2Modal('標題', body('a'))
    outside.focus()
    press('Tab')
    expect(active()!.classList.contains('v2-modal-x')).toBe(true)
  })

  it('Escape 關閉並呼叫 onClose 一次；焦點回到打開它的按鈕', () => {
    const o = opener()
    const onClose = vi.fn()
    v2Modal('標題', body('a'), onClose)
    press('Escape')
    expect($('.v2-modal')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(active()).toBe(o)
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('遮罩、✕、底部關閉都還能關，而且焦點一樣還原', () => {
    for (const how of ['overlay', 'x', 'bottom'] as const) {
      const o = opener(how)
      const onClose = vi.fn()
      v2Modal('標題', body('a'), onClose)
      if (how === 'overlay') $('.v2-modal-overlay')!.click()
      else $<HTMLButtonElement>(how === 'x' ? '.v2-modal-x' : '.v2-modal-bottom')!.click()
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(openDialogCount()).toBe(0)
      expect(active()).toBe(o)
      o.remove()
    }
  })

  it('打開它的元素已經不在了：焦點移到目前的導覽分頁', () => {
    const nav = document.createElement('nav')
    const tabBtn = button('球團')
    tabBtn.className = 'v2-nav-btn'
    tabBtn.setAttribute('aria-current', 'page')
    nav.append(tabBtn)
    document.body.append(nav)
    const o = opener()
    v2Modal('標題', body('a'))
    o.remove()
    press('Escape')
    expect(active()).toBe(tabBtn)
  })

  it('onEscape 回傳 true 時，Escape 只交給它處理，對話框不關', () => {
    let n = 0
    v2Modal('標題', body('a'), undefined, { onEscape: () => ++n === 1 })
    press('Escape')
    expect($('.v2-modal')).not.toBeNull()
    press('Escape')
    expect($('.v2-modal')).toBeNull()
  })
})

describe('兩層對話框', () => {
  it('焦點限制在上層；Escape 先關上層、焦點回到上層的開啟按鈕，再關下層、回到最初的元素', () => {
    const o = opener()
    const lower = body('a')
    v2Modal('下層', lower)
    const openUpper = lower.querySelector<HTMLButtonElement>('[data-t="a-1"]')!
    openUpper.focus()
    v2Modal('上層', body('b'))
    expect(openDialogCount()).toBe(2)
    const seen = new Set<string>()
    for (let i = 0; i < 8; i++) {
      press('Tab')
      seen.add(label(active()))
    }
    // 只在上層裡循環：不會走到下層的 a-1、a-2
    expect([...seen].sort()).toEqual(['b-1', 'b-2', V2T.close].sort())
    press('Escape')
    expect(openDialogCount()).toBe(1)
    expect(active()).toBe(openUpper)
    press('Escape')
    expect(openDialogCount()).toBe(0)
    expect(active()).toBe(o)
  })

  it('程式先關掉下層：上層照常運作；全部關閉後畫面的快捷鍵恢復，中途不會被觸發', () => {
    const hits: string[] = []
    setKeys({ x: () => hits.push('x') })
    const o = opener()
    const closeLower = v2Modal('下層', body('a'))
    v2Modal('上層', body('b'))
    press('x')
    expect(hits).toEqual([])
    closeLower()
    expect(openDialogCount()).toBe(1)
    // 焦點留在上層
    expect($('.v2-modal')!.contains(active())).toBe(true)
    press('x')
    expect(hits).toEqual([])
    press('Escape')
    expect(openDialogCount()).toBe(0)
    expect(active()).toBe(o)
    o.blur()
    press('x')
    expect(hits).toEqual(['x'])
  })

  it('公告型對話框疊在一般對話框上：Tab 只在公告的按鈕之間；Escape 依序關閉', () => {
    opener()
    v2Modal('下層', body('a'))
    const onClose = vi.fn()
    announceModal({ icon: 'clock', title: '公告', primary: { label: '主要', closes: true }, secondary: { label: '次要' }, onClose })
    expect(label(active())).toBe('主要')
    press('Tab')
    expect(label(active())).toBe('次要')
    press('Tab')
    expect(label(active())).toBe('主要')
    press('Tab', true)
    expect(label(active())).toBe('次要')
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect($('.v2-announce')).toBeNull()
    expect($('.v2-modal')!.contains(active())).toBe(true)
  })

  it('上面又蓋了別的全畫面圖層（觀戰）：對話框不搶 Tab 與 Escape', () => {
    opener()
    const onClose = vi.fn()
    v2Modal('下層', body('a'), onClose)
    const viewer = document.createElement('div')
    viewer.setAttribute('aria-modal', 'true')
    const inViewer = button('viewer')
    viewer.append(inViewer)
    document.body.append(viewer)
    inViewer.focus()
    press('Tab')
    expect(active()).toBe(inViewer)
    press('Escape')
    expect(onClose).not.toHaveBeenCalled()
    viewer.remove()
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ---- 實際畫面 ----

const otherTabWrote = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))

function fakeStage(): () => ReplayStage {
  return () => {
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
}

async function mount(clubSeed: number, edit?: (c: ClubSave) => ClubSave) {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const locks = new FakeLockManager()
  const deps = tab(storage, clock, locks)
  await createClubSafely(deps, { clubName: '焦點測試隊', clubSeed, clubId: 'club-focus' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'focus-tab', replayStage: fakeStage(), replayTimeScale: 0 })
  await flush()
  // 新球團可能有歡迎對話框之類的：全部關掉
  for (let i = 0; i < 3 && openDialogCount(); i++) press('Escape')
  await flush()
  return { storage, deps }
}

describe('球員養成與釋出確認', () => {
  it('打開養成：焦點在 ✕、Tab 不離開面板；Escape 關閉後回到「養成」按鈕', async () => {
    await mount(8)
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    const develop = $$('.v2-develop')[0] as HTMLButtonElement
    develop.focus()
    develop.click()
    const sheet = $('.v2-player-sheet')!
    expect(active()!.classList.contains('v2-modal-x')).toBe(true)
    for (let i = 0; i < 12; i++) {
      press('Tab')
      expect(sheet.contains(active())).toBe(true)
    }
    press('Escape')
    expect($('.v2-player-sheet')).toBeNull()
    expect(active()).toBe(develop)
  })

  it('釋出的第二次確認：焦點只在確認框；Escape 只取消確認、回到「釋出球員」；確定釋出後焦點落在導覽分頁', async () => {
    const { deps, storage } = await mount(8, (c) => ({ ...c, economy: { ...c.economy, assets: { funds: 1e6, experience: 0 }, earned: { funds: 1e6, experience: 0 } } }))
    const { op } = await recruit(deps, { opSeq: deps.store.loadClub()!.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: deps.store.loadClub()!.recruitment.count })
    otherTabWrote()
    await flush()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    const develop = $<HTMLButtonElement>(`.v2-reserves .v2-develop[data-player="${op.playerId}"]`)!
    develop.focus()
    develop.click()
    $<HTMLButtonElement>('[data-action="release"]')!.click()
    await flush(2)
    const confirm = $('.v2-release-confirm')!
    expect(active()!.classList.contains('v2-release-no')).toBe(true)
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      press('Tab')
      expect(confirm.contains(active())).toBe(true)
      seen.add(active()!.className)
    }
    expect(seen.size).toBe(2)
    press('Escape')
    expect($('.v2-release-confirm')).toBeNull()
    expect($('.v2-player-sheet')).not.toBeNull()
    expect(active()!.dataset.action).toBe('release')
    // 再確認一次，真的釋出：面板關閉，原本的「養成」按鈕已經隨著球員消失，焦點移到導覽的「陣容」
    $<HTMLButtonElement>('[data-action="release"]')!.click()
    $<HTMLButtonElement>('[data-action="release-confirm"]')!.click()
    await flush()
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).players).toHaveLength(14)
    expect($('.v2-player-sheet')).toBeNull()
    expect(develop.isConnected).toBe(false)
    expect(active()!.dataset.tab).toBe('lineup')
  })
})

describe('聯盟挑戰結果與觀戰切換', () => {
  const eligible = (c: ClubSave): ClubSave => {
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    return { ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle, nextMatchIndex: n } }
  }
  async function seedFor(want: boolean): Promise<number> {
    for (let seed = 1; seed < 200; seed++) {
      const d = tab(new MemoryStorage(), new ManualClock(), new FakeLockManager())
      await createClubSafely(d, { clubName: '焦點測試隊', clubSeed: seed, clubId: 'club-focus' })
      const plan = planChallenge(eligible(d.store.loadClub()!))
      if ((runMatch(plan.setup, plan.ai).winner === plan.userSide) === want) return seed
    }
    throw new Error('no seed')
  }
  async function untilOverlay(): Promise<void> {
    for (let i = 0; i < 100 && !$('.v2-replay-overlay'); i++) await flush(5)
  }

  it('結果對話框 → 觀看挑戰過程：觀戰畫面在上層時 Escape 交給觀戰；返回後結果對話框還在、焦點回到它；Escape 才關閉結果', async () => {
    await mount(await seedFor(true), eligible)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    // 先問要不要看：選「直接看結果」
    expect($('.v2-challenge-start')).not.toBeNull()
    $<HTMLButtonElement>('.v2-announce .btn-white')!.click()
    await flush()
    expect($('.v2-challenge-verdict')!.textContent).toBe(V2T.challengeWin)
    expect(openDialogCount()).toBe(1)
    // 結果對話框：Tab 在「繼續」與「觀看挑戰過程」之間
    expect(active()!.textContent).toBe(V2T.challengeContinue)
    press('Tab')
    expect(active()!.dataset.action).toBe('watch-challenge')
    press('Tab')
    expect(active()!.textContent).toBe(V2T.challengeContinue)

    $<HTMLButtonElement>('.v2-challenge-modal [data-action="watch-challenge"]')!.click()
    await untilOverlay()
    expect($('.v2-replay-overlay')).not.toBeNull()
    // 觀戰在最上層：Escape 由觀戰畫面處理（關閉觀戰），結果對話框還在
    press('Escape')
    await flush()
    expect($('.v2-replay-overlay')).toBeNull()
    expect($$('.v2-challenge-result')).toHaveLength(1)
    expect($('.v2-challenge-modal')!.contains(active())).toBe(true)
    press('Escape')
    await flush()
    expect($('.v2-challenge-result')).toBeNull()
    expect(openDialogCount()).toBe(0)
  })

  it('選「觀看比賽」：提問關閉、觀戰打開；看完結果才出現，焦點在結果的主要按鈕', async () => {
    await mount(await seedFor(false), eligible)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-challenge-start')!.closest('.v2-announce')!.querySelector<HTMLButtonElement>('[data-action="watch-challenge"]')!.click()
    await untilOverlay()
    expect(openDialogCount()).toBe(0)
    $<HTMLButtonElement>('[data-action="replay-skip"]')!.click()
    await flush()
    $<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush()
    expect($('.v2-challenge-verdict')!.textContent).toBe(V2T.challengeLose)
    expect(active()!.textContent).toBe(V2T.gotIt)
  })
})
