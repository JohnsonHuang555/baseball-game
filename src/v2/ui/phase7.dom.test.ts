// @vitest-environment happy-dom
// Phase 7 的唯讀畫面：遊戲指南（「?」入口、章節、搜尋、問答、焦點還原）、首頁「下一個目標」、聯盟之路、聯盟詳情。
// 這些畫面只讀規則與存檔，不寫入；競技積分／降級還沒定案，畫面上只能以「示意」出現
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import type { ClubSave } from '../domain/club'
import { IDLE_CONFIG } from '../domain/config'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from '../domain/leagueConfig'
import { openV2, type V2App } from './app'
import { dialogDebug } from './dialog'
import { guideChapters, searchGuide } from './guideContent'
import { leagueDetail, openLeagueRoad } from './leagueRoadView'
import { linkText, riskOf } from './leagueInfo'
import { badgeStateFor, leagueBadgeSvg } from './leagueBadge'

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
const key = (k: string, target: EventTarget = document) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))

class CountingStorage extends MemoryStorage {
  writes = 0
  override setItem(k: string, value: string): void {
    if (k === CLUB_STORAGE_KEY) this.writes++
    super.setItem(k, value)
  }
}

async function setup(edit?: (c: ClubSave) => ClubSave, mobile = true) {
  const storage = new CountingStorage()
  const clock = new ManualClock(T0)
  const locks = new FakeLockManager()
  const deps = tab(storage, clock, locks)
  await createClubSafely(deps, { clubName: '指南隊', clubSeed: 7, clubId: 'club-p7' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  const real = globalThis.matchMedia
  if (mobile) globalThis.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  try {
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'tab-p7' })
    await flush()
    $$('.v2-modal-close').forEach((b) => b.click())
    await flush()
  } finally {
    globalThis.matchMedia = real
  }
  return { storage, clock }
}

const atTier = (tier: number, extra: Partial<ClubSave['league']> = {}) => (c: ClubSave): ClubSave => ({
  ...c,
  league: { ...c.league, tier, highestTier: tier, promotions: tier, rewardedTiers: Array.from({ length: tier }, (_, i) => i + 1), ...extra },
})

describe('遊戲指南', () => {
  it('首頁標題列的「?」打開全畫面指南；9 章、可切換；Esc 關閉後焦點回到「?」；不寫入存檔', async () => {
    const env = await setup()
    const help = $<HTMLButtonElement>('[data-action="open-guide"]')!
    expect(help.hidden).toBe(false)
    expect(help.getAttribute('aria-label')).toBe('遊戲指南')
    const writes = env.storage.writes
    help.focus()
    help.click()
    await flush()
    const modal = $('.v2-modal.full.v2-guide-modal')!
    expect(modal).toBeTruthy()
    expect(modal.getAttribute('aria-modal')).toBe('true')
    const tabs = $$('.v2-guide-tab')
    expect(tabs).toHaveLength(9)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('intro')
    tabs[6].click()
    await flush()
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('promotion')
    expect(tabs[6].getAttribute('aria-selected')).toBe('true')
    // 下一章／上一章
    $<HTMLButtonElement>('.v2-guide-next')!.click()
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('ranked')
    $<HTMLButtonElement>('.v2-guide-prev')!.click()
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('promotion')
    // 方向鍵切章
    key('ArrowRight', tabs[6])
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('ranked')
    expect(document.activeElement).toBe(tabs[7])
    key('Escape')
    await flush()
    expect($('.v2-guide-modal')).toBeNull()
    expect(document.activeElement).toBe(help)
    expect(dialogDebug().layers).toBe(0)
    expect(env.storage.writes).toBe(writes)
  })

  it('搜尋「降級」找到積分章與問答；點結果跳到那一章', async () => {
    await setup()
    $<HTMLButtonElement>('[data-action="open-guide"]')!.click()
    await flush()
    const input = $<HTMLInputElement>('.v2-guide-input')!
    input.value = '降級'
    input.dispatchEvent(new Event('input'))
    expect($('.v2-guide-results-title')!.textContent).toMatch(/「降級」找到 \d+ 筆/)
    const hits = $$('.v2-guide-hit')
    expect(hits.length).toBeGreaterThan(1)
    expect(hits.some((h) => h.textContent!.includes('常見問題'))).toBe(true)
    hits.find((h) => h.textContent!.includes('積分與降級'))!.click()
    expect($('.v2-guide-chapter')!.dataset.chapter).toBe('ranked')
    expect(input.value).toBe('')
  })

  it('問答一次只展開一題', async () => {
    await setup()
    $<HTMLButtonElement>('[data-action="open-guide"]')!.click()
    await flush()
    $$('.v2-guide-tab')[8].click()
    const qs = $$('.v2-faq-q')
    expect(qs).toHaveLength(5)
    qs[0].click()
    qs[2].click()
    expect(qs.map((q) => q.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'true', 'false', 'false'])
    expect($$('.v2-faq-a').filter((a) => !a.hidden)).toHaveLength(1)
    qs[2].click()
    expect($$('.v2-faq-a').filter((a) => !a.hidden)).toHaveLength(0)
  })

  it('數字來自 config；未定案的積分規則一律標示「示意」', () => {
    const chapters = guideChapters()
    const byId = Object.fromEntries(chapters.map((c) => [c.id, c]))
    expect(JSON.stringify(byId.match)).toContain(String(IDLE_CONFIG.MAX_BATCH_MATCHES))
    expect(byId.promotion.cards[0].title).toContain(String(PROMOTION_CONFIG.minMatches))
    expect(byId.promotion.summary).toContain(String(LEAGUES.length))
    const ranked = byId.ranked
    expect(ranked.title).toContain('規劃中')
    // 寫到積分數字的卡片都是 demo；說明「目前不會降級」的是重點
    for (const c of ranked.cards) if (/[+−]\d|\d+ 分/.test(c.text)) expect(c.tag).toBe('demo')
    expect(ranked.cards.some((c) => c.tag === 'key' && c.text.includes('不會被降級'))).toBe(true)
    // 其他章節不提積分數字
    for (const c of chapters.filter((x) => x.id !== 'ranked')) for (const card of c.cards) expect(card.tag).not.toBe('demo')
    expect(searchGuide(chapters, '  ')).toEqual([])
    expect(searchGuide(chapters, '離線').length).toBeGreaterThan(0)
  })

  it('指南在其他分頁不顯示「?」', async () => {
    await setup()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    await flush()
    expect($<HTMLButtonElement>('[data-action="open-guide"]')!.hidden).toBe(true)
  })
})

