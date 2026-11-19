// Phase 8 球員數據的畫面元件：縮寫說明、球員詳情的「比賽數據」分頁、隊內排行、戰報的打擊／投手表。
// 只讀存檔（生涯累計、最近比賽的 lines），不重新模擬、不改存檔。數字一律由 domain/stats.ts 的公式算出，
// 分母是 0 的比率顯示「—」，不顯示 0 或 .000。
import { el } from '../../ui/playerCard'
import { avatar } from '../../ui/avatar'
import type { ClubSave, SettledMatch } from '../domain/club'
import {
  batOf,
  battingRates,
  fmtEra,
  fmtIp,
  fmtRate,
  pitOf,
  pitchingRates,
  smallBatSample,
  smallPitSample,
  type BattingCounts,
  type PitchingCounts,
} from '../domain/stats'
import {
  BAT_SORTS,
  PIT_SORTS,
  leaderboard,
  lowerIsBetter,
  playerStats,
  type BatSort,
  type LeaderRow,
  type PitSort,
  type PlayerStatsView,
  type StatPeriod,
} from '../application/statsQuery'
import { icon } from './icons'
import { METRICS, ST, type MetricKey } from './statsStrings'

// ---- 縮寫說明 ----

let openTip: { button: HTMLButtonElement; tip: HTMLElement } | null = null

function closeTip(): void {
  if (!openTip) return
  openTip.tip.hidden = true
  openTip.button.setAttribute('aria-expanded', 'false')
  openTip = null
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (openTip && !openTip.button.contains(e.target as Node)) closeTip()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openTip) {
      const b = openTip.button
      closeTip()
      b.focus({ preventScroll: true })
      // 只關說明，不要連對話框一起關
      e.stopImmediatePropagation()
    }
  }, true)
}

let tipSeq = 0

/**
 * 縮寫按鈕：點一下打開說明（同時只開一個），點外面、再點一次或 Escape 關閉；電腦版 hover／focus 也會顯示。
 * label 是按鈕上的字（預設是縮寫本身）
 */
export function abbr(key: MetricKey, label: string = key, cls = ''): HTMLElement {
  const wrap = el('span', `v2-abbr-wrap ${cls}`.trim())
  const b = el('button', 'v2-abbr', label)
  b.type = 'button'
  const tip = el('span', 'v2-abbr-tip')
  tip.id = `v2-tip-${++tipSeq}`
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  const m = METRICS[key]
  tip.append(el('strong', 'v2-abbr-tip-key', `${key}・${m.zh}`), el('span', '', m.desc))
  b.setAttribute('aria-describedby', tip.id)
  b.setAttribute('aria-expanded', 'false')
  b.setAttribute('aria-label', ST.help(key, m.zh))
  b.dataset.metric = key
  b.onclick = (e) => {
    e.stopPropagation()
    const same = openTip?.button === b
    closeTip()
    if (same) return
    tip.hidden = false
    b.setAttribute('aria-expanded', 'true')
    openTip = { button: b, tip }
  }
  wrap.append(b, tip)
  return wrap
}

// ---- 共用 ----

const periodName = (club: ClubSave, p: StatPeriod) => (p === 'career' && club.stats.sinceMatch > 0 ? ST.periodSince : ST.period[p])

function segmented<T extends string>(label: string, items: readonly { value: T; text: string; disabled?: boolean }[], current: T, onPick: (v: T) => void, cls: string): HTMLElement {
  const g = el('div', `v2-seg ${cls}`)
  g.setAttribute('role', 'radiogroup')
  g.setAttribute('aria-label', label)
  for (const it of items) {
    const b = el('button', 'v2-seg-btn', it.text)
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(it.value === current))
    b.dataset.value = it.value
    b.disabled = !!it.disabled
    if (it.value === current) b.classList.add('on')
    b.onclick = () => {
      if (it.value !== current) onPick(it.value)
    }
    g.append(b)
  }
  return g
}

/** 統計期間的說明：實際範圍（第幾場到第幾場）、本人出賽幾場、有沒有記錄不完整 */
function periodCaption(v: PlayerStatsView, club: ClubSave): string {
  const g = v.role === 'pitcher' ? v.totals.gp : v.totals.g
  const i = v.info
  if (i.period === 'career') {
    if (v.status === 'released') return ST.careerReleasedCaption(g)
    return club.stats.sinceMatch > 0 ? ST.careerSinceCaption(club.stats.sinceMatch + 1, g) : ST.careerCaption(g)
  }
  if (i.fromMatch === null || i.toMatch === null) return ST.windowNone
  const base = ST.windowCaption(i.matches, i.fromMatch + 1, i.toMatch + 1, g)
  return i.recorded < i.matches ? `${base}。${ST.windowPartial(i.recorded)}` : base
}

