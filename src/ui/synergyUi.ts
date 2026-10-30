// 羈絆的畫面元件：流派徽章、隊長標記、羈絆追蹤欄與說明、球員所在的羈絆、羈絆變化預告、錦標賽主畫面的摘要
import type { RelicId } from '../sim/items'
import { positionPenalty } from '../sim/positions'
import {
  SYNERGY_KEYS,
  THRESHOLD_RELICS,
  archetypeCounts,
  captainIn,
  captainWeight,
  positionSynergies,
  synergyTiers,
  thresholds,
  type SynergyKey,
  type SynergyTier,
} from '../sim/synergy'
import { ARCHETYPES, type Archetype, type Batter, type LineupSpot, type Roster } from '../sim/types'
import { avatar } from './avatar'
import { el } from './playerCard'
import { ARCHETYPE_NAMES, CAPTAIN_TITLES, FIELDER_TITLES, POSITION_SPOT, SYNERGY_DESC, SYNERGY_NAMES, SYNERGY_SCOUTING, SYNERGY_SHORT, T } from './strings'
import { ARCHETYPE_COLORS, archetypeSvg, captainSvg, positionSynergySvg, synergySvg } from './synergyIcons'

/** 一個羈絆目前的狀態。守位羈絆只有成立（tier 1）與未成立兩種 */
export interface SynergyRow {
  key: SynergyKey
  /** 守位羈絆（黃金二遊、投捕搭檔） */
  position: boolean
  tier: SynergyTier
  /** 流派羈絆的人數（隊長算兩人或三人）；守位羈絆成立就是 1 */
  count: number
  /** 兩階的門檻（有門檻秘寶時是 2、4）；守位羈絆都是 1 */
  low: number
  high: number
  /** 算進去的先發打者；守位羈絆是站在那些守位的人 */
  members: Batter[]
  /** 守位羈絆成立或未成立的原因，例如「游擊手 王俊傑 非本職」 */
  reason: string
}

export function isPositionKey(key: SynergyKey): key is 'middle' | 'battery' {
  return key === 'middle' || key === 'battery'
}

/** 六個羈絆的狀態：四個流派羈絆加上黃金二遊、投捕搭檔 */
export function synergyRows(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): SynergyRow[] {
  const cap = captainIn(lineup, captain)
  const counts = archetypeCounts(lineup, cap, relics)
  const tiers = synergyTiers(lineup, cap, relics)
  const rows: SynergyRow[] = ARCHETYPES.map((a) => {
    const [low, high] = thresholds(a, relics)
    return { key: a, position: false, tier: tiers[a], count: counts[a], low, high, members: lineup.map((s) => s.player).filter((p) => p.archetype === a), reason: '' }
  })
  const pos = positionSynergies(lineup)
  const spot = (p: 'C' | '2B' | 'SS') => lineup.find((s) => s.position === p)
  const why = (positions: ('C' | '2B' | 'SS')[], ok: boolean) => {
    if (ok) return positions.length > 1 ? T.middleOk : T.positionOk(FIELDER_TITLES.C, spot('C')?.player.name ?? '')
    const bad = positions.map(spot).find((s) => s && s.player.primary !== s.position)
    return bad ? T.positionOff(FIELDER_TITLES[bad.position as 'C' | '2B' | 'SS'], bad.player.name) : ''
  }
  for (const [key, positions] of [['middle', ['2B', 'SS']], ['battery', ['C']]] as const) {
    const ok = pos[key]
    rows.push({ key, position: true, tier: ok ? 1 : 0, count: ok ? 1 : 0, low: 1, high: 1, members: positions.flatMap((p) => spot(p)?.player ?? []), reason: why([...positions], ok) })
  }
  return rows
}

/** 還差幾人到下一階（守位羈絆未成立算差 1） */
function missing(row: SynergyRow): number {
  return row.tier === 2 ? 0 : (row.tier === 1 ? row.high : row.low) - row.count
}

/** 追蹤欄上的數字：流派羈絆未啟動寫「2/3」、已啟動寫「4/5」、滿了「5/5」；守位羈絆寫成立或未成立 */
function countText(row: SynergyRow): string {
  if (row.position) return row.tier ? T.positionOn : T.positionOffShort
  return T.synergyCount(Math.min(row.count, row.high), row.tier === 0 ? row.low : row.high)
}

