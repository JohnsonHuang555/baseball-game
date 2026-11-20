// @vitest-environment happy-dom
// 招募市場的畫面：三選一、關閉重開與重新整理是同一批人、切換角色、取消不扣款、別的分頁先簽約、資金不足與名單已滿的提示
import { afterEach, describe, expect, it } from 'vitest'
import { recruit } from '../application/economyService'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCandidates } from '../domain/recruitment'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, tab } from '../testkit'
import { openV2, type V2App } from './app'
import { V2T } from './strings'

let apps: V2App[] = []
afterEach(() => {
  apps.forEach((a) => a.close())
  apps = []
  document.body.replaceChildren()
})
const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''
const cardIds = () => $$('.v2-cand').map((c) => c.dataset.player)

async function start(funds = 100_000, env = { storage: new MemoryStorage(), clock: new ManualClock(), locks: new FakeLockManager() }, create = true) {
  const root = document.createElement('div')
  document.body.append(root)
  const deps = tab(env.storage, env.clock, env.locks)
  const app = openV2(root, { deps, tickMs: 0, tabId: `t${apps.length}` })
  apps.push(app)
  await flush()
  if (create) {
    const input = $<HTMLInputElement>('#v2-club-name')!
    input.value = '市場隊'
    $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    $<HTMLButtonElement>('.v2-modal-close')?.click()
    const c = deps.store.loadClub()!
    deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { funds, experience: 0 }, earned: { funds, experience: 0 } } }, c.revision)
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
  }
  return { env, deps, app }
}
const openMarket = () => $<HTMLButtonElement>('[data-action="recruit"]')!.click()
const closeMarket = () => $<HTMLButtonElement>('.v2-modal-close')!.click()

