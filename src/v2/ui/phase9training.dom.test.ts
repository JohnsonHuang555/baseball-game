// @vitest-environment happy-dom
// Phase 9 PR 3：球員詳情的「特性養成」：特性分類、潛能池、選擇 → 確認 → 開始、訓練中（進度條、剩餘場數）、
// 取消確認、負面改善、資源不足、訓練槽占用、多分頁更新、訓練完成（球員詳情與歡迎回來摘要）
import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { startTraining } from '../application/economyService'
import type { ClubSave } from '../domain/club'
import { recordOf } from '../domain/roster'
import { TRAINING_CONFIG, effectiveTraits, potentialPool, trainingClass, trainingOptions } from '../domain/traitTraining'
import { TRAIT_NAMES } from '../../ui/strings'
import type { TraitId } from '../../sim/traits'
import { openV2, type V2App } from './app'
import type { ReplayStage } from './replayView'
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
const click = async (sel: string) => {
  $<HTMLButtonElement>(sel)!.click()
  await flush()
}
const stage = (): ReplayStage => {
  const anim = () => Promise.resolve()
  return { elements: [document.createElement('canvas')], setColors: () => undefined, align: anim, sync: () => undefined, pitch: anim, pitchResult: anim, play: anim, run: anim, cancel: () => undefined, resize: () => undefined, alignment: 'normal' } as unknown as ReplayStage
}

interface Env {
  storage: MemoryStorage
  clock: ManualClock
  locks: FakeLockManager
}
async function open(env: Env): Promise<void> {
  app?.close()
  document.body.replaceChildren()
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'tab-a', replayStage: stage, replayTimeScale: 0 })
  await flush()
  $$('.v2-modal-close').forEach((b) => b.click())
  await flush()
}
async function setup(edit?: (c: ClubSave) => ClubSave): Promise<Env> {
  const env: Env = { storage: new MemoryStorage(), clock: new ManualClock(T0), locks: new FakeLockManager() }
  const deps = tab(env.storage, env.clock, env.locks)
  await createClubSafely(deps, { clubName: '養成隊', clubSeed: 42, clubId: 'club-train-ui' })
  const c = deps.store.loadClub()!
  deps.store.saveClub(edit ? edit(c) : c, c.revision)
  await open(env)
  return env
}
const load = (env: Env) => JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const rich = (c: ClubSave): ClubSave => ({ ...c, economy: { ...c.economy, assets: { funds: 50_000, experience: 5_000 }, earned: { funds: 50_000, experience: 5_000 } } })
async function detail(id: string): Promise<void> {
  const { openPlayerDetail } = await import('./playerView')
  openPlayerDetail(app!.controller, id)
  await flush()
}
/** 打者裡有負面特性的第一位（沒有就給第一棒一個「扇風機」） */
function withNegative(c: ClubSave): { club: ClubSave; id: string; neg: TraitId } {
  const n = structuredClone(c)
  const ids = n.roster.lineup.map((s) => s.playerId)
  const found = ids.map((id) => recordOf(n, id)!).find((r) => r.player.traits.some((t) => ['clutchBad', 'freeSwinger', 'errorProne'].includes(t)))
  if (found) return { club: n, id: found.player.id, neg: found.player.traits.find((t) => ['clutchBad', 'freeSwinger', 'errorProne'].includes(t))! }
  const r = recordOf(n, ids[0])!
  r.player.traits = ['freeSwinger']
  return { club: n, id: ids[0], neg: 'freeSwinger' }
}

