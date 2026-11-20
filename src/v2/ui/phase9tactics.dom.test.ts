// @vitest-environment happy-dom
// Phase 9 PR 2：戰術頁（四張風格卡片、推薦戰術、收合的進階設定、自訂／恢復預設、未儲存提示、多分頁衝突）
// 與戰報的「本場戰術」（新比賽顯示實際執行的結果、舊比賽顯示未記錄）
import { afterEach, describe, expect, it } from 'vitest'
import fixtureV10 from '../domain/__fixtures__/club-v10-phase8.json'
import { updateSettings } from '../application/settlementService'
import { resolveRoster } from '../domain/roster'
import { recommendStyle } from '../domain/tacticsAdvice'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { openV2, type V2App } from './app'
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
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''

function mount(storage = new MemoryStorage(), clock = new ManualClock(), locks = new FakeLockManager()) {
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'test-tab' })
  return { root, storage, clock, locks }
}
async function createClub(name = '戰術測試隊') {
  const input = $<HTMLInputElement>('#v2-club-name')!
  input.value = name
  $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}
const card = (style: string) => $<HTMLButtonElement>(`.v2-style-card[data-style="${style}"]`)!
const saved = (storage: MemoryStorage) => JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
const toTactics = () => $<HTMLButtonElement>('[data-tab="tactics"]')!.click()

describe('戰術頁：四張風格卡片', () => {
  it('四張卡片：名稱、圖示、一句話、適合、優點、缺點；目前的風格標「已選擇」', async () => {
    mount()
    await flush()
    await createClub()
    toTactics()
    const cards = $$('.v2-style-card')
    expect(cards.map((c) => c.dataset.style)).toEqual(['balanced', 'power', 'speed', 'defense'])
    for (const c of cards) {
      const style = c.dataset.style as 'balanced'
      expect(c.querySelector('.v2-style-ico svg')).not.toBeNull()
      expect(c.querySelector('.v2-style-name')!.textContent).toBe(V2T.styleNames[style])
      expect(c.textContent).toContain(V2T.styleOneLine[style])
      expect(c.querySelector('.fit dd')!.textContent).toBe(V2T.styleFit[style])
      expect(c.querySelector('.pro dd')!.textContent).toBe(V2T.stylePros[style])
      expect(c.querySelector('.con dd')!.textContent).toBe(V2T.styleCons[style])
    }
    expect(card('balanced').getAttribute('aria-checked')).toBe('true')
    expect(card('balanced').classList.contains('selected')).toBe(true)
    expect(card('balanced').textContent).toContain(V2T.styleSelected)
    expect($$('.v2-style-card[aria-checked="true"]')).toHaveLength(1)
    expect(text('.v2-savebar-status')).toBe(V2T.tacticsEffective)
  })

  it('選另一張卡片：進階設定換成那個風格的預設；原本的風格標「目前使用」；未儲存提示；儲存後存成那個風格', async () => {
    const { storage } = mount()
    await flush()
    await createClub()
    toTactics()
    card('power').click()
    expect(card('power').getAttribute('aria-checked')).toBe('true')
    expect(card('balanced').textContent).toContain(V2T.styleInUse)
    // 強攻型的預設：保守跑壘、關閉觸擊
    expect($('.v2-seg-btn[data-option="conservative"]')!.getAttribute('aria-checked')).toBe('true')
    expect($('[data-toggle="bunt"]')!.getAttribute('aria-checked')).toBe('false')
    expect(text('.v2-advanced-state')).toBe(V2T.advancedPreset(V2T.styleNames.power))
    expect(text('.v2-savebar-status')).toBe(V2T.unsavedCount(3))
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    expect(saved(storage).strategy.coach).toEqual({ style: 'power', params: { stealMin: 0.85, latePlatoon: true, sacBunt: false } })
    expect(card('power').textContent).toContain(V2T.styleSelected)
    expect(text('.v2-savebar-status')).toBe(V2T.tacticsEffective)
  })

  it('取消修改：回到存檔的風格與參數', async () => {
    mount()
    await flush()
    await createClub()
    toTactics()
    card('speed').click()
    $<HTMLButtonElement>('[data-action="reset-draft"]')!.click()
    expect(card('balanced').getAttribute('aria-checked')).toBe('true')
    expect(text('.v2-savebar-status')).toBe(V2T.tacticsEffective)
  })
})