/** 樣式狀態：未啟動 off、已啟動 on、升級 max；守位羈絆未成立 fail */
function stateOf(row: SynergyRow): 'off' | 'on' | 'max' | 'fail' {
  if (row.position && !row.tier) return 'fail'
  return (['off', 'on', 'max'] as const)[row.tier]
}

function statusText(row: SynergyRow): string {
  return row.position ? (row.tier ? T.positionOn : T.positionOffShort) : T.synergyStatus[row.tier]
}

function icon(html: string, className = 'syn-icon'): HTMLElement {
  const span = el('span', className)
  span.innerHTML = html
  return span
}

/** 羈絆圖示：流派羈絆是流派記號加方框，守位羈絆是深藍框 */
export function synergyIcon(key: SynergyKey, size: number, className = 'syn-icon'): HTMLElement {
  return icon(isPositionKey(key) ? positionSynergySvg(key, size) : synergySvg(key, size), className)
}

/** 流派徽章（只有圖示）；滑過顯示流派名稱 */
export function archetypeIcon(a: Archetype, size = 16): HTMLElement {
  const span = icon(archetypeSvg(a, size, ARCHETYPE_NAMES[a]), 'arch-icon')
  span.title = ARCHETYPE_NAMES[a]
  return span
}

/** 流派膠囊：圖示加「力量型」，框線用流派色 */
export function archetypeChip(b: Batter): HTMLElement {
  const chip = el('span', `arch-chip arch-${b.archetype}`)
  chip.style.setProperty('--arch', ARCHETYPE_COLORS[b.archetype])
  chip.append(icon(archetypeSvg(b.archetype, 20)), ARCHETYPE_NAMES[b.archetype])
  return chip
}

export function captainIcon(size = 16): HTMLElement {
  const span = icon(captainSvg(size, T.captainLabel), 'captain-icon')
  span.title = T.captainLabel
  return span
}

/** 「重砲隊長」這類稱號的小標籤 */
export function captainTag(b: Batter): HTMLElement {
  return el('span', 'captain-tag', CAPTAIN_TITLES[b.archetype])
}

/** 進度格：一格一人，兩個門檻的格子加外框 */
function pips(row: SynergyRow): HTMLElement {
  const box = el('span', `syn-pips ${stateOf(row)}`)
  for (let i = 1; i <= row.high; i++) {
    const pip = el('span', 'syn-pip')
    if (i <= row.count) pip.classList.add('filled')
    if (i === row.low) pip.classList.add('gate')
    if (i === row.high) pip.classList.add('gate', 'top')
    box.append(pip)
  }
  return box
}

/** 羈絆的說明：效果（流派羈絆兩階，目前那一階反白）、算進去的人；板凳同流派的人另外提一句 */
export function synergyDetail(row: SynergyRow, roster: Roster, relics: readonly RelicId[]): HTMLElement {
  const box = el('div', 'syn-detail')
  const captain = captainIn(roster.lineup, roster.captain)
  const tiers = el('div', 'syn-tiers')
  const levels = row.position ? [T.positionTierLabel] : [T.synergyTierLabel(row.low), T.synergyTierLabel(row.high)]
  levels.forEach((label, i) => {
    const current = row.tier === i + 1
    const tier = el('div', `syn-tier${current ? ' current' : ''}`)
    tier.append(el('span', 'syn-tier-label', label + (current ? T.synergyCurrent : '')), el('span', 'syn-tier-text', SYNERGY_DESC[row.key][i]))
    tiers.append(tier)
  })
  box.append(tiers)
  box.append(el('span', 'syn-members-title', row.position ? T.positionMembers : T.synergyMembers(row.count)))
  const members = el('div', 'syn-members')
  for (const p of row.members) {
    const m = el('span', 'syn-member')
    const spot = roster.lineup.find((s) => s.player.id === p.id)
    m.append(avatar(p.id, 'user'), el('span', 'syn-member-name', p.name))
    if (spot) m.append(el('span', `syn-member-pos${row.position && positionPenalty(p.primary, spot.position) ? ' off' : ''}`, POSITION_SPOT[spot.position]))
    if (!row.position && p.id === captain) m.append(el('span', 'captain-tag', T.captainCounts(captainWeight(relics))))
    members.append(m)
  }
  box.append(members)
  if (!row.position) {
    const bench = roster.bench.filter((p) => p.archetype === row.key)
    if (bench.length) box.append(el('p', 'syn-note', T.synergyBenchNote(bench.map((p) => p.name).join('、'))))
  }
  return box
}