/** 投手的被安打、失分在畫面上仍寫 H、R（說明不同） */
const SHOWN: Partial<Record<MetricKey, string>> = { HA: 'H', RA: 'R' }

interface Tile {
  key: MetricKey
  value: string
  rate: boolean
}

function batTiles(b: BattingCounts): Tile[] {
  const r = battingRates(b)
  return [
    { key: 'AVG', value: fmtRate(r.avg), rate: true },
    { key: 'OBP', value: fmtRate(r.obp), rate: true },
    { key: 'SLG', value: fmtRate(r.slg), rate: true },
    { key: 'OPS', value: fmtRate(r.ops), rate: true },
    { key: 'HR', value: String(b.hr), rate: false },
    { key: 'RBI', value: String(b.rbi), rate: false },
  ]
}

function pitTiles(p: PitchingCounts): Tile[] {
  const r = pitchingRates(p)
  return [
    { key: 'ERA', value: fmtEra(r.era), rate: true },
    { key: 'WHIP', value: fmtEra(r.whip), rate: true },
    { key: 'IP', value: fmtIp(p.outs), rate: false },
    { key: 'K', value: String(p.k), rate: false },
    { key: 'BB', value: String(p.bb), rate: false },
  ]
}

// ---- 球員詳情：比賽數據 ----

export interface StatsPanelOptions {
  period: StatPeriod
  onPeriod: (p: StatPeriod) => void
  onOpenMatch?: (m: SettledMatch) => void
}

/** 球員詳情的「比賽數據」分頁內容；playerId 可以是已釋出的球員 */
export function statsPanel(club: ClubSave, playerId: string, opts: StatsPanelOptions): HTMLElement {
  const released = !club.players.some((p) => p.player.id === playerId)
  const period: StatPeriod = released ? 'career' : opts.period
  const view = playerStats(club, playerId, period)
  const box = el('div', 'v2-stats-panel')
  box.dataset.period = period
  if (!view) {
    box.append(emptyCard(true))
    return box
  }
  const bat = view.role === 'batter'
  box.dataset.role = view.role

  if (released && view.career?.releasedAt !== undefined) {
    box.append(banner('release', 'released', ST.releasedTitle(view.career.releasedAt), ST.releasedText))
  } else if (club.stats.sinceMatch > 0 && (period === 'career' || view.info.recorded < view.info.matches)) {
    box.append(banner('clock', 'legacy', ST.legacyTitle(club.stats.sinceMatch + 1), ST.legacyText(club.stats.sinceMatch)))
  }

  const periods = (['last10', 'last30', 'career'] as const).map((p) => ({ value: p, text: periodName(club, p), disabled: released && p !== 'career' }))
  const head = el('div', 'v2-stats-period')
  head.append(segmented(ST.periodLabel, periods, period, opts.onPeriod, 'v2-period'), el('p', 'v2-stats-caption', periodCaption(view, club)))
  box.append(head)

  const t = view.totals
  const appeared = bat ? t.g > 0 : t.gp > 0
  const small = appeared && (bat ? smallBatSample(t.bat) : smallPitSample(t.pit))
  if (!appeared) box.append(emptyCard(bat))

  const tiles = el('section', `v2-stat-tiles ${bat ? 'bat' : 'pit'}`)
  tiles.setAttribute('aria-label', ST.mainLabel)
  for (const x of bat ? batTiles(t.bat) : pitTiles(t.pit)) {
    const value = appeared ? x.value : '—'
    const weak = appeared && small && x.rate
    const tile = el('div', `v2-stat-tile${weak ? ' small' : ''}${appeared ? '' : ' none'}`)
    tile.dataset.metric = x.key
    const v = el('span', 'v2-stat-num', value)
    const zh = el('span', 'v2-stat-zh', METRICS[x.key].zh)
    tile.append(abbr(x.key), v, zh)
    if (weak) zh.append(el('span', 'v2-small-tag', ST.smallTag))
    tiles.append(tile)
  }
  box.append(tiles)

  if (small) {
    const n = bat ? ST.paCount(t.bat.pa) : ST.ipCount(fmtIp(t.pit.outs))
    const warn = el('p', 'v2-stats-small')
    warn.append(icon('alert', 18), el('span', '', ST.smallText(n, bat)))
    box.append(warn)
  }

  if (appeared) {
    const full = el('section', 'v2-stats-full')
    full.append(el('h3', 'v2-stats-sub', ST.fullTitle))
    const grid = el('div', `v2-stats-grid ${bat ? 'bat' : 'pit'}`)
    const cells: [MetricKey, number][] = bat
      ? [['G', t.g], ['PA', t.bat.pa], ['AB', t.bat.ab], ['H', t.bat.h], ['1B', battingRates(t.bat).singles], ['2B', t.bat.d], ['3B', t.bat.t], ['BB', t.bat.bb], ['SO', t.bat.so]]
      : [['G', t.gp], ['HA', t.pit.h], ['ER', t.pit.er], ['RA', t.pit.r], ['Outs', t.pit.outs]]
    for (const [k, n] of cells) {
      const c = el('div', 'v2-stats-cell')
      c.dataset.metric = k
      c.append(abbr(k, SHOWN[k] ?? k), el('span', 'v2-stats-cell-num', String(n)), el('span', 'v2-stats-cell-zh', METRICS[k].zh))
      grid.append(c)
    }
    full.append(grid)
    box.append(full)
    box.append(gameLog(club, playerId, bat, released, opts.onOpenMatch))
  }
  return box
}

