// @vitest-environment happy-dom
// 羈絆說明與隊長的畫面：說明入口（Modal、Escape、焦點還原）、六種羈絆的內容、隊長標記與說明、
// 指定隊長只改草稿（不寫存檔）、編輯後的羈絆預覽、儲存後才生效、球員詳情的隊長身分、指南章節、自動排陣照舊
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import type { ClubSave } from '../domain/club'
import { resolveRoster } from '../domain/roster'
import { captainIn, captainWeight, thresholds } from '../../sim/synergy'
import { SYNERGY_NAMES } from '../../ui/strings'
import { synergyChanges, synergyDetails } from '../../ui/synergyInfo'
import { synergyRows } from '../../ui/synergyUi'
import { substitute } from '../domain/lineup'
import { openV2, type V2App } from './app'
import { dialogDebug } from './dialog'
import { guideChapters } from './guideContent'

let app: V2App | null = null
afterEach(() => {
  app?.close()
  app = null
  document.body.replaceChildren()
})

const flush = async (times = 20) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
const mobile = () => {
  const real = globalThis.matchMedia
  globalThis.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  return () => (globalThis.matchMedia = real)
}

async function setup() {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const locks = new FakeLockManager()
  await createClubSafely(tab(storage, clock, locks), { clubName: '羈絆隊', clubSeed: 21, clubId: 'club-syn' })
  const restore = mobile()
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'tab-syn' })
  await flush()
  $$('.v2-modal-close').forEach((b) => b.click())
  await flush()
  restore()
  $<HTMLButtonElement>('.v2-nav-btn[data-tab="lineup"]')!.click()
  await flush()
  return { storage }
}
const saved = (storage: MemoryStorage) => JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave

