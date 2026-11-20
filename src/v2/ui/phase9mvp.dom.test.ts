// @vitest-environment happy-dom
// Phase 9 PR 4：單場 MVP 的畫面：戰報的 MVP 區塊（真實數據、成長進度、點開球員）、舊比賽「未記錄」、
// 球員詳情的 MVP 紀錄與能力表（原始／等級／MVP 分開）、歡迎回來摘要的 MVP 統計與能力提升
import { afterEach, describe, expect, it } from 'vitest'
import fixtureV12 from '../domain/__fixtures__/club-v12-phase9.json'
import { createClubSafely } from '../application/clubLifecycle'
import type { ClubSave } from '../domain/club'
import { mvpToNext, unpackMvp, withMvpBonus } from '../domain/mvp'
import { leveled } from '../domain/progression'
import { recordOf } from '../domain/roster'
import { batOf } from '../domain/stats'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../testkit'
import { RATING_FULL } from '../../ui/strings'
import { openV2, type V2App } from './app'
import { V2T } from './strings'
import { WELCOME_GROWTH_ROWS } from './mvpView'

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
const click = async (sel: string | HTMLElement | null) => {
  const n = typeof sel === 'string' ? $(sel) : sel
  if (!n) throw new Error(`找不到 ${String(sel)}`)
  n.click()
  await flush()
}
interface Env {
  storage: MemoryStorage
  clock: ManualClock
  locks: FakeLockManager
}
async function create(hours: number, edit?: (c: ClubSave) => ClubSave): Promise<Env> {
  const env = { storage: new MemoryStorage(), clock: new ManualClock(T0), locks: new FakeLockManager() }
  const deps = tab(env.storage, env.clock, env.locks)
  await createClubSafely(deps, { clubName: 'MVP 隊', clubSeed: 31, clubId: 'club-mvp-ui' })
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  if (hours) {
    env.clock.advance(hours * HOUR)
    const { settleDue } = await import('../application/settlementService')
    await settleDue(deps)
  }
  return env
}
async function open(env: Env, closeModals = true): Promise<void> {
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'tab-mvp' })
  await flush(80)
  if (closeModals) {
    $$('.v2-modal-close').forEach((b) => b.click())
    await flush()
  }
}
const saved = (env: Env) => JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const openLatestReport = async () => {
  await click('.v2-nav-btn[data-tab="reports"]')
  await click('.v2-report-row')
}

