// @vitest-environment happy-dom
// Phase 10 PR 1 的畫面：首頁的傳奇總冠軍賽卡片（資格、缺的條件、進行中、冷卻、降級、奪冠）、
// 開始前確認、打完一場「觀看或看結果」、單場與系列賽結果、過期與唯讀
import { afterEach, describe, expect, it } from 'vitest'
import fixtureV13 from '../domain/__fixtures__/club-v13-phase9.json'
import { startSeries } from '../application/championshipService'
import type { ClubSave } from '../domain/club'
import { relegate } from '../domain/league'
import { migrateToLatest } from '../domain/migration'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { openV2, type V2App } from './app'

let app: V2App | null = null
afterEach(() => {
  app?.close()
  app = null
  document.body.replaceChildren()
})

const flush = async (times = 30) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0))
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)]
const media = (desk: boolean) => {
  const real = globalThis.matchMedia
  globalThis.matchMedia = ((q: string) => ({ matches: desk && q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia
  return () => (globalThis.matchMedia = real)
}

interface Env {
  storage: MemoryStorage
  clock: ManualClock
  locks: FakeLockManager
}
function env(edit?: (c: ClubSave) => ClubSave): Env {
  const base = migrateToLatest(structuredClone(fixtureV13))
  const club = edit ? edit(base) : base
  const storage = new MemoryStorage()
  storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club))
  return { storage, clock: new ManualClock(club.idle.anchorMs), locks: new FakeLockManager() }
}
async function open(e: Env, desk = false): Promise<void> {
  const restore = media(desk)
  try {
    const root = document.createElement('div')
    document.body.append(root)
    app = openV2(root, { deps: tab(e.storage, e.clock, e.locks), tickMs: 0, tabId: 'tab-p10' })
    await flush()
    $$('.v2-modal-close').forEach((b) => b.click())
    await flush()
  } finally {
    restore()
  }
}
const saved = (e: Env) => JSON.parse(e.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const card = () => $('.v2-champ')
const click = async (sel: string) => {
  const b = $(sel)
  expect(b, sel).not.toBeNull()
  b!.click()
  await flush()
}

describe('首頁的冠軍賽卡片', () => {
  it('還沒到過傳奇：不顯示', async () => {
    const e = { storage: new MemoryStorage(), clock: new ManualClock(T0), locks: new FakeLockManager() }
    await createClubSafely(tab(e.storage, e.clock, e.locks), { clubName: '新秀隊', clubSeed: 3, clubId: 'club-new' })
    await open(e)
    expect($('.v2-dashboard')).not.toBeNull()
    expect(card()).toBeNull()
  })

  it('有資格：顯示可以挑戰與「開始系列賽」；按下先確認規則，確認後開始，卡片變成進行中', async () => {
    const e = env()
    await open(e)
    expect(card()!.dataset.status).toBe('eligible')
    expect(card()!.textContent).toContain('已經達到資格')
    await click('[data-action="champ-start"]')
    expect($('.v2-champ-modal')!.textContent).toContain('七戰四勝')
    expect(saved(e).championship.active).toBeNull()
    await click('[data-action="champ-confirm"]')
    expect(saved(e).championship.active).not.toBeNull()
    expect(card()!.dataset.status).toBe('in-progress')
    expect(card()!.textContent).toContain('目前戰績 0 勝 0 敗')
    expect(card()!.textContent).toContain('再贏 4 場即可奪冠')
    expect(card()!.textContent).toContain('傳奇王朝')
    expect($('[data-action="champ-play"]')!.textContent).toContain('打第 1 場')
    expect($$('.v2-champ-game.todo')).toHaveLength(7)
  })

  it('打一場：先問要觀看或看結果（不先揭曉）；看結果後顯示比分與系列賽戰績，卡片更新、可以觀看這一場', async () => {
    const e = env()
    await startSeries(tab(e.storage, e.clock, e.locks), { seriesSeq: 0 })
    await open(e)
    await click('[data-action="champ-play"]')
    const g = saved(e).championship.lastGame!.game
    expect($('.v2-champ-modal')!.textContent).toContain('第 1 場已經打完')
    expect($('.v2-champ-modal')!.textContent).not.toContain(`${g.runsFor} : ${g.runsAgainst}`)
    // 直接看結果
    const show = $$('.v2-champ-modal button').find((b) => b.textContent?.includes('直接看結果'))!
    show.click()
    await flush()
    const result = $('.v2-champ-modal')!
    expect(result.textContent).toContain(`${g.runsFor} : ${g.runsAgainst}`)
    expect(result.querySelector('.v2-champ-verdict')!.textContent).toBe(g.won ? '第 1 場勝利！' : '第 1 場落敗')
    expect(result.textContent).toContain(`目前戰績 ${g.won ? 1 : 0} 勝 ${g.won ? 0 : 1} 敗`)
    $$('.v2-champ-modal button').find((b) => b.textContent === '繼續')!.click()
    await flush()
    expect($$('.v2-champ .v2-champ-game.todo')).toHaveLength(6)
    expect($('[data-action="champ-play"]')!.textContent).toContain('打第 2 場')
    expect($('[data-action="champ-watch"]')!.textContent).toContain('觀看第 1 場')
  })

  it('條件不足：列出每個條件與還差幾個（積分不足）', async () => {
    const e = env((c) => ({ ...c, league: { ...c.league, points: 60 } }))
    await open(e)
    expect(card()!.dataset.status).toBe('not-eligible')
    expect(card()!.textContent).toContain('還差 1 個條件')
    expect($('.v2-champ-need [data-need="points"]')!.className).not.toContain('done')
    expect($('.v2-champ-need [data-need="matches"]')!.className).toContain('done')
    expect($('[data-action="champ-start"]')).toBeNull()
  })

  it('冷卻中：顯示還要幾場；上一個系列賽的比分', async () => {
    const e = env((c) => ({
      ...c,
      championship: { ...c.championship, nextSeriesSeq: 1, readyAt: c.idle.nextMatchIndex + 40, history: [{ seq: 0, id: `${c.clubId}#s0`, opponentName: '傳奇王朝', won: false, wins: 3, losses: 4, startedAt: 0, completedAt: 0, completedAtMatch: c.idle.nextMatchIndex, scores: [[3, 1], [1, 2], [4, 0], [0, 5], [2, 1], [1, 3], [2, 4]] }] },
    }))
    await open(e)
    expect(card()!.dataset.status).toBe('cooldown')
    expect(card()!.textContent).toContain('再打 40 場一般比賽')
    expect(card()!.textContent).toContain('上一個系列賽：落敗（3 勝 4 敗）')
  })

  it('降級：還沒開始的系列賽失去資格，說明要回到傳奇；已經拿到的冠軍照樣顯示', async () => {
    const e = env((c) => {
      const r = { ...c, league: relegate(c.league, c.idle.nextMatchIndex, 0) }
      return {
        ...r,
        championship: {
          ...r.championship,
          nextSeriesSeq: 1,
          titles: 1,
          readyAt: 0,
          firstTitle: { seriesSeq: 0, seriesId: `${c.clubId}#s0`, at: Date.UTC(2026, 10, 3), wins: 4, losses: 2, clubId: c.clubId, clubName: c.clubName, matchIndexAt: c.idle.nextMatchIndex },
          history: [{ seq: 0, id: `${c.clubId}#s0`, opponentName: '傳奇王朝', won: true, wins: 4, losses: 2, startedAt: 0, completedAt: 0, completedAtMatch: c.idle.nextMatchIndex, scores: [[3, 1], [1, 2], [4, 0], [0, 5], [2, 1], [5, 3]] }],
        },
      }
    })
    await open(e)
    expect(card()!.dataset.status).toBe('locked')
    expect(card()!.textContent).toContain('回到傳奇聯盟')
    expect(card()!.textContent).toContain('恭喜！你已獲得傳奇總冠軍！')
    expect(card()!.textContent).toContain('首次奪冠：2026/11/3・系列賽 4 勝 2 敗')
    expect(card()!.textContent).toContain('傳奇總冠軍')
  })

  it('打完系列賽奪冠：結果顯示「恭喜！你已獲得傳奇總冠軍！」與系列賽比分，卡片顯示冠軍與首次奪冠日期（沒有彩帶）', async () => {
    const e = env()
    const d = tab(e.storage, e.clock, e.locks)
    await startSeries(d, { seriesSeq: 0 })
    // 前三場用劇本贏下來（正式模擬，比分對調），留最後一場用畫面打
    const { playSeriesGame } = await import('../application/championshipService')
    const { runMatch } = await import('../application/matchRunner')
    const win: typeof d = { ...d, batch: { ...d.batch, simulate: (plan) => {
      const r = runMatch(plan.setup, plan.ai)
      if (!plan.matchId.includes('#s') || r.winner === plan.userSide) return r
      return { ...r, winner: plan.userSide, score: { home: r.score.away, away: r.score.home } }
    } } }
    for (let g = 1; g <= 3; g++) await playSeriesGame(win, { seriesSeq: 0, game: g })
    const before = saved(e)
    await playSeriesGame(win, { seriesSeq: 0, game: 4 })
    expect(saved(e).championship.titles).toBe(1)
    await open(e)
    expect(card()!.className).toContain('champion')
    expect(card()!.textContent).toContain('恭喜！你已獲得傳奇總冠軍！')
    expect(card()!.textContent).toContain('系列賽 4 勝 0 敗')
    expect(card()!.textContent).toContain('上一個系列賽：奪冠（4 勝 0 敗）')
    expect(document.querySelector('.celebrate')).toBeNull()
    expect(before.championship.active!.games).toHaveLength(3)
  })

  it('過期：別的分頁已經開始系列賽，這個分頁按開始會被拒絕並重新讀取', async () => {
    const e = env()
    await open(e)
    await startSeries(tab(e.storage, e.clock, e.locks), { seriesSeq: 0, requestId: 'other-tab' })
    await click('[data-action="champ-start"]')
    await click('[data-action="champ-confirm"]')
    expect($('.toast')!.textContent).toContain('已重新讀取')
    expect(card()!.dataset.status).toBe('in-progress')
    expect(saved(e).championship.nextSeriesSeq).toBe(1)
  })

  it('電腦版：冠軍賽卡片在第三欄、聯盟卡下面', async () => {
    const e = env()
    await open(e, true)
    const champ = card()!
    expect(champ.previousElementSibling?.classList.contains('v2-league')).toBe(true)
  })
})