describe('球員詳情：特性養成', () => {
  it('原生、習得、負面三組；潛能池的每一項有費用、所需場數、效果說明；同一位球員重開還是同一池', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    await detail(id)
    expect($('.v2-training')).not.toBeNull()
    expect($$('.v2-training-group').map((g) => g.dataset.group)).toEqual(['native', 'learned', 'negative'])
    const pool = potentialPool(load(env).clubSeed, recordOf(load(env), id)!.player)
    const learnRows = $$('.v2-training-option[data-kind="learn"]')
    expect(learnRows.map((r) => r.dataset.trait)).toEqual(pool)
    for (const row of learnRows) {
      expect(row.querySelector('.v2-training-cost')!.textContent).toMatch(/[0-9,]+.*[0-9,]+/)
      expect(row.querySelector('.v2-training-need')!.textContent).toMatch(/正式出賽 \d+ 場/)
      expect(row.querySelector('.v2-training-desc')!.textContent!.length).toBeGreaterThan(4)
    }
    expect(text('.v2-training')).toContain(V2T.trainingPoolNote)
  })

  it('選擇 → 確認（費用、場數、規則）→ 開始：扣款、顯示訓練中（目標、進度條、0／N、還差 N 場）', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    await detail(id)
    const first = $('.v2-training-option[data-kind="learn"]:not(.blocked)')!
    const trait = first.dataset.trait as TraitId
    first.querySelector<HTMLButtonElement>('[data-action="training-pick"]')!.click()
    await flush()
    expect(text('.v2-training-confirm')).toContain(TRAIT_NAMES[trait])
    expect(text('.v2-training-confirm')).toContain(V2T.trainingRules[1])
    // 「再想想」：回到列表，沒有扣款
    $<HTMLButtonElement>('.v2-training-confirm .btn-white')!.click()
    await flush()
    expect($('.v2-training-confirm')).toBeNull()
    expect(load(env).training.active).toBeNull()
    $<HTMLButtonElement>(`.v2-training-option[data-trait="${trait}"] [data-action="training-pick"]`)!.click()
    await flush()
    await click('[data-action="training-start"]')
    const c = load(env)
    expect(c.training.active).toMatchObject({ playerId: id, trait, progress: 0 })
    expect(c.economy.assets.funds).toBe(50_000 - TRAINING_CONFIG[trainingClass(trait)].cost.funds)
    expect($('.v2-training-active')!.dataset.trait).toBe(trait)
    expect(text('.v2-training-progress')).toBe(V2T.trainingProgress(0, c.training.active!.need))
    expect(text('.v2-training-remain')).toBe(V2T.trainingRemain(c.training.active!.need))
    expect($('.v2-training-bar')!.getAttribute('aria-valuenow')).toBe('0')
  })

  it('訓練中：比賽打完進度跟著更新；取消要再確認一次，確認後釋放訓練槽、不退款', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    const trait = trainingOptions(42, recordOf(load(env), id)!, { active: null, assets: { funds: 1e9, experience: 1e9 } }).find((o) => o.kind === 'learn')!.trait
    await startTraining(tab(env.storage, env.clock, env.locks), { opSeq: 0, playerId: id, trait, kind: 'learn' })
    await open(env)
    env.clock.advance(1 * HOUR)
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush(60)
    $$('.v2-modal-close').forEach((b) => b.click())
    await flush()
    await detail(id)
    const a = load(env).training.active!
    expect(a.progress).toBeGreaterThan(0)
    expect(text('.v2-training-progress')).toBe(V2T.trainingProgress(a.progress, a.need))
    const spent = load(env).economy.spent
    await click('[data-action="training-cancel"]')
    expect(text('.v2-training-cancel-confirm')).toContain(V2T.trainingCancelConfirm)
    // 「繼續訓練」：沒有取消
    $<HTMLButtonElement>('.v2-training-cancel-confirm .btn-white')!.click()
    await flush()
    expect(load(env).training.active).not.toBeNull()
    await click('[data-action="training-cancel"]')
    await click('[data-action="training-cancel-confirm"]')
    expect(load(env).training.active).toBeNull()
    expect(load(env).economy.spent).toEqual(spent)
    expect($('.v2-training-active')).toBeNull()
  })

  it('負面特性改善：列在「改善」，完成後劃掉並標「已改善」；比賽用的特性不再有它', async () => {
    const env = await setup((c) => rich(withNegative(c).club))
    const { id, neg } = withNegative(load(env))
    await detail(id)
    const row = $(`.v2-training-option[data-kind="improve"][data-trait="${neg}"]`)!
    expect(row.querySelector('.v2-training-class')!.textContent).toBe(V2T.trainingClassNames.improve)
    expect(row.querySelector('.v2-training-need')!.textContent).toBe(V2T.trainingNeed(TRAINING_CONFIG.improve.appearances))
    // 直接寫一份已改善的資料（模擬訓練完成），畫面重畫
    const c = load(env)
    const r = recordOf(c, id)!
    r.dev = { learned: [], removed: [neg] }
    c.training.recent = [{ playerId: id, playerName: r.player.name, trait: neg, kind: 'improve', completedAtMatch: 0, effectiveFromMatch: 1 }]
    env.storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(c))
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
    expect($('.v2-training-improved')).not.toBeNull()
    expect(text('.v2-training-improved')).toContain(V2T.trainingImproved)
    expect(text('.v2-training-done')).toContain(V2T.trainingDoneTitle(neg, 'improve'))
    expect(text('.v2-training-done')).toContain(V2T.trainingEffectiveFrom(2))
    expect(effectiveTraits(recordOf(load(env), id)!)).not.toContain(neg)
    expect($(`.v2-training-option[data-kind="improve"][data-trait="${neg}"] .v2-training-block`)!.dataset.block).toBe('improved')
  })

  it('不能訓練的原因寫清楚：資源不足；訓練槽被別人用（列出是誰在訓練什麼）', async () => {
    const env = await setup()
    const id = load(env).roster.lineup[0].playerId
    await detail(id)
    const blocks = $$('.v2-training-option .v2-training-block').map((b) => b.dataset.block)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((b) => b === 'insufficient')).toBe(true)
    expect(text('.v2-training-block')).toBe(V2T.trainingBlockText.insufficient)
    // 另一位球員在訓練
    const env2 = await setup(rich)
    const c2 = load(env2)
    const other = c2.roster.lineup[1].playerId
    const t = trainingOptions(42, recordOf(c2, other)!, { active: null, assets: { funds: 1e9, experience: 1e9 } }).find((o) => o.kind === 'learn')!.trait
    await startTraining(tab(env2.storage, env2.clock, env2.locks), { opSeq: 0, playerId: other, trait: t, kind: 'learn' })
    await open(env2)
    await detail(c2.roster.lineup[0].playerId)
    expect(text('.v2-training-other')).toBe(V2T.trainingOther(recordOf(c2, other)!.player.name, t))
    expect($$('.v2-training-option .v2-training-block').every((b) => b.dataset.block === 'slot-busy' || b.dataset.block === 'owned')).toBe(true)
  })

  it('多分頁：別的分頁開始了訓練，這邊的畫面跟著更新成「訓練槽使用中」，按下舊的確認也不會重複扣款', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    await detail(id)
    const trait = $('.v2-training-option[data-kind="learn"]:not(.blocked)')!.dataset.trait as TraitId
    $<HTMLButtonElement>(`.v2-training-option[data-trait="${trait}"] [data-action="training-pick"]`)!.click()
    await flush()
    // 另一個分頁先開始了另一位的訓練
    const c = load(env)
    const other = c.roster.lineup[2].playerId
    const ot = trainingOptions(42, recordOf(c, other)!, { active: null, assets: c.economy.assets }).find((o) => o.kind === 'learn')!.trait
    await startTraining(tab(env.storage, env.clock, env.locks), { opSeq: c.economy.nextOpSeq, playerId: other, trait: ot, kind: 'learn' })
    window.dispatchEvent(Object.assign(new Event('storage'), { key: CLUB_STORAGE_KEY, newValue: null }))
    await flush()
    expect(text('.v2-training-other')).toContain(TRAIT_NAMES[ot])
    // 確認框已經消失（那一項現在被擋下），不會再扣第二次
    expect($('[data-action="training-start"]')).toBeNull()
    expect(load(env).economy.recentOps.filter((o) => o.kind === 'trainStart')).toHaveLength(1)
  })

  it('訓練中的球員不能釋出：按鈕停用並說明要先取消訓練', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    const t = trainingOptions(42, recordOf(load(env), id)!, { active: null, assets: { funds: 1e9, experience: 1e9 } }).find((o) => o.kind === 'learn')!.trait
    await startTraining(tab(env.storage, env.clock, env.locks), { opSeq: 0, playerId: id, trait: t, kind: 'learn' })
    await open(env)
    await detail(id)
    expect($<HTMLButtonElement>('[data-action="release"]')!.disabled).toBe(true)
  })
})