describe('戰報：本場 MVP', () => {
  it('名字、頭像、MVP 標示、角色、得獎原因、真實的單場數據、這次的成長進度；點了打開球員詳情', async () => {
    const env = await create(1)
    await open(env)
    await openLatestReport()
    const m = saved(env).recentMatches.at(-1)!
    const mvp = unpackMvp(m.mvp!)
    const card = $('.v2-report-mvp')!
    expect(card.dataset.player).toBe(mvp.playerId)
    expect(card.querySelector('h3')!.textContent).toBe(V2T.mvpTitle)
    expect(card.querySelector('.v2-report-mvp-avatar svg')).not.toBeNull()
    expect(card.querySelector('.v2-mvp-badge')!.textContent).toBe('MVP')
    expect(text('.v2-report-mvp-name strong')).toBe(recordOf(saved(env), mvp.playerId)!.player.name)
    expect(text('.v2-report-mvp-role')).toBe(V2T.mvpRole[mvp.role])
    // 單場數據是這場的 lines（不是生涯、不是目前的能力）
    const line = text('.v2-report-mvp-line')
    if (mvp.role === 'batter') {
      const b = batOf(m.lines!.bat.find((r) => r[0] === mvp.playerId)!.slice(1) as number[])
      expect(line).toContain(`${b.ab} 打數 ${b.h} 安打`)
    } else expect(line).toMatch(/局/)
    expect(text('.v2-report-mvp-reason')).toMatch(/MVP 評分/)
    expect(text('.v2-report-mvp-progress')).toBe(V2T.mvpProgress(mvp.count, 10 - (mvp.count % 10)))
    // 點 MVP：打開球員詳情的「球員能力」（MVP 紀錄在那裡）
    await click('[data-action="mvp-player"]')
    expect($('.v2-player-sheet')).not.toBeNull()
    expect($('[data-tab="ability"]')!.getAttribute('aria-selected')).toBe('true')
    expect($('.v2-mvp-section')).not.toBeNull()
  })

  it('這場觸發成長：顯示「MVP 累積 10 次，○○ +0.1」與生效場次', async () => {
    // 全隊都已經 9 次：第一場的 MVP 就會成長
    const env = await create(0.5, (c) => ({ ...c, players: c.players.map((r) => ({ ...r, mvp: { count: 9, grants: [] } })) }))
    const c = saved(env)
    const first = c.recentMatches[0]
    const mvp = unpackMvp(first.mvp!)
    expect(mvp.growth).not.toBeNull()
    await open(env)
    await click('.v2-nav-btn[data-tab="reports"]')
    const rows = $$('.v2-report-row')
    await click(rows[rows.length - 1])
    expect(text('.v2-report-mvp-progress')).toContain(V2T.mvpGrowth(10, RATING_FULL[mvp.growth as keyof typeof RATING_FULL]))
    expect(text('.v2-report-mvp-progress')).toContain(V2T.mvpGrowthFrom(first.matchIndex + 2))
    expect($('.v2-report-mvp-progress.grew')).not.toBeNull()
  })

  it('舊比賽（V13 之前結算）：顯示「未記錄」與說明，不用目前的能力或舊數據補算', async () => {
    const env = { storage: new MemoryStorage(), clock: new ManualClock(fixtureV12.idle.anchorMs), locks: new FakeLockManager() }
    env.storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(fixtureV12))
    await open(env)
    await openLatestReport()
    const card = $('.v2-report-mvp')!
    expect(card.dataset.player).toBeUndefined()
    expect(card.textContent).toContain(V2T.mvpNone)
    expect(card.textContent).toContain(V2T.mvpNoneNote)
    expect(saved(env).recentMatches.every((m) => m.mvp === undefined)).toBe(true)
  })
})

describe('球員詳情：MVP 紀錄與能力表', () => {
  it('生涯次數、下一次成長的進度、各項加成與總加成；能力表把原始／等級／MVP 分開，「目前」= 比賽用的有效能力', async () => {
    let id = ''
    const env = await create(0, (c) => {
      id = c.roster.lineup[0].playerId
      return { ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, level: 6, mvp: { count: 27, grants: [{ rating: 'contact', atMatch: 3 }, { rating: 'contact', atMatch: 9 }] } } : r)) }
    })
    await open(env)
    const { openPlayerDetail } = await import('./playerView')
    openPlayerDetail(app!.controller, id)
    await flush()
    const rec = recordOf(saved(env), id)!
    expect(text('.v2-mvp-fact[data-key="count"] dd')).toBe(V2T.mvpCareerCount(27))
    expect(mvpToNext(rec)).toBe(3)
    expect(text('.v2-mvp-fact[data-key="next"] .v2-num')).toBe(V2T.mvpNextValue(7, 10))
    expect($('.v2-mvp-bar')!.getAttribute('aria-valuenow')).toBe('7')
    expect(text('.v2-mvp-bonus-chip[data-rating="contact"]')).toBe(`${RATING_FULL.contact} +0.2`)
    expect(text('.v2-mvp-bonus-total')).toBe(V2T.mvpBonusTotal(2, 5))
    // 能力表
    const heads = $$('.v2-rating-table thead th').map((th) => th.textContent)
    expect(heads.slice(1, 5)).toEqual([V2T.baseRating, V2T.levelGrowthCol, V2T.mvpCol, V2T.currentRatingLong])
    const row = $('.v2-rating-table tr[data-rating="contact"]')!
    expect(row.querySelector('td.mvp')!.textContent).toBe('+0.2')
    const eff = withMvpBonus(leveled(rec.player, 6), rec).ratings as unknown as Record<string, number>
    expect(row.querySelector('td.current .v2-num')!.textContent).toBe(eff.contact.toFixed(2))
    expect($('.v2-rating-table tr[data-rating="power"] td.mvp')!.textContent).toBe('—')
  })

  it('成長已達上限：顯示「已達上限」、+0.5／+0.5，說明之後只累計次數', async () => {
    let id = ''
    const env = await create(0, (c) => {
      id = c.roster.starter
      const grants = (['control', 'stuff', 'control', 'stuff', 'control'] as const).map((rating, i) => ({ rating, atMatch: i }))
      return { ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, mvp: { count: 61, grants } } : r)) }
    })
    await open(env)
    const { openPlayerDetail } = await import('./playerView')
    openPlayerDetail(app!.controller, id)
    await flush()
    expect(text('.v2-mvp-fact[data-key="next"] dd')).toBe(V2T.mvpMaxed)
    expect(text('.v2-mvp-bonus-total')).toBe(V2T.mvpBonusTotal(5, 5))
    expect(text('.v2-mvp-section')).toContain(V2T.mvpCappedRule)
  })
})