/** 一個羈絆的標頭：圖示、名稱、狀態、進度與提示，給追蹤欄的列和說明視窗共用 */
function synergyHead(row: SynergyRow): HTMLElement {
  const head = el('span', 'syn-head')
  const title = el('span', 'syn-title')
  title.append(el('span', 'syn-name', SYNERGY_NAMES[row.key]), el('span', `syn-status ${stateOf(row)}`, statusText(row)))
  const body = el('span', 'syn-body')
  body.append(title)
  if (!row.position) {
    const progress = el('span', 'syn-progress')
    progress.append(pips(row), el('span', 'syn-count', countText(row)))
    body.append(progress, el('span', 'syn-hint', T.synergyHint(row.tier, missing(row))))
  } else body.append(el('span', `syn-hint${row.tier ? '' : ' fail'}`, row.reason))
  head.append(synergyIcon(row.key, 30, `syn-icon ${stateOf(row)}`), body)
  return head
}

export interface TrackerOptions {
  /** 手機版有沒有展開全部羈絆 */
  expanded: boolean
  onToggle: (expanded: boolean) => void
  /** 手機版點晶片：打開說明 */
  onOpen: (row: SynergyRow) => void
  /** 電腦版側欄頂端的額外按鈕（例如「最多羈絆排法」） */
  extra?: HTMLElement
}

/** 排序用：已啟動的依人數多到少排前面（守位羈絆當 3.5 人），未啟動的依離門檻近到遠 */
function byImportance(a: SynergyRow, b: SynergyRow): number {
  const weight = (r: SynergyRow) => (r.position ? (r.tier ? 3.5 : 2.5) : r.tier ? r.count : r.count - r.low)
  return Number(b.tier > 0) - Number(a.tier > 0) || weight(b) - weight(a)
}

/**
 * 羈絆追蹤欄。手機版一行最多三個晶片：已啟動的兩個加上最接近啟動的一個，其他收成「+N」，點了展開全部；
 * 點晶片打開說明。電腦版是一張卡片，已啟動的排前面，點一列就地展開說明
 */
export function synergyTracker(roster: Roster, relics: readonly RelicId[], opts: TrackerOptions): HTMLElement {
  const rows = synergyRows(roster.lineup, roster.captain, relics)
  const sorted = [...rows].sort(byImportance)
  const box = el('section', 'syn-tracker')
  box.setAttribute('aria-label', T.synergyTitle)

  // 手機版：晶片
  const on = sorted.filter((r) => r.tier > 0)
  const off = sorted.filter((r) => r.tier === 0)
  let shown = [...on.slice(0, 2), ...off.slice(0, 1)]
  if (shown.length < 3) shown = [...shown, ...on.slice(2, 2 + 3 - shown.length)]
  const visible = opts.expanded ? sorted : shown
  const strip = el('div', `syn-strip mobile-only${opts.expanded ? ' expanded' : ''}`)
  const chips = el('div', 'syn-chips')
  for (const row of visible) {
    const chip = el('button', `syn-chip ${stateOf(row)}`)
    chip.type = 'button'
    chip.setAttribute('aria-label', `${SYNERGY_NAMES[row.key]} ${countText(row)} ${statusText(row)}`)
    chip.append(synergyIcon(row.key, 18, `syn-icon ${stateOf(row)}`), el('span', 'syn-chip-name', SYNERGY_SHORT[row.key]), el('span', 'syn-chip-count', countText(row)))
    chip.onclick = () => opts.onOpen(row)
    chips.append(chip)
  }
  strip.append(chips)
  const hidden = rows.length - shown.length
  if (hidden > 0) {
    const toggle = el('button', 'syn-toggle')
    toggle.type = 'button'
    toggle.setAttribute('aria-label', opts.expanded ? T.collapseSynergy : T.expandSynergy)
    toggle.setAttribute('aria-expanded', String(opts.expanded))
    if (!opts.expanded) toggle.append(`+${hidden}`)
    toggle.insertAdjacentHTML('beforeend', `<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="${opts.expanded ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}"/></svg>`)
    toggle.onclick = () => opts.onToggle(!opts.expanded)
    strip.append(toggle)
  }
  box.append(strip)

  // 電腦版：列
  const card = el('div', 'syn-card desk-only')
  const head = el('div', 'syn-card-head')
  head.append(el('h2', 'syn-card-title', T.synergyTitle), el('span', 'syn-card-sub', T.synergyLineupOnly), el('span', 'syn-card-count', T.synergyActiveCount(rows.filter((r) => r.tier > 0).length)))
  card.append(head)
  if (opts.extra) card.append(opts.extra)
  const list = el('div', 'syn-rows')
  for (const row of sorted) {
    const item = el('div', `syn-row ${stateOf(row)}`)
    const button = el('button', 'syn-row-btn')
    button.type = 'button'
    button.setAttribute('aria-expanded', 'false')
    button.append(synergyHead(row))
    let detail: HTMLElement | null = null
    button.onclick = () => {
      if (detail) {
        detail.remove()
        detail = null
      } else {
        detail = synergyDetail(row, roster, relics)
        item.append(detail)
      }
      button.setAttribute('aria-expanded', String(!!detail))
    }
    item.append(button)
    list.append(item)
  }
  card.append(list)
  box.append(card)

  if (!captainIn(roster.lineup, roster.captain)) {
    const hint = el('div', 'syn-no-captain')
    hint.append(captainIcon(18), T.noCaptain)
    box.append(hint)
  }
  return box
}