function banner(iconName: 'clock' | 'release' | 'alert', kind: string, title: string, text: string): HTMLElement {
  const b = el('div', `v2-stats-banner ${kind}`)
  b.setAttribute('role', 'note')
  const words = el('span', 'v2-stats-banner-words')
  words.append(el('strong', '', title), el('span', '', text))
  b.append(icon(iconName, 18), words)
  return b
}

function emptyCard(bat: boolean): HTMLElement {
  const c = el('div', 'v2-stats-empty')
  c.append(icon('report', 26), el('strong', '', ST.emptyTitle), el('span', '', bat ? ST.emptyText : ST.emptyPitcher))
  return c
}

/** 這位球員在最近戰報裡的出賽（新的在前，最多 5 場） */
function gameLog(club: ClubSave, playerId: string, bat: boolean, released: boolean, open?: (m: SettledMatch) => void): HTMLElement {
  const sec = el('section', 'v2-stats-log')
  sec.append(el('h3', 'v2-stats-sub', released ? ST.logReleased : ST.logTitle))
  const rows: HTMLElement[] = []
  for (const m of [...club.recentMatches].reverse()) {
    if (rows.length >= 5) break
    const row = (bat ? m.lines?.bat : m.lines?.pit)?.find((r) => r[0] === playerId)
    if (!row) continue
    const counts = row.slice(1) as number[]
    const b = el('button', 'v2-stats-log-row')
    b.type = 'button'
    b.append(el('span', 'v2-stats-log-no', ST.logVs(m.matchIndex + 1, m.result.opponentName)), el('span', 'v2-stats-log-line', bat ? batLine(batOf(counts)) : pitLine(pitOf(counts))), icon('chev', 14, 'v2-report-chev'))
    if (open) b.onclick = () => open(m)
    else b.disabled = true
    rows.push(b)
  }
  if (!rows.length) sec.append(el('p', 'v2-hint', ST.logNone))
  sec.append(...rows)
  return sec
}

export function batLine(b: BattingCounts): string {
  if (b.pa === 0) return '上場（沒有打席）'
  const parts = [`${b.ab} 打數 ${b.h} 安打`]
  if (b.hr) parts.push(`${b.hr} 全壘打`)
  if (b.rbi) parts.push(`${b.rbi} 打點`)
  if (b.bb) parts.push(`${b.bb} 保送`)
  if (b.so) parts.push(`${b.so} 三振`)
  if (b.sf) parts.push(`${b.sf} 高飛犧牲打`)
  if (b.sh) parts.push(`${b.sh} 犧牲觸擊`)
  return parts.join('・')
}

export function pitLine(p: PitchingCounts): string {
  const parts = [`${fmtIp(p.outs)} 局`, p.er < p.r ? `${p.r} 失分（自責 ${p.er}）` : `${p.r} 失分`, `${p.k} 三振`]
  if (p.bb) parts.push(`${p.bb} 保送`)
  return parts.join('・')
}