describe('首頁：下一個目標', () => {
  it('新秀聯盟：顯示正式的晉級條件與還需要的項目，不顯示積分', async () => {
    await setup()
    const goal = $('.v2-goal')!
    expect(goal.dataset.tier).toBe('0')
    expect(goal.textContent).toContain(`晉級到${LEAGUES[1].name}`)
    expect(goal.textContent).toContain(`再完成 ${PROMOTION_CONFIG.minMatches} 場本聯盟比賽`)
    expect(goal.querySelectorAll('.v2-goal-conds li')).toHaveLength(2)
    expect(goal.querySelector('.v2-points-bar')).toBeNull()
    expect(goal.querySelector('.v2-demo-tag')).toBeNull()
  })

  it('業餘聯盟：多一行「示意」說明下一級規劃的積分；挑戰者：說明規則確定前仍用正式條件', async () => {
    await setup(atTier(1))
    expect($('.v2-goal-plan')!.textContent).toContain('示意')
    expect($('.v2-goal-plan')!.textContent).toContain(LEAGUES[2].name)
    app?.close()
    document.body.replaceChildren()
    await setup(atTier(2))
    expect($('.v2-goal-plan')!.textContent).toContain('規則確定前仍用上面的條件')
    expect($('.v2-goal .v2-points-bar')).toBeNull()
  })

  it('條件都達成：顯示可以挑戰', async () => {
    const need = PROMOTION_CONFIG.minMatches
    await setup((c) => ({ ...c, league: { ...c.league, matches: need, wins: need, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, record: { ...c.record, wins: need } }))
    expect($('.v2-goal')!.classList.contains('ready')).toBe(true)
    expect($('.v2-goal-need')!.classList.contains('done')).toBe(true)
  })

  it('傳奇聯盟：沒有晉級條件，目標是繼續變強', async () => {
    await setup(atTier(MAX_TIER))
    const goal = $('.v2-goal')!
    expect(goal.querySelector('.v2-goal-conds')).toBeNull()
    expect(goal.textContent).toContain('最高的聯盟')
  })

  it('「聯盟之路」打開全畫面視窗，關閉後焦點回到按鈕', async () => {
    const env = await setup(atTier(1))
    const writes = env.storage.writes
    const btn = $<HTMLButtonElement>('[data-action="open-road"]')!
    btn.focus()
    btn.click()
    await flush()
    expect($('.v2-road-modal')).toBeTruthy()
    $<HTMLButtonElement>('.v2-road-modal .v2-modal-x')!.click()
    await flush()
    expect(document.activeElement).toBe(btn)
    expect(env.storage.writes).toBe(writes)
  })
})

describe('聯盟之路與聯盟詳情', () => {
  it('手機：傳奇在最上、新秀在最下；已到達／目前所在／尚未到達；點聯盟從底部打開詳情，Esc 只關詳情', async () => {
    await setup(atTier(1))
    $<HTMLButtonElement>('[data-action="open-road"]')!.click()
    await flush()
    const cards = $$('.v2-road-card')
    expect(cards.map((c) => c.dataset.tier)).toEqual(['4', '3', '2', '1', '0'])
    expect(cards.map((c) => c.classList.contains('locked') ? 'locked' : c.classList.contains('current') ? 'current' : 'reached')).toEqual(['locked', 'locked', 'locked', 'current', 'reached'])
    // 競技區的卡片都有示意標籤；新手區沒有
    for (const c of cards) expect(!!c.querySelector('.v2-demo-tag')).toBe(Number(c.dataset.tier) >= 2)
    cards[1].click()
    await flush()
    const sheet = $('.v2-modal.sheet.v2-league-detail-modal')!
    expect(sheet.querySelector('.v2-league-detail')!.getAttribute('data-tier')).toBe('3')
    expect(sheet.querySelector('.v2-ld-rel.danger .v2-demo-tag')).toBeTruthy()
    expect(sheet.textContent).toContain('目前所有聯盟都還不會降級')
    key('Escape')
    await flush()
    expect($('.v2-league-detail-modal')).toBeNull()
    expect($('.v2-road-modal')).toBeTruthy()
    const a = document.activeElement as HTMLElement
    expect(a.className + '|' + a.dataset.tier + '|' + a.textContent).toBe(cards[1].className + '|3|' + cards[1].textContent)
  })

  it('目前所在的聯盟詳情有「可以優先看看」；點入口會關掉聯盟之路再前往', async () => {
    await setup(atTier(1))
    $<HTMLButtonElement>('[data-action="open-road"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-road-card[data-tier="1"]')!.click()
    await flush()
    const links = $$('.v2-ld-link')
    expect(links.map((l) => l.textContent)).toEqual(['檢查陣容與守位', '招募新球員', '看晉級規則'])
    links[2].click()
    await flush()
    expect($('.v2-road-modal')).toBeNull()
    expect($('.v2-guide-modal .v2-guide-chapter')!.dataset.chapter).toBe('promotion')
  })

  it('電腦版：五階台階加右側詳情面板，點台階換面板內容', () => {
    const close = openLeagueRoad({ club: null, desk: true })
    expect($$('.v2-road-step')).toHaveLength(LEAGUES.length)
    expect($('.v2-road-panel .v2-league-detail')!.dataset.tier).toBe('0')
    $<HTMLButtonElement>('.v2-road-step .v2-road-card[data-tier="3"]')!.click()
    expect($('.v2-road-panel .v2-league-detail')!.dataset.tier).toBe('3')
    expect($('.v2-road-card[data-tier="3"]')!.classList.contains('selected')).toBe(true)
    close()
  })

  it('存檔還沒讀到：只顯示規則（骨架與說明），不顯示自己的位置', () => {
    const close = openLeagueRoad({ club: null })
    expect($('.v2-road-where.loading')).toBeTruthy()
    expect($('.v2-road-where')!.textContent).toContain('讀取完成後才會顯示')
    expect($$('.v2-road-card.current')).toHaveLength(0)
    close()
  })

  it('規則說明從 config 讀：倍率、首次晉級獎勵；降級風險只在競技區', () => {
    for (const def of LEAGUES) {
      const d = leagueDetail(def.tier, null)
      expect(d.textContent).toContain(`×${def.rewardMultiplier.toFixed(2)}`)
      if (def.tier) expect(d.textContent).toContain(def.promotionReward.funds.toLocaleString('zh-Hant'))
      if (def.tier < MAX_TIER) expect(d.textContent).toContain(`${PROMOTION_CONFIG.minMatches} 場`)
    }
    expect(LEAGUES.map((l) => riskOf(l.tier))).toEqual(['safe', 'safe', 'floor', 'danger', 'danger'])
    expect(linkText(1).planned).toBe(false)
    expect(linkText(2).planned).toBe(true)
  })

  it('徽章：星數等於等級、未到達是鎖', () => {
    expect(leagueBadgeSvg(0).match(/<polygon/g)).toHaveLength(1)
    expect(leagueBadgeSvg(4).match(/<polygon/g)).toHaveLength(5)
    expect(leagueBadgeSvg(4, 'locked')).not.toContain('<polygon')
    expect(badgeStateFor(3, 1, 1)).toBe('locked')
    expect(badgeStateFor(1, 1, 1)).toBe('current')
    expect(badgeStateFor(0, 1, 1)).toBe('reached')
  })

  it('App 關閉時一起關掉指南與聯盟之路（不留對話框堆疊）', async () => {
    await setup()
    $<HTMLButtonElement>('[data-action="open-road"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-road-card[data-tier="0"]')!.click()
    await flush()
    expect(dialogDebug().layers).toBe(2)
    app!.close()
    app = null
    expect(dialogDebug().layers).toBe(0)
    expect($$('.v2-modal')).toHaveLength(0)
  })
})