/** 手機版說明視窗的內容：標頭加說明 */
export function synergySheetBody(row: SynergyRow, roster: Roster, relics: readonly RelicId[]): HTMLElement {
  const body = el('div', 'syn-sheet')
  body.append(synergyHead(row), synergyDetail(row, roster, relics))
  return body
}

/**
 * 球員詳細資料裡「他在哪些羈絆裡」：他的流派羈絆（隊長另外註明算幾人），
 * 站在二游或捕手的人再加上對應的守位羈絆
 */
export function playerSynergies(p: Batter, roster: Roster, relics: readonly RelicId[]): HTMLElement {
  const box = el('section', 'player-syn')
  box.append(el('h3', 'player-syn-title', T.synergyIn))
  const rows = synergyRows(roster.lineup, roster.captain, relics)
  const spot = roster.lineup.find((s) => s.player.id === p.id)
  const captain = captainIn(roster.lineup, roster.captain) === p.id
  const line = (row: SynergyRow, note: string) => {
    const item = el('div', `player-syn-row ${stateOf(row)}`)
    const text = el('span', 'player-syn-text')
    const title = el('span', 'syn-title')
    title.append(el('span', 'syn-name', SYNERGY_NAMES[row.key]), el('span', `syn-status ${stateOf(row)}`, row.position ? statusText(row) : `${statusText(row)}・${countText(row)}`))
    text.append(title, el('span', 'syn-hint', note))
    item.append(synergyIcon(row.key, 30, `syn-icon ${stateOf(row)}`), text)
    box.append(item)
  }
  const own = rows.find((r) => r.key === p.archetype)!
  line(
    own,
    !spot ? T.synergyBenchSelf : captain ? `${T.synergyCaptainNote(captainWeight(relics))}；${T.synergyNoteActive(missing(own), own.tier)}` : T.synergyNoteActive(missing(own), own.tier),
  )
  if (spot) {
    const key = spot.position === '2B' || spot.position === 'SS' ? 'middle' : spot.position === 'C' ? 'battery' : null
    if (key) {
      const row = rows.find((r) => r.key === key)!
      const native = p.primary === spot.position
      line(row, row.tier ? T.positionYou(SYNERGY_NAMES[key]) : native ? row.reason : T.positionBecause(POSITION_SPOT[spot.position], FIELDER_TITLES[spot.position as 'C' | '2B' | 'SS']))
    }
  }
  return box
}