describe('羈絆說明', () => {
  it('陣容頁有「羈絆說明」：打開 Modal、六種羈絆、門檻與加成來自正式設定；Escape 關閉、焦點回到按鈕', async () => {
    const { storage } = await setup()
    const btn = $<HTMLButtonElement>('[data-action="synergy-guide"]')!
    btn.focus()
    btn.click()
    await flush()
    const modal = $('.v2-syn-modal')!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    const cards = $$('.v2-syn-card')
    expect(cards.map((c) => c.dataset.synergy)).toEqual(['power', 'speed', 'skill', 'defense', 'middle', 'battery'])
    const c = saved(storage)
    const roster = resolveRoster(c)
    const details = synergyDetails(roster.lineup, roster.captain, [], roster.bench)
    const [low, high] = thresholds('power', [])
    for (const d of details) {
      const card = $(`.v2-syn-card[data-synergy="${d.key}"]`)!
      expect(card.querySelector('h3')!.textContent).toBe(SYNERGY_NAMES[d.key])
      expect(card.textContent).toContain(d.desc)
      if (!d.position) {
        expect(card.textContent).toContain(`目前 ${d.count} 人`)
        expect(card.textContent).toContain(`第一階（${low} 人）`)
        expect(card.textContent).toContain(`第二階（${high} 人）`)
        expect(card.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe(String(Math.min(d.count, high)))
      }
      for (const e of [...d.current, ...(d.next?.effects ?? [])]) expect(card.textContent).toContain(e)
      for (const m of d.members) expect(card.textContent).toContain(m.name)
      for (const t of d.tips) expect(card.textContent).toContain(t)
    }
    // 不依賴 hover：所有說明都是看得到的文字
    expect($$('.v2-syn-card [title]').filter((n) => !n.classList.contains('captain-icon'))).toHaveLength(0)
    for (const n of $$('.v2-syn-card .captain-icon')) expect(n.closest('.v2-syn-member')!.textContent).toContain('隊長・算')
    key('Escape')
    await flush()
    expect($('.v2-syn-modal')).toBeNull()
    expect(document.activeElement).toBe($('[data-action="synergy-guide"]'))
    expect(dialogDebug().layers).toBe(0)
  })

  it('隊長：C 是 Captain、隊長在自己流派算 2 人、要是先發；陣容列上有「隊長」文字', async () => {
    const { storage } = await setup()
    const c = saved(storage)
    const capId = captainIn(resolveRoster(c).lineup, c.roster.captain)!
    const capName = c.players.find((p) => p.player.id === capId)!.player.name
    const row = $$('.v2-player').find((b) => b.textContent!.includes(capName))!
    expect(row.querySelector('.v2-captain-chip')!.textContent).toBe('隊長')
    expect(row.getAttribute('aria-label')).toContain('隊長')
    $<HTMLButtonElement>('[data-action="synergy-guide"]')!.click()
    await flush()
    const sec = text('.v2-syn-captain')
    expect(sec).toContain('Captain')
    expect(sec).toContain(`算 ${captainWeight([])} 人`)
    expect(sec).toContain('先發')
    expect(sec).toContain(`目前隊長：${capName}`)
    expect($(`.v2-syn-cap[data-captain="${capId}"]`)!.getAttribute('aria-pressed')).toBe('true')
    expect($$('.v2-syn-cap')).toHaveLength(9)
  })

  it('指定隊長只改草稿：存檔不變、預覽顯示變化；還原回到存檔；儲存後才寫入', async () => {
    const { storage } = await setup()
    const before = storage.getItem(CLUB_STORAGE_KEY)
    const c = saved(storage)
    const oldCap = c.roster.captain
    const target = c.roster.lineup.map((s) => s.playerId).find((id) => id !== oldCap)!
    $<HTMLButtonElement>('[data-action="synergy-guide"]')!.click()
    await flush()
    $<HTMLButtonElement>(`.v2-syn-cap[data-captain="${target}"]`)!.click()
    await flush()
    // Modal 留著、重畫成新的隊長，焦點在剛按的那一位
    expect($(`.v2-syn-cap[data-captain="${target}"]`)!.getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe($(`.v2-syn-cap[data-captain="${target}"]`))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    expect(text('.v2-syn-guide')).not.toContain('（成立）')
    key('Escape')
    await flush()
    // 陣容頁：草稿有變更、預覽寫出隊長換人
    expect(text('.v2-syn-preview')).toContain('儲存後')
    expect(text('.v2-syn-preview')).toContain(`隊長換成 ${c.players.find((p) => p.player.id === target)!.player.name}`)
    expect($('[data-action="save-draft"]')).not.toBeNull()
    expect(saved(storage).roster.captain).toBe(oldCap)
    // 還原
    $<HTMLButtonElement>('[data-action="reset-draft"]')!.click()
    await flush()
    expect($('.v2-syn-preview')).toBeNull()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    // 再指定一次並儲存
    $<HTMLButtonElement>('[data-action="synergy-guide"]')!.click()
    await flush()
    $<HTMLButtonElement>(`.v2-syn-cap[data-captain="${target}"]`)!.click()
    await flush()
    key('Escape')
    await flush()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    expect(saved(storage).roster.captain).toBe(target)
    expect($('.v2-syn-preview')).toBeNull()
  })

  it('交換先發與板凳：預覽用草稿算出羈絆變化，存檔不動', async () => {
    const { storage } = await setup()
    const before = storage.getItem(CLUB_STORAGE_KEY)
    // 第一位先發 ↔ 第一位板凳
    const rows = $$('.v2-starters .v2-player')
    rows[0].click()
    await flush()
    $$('.v2-bench .v2-player')[0].click()
    await flush()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
    // 預期：用領域函式在同一份草稿上算（先發第 1 位 ↔ 板凳第 1 位）
    const savedRoster = resolveRoster(saved(storage))
    const draft = substitute(savedRoster, 0, 0)
    const changes = synergyChanges(synergyRows(savedRoster.lineup, savedRoster.captain, []), synergyRows(draft.lineup, draft.captain, []))
    const capChanged = captainIn(savedRoster.lineup, savedRoster.captain) !== captainIn(draft.lineup, draft.captain)
    const preview = $('.v2-syn-preview')
    expect(!!preview).toBe(changes.length > 0 || capChanged)
    for (const c of changes) expect(preview!.textContent).toContain(c.name)
    if (capChanged) expect(preview!.textContent).toContain('沒有隊長')
    $<HTMLButtonElement>('[data-action="synergy-guide"]')!.click()
    await flush()
    expect($('.v2-syn-diff')!.textContent).toContain('跟已儲存的陣容比')
    expect($('.v2-syn-diff')!.dataset.changes).toBe(String(changes.length))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
  })
})

describe('球員詳情與指南', () => {
  it('隊長的球員詳情顯示「隊長 C」與說明；其他人沒有', async () => {
    const { storage } = await setup()
    const c = saved(storage)
    const capId = c.roster.captain!
    const capName = c.players.find((p) => p.player.id === capId)!.player.name
    const idx = $$('.v2-player-item').findIndex((it) => it.textContent!.includes(capName))
    $$('.v2-player-item')[idx].querySelector<HTMLButtonElement>('.v2-develop')!.click()
    await flush()
    expect(text('.v2-detail-chips')).toContain('隊長 C')
    expect(text('.v2-captain-note')).toContain('Captain')
    expect(text('.v2-captain-note')).toContain(`算 ${captainWeight([])} 人`)
    key('Escape')
    await flush()
    const other = $$('.v2-player-item').findIndex((it, i) => i !== idx && !it.textContent!.includes('隊長'))
    $$('.v2-player-item')[other].querySelector<HTMLButtonElement>('.v2-develop')!.click()
    await flush()
    expect($('.v2-captain-note')).toBeNull()
  })

  it('遊戲指南有「球員流派、羈絆與隊長」，數字來自正式設定、有精確效果', () => {
    const ch = guideChapters().find((c) => c.id === 'synergy')!
    expect(ch.title).toBe('球員流派、羈絆與隊長')
    const all = JSON.stringify(ch)
    const [low, high] = thresholds('power', [])
    expect(all).toContain(`${low} 人啟動`)
    expect(all).toContain(`算 ${captainWeight([])} 人`)
    for (const k of Object.keys(SYNERGY_NAMES)) expect(all).toContain(SYNERGY_NAMES[k as keyof typeof SYNERGY_NAMES])
    expect(ch.faq!.find((f) => f.q.includes('精確'))!.a).toContain(`${high} 人階`)
    expect(all).toContain('指定打擊不算')
  })

  it('自動排陣照舊：打開「最多羈絆排法」不寫存檔', async () => {
    const { storage } = await setup()
    const before = storage.getItem(CLUB_STORAGE_KEY)
    $<HTMLButtonElement>('.v2-auto')!.click()
    await flush()
    expect($('.v2-modal')).not.toBeNull()
    key('Escape')
    await flush()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(before)
  })
})
