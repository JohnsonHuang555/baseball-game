// @vitest-environment happy-dom
// Phase 5 的畫面：首頁聯盟卡片、挑戰下一聯盟與結果對話框、釋出預備球員（二次確認）
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, tab } from '../testkit'
import { recruit } from '../application/economyService'
import { challengeNextLeague, planChallenge } from '../application/leagueService'
import { runMatch } from '../application/matchRunner'
import { LEAGUES, PROMOTION_CONFIG } from '../domain/leagueConfig'
import type { ClubSave } from '../domain/club'
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
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const text = (sel: string) => $(sel)?.textContent ?? ''
const otherTabWrote = () => window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))

/** 建好球團；edit 可以直接改存檔（模擬已經打了很多場） */
async function mountClub(clubSeed: number, edit?: (c: ClubSave) => ClubSave) {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const locks = new FakeLockManager()
  const deps = tab(storage, clock, locks)
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(storage, clock, locks), tickMs: 0, tabId: 'test-tab' })
  await flush()
  await (await import('../application/clubLifecycle')).createClubSafely(deps, { clubName: '聯盟畫面隊', clubSeed, clubId: 'club-ui' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  otherTabWrote()
  await flush()
  return { storage, deps }
}

const eligible = (c: ClubSave): ClubSave => {
  const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
  return { ...c, league: { ...c.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle, nextMatchIndex: n } }
}

/** 找一個第一次挑戰會贏（或輸）的球團種子 */
async function seedFor(want: boolean): Promise<number> {
  const { MemoryStorage: M } = await import('../infrastructure/clubRepository')
  for (let seed = 1; seed < 200; seed++) {
    const d = tab(new M(), new ManualClock(), new FakeLockManager())
    await (await import('../application/clubLifecycle')).createClubSafely(d, { clubName: '聯盟畫面隊', clubSeed: seed, clubId: 'club-ui' })
    const plan = planChallenge(eligible(d.store.loadClub()!))
    if ((runMatch(plan.setup, plan.ai).winner === plan.userSide) === want) return seed
  }
  throw new Error('no seed')
}

describe('聯盟卡片', () => {
  it('新球團：顯示新秀聯盟、本聯盟戰績、下一級，以及還差的條件（沒有挑戰按鈕）', async () => {
    await mountClub(5)
    expect(text('.v2-league-name')).toBe(LEAGUES[0].name)
    expect(text('.v2-league-sub')).toBe(V2T.leagueNext(LEAGUES[1].name))
    expect(text('.v2-league')).toContain(V2T.leagueRecord(0, 0))
    expect($$('.v2-league-need li')).toHaveLength(2)
    expect($('[data-action="challenge"]')).toBeNull()
    expect($('[data-need="matches"] [role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('0')
    expect($('[data-need="rate"] [role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('0')
  })

  it('達到條件：出現「挑戰下一聯盟」；挑戰成功後顯示結果對話框，首頁換成新聯盟', async () => {
    const { storage } = await mountClub(await seedFor(true), eligible)
    const btn = $<HTMLButtonElement>('[data-action="challenge"]')!
    expect(btn.textContent).toBe(V2T.challengeButton)
    btn.click()
    btn.click()
    await flush()
    // 結果已經確定，先問要不要看過程；選「直接看結果」
    expect($('.v2-challenge-start')).not.toBeNull()
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect(text('.v2-challenge-verdict')).toBe(V2T.challengeWin)
    expect(text('.v2-challenge-result')).toContain(V2T.challengePromoted(LEAGUES[1].name))
    expect(text('.v2-challenge-result')).toContain(V2T.challengeReward(LEAGUES[1].promotionReward.funds, LEAGUES[1].promotionReward.experience))
    expect($$('.v2-modal-overlay')).toHaveLength(1)
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect($('.v2-modal')).toBeNull()
    expect(text('.v2-league-name')).toBe(LEAGUES[1].name)
    const saved = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    expect(saved.league).toMatchObject({ tier: 1, nextChallengeSeq: 1 })
  })

  it('挑戰失敗：結果對話框顯示失敗與建議，首頁顯示要再打幾場', async () => {
    await mountClub(await seedFor(false), eligible)
    $<HTMLButtonElement>('[data-action="challenge"]')!.click()
    await flush()
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect(text('.v2-challenge-verdict')).toBe(V2T.challengeLose)
    expect(text('.v2-challenge-result')).toContain(V2T.challengeNextLose(PROMOTION_CONFIG.retryAfterMatches))
    $<HTMLButtonElement>('.v2-modal-close')!.click()
    await flush()
    expect(text('.v2-league-need')).toContain(V2T.leagueCooldownLine(PROMOTION_CONFIG.retryAfterMatches))
  })
})

describe('過期畫面的挑戰按鈕', () => {
  it('分頁 A 顯示新秀聯盟、分頁 B 已經晉級：A 按舊按鈕被拒絕並重新載入，不會挑戰「業餘 → 挑戰者」', async () => {
    const { storage, deps } = await mountClub(await seedFor(true), eligible)
    const btn = $<HTMLButtonElement>('[data-action="challenge"]')!
    expect([btn.dataset.tier, btn.dataset.seq]).toEqual(['0', '0'])
    // 分頁 B（另一份依賴、同一個儲存）晉級，並且在業餘聯盟也達到條件；分頁 A 沒收到通知，畫面還是舊的
    await challengeNextLeague(deps, { fromTier: 0, challengeSeq: 0, requestId: 'tab-b' })
    const c = deps.store.loadClub()!
    deps.store.saveClub(eligible(c), c.revision)
    const before = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).league
    expect(before.tier).toBe(1)
    expect(text('.v2-league-name')).toBe(LEAGUES[0].name)
    btn.click()
    await flush()
    const after = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).league
    expect(after).toEqual(before)
    expect($('.v2-challenge-result')).toBeNull()
    // 重新載入：畫面換成業餘聯盟，新的按鈕帶的是新的聯盟與序號
    expect(text('.v2-league-name')).toBe(LEAGUES[1].name)
    const fresh = $<HTMLButtonElement>('[data-action="challenge"]')!
    expect([fresh.dataset.tier, fresh.dataset.seq]).toEqual(['1', '1'])
  })
})

describe('釋出球員', () => {
  it('預備球員：按「釋出球員」→ 顯示警告 → 取消不會釋出；確定後才釋出並關閉', async () => {
    const { storage, deps } = await mountClub(8, (c) => ({ ...c, economy: { ...c.economy, assets: { funds: 1e6, experience: 0 }, earned: { funds: 1e6, experience: 0 } } }))
    const { op } = await recruit(deps, { opSeq: deps.store.loadClub()!.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: deps.store.loadClub()!.recruitment.count })
    otherTabWrote()
    await flush()
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    $<HTMLButtonElement>(`.v2-reserves .v2-develop[data-player="${op.playerId}"]`)!.click()
    $<HTMLButtonElement>('[data-action="release"]')!.click()
    expect(text('.v2-release-warn')).toBe(V2T.releaseConfirm)
    $<HTMLButtonElement>('.v2-release-no')!.click()
    expect($('.v2-release-warn')).toBeNull()
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).players).toHaveLength(15)
    $<HTMLButtonElement>('[data-action="release"]')!.click()
    $<HTMLButtonElement>('[data-action="release-confirm"]')!.click()
    await flush()
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).players).toHaveLength(14)
    expect($('.v2-player-detail')).toBeNull()
    expect($$('.v2-reserves .v2-player')).toHaveLength(0)
  })

  it('上場球員的詳情：釋出按鈕停用，並說明只有預備球員可以釋出', async () => {
    await mountClub(9)
    $<HTMLButtonElement>('[data-tab="lineup"]')!.click()
    $$('.v2-develop')[0].click()
    expect($<HTMLButtonElement>('[data-action="release"]')!.disabled).toBe(true)
    expect(text('.v2-release .v2-hint')).toBe(V2T.releaseOnlyReserve)
  })
})