// ---- 隊內排行 ----

export interface BoardState {
  role: 'batter' | 'pitcher'
  period: StatPeriod
  batSort: BatSort
  pitSort: PitSort
}

export const defaultBoard = (): BoardState => ({ role: 'batter', period: 'last30', batSort: 'ops', pitSort: 'era' })

const SORT_LABEL: Record<BatSort | PitSort, MetricKey> = { ops: 'OPS', avg: 'AVG', obp: 'OBP', hr: 'HR', rbi: 'RBI', era: 'ERA', whip: 'WHIP', k: 'K', ip: 'IP' }

/** 每個排序要顯示的欄位（手機 3 欄，電腦版另外用 CSS 顯示全部） */
function columnsFor(role: 'batter' | 'pitcher', sort: BatSort | PitSort): MetricKey[] {
  if (role === 'batter') {
    const all: MetricKey[] = ['OPS', 'AVG', 'OBP', 'SLG', 'HR', 'RBI', 'PA']
    const first = SORT_LABEL[sort]
    return [first, ...all.filter((k) => k !== first)]
  }
  const all: MetricKey[] = ['ERA', 'WHIP', 'IP', 'K', 'G']
  const first = SORT_LABEL[sort]
  return [first, ...all.filter((k) => k !== first)]
}

function cellValue(row: LeaderRow, key: MetricKey): string {
  if (!row.played) return '—'
  const { bat, pit } = row.totals
  const br = battingRates(bat)
  const pr = pitchingRates(pit)
  switch (key) {
    case 'OPS': return fmtRate(br.ops)
    case 'AVG': return fmtRate(br.avg)
    case 'OBP': return fmtRate(br.obp)
    case 'SLG': return fmtRate(br.slg)
    case 'HR': return String(bat.hr)
    case 'RBI': return String(bat.rbi)
    case 'PA': return String(bat.pa)
    case 'ERA': return fmtEra(pr.era)
    case 'WHIP': return fmtEra(pr.whip)
    case 'IP': return fmtIp(pit.outs)
    case 'K': return String(pit.k)
    case 'G': return String(row.totals.gp)
    default: return '—'
  }
}

const RATE_KEYS: ReadonlySet<MetricKey> = new Set(['OPS', 'AVG', 'OBP', 'SLG', 'ERA', 'WHIP'])