export interface BadgeOptions {
  /** 寫全名（重砲打線）；否則寫簡稱（重砲） */
  full?: boolean
  /** 再加上最接近啟動的一個（虛線框，寫「差 N」） */
  near?: boolean
}

/** 精簡標籤上的階級：3 人階寫「3 人」，5 人階寫「5 人」（金底），守位羈絆寫「成立」；有門檻秘寶時照實際門檻 */
function tierText(row: SynergyRow): string {
  if (row.position) return T.positionOn
  return T.synergyTierLabel(row.tier === 2 ? row.high : row.low)
}

/** 一個羈絆的精簡標籤：圖示、名稱、階級 */
export function synergyBadge(row: SynergyRow, full = false): HTMLElement {
  const badge = el('span', `syn-badge ${stateOf(row)}`)
  badge.title = `${SYNERGY_NAMES[row.key]}：${statusText(row)}`
  badge.append(synergyIcon(row.key, 18), el('span', 'syn-badge-name', (full ? SYNERGY_NAMES : SYNERGY_SHORT)[row.key]), el('span', 'syn-badge-tier', tierText(row)))
  return badge
}

/**
 * 錦標賽主畫面、對手陣容、比賽中的精簡版：已啟動的羈絆一個一個標籤，人多的排前面；
 * 都沒有啟動又不加最接近的時候寫「無」
 */
export function synergyBadges(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[], opts: BadgeOptions = {}): HTMLElement {
  const rows = [...synergyRows(lineup, captain, relics)].sort(byImportance)
  const box = el('span', 'syn-badges')
  const active = rows.filter((r) => r.tier > 0)
  for (const row of active) box.append(synergyBadge(row, opts.full))
  const closest = rows.find((r) => r.tier === 0)
  if (opts.near && closest) {
    const badge = el('span', 'syn-badge near')
    badge.title = `${SYNERGY_NAMES[closest.key]}：${closest.position ? closest.reason : T.synergyHint(0, missing(closest))}`
    badge.append(synergyIcon(closest.key, 18, 'syn-icon off'), el('span', 'syn-badge-name', (opts.full ? SYNERGY_NAMES : SYNERGY_SHORT)[closest.key]), el('span', 'syn-badge-tier', T.synergyMissing(missing(closest))))
    box.append(badge)
  } else if (!active.length) box.append(el('span', 'syn-badge-hint', T.noSynergyShort))
  return box
}

/** 「已啟動 2・最接近 1」這類摘要 */
export function synergyCountText(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): string {
  const rows = synergyRows(lineup, captain, relics)
  return T.synergySummary(rows.filter((r) => r.tier > 0).length, rows.some((r) => r.tier === 0))
}

/** 對手一句話：依啟動的羈絆描述他們的打法，沒有羈絆就回傳空字串 */
export function synergyScouting(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): string {
  const active = synergyRows(lineup, captain, relics).filter((r) => r.tier > 0).sort(byImportance)
  return active.length ? T.scoutingLine(active.map((r) => SYNERGY_SCOUTING[r.key])) : ''
}

// ---- 羈絆變化預告 ----

/** 一個羈絆的變化：升級、啟動（守位羈絆是成立）、失效、降階，或只有人數變了 */
export interface SynergyDiff {
  key: SynergyKey
  kind: 'up' | 'act' | 'lose' | 'down' | 'count'
  from: number
  to: number
}

const DIFF_ORDER: Record<SynergyDiff['kind'], number> = { up: 0, act: 1, lose: 2, down: 3, count: 4 }

/** 兩個陣容之間的羈絆變化，重要的排前面 */
export function synergyDiff(before: Roster, after: Roster, relics: readonly RelicId[]): SynergyDiff[] {
  const a = synergyRows(before.lineup, before.captain, relics)
  const b = synergyRows(after.lineup, after.captain, relics)
  return SYNERGY_KEYS.flatMap((key): SynergyDiff[] => {
    const x = a.find((r) => r.key === key)!
    const y = b.find((r) => r.key === key)!
    if (y.tier > x.tier) return [{ key, kind: y.tier === 2 ? 'up' : 'act', from: x.count, to: y.count }]
    if (y.tier < x.tier) return [{ key, kind: y.tier === 0 ? 'lose' : 'down', from: x.count, to: y.count }]
    if (!y.position && y.count !== x.count) return [{ key, kind: 'count', from: x.count, to: y.count }]
    return []
  }).sort((p, q) => DIFF_ORDER[p.kind] - DIFF_ORDER[q.kind])
}

