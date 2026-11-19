// @vitest-environment happy-dom
// Phase 8 的畫面：陣容頁的「球員數據」排行、球員詳情的比賽數據分頁（期間切換、樣本少、空資料、舊存檔、已釋出）、
// 縮寫說明、戰報的打擊／投手表（新格式可點名字、舊格式「未記錄」）、招募比較的實際數據（候選人不估算）
import { afterEach, describe, expect, it } from 'vitest'
import fixtureV9 from '../domain/__fixtures__/club-v9-phase7b.json'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from '../application/clubLifecycle'
import { releasePlayer } from '../application/economyService'
import { leaderboard, periodTotals } from '../application/statsQuery'
import type { ClubSave } from '../domain/club'
import { battingRates, fmtEra, fmtRate, pitchingRates } from '../domain/stats'
import { openV2, type V2App } from './app'
import { ST } from './statsStrings'

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
const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
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
  await createClubSafely(deps, { clubName: '數據隊', clubSeed: 31, clubId: 'club-p8' })
  if (hours) {
    env.clock.advance(hours * HOUR)
    const { settleDue } = await import('../application/settlementService')
    await settleDue(deps)
  }
  if (edit) {
    const c = deps.store.loadClub()!
    deps.store.saveClub(edit(c), c.revision)
  }
  return env
}

async function open(env: Env): Promise<void> {
  const root = document.createElement('div')
  document.body.append(root)
  app = openV2(root, { deps: tab(env.storage, env.clock, env.locks), tickMs: 0, tabId: 'tab-p8' })
  await flush()
  $$('.v2-modal-close').forEach((b) => b.click())
  await flush()
}
const saved = (env: Env) => JSON.parse(env.storage.getItem(CLUB_STORAGE_KEY)!) as ClubSave
const goBoard = async () => {
  await click('.v2-nav-btn[data-tab="lineup"]')
  await click('[data-view="stats"]')
}
const rowIds = () => $$('.v2-board-row:not(.head)').map((r) => r.dataset.player!)