describe('戰術頁：進階設定', () => {
  it('預設收合；展開後改設定重畫也保持展開', async () => {
    mount()
    await flush()
    await createClub()
    toTactics()
    const details = () => $<HTMLDetailsElement>('.v2-advanced')!
    expect(details().open).toBe(false)
    details().open = true
    details().dispatchEvent(new Event('toggle'))
    $<HTMLButtonElement>('[data-toggle="platoon"]')!.click()
    expect(details().open).toBe(true)
  })

  it('改了進階設定就標「自訂」；恢復預設換回目前風格的預設（不是均衡型）', async () => {
    const { storage } = mount()
    await flush()
    await createClub()
    toTactics()
    card('speed').click()
    expect($<HTMLButtonElement>('[data-action="restore-defaults"]')!.disabled).toBe(true)
    $<HTMLButtonElement>('.v2-seg-btn[data-option="conservative"]')!.click()
    expect(text('.v2-advanced-state')).toBe(V2T.advancedCustom)
    expect($<HTMLButtonElement>('[data-action="restore-defaults"]')!.disabled).toBe(false)
    $<HTMLButtonElement>('[data-action="restore-defaults"]')!.click()
    expect(text('.v2-advanced-state')).toBe(V2T.advancedPreset(V2T.styleNames.speed))
    expect($('.v2-seg-btn[data-option="aggressive"]')!.getAttribute('aria-checked')).toBe('true')
    expect(card('speed').getAttribute('aria-checked')).toBe('true')
    // 存一份自訂的：關掉觸擊
    $<HTMLButtonElement>('[data-toggle="bunt"]')!.click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    expect(saved(storage).strategy.coach).toEqual({ style: 'speed', params: { stealMin: 0.7, latePlatoon: true, sacBunt: false } })
    expect(text('.v2-advanced-state')).toBe(V2T.advancedCustom)
  })

  it('舊存檔的「積極」（0.65）：顯示積極；只改別的設定時原值保留，不會被換成 0.70', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    mount(storage, clock, locks)
    await flush()
    await createClub()
    await updateSettings(tab(storage, clock, locks), { coach: { style: 'balanced', params: { stealMin: 0.65, latePlatoon: true, sacBunt: true } } })
    app!.close()
    document.body.replaceChildren()
    mount(storage, clock, locks)
    await flush()
    toTactics()
    expect($('.v2-seg-btn[data-option="aggressive"]')!.getAttribute('aria-checked')).toBe('true')
    $<HTMLButtonElement>('[data-toggle="platoon"]')!.click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    expect(saved(storage).strategy.coach.params).toEqual({ stealMin: 0.65, latePlatoon: false, sacBunt: true })
  })

  it('多分頁：別的分頁先存了戰術，這邊的草稿過期，不能覆蓋', async () => {
    const { storage, clock, locks } = mount()
    await flush()
    await createClub()
    toTactics()
    card('defense').click()
    await updateSettings(tab(storage, clock, locks), { coach: { style: 'power', params: { stealMin: 0.85, latePlatoon: true, sacBunt: false } } })
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
    expect(text('.v2-savebar-status')).toBe(V2T.draftStaleTitle)
    expect($('[data-action="save-draft"]')).toBeNull()
    $<HTMLButtonElement>('[data-action="load-latest"]')!.click()
    expect(card('power').getAttribute('aria-checked')).toBe('true')
    expect(saved(storage).strategy.coach.style).toBe('power')
  })
})

describe('戰術頁：推薦戰術', () => {
  it('依上場陣容推薦，說明理由；按「改選」只是選卡片，不會自動儲存；跟目前一樣時說明', async () => {
    const { storage } = mount()
    await flush()
    await createClub()
    toTactics()
    const advice = recommendStyle(resolveRoster(saved(storage)))
    expect(text('.v2-advice-style')).toBe(V2T.adviceStyle(V2T.styleNames[advice.style]))
    expect(text('.v2-advice-reason').length).toBeGreaterThan(10)
    expect(text('.v2-advice-note')).toBe(V2T.adviceNote)
    if (advice.style === 'balanced') {
      expect(text('.v2-advice-same')).toBe(V2T.adviceSame)
      card('power').click()
    }
    const before = JSON.stringify(saved(storage).strategy)
    $<HTMLButtonElement>('[data-action="try-advice"]')!.click()
    expect(card(advice.style).getAttribute('aria-checked')).toBe('true')
    expect(JSON.stringify(saved(storage).strategy)).toBe(before)
  })
})

describe('戰報：本場戰術', () => {
  it('新比賽：顯示當場的風格與實際執行的次數（跟存檔裡的摘要一致）', async () => {
    const { clock, storage } = mount()
    await flush()
    await createClub()
    toTactics()
    card('speed').click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    clock.advance(2 * HOUR)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush(60)
    const club = saved(storage)
    const m = club.recentMatches.at(-1)
    expect(m.tactics[0]).toBe('speed')
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    $$('.v2-report-row')[0].click()
    await flush()
    const box = $('.v2-report-tactics')!
    expect(box.querySelector('.v2-report-tactics-style')!.textContent).toBe(V2T.styleNames.speed)
    const val = (key: string) => box.querySelector(`[data-key="${key}"] dd`)!.textContent
    expect(val('steals')).toBe(`${m.tactics[3]} / ${m.tactics[2]}`)
    expect(val('bunts')).toBe(`${m.tactics[5]} / ${m.tactics[4]}`)
    expect(val('hitAndRuns')).toBe(String(m.tactics[6]))
    expect(val('defensiveSubs')).toBe(String(m.tactics[9]))
    expect(box.textContent).toContain(V2T.matchTacticsNote)
  })

  it('舊比賽（V10 遷移上來的）：顯示「未記錄」，不用目前的戰術回填', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(fixtureV10))
    mount(storage, new ManualClock(fixtureV10.idle.anchorMs))
    await flush(60)
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    $$('.v2-report-row')[0].click()
    await flush()
    const box = $('.v2-report-tactics')!
    expect(box.querySelector('.v2-report-tactics-style')!.textContent).toBe(V2T.matchTacticsNone)
    expect(box.textContent).toContain(V2T.matchTacticsNoneNote)
    expect(box.querySelector('[data-key]')).toBeNull()
  })
})