/** 變化的文字：「重砲打線 升級」「黃金二遊 成立」「鐵壁球隊 失效」「快腿 2→1」；short 時用簡稱 */
export function diffText(d: SynergyDiff, short = false): string {
  const name = (short ? SYNERGY_SHORT : SYNERGY_NAMES)[d.key]
  switch (d.kind) {
    case 'up':
      return T.diffUp(name)
    case 'act':
      return isPositionKey(d.key) ? T.diffFormed(name) : T.diffActivate(name)
    case 'lose':
      return T.diffLose(name)
    case 'down':
      return T.diffDown(name)
    case 'count':
      return T.diffCount(SYNERGY_SHORT[d.key], d.from, d.to)
  }
}

/** 變化標籤：綠＝啟動或成立、金＝升級、灰虛線＝失效、白＝只有人數變了 */
export function diffTag(d: SynergyDiff, short = false): HTMLElement {
  const tag = el('span', `diff-tag ${d.kind}`)
  tag.append(synergyIcon(d.key, 14), diffText(d, short))
  return tag
}

/** 警告標籤（紅）：失去隊長、守非本職 */
export function warnTag(text: string, kind: 'captain' | 'offpos'): HTMLElement {
  const tag = el('span', 'diff-tag warn')
  if (kind === 'captain') tag.append(captainIcon(14))
  tag.append(text)
  return tag
}

// ---- 羈絆秘寶 ----

/**
 * 羈絆秘寶卡上的「連動」與「你的隊伍」：拿到這個秘寶以後，目前的陣容會怎樣。
 * 不是羈絆秘寶就回傳 null
 */
export function relicPreview(id: RelicId, roster: Roster, relics: readonly RelicId[]): HTMLElement | null {
  const archetype = ARCHETYPES.find((a) => THRESHOLD_RELICS[a] === id)
  if (!archetype && id !== 'captainBand') return null
  const box = el('span', 'relic-preview')
  const link = el('span', 'relic-link')
  if (archetype) link.append(synergyIcon(archetype, 18), T.relicLink(SYNERGY_NAMES[archetype]))
  else link.append(captainIcon(18), T.relicLink(T.captainLabel))
  const after = [...relics, id]
  const captain = captainIn(roster.lineup, roster.captain)
  const rowOf = (rel: readonly RelicId[], key: SynergyKey) => synergyRows(roster.lineup, captain, rel).find((r) => r.key === key)!
  let kind: 'act' | 'up' | 'count' = 'count'
  let text: string
  if (archetype) {
    const before = rowOf(relics, archetype)
    const now = rowOf(after, archetype)
    const who = T.archetypeCount(ARCHETYPE_NAMES[archetype], now.count)
    if (now.tier > before.tier) {
      kind = now.tier === 2 ? 'up' : 'act'
      text = T.relicNow(who, SYNERGY_NAMES[archetype], now.tier === 2)
    } else if (now.tier === 1) {
      kind = 'act'
      text = T.relicProgress(who, SYNERGY_NAMES[archetype], T.synergyCount(now.count, now.high), now.high - now.count)
    } else if (now.tier === 2) text = `${who}：${T.synergyHint(2, 0)}`
    else text = `${who}：${T.synergyHint(0, now.low - now.count)}`
  } else {
    const cap = roster.lineup.find((s) => s.player.id === captain)?.player
    if (!cap) text = T.relicNoCaptain
    else {
      const before = rowOf(relics, cap.archetype)
      const now = rowOf(after, cap.archetype)
      if (now.tier > before.tier) kind = now.tier === 2 ? 'up' : 'act'
      text = T.relicCaptain(cap.name, SYNERGY_NAMES[cap.archetype], before.count, now.count, now.tier > before.tier ? (now.tier === 2 ? T.upgradeWord : T.activateWord) : '')
    }
  }
  const team = el('span', 'relic-team')
  team.append(el('span', 'relic-team-label', T.yourTeam), el('span', `relic-team-text ${kind}`, text))
  box.append(link, team)
  return box
}