describe('陣容 → 球員數據（隊內排行）', () => {
  it('入口在陣容頁裡，不新增底部分頁；預設打者、最近 30 場、OPS 由高到低；樣本不足、沒出場另外列', async () => {
    const env = await create(4)
    await open(env)
    expect($$('.v2-nav-btn')).toHaveLength(4)
    await goBoard()
    expect($('[data-view="stats"]')!.getAttribute('aria-selected')).toBe('true')
    expect($('.v2-board-role [aria-checked="true"]')!.dataset.value).toBe('batter')
    expect($('.v2-board-period [aria-checked="true"]')!.dataset.value).toBe('last30')
    expect($('[data-sort="ops"]')!.getAttribute('aria-pressed')).toBe('true')
    const club = saved(env)
    const lb = leaderboard(club, 'batter', 'last30', 'ops')
    expect(rowIds()).toEqual([...lb.ranked, ...lb.smallSample, ...lb.none].map((r) => r.playerId))
    // 第一名的 OPS 跟公式一致；列上有頭像、等級、先發／板凳
    const first = $('.v2-board-row:not(.head)')!
    expect(first.querySelector('.v2-board-num.cur')!.textContent).toBe(fmtRate(battingRates(lb.ranked[0].totals.bat).ops))
    expect(first.querySelector('.v2-level')!.textContent).toMatch(/^Lv\.\d+$/)
    expect(['先發', '板凳', '預備']).toContain(first.querySelector('.v2-board-status')!.textContent)
    expect(first.querySelector('.v2-board-avatar, svg, img')).not.toBeNull()
    // 沒出場的人一定在最後、數字是「—」
    for (const r of lb.none) {
      const row = $(`.v2-board-row[data-player="${r.playerId}"]`)!
      expect([...row.querySelectorAll('.v2-board-num')].every((n) => n.textContent === '—')).toBe(true)
      expect(row.querySelector('.v2-board-rank')!.textContent).toBe('—')
    }
    expect(document.body.textContent).not.toContain('NaN')
  })

  it('投手：ERA 由低到高，切換排序；計數排序（K）不分樣本', async () => {
    const env = await create(2)
    await open(env)
    await goBoard()
    await click('.v2-board-role [data-value="pitcher"]')
    expect($('[data-sort="era"]')!.getAttribute('aria-pressed')).toBe('true')
    expect($('[data-sort="era"]')!.textContent).toContain('↑')
    const club = saved(env)
    const era = leaderboard(club, 'pitcher', 'last30', 'era')
    expect(rowIds().slice(0, era.ranked.length)).toEqual(era.ranked.map((r) => r.playerId))
    const shown = era.ranked.map((r) => pitchingRates(r.totals.pit).era!)
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
    await click('[data-sort="k"]')
    expect($('.v2-board-group')).toBeNull()
    // 焦點留在剛按的排序
    expect(document.activeElement).toBe($('[data-sort="k"]'))
  })

  it('還沒有任何正式比賽：空狀態，不顯示 0 或 .000', async () => {
    const env = await create(0)
    await open(env)
    await goBoard()
    expect(text('.v2-board-empty')).toContain(ST.boardEmptyTitle)
    expect($$('.v2-board-num:not(.wide)').filter((n) => !n.closest('.head')).every((n) => n.textContent === '—')).toBe(true)
    const nums = $$('.v2-board-row:not(.head) .v2-board-num').map((n) => n.textContent)
    expect(nums.length).toBeGreaterThan(0)
    expect(nums.every((n) => n === '—')).toBe(true)
  })

  it('點列打開球員詳情，停在比賽數據、期間沿用排行；關閉後焦點回來', async () => {
    const env = await create(2)
    await open(env)
    await goBoard()
    await click('.v2-board-period [data-value="last10"]')
    const row = $('.v2-board-row:not(.head)')!
    const id = row.dataset.player!
    row.focus()
    await click(row)
    expect($('.v2-player-sheet')).not.toBeNull()
    expect($('[data-tab="stats"]')!.getAttribute('aria-selected')).toBe('true')
    expect($('.v2-stats-panel')!.dataset.period).toBe('last10')
    // 數字跟同一組公式一致
    const t = periodTotals(saved(env), 'last10').byPlayer.get(id)!
    expect(text('.v2-stat-tile[data-metric="AVG"] .v2-stat-num')).toBe(fmtRate(battingRates(t.bat).avg))
    expect(text('.v2-stats-cell[data-metric="G"] .v2-stats-cell-num')).toBe(String(t.g))
    key('Escape')
    await flush()
    expect($('.v2-player-sheet')).toBeNull()
    expect(document.activeElement).toBe(row)
  })
})