/** 陣容頁的「球員數據」：打者／投手、期間、排序；點列打開球員詳情的比賽數據 */
export function renderStatsBoard(club: ClubSave, board: BoardState, onChange: (b: BoardState) => void, openPlayer: (id: string, period: StatPeriod) => void): HTMLElement {
  const wrap = el('div', 'v2-board')
  const sort = board.role === 'batter' ? board.batSort : board.pitSort
  const controls = el('section', 'v2-card v2-board-controls')
  const top = el('div', 'v2-board-top')
  top.append(
    segmented(ST.roleLabel, [{ value: 'batter', text: ST.roleBat }, { value: 'pitcher', text: ST.rolePit }] as const, board.role, (role) => onChange({ ...board, role }), 'v2-board-role'),
    segmented(ST.periodLabel, (['last10', 'last30', 'career'] as const).map((p) => ({ value: p, text: p === 'career' && club.stats.sinceMatch > 0 ? ST.periodSince : ST.periodShort[p] })), board.period, (period) => onChange({ ...board, period }), 'v2-board-period'),
  )
  const sorts = el('div', 'v2-board-sorts')
  sorts.setAttribute('role', 'group')
  sorts.setAttribute('aria-label', ST.sortLabel)
  sorts.append(el('span', 'v2-board-sort-label', ST.sortLabel))
  for (const s of board.role === 'batter' ? BAT_SORTS : PIT_SORTS) {
    const on = s === sort
    const b = el('button', `v2-sort-chip${on ? ' on' : ''}`, `${SORT_LABEL[s]}${on ? (lowerIsBetter(s) ? ' ↑' : ' ↓') : ''}`)
    b.type = 'button'
    b.dataset.sort = s
    b.setAttribute('aria-pressed', String(on))
    b.onclick = () => onChange(board.role === 'batter' ? { ...board, batSort: s as BatSort } : { ...board, pitSort: s as PitSort })
    sorts.append(b)
  }
  const lb = leaderboard(club, board.role, board.period, sort)
  const i = lb.info
  const range = i.fromMatch === null || i.toMatch === null ? ST.windowNone : board.period === 'career' ? (club.stats.sinceMatch > 0 ? ST.careerSinceCaption(club.stats.sinceMatch + 1, i.matches).split('・')[0] : ST.period.career) : ST.windowCaptionShort(i.matches, i.fromMatch + 1, i.toMatch + 1)
  const caption = [range, board.role === 'batter' ? ST.boardCaptionBat : ST.boardCaptionPit, lowerIsBetter(sort) ? ST.lowerBetter : ST.higherBetter].join('・')
  controls.append(top, sorts, el('p', 'v2-board-caption', caption))
  wrap.append(controls)

  if (!lb.ranked.length && !lb.smallSample.length) {
    const e = el('div', 'v2-stats-empty v2-board-empty')
    e.append(icon('report', 28), el('strong', '', ST.boardEmptyTitle), el('span', '', ST.boardEmptyText))
    wrap.append(e)
  }

  const cols = columnsFor(board.role, sort)
  const table = el('div', 'v2-card v2-board-table')
  table.style.setProperty('--cols', String(cols.length))
  table.setAttribute('role', 'table')
  table.setAttribute('aria-label', `${board.role === 'batter' ? ST.roleBat : ST.rolePit}・${SORT_LABEL[sort]}`)
  const head = el('div', 'v2-board-row head')
  head.setAttribute('role', 'row')
  head.append(el('span', 'v2-board-rank', '#'), el('span', 'v2-board-who', board.role === 'batter' ? ST.boxPlayer : ST.boxPitcher))
  cols.forEach((k, idx) => {
    const c = el('span', `v2-board-num${k === SORT_LABEL[sort] ? ' cur' : ''}${idx >= 3 ? ' wide' : ''}`)
    c.append(abbr(k))
    head.append(c)
  })
  head.append(el('span', 'v2-board-chev'))
  table.append(head)
  const rowEl = (r: LeaderRow, rank: number | null) => {
    const b = el('button', `v2-board-row${r.played ? '' : ' none'}`)
    b.type = 'button'
    b.setAttribute('role', 'row')
    b.dataset.player = r.playerId
    b.setAttribute('aria-label', ST.rowLabel(r.name))
    const who = el('span', 'v2-board-who')
    const face = el('span', 'v2-board-face')
    face.append(avatar(r.playerId, 'user', 'v2-board-avatar'))
    const words = el('span', 'v2-board-words')
    const name = el('span', 'v2-board-name')
    name.append(el('span', 'v2-board-name-text', r.name), el('span', 'v2-level', `Lv.${r.level}`))
    words.append(name, el('span', `v2-board-status ${r.status}`, ST.status[r.status]))
    who.append(face, words)
    b.append(el('span', 'v2-board-rank', rank === null ? ST.rankNone : String(rank)), who)
    cols.forEach((k, idx) => {
      const faded = !r.played || (r.small && RATE_KEYS.has(k))
      b.append(el('span', `v2-board-num${k === SORT_LABEL[sort] ? ' cur' : ''}${faded ? ' faded' : ''}${idx >= 3 ? ' wide' : ''}`, cellValue(r, k)))
    })
    b.append(icon('chev', 14, 'v2-board-chev'))
    b.onclick = () => openPlayer(r.playerId, board.period)
    return b
  }
  lb.ranked.forEach((r, idx) => table.append(rowEl(r, idx + 1)))
  const group = (title: string, text: string) => {
    const g = el('div', 'v2-board-group')
    g.setAttribute('role', 'row')
    const t = el('strong', '')
    t.append(icon('alert', 14), title)
    g.append(t, el('span', '', text))
    return g
  }
  if (lb.smallSample.length) {
    table.append(group(ST.smallGroup(SORT_LABEL[sort]), board.role === 'batter' ? ST.smallGroupBat : ST.smallGroupPit))
    lb.smallSample.forEach((r) => table.append(rowEl(r, null)))
  }
  if (lb.none.length) {
    table.append(group(ST.noneGroup, ST.noneGroupText))
    lb.none.forEach((r) => table.append(rowEl(r, null)))
  }
  wrap.append(table, el('p', 'v2-board-note', ST.boardNote))
  return wrap
}