describe('歡迎回來摘要：MVP', () => {
  it('打者／投手次數、得獎最多的球員、這批的能力提升（不把 96 場逐一列出）；點名字打開球員詳情', async () => {
    const env = await create(0, (c) => ({ ...c, players: c.players.map((r) => ({ ...r, mvp: { count: 9, grants: [] } })) }))
    env.clock.advance(8 * HOUR)
    await open(env, false)
    const c = saved(env)
    expect(c.idle.nextMatchIndex).toBe(96)
    const mvps = c.recentMatches.filter((m) => m.mvp).map((m) => unpackMvp(m.mvp!))
    expect($$('.v2-welcome-modal')).toHaveLength(1)
    const box = $('.v2-welcome-mvp')!
    expect(box.textContent).toContain(V2T.welcomeMvpTitle)
    // 摘要的次數用的是這批 96 場（近期比賽只留 50 場，所以用總數驗證）
    const counts = text('.v2-welcome-mvp-counts').match(/打者 (\d+) 次・投手 (\d+) 次/)!
    expect(Number(counts[1]) + Number(counts[2])).toBe(96)
    // 能力提升：一位球員一行（同一位可能成長兩次以上，合併），最多 5 位，其他的合併成一行說明
    const grown = c.players.filter((p) => (p.mvp?.grants.length ?? 0) > 0)
    expect(grown.length).toBeGreaterThan(WELCOME_GROWTH_ROWS)
    expect(box.querySelectorAll('.v2-welcome-mvp-growth li').length).toBe(WELCOME_GROWTH_ROWS)
    expect(box.textContent).toContain(V2T.welcomeMvpMore(grown.length - WELCOME_GROWTH_ROWS))
    const twice = grown.find((p) => p.mvp!.grants.length >= 2 && [...box.querySelectorAll<HTMLElement>('.v2-welcome-mvp-growth li')].some((li) => li.dataset.player === p.player.id))
    if (twice) expect(box.querySelector(`.v2-welcome-mvp-growth li[data-player="${twice.player.id}"]`)!.textContent).toContain(`MVP 累積 ${twice.mvp!.count - (twice.mvp!.count % 10)} 次`)
    expect(mvps.some((m) => m.growth)).toBe(true)
    const top = $('.v2-welcome-mvp-top .v2-link')!
    expect(top.textContent).toMatch(/得獎最多：.+（\d+ 次）/)
    await click(top)
    expect($('.v2-player-sheet')).not.toBeNull()
  })
})