describe('球員詳情：比賽數據分頁', () => {
  it('從養成入口打開：預設球員能力（升級按鈕照舊）；切到比賽數據、切換期間', async () => {
    const env = await create(4)
    await open(env)
    await click('.v2-nav-btn[data-tab="lineup"]')
    await click('.v2-develop')
    expect($('[data-tab="ability"]')!.getAttribute('aria-selected')).toBe('true')
    expect($('.v2-upgrade-btn')).not.toBeNull()
    expect(text('.v2-ability-note')).toContain('分開顯示')
    await click('[data-tab="stats"]')
    expect(document.activeElement).toBe($('[data-tab="stats"]'))
    expect($('.v2-upgrade-btn')).toBeNull()
    expect($$('.v2-stat-tile').map((t) => t.dataset.metric)).toEqual(['AVG', 'OBP', 'SLG', 'OPS', 'HR', 'RBI'])
    expect($$('.v2-stats-cell').map((t) => t.dataset.metric)).toEqual(['G', 'PA', 'AB', 'H', '1B', '2B', '3B', 'BB', 'SO'])
    for (const p of ['last10', 'last30', 'career'] as const) {
      await click(`.v2-period [data-value="${p}"]`)
      expect($('.v2-stats-panel')!.dataset.period).toBe(p)
      expect($(`.v2-period [data-value="${p}"]`)!.getAttribute('aria-checked')).toBe('true')
    }
    expect(text('.v2-stats-caption')).toContain('加入球隊至今')
    expect($$('.v2-stats-log-row').length).toBeGreaterThan(0)
  })

  it('投手：ERA、WHIP、IP、K、BB；IP 用棒球寫法', async () => {
    const env = await create(2)
    await open(env)
    await goBoard()
    await click('.v2-board-role [data-value="pitcher"]')
    const id = $('.v2-board-row:not(.head)')!.dataset.player!
    await click('.v2-board-row:not(.head)')
    expect($$('.v2-stat-tile').map((t) => t.dataset.metric)).toEqual(['ERA', 'WHIP', 'IP', 'K', 'BB'])
    const t = periodTotals(saved(env), 'last30').byPlayer.get(id)!
    expect(text('.v2-stat-tile[data-metric="ERA"] .v2-stat-num')).toBe(fmtEra(pitchingRates(t.pit).era))
    expect(text('.v2-stat-tile[data-metric="IP"] .v2-stat-num')).toBe(`${Math.floor(t.pit.outs / 3)}.${t.pit.outs % 3}`)
    expect(text('.v2-stats-cell[data-metric="RA"]')).toContain('失分')
  })

  it('樣本少：比率格標「樣本少」並說明；沒出場：「尚無出賽紀錄」、數字是「—」', async () => {
    const env = await create(1)
    await open(env)
    const club = saved(env)
    const p10 = periodTotals(club, 'last10').byPlayer
    // 找一位打席少於 20 的打者（板凳）與一位沒出場的預備／板凳
    const small = club.players.find((p) => p.player.role === 'batter' && (p10.get(p.player.id)?.bat.pa ?? 0) > 0 && p10.get(p.player.id)!.bat.pa < 20)
    await goBoard()
    await click('.v2-board-period [data-value="last10"]')
    if (small) {
      await click(`.v2-board-row[data-player="${small.player.id}"]`)
      expect($$('.v2-stat-tile.small').map((t) => t.dataset.metric)).toEqual(['AVG', 'OBP', 'SLG', 'OPS'])
      expect(text('.v2-stats-small')).toContain('打席')
      key('Escape')
      await flush()
    }
    expect(small).toBeDefined()
  })

  it('還沒出場：「尚無出賽紀錄」、數字是「—」，不是 0 或 .000', async () => {
    const env = await create(0)
    await open(env)
    await click('.v2-nav-btn[data-tab="lineup"]')
    await click('.v2-develop')
    await click('[data-tab="stats"]')
    expect(text('.v2-stats-panel .v2-stats-empty')).toContain(ST.emptyTitle)
    expect($$('.v2-stat-tile .v2-stat-num').every((n) => n.textContent === '—')).toBe(true)
    expect($('.v2-stats-full')).toBeNull()
  })

  it('縮寫說明：點開、同時只開一個、Escape 關閉並把焦點還給按鈕（不會關掉詳情）', async () => {
    const env = await create(1)
    await open(env)
    await goBoard()
    await click('.v2-board-row:not(.head)')
    const ops = $('.v2-stat-tile[data-metric="OPS"] .v2-abbr')!
    const avg = $('.v2-stat-tile[data-metric="AVG"] .v2-abbr')!
    await click(ops)
    expect(ops.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(ops.getAttribute('aria-describedby')!)!.hidden).toBe(false)
    expect(document.getElementById(ops.getAttribute('aria-describedby')!)!.textContent).toContain('上壘率＋長打率')
    await click(avg)
    expect(ops.getAttribute('aria-expanded')).toBe('false')
    expect(avg.getAttribute('aria-expanded')).toBe('true')
    key('Escape')
    await flush()
    expect(avg.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(avg)
    expect($('.v2-player-sheet')).not.toBeNull()
  })
})

describe('戰報的打擊／投手表', () => {
  it('新格式：打擊 9 欄＋合計、投手 6 欄；名字可以點開詳情；數字對得起比分', async () => {
    const env = await create(1)
    await open(env)
    await click('.v2-nav-btn[data-tab="reports"]')
    await click('.v2-report-row')
    const m = saved(env).recentMatches.at(-1)!
    const heads = (i: number) => [...$$('.v2-box8')[i].querySelectorAll('thead .v2-abbr')].map((b) => b.textContent)
    expect(heads(0)).toEqual(['PA', 'AB', 'H', '2B', '3B', 'HR', 'RBI', 'BB', 'SO'])
    expect(heads(1)).toEqual(['IP', 'H', 'R', 'ER', 'BB', 'K'])
    expect($('.v2-box-scroll')!.getAttribute('role')).toBe('region')
    const total = $$('.v2-box8')[0].querySelector('tr.total')!
    const cells = [...total.querySelectorAll('td')].map((td) => Number(td.textContent))
    expect(cells[2]).toBe(m.box!.hits[m.result.userSide])
    const name = $('.v2-box-name[data-player]')!
    await click(name)
    expect($('.v2-player-sheet')).not.toBeNull()
    expect($('[data-tab="stats"]')!.getAttribute('aria-selected')).toBe('true')
  })

  it('已釋出的球員：戰報名字仍點得開，詳情只有比賽數據（唯讀）', async () => {
    let releasedId = ''
    const env = await create(1, (c) => {
      releasedId = c.roster.lineup[8].playerId
      const reserve: ClubSave = { ...c, roster: { ...c.roster, lineup: c.roster.lineup.map((s, i) => (i === 8 ? { ...s, playerId: c.roster.bench[0] } : s)), bench: c.roster.bench.slice(1) } }
      return releasePlayer(reserve, { opSeq: reserve.economy.nextOpSeq, playerId: releasedId }, T0).club
    })
    await open(env)
    await click('.v2-nav-btn[data-tab="reports"]')
    await click('.v2-report-row')
    await click(`.v2-box-name[data-player="${releasedId}"]`)
    expect(text('.v2-detail-where')).toBe(ST.releasedStatus)
    expect(($('[data-tab="ability"]') as HTMLButtonElement).disabled).toBe(true)
    expect(text('.v2-stats-banner.released')).toContain('釋出')
    expect(($('.v2-period [data-value="last10"]') as HTMLButtonElement).disabled).toBe(true)
    expect($('.v2-stats-panel')!.dataset.period).toBe('career')
  })

  it('舊存檔：舊比賽的戰報缺的欄位顯示「未記錄」、名字不能點；詳情是「記錄以來」並說明起點', async () => {
    const env = { storage: new MemoryStorage(), clock: new ManualClock(fixtureV9.idle.anchorMs), locks: new FakeLockManager() }
    env.storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(fixtureV9))
    await open(env)
    expect(saved(env).schemaVersion).toBe(10)
    await click('.v2-nav-btn[data-tab="reports"]')
    await click('.v2-report-row')
    expect($('.v2-box-card.legacy')).not.toBeNull()
    expect($$('.v2-box8 td.unrec').length).toBeGreaterThan(0)
    expect($$('.v2-box8 td.unrec')[0].textContent).toBe(ST.unrecorded)
    expect($('.v2-box-name[data-player]')).toBeNull()
    expect(text('.v2-box-note')).toContain('未記錄')
    key('Escape')
    await flush()
    await goBoard()
    expect($('.v2-board-period [data-value="career"]')!.textContent).toBe(ST.periodSince)
    await click('.v2-board-row:not(.head)')
    await click('.v2-period [data-value="career"]')
    expect(text('.v2-stats-banner.legacy')).toContain('第 313 場開始記錄')
    expect($('.v2-period [data-value="career"]')!.textContent).toBe(ST.periodSince)
    expect(text('.v2-stats-panel .v2-stats-empty')).toContain(ST.emptyTitle)
  })
})