// ---- 戰報 ----

interface BoxCol {
  key: MetricKey
  bat?: (b: BattingCounts) => number
  pit?: (p: PitchingCounts) => string | number
}

const BAT_COLS: BoxCol[] = [
  { key: 'PA', bat: (b) => b.pa },
  { key: 'AB', bat: (b) => b.ab },
  { key: 'H', bat: (b) => b.h },
  { key: '2B', bat: (b) => b.d },
  { key: '3B', bat: (b) => b.t },
  { key: 'HR', bat: (b) => b.hr },
  { key: 'RBI', bat: (b) => b.rbi },
  { key: 'BB', bat: (b) => b.bb },
  { key: 'SO', bat: (b) => b.so },
]
const PIT_COLS: BoxCol[] = [
  { key: 'IP', pit: (p) => fmtIp(p.outs) },
  { key: 'HA', pit: (p) => p.h },
  { key: 'RA', pit: (p) => p.r },
  { key: 'ER', pit: (p) => p.er },
  { key: 'BB', pit: (p) => p.bb },
  { key: 'K', pit: (p) => p.k },
]

/** 舊 Box Score（schemaVersion 7～9）有的欄位 */
const LEGACY_BAT: Partial<Record<MetricKey, number>> = { PA: 1, H: 2, HR: 3, RBI: 4, SO: 5 }
const LEGACY_PIT: Partial<Record<MetricKey, number>> = { IP: 1, RA: 2, K: 3 }

function scrollTable(label: string, cols: BoxCol[], firstHead: string, rows: { name: HTMLElement; cells: (string | number | null)[]; total?: boolean }[]): HTMLElement {
  const region = el('div', 'v2-box-scroll')
  region.setAttribute('role', 'region')
  region.setAttribute('aria-label', label)
  region.tabIndex = 0
  const t = el('table', 'v2-box v2-box8')
  const thead = el('thead')
  const hr = el('tr')
  const first = el('th', 'name', firstHead)
  first.setAttribute('scope', 'col')
  hr.append(first)
  for (const c of cols) {
    const th = el('th', 'num')
    th.setAttribute('scope', 'col')
    th.append(abbr(c.key, SHOWN[c.key] ?? c.key))
    hr.append(th)
  }
  thead.append(hr)
  const tb = el('tbody')
  for (const r of rows) {
    const tr = el('tr', r.total ? 'total' : '')
    const th = el('th', 'name')
    th.setAttribute('scope', 'row')
    th.append(r.name)
    tr.append(th)
    for (const v of r.cells) {
      const td = el('td', `num${v === null ? ' unrec' : v === 0 || v === '0' ? ' zero' : ''}`, v === null ? ST.unrecorded : String(v))
      tr.append(td)
    }
    tb.append(tr)
  }
  t.append(thead, tb)
  region.append(t)
  return region
}

/**
 * 戰報的我方打擊、我方投手。新格式（有 lines）：完整原始數據、名字可以點開球員詳情（已釋出的也可以）；
 * 舊格式（只有名字陣列）：沒有的欄位顯示「未記錄」，名字不能點（舊資料沒有球員編號）
 */
