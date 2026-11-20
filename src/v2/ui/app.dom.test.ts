// @vitest-environment happy-dom
// V2 畫面的 DOM 互動測試：建立球團、連點、首頁、領取按鈕、分頁切換、回歸摘要只彈一次、沒有離開 V2 的入口
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, ManualClock, tab } from '../testkit'
import { updateSettings } from '../application/settlementService'
import { substitute } from '../domain/lineup'
import { resolveRoster, toAssignment } from '../domain/roster'
import { openV2, type V2App } from './app'
import { setKeys } from '../../ui/keys'
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

function mount(storage: MemoryStorage | FlakyStorage = new MemoryStorage(), clock = new ManualClock(), locks = new FakeLockManager()) {
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'test-tab' })
  return { root, storage, clock, locks }
}

/** 瀏覽器在別的分頁寫入 localStorage 時發的 storage 事件 */
function otherTabWrote(): void {
  window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T & HTMLElement>(sel)
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''

async function createClub(name = '測試貓熊隊') {
  const input = $<HTMLInputElement>('#v2-club-name')!
  input.value = name
  $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

describe('V2 畫面', () => {
  it('第一次進入：顯示建立球團；名稱空白顯示錯誤；建立後直接進入首頁', async () => {
    mount()
    await flush()
    expect($('.v2-create')).not.toBeNull()
    expect($('.v2-nav')!.hidden).toBe(true)
    await createClub('   ')
    expect(text('.v2-form-error')).toBe(V2T.nameRequired)
    await createClub('台北貓熊隊')
    expect($('.v2-dashboard')).not.toBeNull()
    expect(text('.v2-title')).toBe('台北貓熊隊')
    expect($('.v2-nav')!.hidden).toBe(false)
    // 剛建立：沒有比賽、沒有收益
    expect(text('.v2-recent .v2-empty')).toBe(V2T.noMatches)
    expect($<HTMLButtonElement>('.v2-claim')!.disabled).toBe(true)
    expect(text('[data-live-remain]')).toContain('5:00')
  })

  it('連續送出建立表單只會建立一份球團', async () => {
    const { storage } = mount()
    await flush()
    const form = $<HTMLFormElement>('.v2-create-form')!
    $<HTMLInputElement>('#v2-club-name')!.value = '連點隊'
    for (let i = 0; i < 5; i++) form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    const saved = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.revision).toBe(0)
    expect(saved.clubName).toBe('連點隊')
  })

  it('離開一段時間再回來：結算並只彈一次回歸摘要；領取收益後資產更新、按鈕停用', async () => {
    const { root, storage, clock } = mount()
    await flush()
    await createClub()
    app!.close()
    clock.advance(HOUR)
    root.remove()
    const again = mount(storage, clock)
    await flush(80)
    expect($('.v2-welcome')).not.toBeNull()
    expect(text('.v2-welcome-lead')).toBe(V2T.welcomeBody(12))
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect($('.v2-welcome')).toBeNull()
    // 畫面重繪（切分頁再回來）不會再彈
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    $<HTMLButtonElement>('[data-tab="home"]')!.click()
    await flush()
    expect($('.v2-welcome')).toBeNull()
    expect($$('.v2-recent .v2-match')).toHaveLength(8)
    const claim = $<HTMLButtonElement>('.v2-claim')!
    expect(claim.disabled).toBe(false)
    claim.click()
    claim.click()
    await flush()
    const saved = JSON.parse(again.storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.economy.nextClaimSeq).toBe(1)
    expect(saved.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    expect($<HTMLButtonElement>('.v2-claim')!.disabled).toBe(true)
    expect(text('.v2-club .v2-stat.funds .v2-stat-value')).toBe(saved.economy.assets.funds.toLocaleString('zh-Hant'))
  })

  it('四個分頁都畫得出來；點比賽打開戰報（有 replay 時有每局比分）', async () => {
    const { clock } = mount()
    await flush()
    await createClub()
    clock.advance(20 * 60 * 1000)
    await app!.controller.settle('manual')
    await flush()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    expect($$('.v2-lineup .v2-player')).toHaveLength(9 + 2 + 1 + 2)
    expect(text('.v2-lineup')).toContain(V2T.lineupEffective)
    $<HTMLButtonElement>('[data-tab="tactics"]')!.click()
    expect($$('.v2-seg-btn')).toHaveLength(3)
    expect($$('.v2-style-card')).toHaveLength(4)
    $<HTMLButtonElement>('[data-tab="reports"]')!.click()
    expect($$('.v2-match')).toHaveLength(4)
    $$('.v2-match')[0].click()
    expect($('.v2-report')).not.toBeNull()
    expect($('.v2-linescore')).not.toBeNull()
    // 每一場都有結算時存下的 Box Score（不再只有最近 3 場），沒有「觀看比賽」入口
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    $$('.v2-match')[3].click()
    expect($('.v2-linescore')).not.toBeNull()
    expect($$('.v2-box tbody tr').length).toBeGreaterThan(9)
    expect($('[data-action="watch"]')).toBeNull()
  })

  it('陣容：點先發再點板凳換人，儲存後從下一場生效；不儲存可以還原', async () => {
    const { storage } = mount()
    await flush()
    await createClub()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    const before = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).roster
    $$('.v2-player')[0].click()
    expect($$('.v2-player')[0].getAttribute('aria-pressed')).toBe('true')
    $$('.v2-player')[9].click()
    expect(text('.v2-savebar-status')).toBe(V2T.unsavedChanges)
    $<HTMLButtonElement>('[data-action="reset-draft"]')!.click()
    expect(text('.v2-savebar-status')).toBe(V2T.lineupEffective)
    $$('.v2-player')[0].click()
    $$('.v2-player')[9].click()
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    const after = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(after.roster.lineup[0].playerId).toBe(before.bench[0])
    // 第 1 場已經在進行中（開賽時的陣容固定），新陣容從第 2 場開始
    expect(after.strategy.effectiveFromMatch).toBe(1)
  })

  it('戰術：選「積極」、關掉觸擊，儲存成合法參數', async () => {
    const { storage } = mount()
    await flush()
    await createClub()
    $<HTMLButtonElement>('[data-tab="tactics"]')!.click()
    $$('.v2-seg-btn')[0].click()
    $$('.v2-switch')[1].click()
    expect($$('.v2-switch')[1].getAttribute('aria-checked')).toBe('false')
    $<HTMLButtonElement>('[data-action="save-draft"]')!.click()
    await flush()
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).strategy.coach).toEqual({ style: 'balanced', params: { stealMin: 0.7, latePlatoon: true, sacBunt: false } })
  })

  it('存檔損壞：顯示錯誤與備份、刪除按鈕，不會自動清除；沒有「回到首頁」（V2 就是整個網站，離開會是空白畫面）', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, '{oops')
    mount(storage)
    await flush()
    expect(text('.v2-broken')).toContain(V2T.corruptSave)
    expect($$('.v2-broken button').map((b) => b.textContent)).toEqual([V2T.downloadBackup, V2T.resetBroken])
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe('{oops')
    expect($('.v2-screen')).not.toBeNull()
  })
})