describe('招募比較', () => {
  it('候選人不顯示任何 AVG／OPS／ERA；被比較的現有球員顯示真實的最近 30 場、點得開詳情', async () => {
    const env = await create(2)
    await open(env)
    await click('.v2-nav-btn[data-tab="lineup"]')
    await click('[data-action="recruit"]')
    await click('.v2-recruit-buttons [data-role="batter"]')
    expect($('.v2-recruit-stats')).toBeNull()
    await click('.v2-cand')
    const block = $('.v2-recruit-stats')!
    expect(block.querySelector('.v2-recruit-stats-cand')!.textContent).toContain(ST.recruitNoStats)
    expect(block.querySelector('.v2-recruit-stats-cand')!.textContent).not.toMatch(/\.\d{3}|\d\.\d\d/)
    for (const card of $$('.v2-cand')) expect(card.textContent).not.toMatch(/AVG|OPS|ERA|\.\d{3}/)
    const cur = block.querySelector<HTMLElement>('.v2-recruit-stats-cur')
    if (cur) {
      const t = periodTotals(saved(env), 'last30').byPlayer.get(cur.dataset.player!)
      if (t) expect(cur.textContent).toContain(fmtRate(battingRates(t.bat).ops))
      await click(cur)
      expect($('[data-tab="stats"]')!.getAttribute('aria-selected')).toBe('true')
    }
  })
})