export function boxStatTables(m: SettledMatch, club: ClubSave, openPlayer: (id: string) => void): HTMLElement | null {
  const sec = el('section', 'v2-report-card v2-box-card')
  const nameOf = (id: string) => club.players.find((p) => p.player.id === id)?.player.name ?? club.stats.players[id]?.name ?? '—'
  const link = (id: string) => {
    const a = el('button', 'v2-box-name', nameOf(id))
    a.type = 'button'
    a.dataset.player = id
    a.onclick = () => openPlayer(id)
    return a
  }
  const plain = (name: string) => el('span', 'v2-box-name plain', name)
  const head = (title: string) => {
    const h = el('div', 'v2-box-head')
    h.append(el('h3', '', title), el('span', 'v2-box-hint', ST.boxScrollHint))
    return h
  }
  if (m.lines) {
    const bats = m.lines.bat.map(([id, ...c]) => ({ id, b: batOf(c as number[]) })).filter((x) => x.b.pa > 0)
    const total = bats.reduce((acc, x) => BAT_COLS.map((col, i) => acc[i] + col.bat!(x.b)), BAT_COLS.map(() => 0))
    sec.append(
      head(ST.boxBatTitle),
      scrollTable(ST.boxTableBat, BAT_COLS, ST.boxPlayer, [
        ...bats.map((x) => ({ name: link(x.id), cells: BAT_COLS.map((c) => c.bat!(x.b)) })),
        { name: el('span', 'v2-box-name plain', ST.boxTotal), cells: total, total: true },
      ]),
    )
    const pits = m.lines.pit.map(([id, ...c]) => ({ id, p: pitOf(c as number[]) })).filter((x) => x.p.bf + x.p.outs > 0)
    sec.append(head(ST.boxPitTitle), scrollTable(ST.boxTablePit, PIT_COLS, ST.boxPitcher, pits.map((x) => ({ name: link(x.id), cells: PIT_COLS.map((c) => c.pit!(x.p)) }))))
    sec.append(el('p', 'v2-box-note', ST.boxNote))
    return sec
  }
  if (!m.box) return null
  sec.classList.add('legacy')
  sec.append(
    head(ST.boxBatTitle),
    scrollTable(ST.boxTableBat, BAT_COLS, ST.boxPlayer, m.box.batters.map((row) => ({ name: plain(row[0]), cells: BAT_COLS.map((c) => (LEGACY_BAT[c.key] ? row[LEGACY_BAT[c.key]!] : null)) }))),
    head(ST.boxPitTitle),
    scrollTable(
      ST.boxTablePit,
      PIT_COLS,
      ST.boxPitcher,
      m.box.pitchers.map((row) => ({ name: plain(row[0]), cells: PIT_COLS.map((c) => (c.key === 'IP' ? fmtIp(row[1]) : LEGACY_PIT[c.key] ? row[LEGACY_PIT[c.key]!] : null)) })),
    ),
    el('p', 'v2-box-note', ST.boxLegacyNote),
  )
  return sec
}

// ---- 招募比較 ----

/** 招募比較區塊的「實際比賽數據」：候選人沒有（不估算），現有球員顯示最近 30 場的真實數據 */
export function recruitStatsBlock(club: ClubSave, currentId: string | null, role: 'batter' | 'pitcher', openPlayer: (id: string) => void): HTMLElement {
  const sec = el('section', 'v2-recruit-stats')
  const h = el('div', 'v2-recruit-stats-head')
  h.append(icon('report', 18), el('h4', '', ST.recruitStatsTitle), el('span', 'v2-recruit-stats-period', ST.recruitStatsPeriod))
  const grid = el('div', 'v2-recruit-stats-grid')
  const cand = el('div', 'v2-recruit-stats-cand')
  cand.append(el('strong', '', ST.recruitNoStats), el('span', '', ST.recruitNoStatsText))
  grid.append(cand)
  if (currentId) {
    const v = playerStats(club, currentId, 'last30')
    if (v) {
      const b = el('button', 'v2-recruit-stats-cur')
      b.type = 'button'
      b.dataset.player = currentId
      const title = el('span', 'v2-recruit-stats-name')
      title.append(ST.recruitCurrent(v.name), icon('chev', 12))
      b.append(title)
      const bat = role === 'batter'
      const appeared = bat ? v.totals.bat.pa > 0 : v.totals.pit.bf + v.totals.pit.outs > 0
      const items: [MetricKey, string][] = bat
        ? [['OPS', fmtRate(battingRates(v.totals.bat).ops)], ['AVG', fmtRate(battingRates(v.totals.bat).avg)], ['HR', String(v.totals.bat.hr)]]
        : [['ERA', fmtEra(pitchingRates(v.totals.pit).era)], ['WHIP', fmtEra(pitchingRates(v.totals.pit).whip)], ['K', String(v.totals.pit.k)]]
      for (const [k, val] of items) {
        const line = el('span', 'v2-recruit-stats-line')
        line.append(el('span', 'k', k), el('span', 'v', appeared ? val : '—'))
        b.append(line)
      }
      b.append(el('span', 'v2-recruit-stats-n', appeared ? ST.recruitGames(bat ? v.totals.g : v.totals.gp, bat ? ST.paCount(v.totals.bat.pa) : ST.ipCount(fmtIp(v.totals.pit.outs))) : ST.emptyTitle))
      b.onclick = () => openPlayer(currentId)
      grid.append(b)
    }
  }
  sec.append(h, grid, el('p', 'v2-hint', currentId ? ST.recruitStatsNote : ST.recruitCandidateNote))
  return sec
}