describe('招募市場畫面', () => {
  it('預設畫面：人數、資金、本次費用、招募打者／投手按鈕', async () => {
    await start(12_345)
    openMarket()
    expect($('.v2-recruit-count')!.getAttribute('aria-label')).toBe(V2T.rosterCount(14, RECRUIT_CONFIG.maxPlayers))
    expect($('.v2-recruit-funds')!.getAttribute('aria-label')).toBe(V2T.recruitFunds(12_345))
    expect($('.v2-recruit-cost')!.getAttribute('aria-label')).toBe(V2T.recruitCost(2000))
    expect($$('.v2-recruit-buttons [data-role]').map((b) => b.dataset.role)).toEqual(['batter', 'pitcher'])
  })

  it('打者三選一：三張卡片都是打者，每張有總評、能力、跟目前陣容的比較；跟純函式推導的一致', async () => {
    const { deps } = await start()
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    expect(cardIds()).toEqual(recruitCandidates(deps.store.loadClub()!, 'batter').map((p) => p.id))
    for (const card of $$('.v2-cand')) {
      expect(card.querySelector('.v2-cand-ovr')).not.toBeNull()
      expect(card.querySelectorAll('.v2-cand-rating')).toHaveLength(4)
      expect(card.querySelector('.v2-cand-vs')!.textContent).toContain('對比')
      expect(['stronger', 'similar', 'weaker']).toContain(card.querySelector<HTMLElement>('.v2-cand-compare')!.dataset.verdict)
    }
  })

  it('投手三選一：三張卡片都是投手，跟先發投手或最弱的後援比較', async () => {
    await start()
    openMarket()
    $<HTMLButtonElement>('[data-role="pitcher"]')!.click()
    expect($$('.v2-cand')).toHaveLength(3)
    for (const card of $$('.v2-cand')) {
      expect(card.querySelectorAll('.v2-cand-rating')).toHaveLength(3)
      expect(card.querySelector('.v2-cand-vs')!.textContent).toMatch(new RegExp(`${V2T.compareSp}|${V2T.compareReliever}`))
    }
  })

  it('關閉後重新開啟、切換角色再切回來、重新整理：同一批候選人', async () => {
    const env = { storage: new MemoryStorage(), clock: new ManualClock(), locks: new FakeLockManager() }
    await start(100_000, env)
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    const first = cardIds()
    $<HTMLButtonElement>('.v2-recruit-roles [data-role="pitcher"]')!.click()
    $<HTMLButtonElement>('.v2-recruit-roles [data-role="batter"]')!.click()
    expect(cardIds()).toEqual(first)
    closeMarket()
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    expect(cardIds()).toEqual(first)
    // 重新整理：關掉 App，用同一份存檔重開
    apps.forEach((a) => a.close())
    document.body.replaceChildren()
    await start(0, env, false)
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    expect(cardIds()).toEqual(first)
  })

  it('選了卡片再取消（返回或關閉視窗）：不扣款、不加人、候選人不變', async () => {
    const { env } = await start()
    const before = env.storage.getItem(CLUB_STORAGE_KEY)
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    const first = cardIds()
    $$('.v2-cand')[2].click()
    expect($$('.v2-cand')[2].getAttribute('aria-pressed')).toBe('true')
    $<HTMLButtonElement>('.v2-recruit-back')!.click()
    closeMarket()
    await flush()
    expect(env.storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    expect(cardIds()).toEqual(first)
    expect($$('.v2-cand').every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('簽約完成：顯示球員、花費、剩餘資金；可以繼續招募，下一批是新的人、價格 2,200', async () => {
    const { env } = await start(10_000)
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    const first = cardIds()
    $$('.v2-cand')[0].click()
    $<HTMLButtonElement>('[data-action="recruit-confirm"]')!.click()
    await flush()
    expect($('.v2-recruit-spent')!.getAttribute('aria-label')).toBe(V2T.recruitSpent(2000))
    expect($('.v2-recruit-remain')!.getAttribute('aria-label')).toBe(V2T.recruitRemain(8000))
    expect(text('.v2-recruit-card .v2-player-name')).toContain(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).players.at(-1).player.name)
    $<HTMLButtonElement>('.v2-recruit-again')!.click()
    expect($('.v2-recruit-cost')!.getAttribute('aria-label')).toBe(V2T.recruitCost(2200))
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    expect(cardIds()).not.toEqual(first)
  })

  it('連點確認簽約：只簽一次、只扣一次款', async () => {
    const { env } = await start()
    openMarket()
    $<HTMLButtonElement>('[data-role="pitcher"]')!.click()
    $$('.v2-cand')[1].click()
    const btn = $<HTMLButtonElement>('[data-action="recruit-confirm"]')!
    btn.click()
    btn.click()
    btn.click()
    await flush()
    const saved = JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.players).toHaveLength(15)
    expect(saved.recruitment.count).toBe(1)
    expect(saved.economy.spent.funds).toBe(2000)
  })

  it('別的分頁先簽約：這個分頁的名單自動換成新的一批、選擇清掉；用舊選擇簽約會被拒絕', async () => {
    const { env, deps } = await start()
    openMarket()
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    const shown = cardIds()
    $$('.v2-cand')[1].click()
    // 另一個分頁簽了投手
    const other = tab(env.storage, env.clock, env.locks)
    const c = other.store.loadClub()!
    await recruit(other, { opSeq: c.economy.nextOpSeq, role: 'pitcher', candidateIndex: 0, expectedCount: c.recruitment.count })
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
    expect(cardIds()).not.toEqual(shown)
    expect(cardIds()).toEqual(recruitCandidates(deps.store.loadClub()!, 'batter').map((p) => p.id))
    expect($$('.v2-cand').every((x) => x.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect($<HTMLButtonElement>('[data-action="recruit-confirm"]')!.disabled).toBe(true)
    expect($('.v2-recruit-cost')!.getAttribute('aria-label')).toBe(V2T.recruitCost(2200))
  })

  it('名單已滿：清楚提示、不能簽約', async () => {
    const { env, deps } = await start(10_000_000)
    for (let i = 14; i < RECRUIT_CONFIG.maxPlayers; i++) {
      const c = deps.store.loadClub()!
      await recruit(deps, { opSeq: c.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: c.recruitment.count })
    }
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
    openMarket()
    expect(text('.v2-recruit-block')).toBe(V2T.recruitFullHint)
    $<HTMLButtonElement>('[data-role="batter"]')!.click()
    $$('.v2-cand')[0].click()
    expect($<HTMLButtonElement>('[data-action="recruit-confirm"]')!.disabled).toBe(true)
    expect(JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!).players).toHaveLength(RECRUIT_CONFIG.maxPlayers)
  })
})