describe('訓練完成通知', () => {
  it('離線期間完成：歡迎回來摘要列出球員、特性與生效場次（同一個對話框，不另外彈）', async () => {
    const env = await setup(rich)
    const id = load(env).roster.lineup[0].playerId
    const opt = trainingOptions(42, recordOf(load(env), id)!, { active: null, assets: { funds: 1e9, experience: 1e9 } }).find((o) => o.kind === 'learn')!
    const t = opt.trait
    const deps = tab(env.storage, env.clock, env.locks)
    await startTraining(deps, { opSeq: 0, playerId: id, trait: t, kind: 'learn' })
    app?.close()
    // 先打到差 10 場（第一棒每場都出場）：離開 8 小時就一定會完成
    const { settleDue } = await import('../application/settlementService')
    while (load(env).idle.nextMatchIndex < opt.need - 10) {
      env.clock.advance(Math.min(96, opt.need - 10 - load(env).idle.nextMatchIndex) * 5 * 60_000)
      await settleDue(deps)
    }
    expect(load(env).training.active!.progress).toBe(opt.need - 11)
    document.body.replaceChildren()
    env.clock.advance(8 * HOUR)
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'tab-a', replayStage: stage, replayTimeScale: 0 })
    await flush(80)
    const done = load(env).training.recent.at(-1)!
    expect(done).toMatchObject({ playerId: id, trait: t })
    expect($$('.v2-welcome-modal')).toHaveLength(1)
    expect(text('.v2-welcome-training')).toContain(V2T.welcomeTrainings)
    expect(text('.v2-welcome-training li')).toContain(V2T.trainingDoneTitle(t, 'learn'))
    expect(text('.v2-welcome-training li')).toContain(V2T.trainingEffectiveFrom(done.effectiveFromMatch + 1))
  })
})