describe('Code review 修正', () => {
  it('建立失敗（寫入失敗）：顯示錯誤，表單重繪後名稱仍在，可以直接重試', async () => {
    const storage = new FlakyStorage()
    mount(storage)
    await flush()
    storage.failWrites = true
    const input = $<HTMLInputElement>('#v2-club-name')!
    input.value = '高雄海豚隊'
    input.dispatchEvent(new Event('input'))
    $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    // 表單已經因為狀態改變重繪過：錯誤還在、名稱還在、按鈕可以按
    expect(text('.v2-form-error')).toBe(V2T.createWriteFailed)
    expect($<HTMLInputElement>('#v2-club-name')!.value).toBe('高雄海豚隊')
    expect($<HTMLButtonElement>('.v2-create-btn')!.disabled).toBe(false)
    storage.failWrites = false
    $<HTMLFormElement>('.v2-create-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(text('.v2-title')).toBe('高雄海豚隊')
  })

  it('陣容草稿過期：其他分頁存了新陣容，草稿留著並提示，不能儲存；「載入最新設定」才捨棄', async () => {
    const { storage, clock, locks } = mount()
    await flush()
    await createClub()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    $$('.v2-player')[0].click()
    $$('.v2-player')[9].click()
    const myDraftFirst = $$('.v2-player')[0].querySelector('.v2-player-name')!.textContent
    // 別的分頁改了陣容並儲存
    const other = tab(storage, clock, locks)
    const club = other.store.loadClub()!
    const theirs = substitute(resolveRoster(club), 3, 1)
    await updateSettings(other, { roster: toAssignment(theirs) })
    otherTabWrote()
    await flush()
    expect(text('.v2-savebar-status')).toBe(V2T.draftStaleTitle)
    expect($('[data-action="save-draft"]')).toBeNull()
    // 草稿沒有消失
    expect($$('.v2-player')[0].querySelector('.v2-player-name')!.textContent).toBe(myDraftFirst)
    // 存檔是別的分頁的版本
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).roster).toEqual(toAssignment(theirs))
    $<HTMLButtonElement>('[data-action="load-latest"]')!.click()
    expect(text('.v2-savebar-status')).toBe(V2T.lineupEffective)
    expect($$('.v2-player')[3].querySelector('.v2-player-name')!.textContent).toContain(theirs.lineup[3].player.name)
  })

  it('戰術草稿過期：同樣提示、不能儲存', async () => {
    const { storage, clock, locks } = mount()
    await flush()
    await createClub()
    $<HTMLButtonElement>('[data-tab="tactics"]')!.click()
    $$('.v2-seg-btn')[0].click()
    await updateSettings(tab(storage, clock, locks), { coach: { style: 'balanced', params: { stealMin: 0.85 } } })
    otherTabWrote()
    await flush()
    expect(text('.v2-savebar-status')).toBe(V2T.draftStaleTitle)
    expect($('[data-action="save-draft"]')).toBeNull()
    expect($$('.v2-seg-btn')[0].getAttribute('aria-checked')).toBe('true')
  })

  it('沒有返回按鈕；Escape 不會關掉 V2，未儲存的草稿留著', async () => {
    const { root } = mount()
    await flush()
    await createClub()
    expect($('.v2-back')).toBeNull()
    $<HTMLButtonElement>('[data-tab="tactics"]')!.click()
    $$('.v2-seg-btn')[2].click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush(2)
    expect(root.querySelector('.v2-screen')).not.toBeNull()
    expect($('.v2-tactics')).not.toBeNull()
    expect($$('.v2-seg-btn')[2].getAttribute('aria-checked')).toBe('true')
    expect($$('.v2-nav-btn')).toHaveLength(4)
  })

  it('開啟時把按鍵設定清成空的：沒有任何按鍵會關掉整個 App', async () => {
    let fired = 0
    setKeys({ Escape: () => fired++ })
    mount()
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(fired).toBe(0)
    expect($('.v2-screen')).not.toBeNull()
  })
})

describe('Phase 4：養成與招募', () => {
  /** 建好球團並給一筆資產（同時算進收入，帳才對得起來） */
  async function richClub(funds = 100_000, experience = 10_000) {
    const ctx = mount()
    await flush()
    await createClub()
    const deps = tab(ctx.storage, ctx.clock, ctx.locks)
    const club = deps.store.loadClub()!
    deps.store.saveClub({ ...club, economy: { ...club.economy, assets: { funds, experience }, earned: { funds, experience } } }, club.revision)
    otherTabWrote()
    await flush()
    return ctx
  }

  it('首頁顯示球隊戰力、可升級提示與招募入口', async () => {
    await richClub()
    expect(text('.v2-power-label')).toBe(V2T.teamPower)
    expect(text('[data-action="lineup"]')).toBe(V2T.upgradeReady(14))
    expect(text('[data-action="recruit"]')).toContain(V2T.recruitEntry)
  })

  it('陣容的「養成」打開球員詳情：顯示原始、目前、下一級與成本；升級後畫面與存檔一起更新', async () => {
    const { storage } = await richClub()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    const develop = $$('.v2-develop')[0]
    const id = develop.dataset.player!
    develop.click()
    expect($('.v2-player-detail')).not.toBeNull()
    expect(text('.v2-detail-name .v2-level')).toBe('Lv.1')
    expect($$('.v2-rating-table tr[data-rating]')).toHaveLength(4)
    expect($('.v2-cost')!.getAttribute('aria-label')).toBe(V2T.upgradeCostLabel)
    $<HTMLButtonElement>('.v2-upgrade-btn')!.click()
    await flush()
    expect(text('.v2-detail-name .v2-level')).toBe('Lv.2')
    const saved = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.players.find((r: { player: { id: string } }) => r.player.id === id).level).toBe(2)
    // 關掉之後，陣容列表上的等級也更新了
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect($$('.v2-player-name .v2-level')[0].textContent).toBe('Lv.2')
  })

  it('從首頁招募：選角色 → 三位候選人 → 選一位 → 確認簽約才扣款；新球員在預備名單，可以前往陣容', async () => {
    const { storage } = await richClub()
    $<HTMLButtonElement>('[data-action="recruit"]')!.click()
    expect($('.v2-recruit-count')!.getAttribute('aria-label')).toBe(V2T.rosterCount(14, 30))
    expect($('.v2-recruit-cost')!.getAttribute('aria-label')).toBe(V2T.recruitCost(2000))
    $<HTMLButtonElement>('.v2-recruit [data-role="pitcher"]')!.click()
    await flush()
    expect($$('.v2-cand')).toHaveLength(3)
    // 還沒選：確認按鈕停用，也沒有扣款
    expect($<HTMLButtonElement>('[data-action="recruit-confirm"]')!.disabled).toBe(true)
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).players).toHaveLength(14)
    const picked = $$('.v2-cand')[1]
    const id = picked.dataset.player!
    picked.click()
    expect($$('.v2-cand')[1].getAttribute('aria-pressed')).toBe('true')
    expect(text('[data-action="recruit-confirm"]')).toBe(V2T.recruitConfirm(2000))
    $<HTMLButtonElement>('[data-action="recruit-confirm"]')!.click()
    await flush()
    expect($('.v2-recruit-card')).not.toBeNull()
    expect($('.v2-recruit-spent')!.getAttribute('aria-label')).toBe(V2T.recruitSpent(2000))
    expect($('.v2-recruit-count')!.getAttribute('aria-label')).toBe(V2T.rosterCount(15, 30))
    const saved = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.players).toHaveLength(15)
    expect(saved.players.at(-1).player.id).toBe(id)
    expect(saved.economy.spent.funds).toBe(2000)
    expect($('.v2-recruit-remain')!.getAttribute('aria-label')).toBe(V2T.recruitRemain(saved.economy.assets.funds))
    $<HTMLButtonElement>('[data-action="go-lineup"]')!.click()
    await flush()
    expect($('.v2-modal')).toBeNull()
    expect($$('.v2-reserves .v2-player')).toHaveLength(1)
  })

  it('資金不足：候選人可以看，但不能簽約、清楚提示、不扣款', async () => {
    const { storage } = await richClub(100, 0)
    $<HTMLButtonElement>('[data-action="recruit"]')!.click()
    expect(text('.v2-recruit-block')).toBe(V2T.recruitShort(1900))
    $<HTMLButtonElement>('.v2-recruit [data-role="batter"]')!.click()
    $$('.v2-cand')[0].click()
    expect($<HTMLButtonElement>('[data-action="recruit-confirm"]')!.disabled).toBe(true)
    expect(text('.v2-recruit-block')).toBe(V2T.recruitShort(1900))
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).economy.spent.funds).toBe(0)
  })
})
