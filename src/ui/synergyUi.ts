// 羈絆的畫面元件：流派徽章、隊長標記、陣容上方的羈絆徽章（V2 陣容、招募、球員養成畫面用）
import type { RelicId } from '../sim/items'
import { withEquipment } from '../sim/items'
import { POSITION_SYNERGY_FIELDING, archetypeCounts, captainIn, positionSynergies, synergyTiers, thresholds, type SynergyKey, type SynergyTier } from '../sim/synergy'
import { ARCHETYPES, type Batter, type LineupSpot } from '../sim/types'
import { gradeOf } from './grades'
import { el } from './playerCard'
import { ARCHETYPE_NAMES, FIELDER_TITLES, SYNERGY_NAMES, SYNERGY_SHORT, T } from './strings'
import { ARCHETYPE_COLORS, archetypeSvg, captainSvg, positionSynergySvg, synergySvg } from './synergyIcons'

/** 一個羈絆目前的狀態。守位羈絆只有成立（tier 1）與未成立兩種 */
export interface SynergyRow {
  key: SynergyKey
  /** 守位羈絆（黃金二遊、投捕搭檔） */
  position: boolean
  tier: SynergyTier
  /** 流派羈絆的人數（隊長算兩人或三人）；守位羈絆成立就是 1 */
  count: number
  /** 兩階的門檻（有門檻秘技時是 2、4）；守位羈絆都是 1 */
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
    // 防守型當指定打擊不算鐵壁球隊
    const members = lineup.filter((s) => s.player.archetype === a && !(a === 'defense' && s.position === 'DH')).map((s) => s.player)
    return { key: a, position: false, tier: tiers[a], count: counts[a], low, high, members, reason: '' }
  })
  const pos = positionSynergies(lineup)
  const spot = (p: 'C' | '2B' | 'SS') => lineup.find((s) => s.position === p)
  // 未成立的原因：先看有沒有人守非本職，再看誰的守備不到 B（含裝備）
  const fielding = (p: Batter) => withEquipment(p).ratings.fielding
  const why = (positions: ('C' | '2B' | 'SS')[], ok: boolean) => {
    if (ok) return positions.length > 1 ? T.middleOk : T.positionOk(FIELDER_TITLES.C, spot('C')?.player.name ?? '')
    const spots = positions.map(spot).filter((s): s is LineupSpot => !!s)
    const off = spots.find((s) => s.player.primary !== s.position)
    if (off) return T.positionOff(FIELDER_TITLES[off.position as 'C' | '2B' | 'SS'], off.player.name)
    const weak = spots.find((s) => fielding(s.player) < POSITION_SYNERGY_FIELDING)
    return weak ? T.positionWeak(FIELDER_TITLES[weak.position as 'C' | '2B' | 'SS'], weak.player.name, gradeOf(fielding(weak.player))) : ''
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

/** 排序用：已啟動的依人數多到少排前面（守位羈絆當 3.5 人），未啟動的依離門檻近到遠 */
function byImportance(a: SynergyRow, b: SynergyRow): number {
  const weight = (r: SynergyRow) => (r.position ? (r.tier ? 3.5 : 2.5) : r.tier ? r.count : r.count - r.low)
  return Number(b.tier > 0) - Number(a.tier > 0) || weight(b) - weight(a)
}

export interface BadgeOptions {
  /** 寫全名（重砲打線）；否則寫簡稱（重砲） */
  full?: boolean
  /** 再加上最接近啟動的一個（虛線框，寫「差 N」） */
  near?: boolean
}

/** 精簡標籤上的階級：3 人階寫「3 人」，5 人階寫「5 人」（金底），守位羈絆寫「成立」；有門檻秘技時照實際門檻 */
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
    const gap = closest.position ? T.positionOffShort : T.synergyMissing(missing(closest))
    badge.append(synergyIcon(closest.key, 18, 'syn-icon off'), el('span', 'syn-badge-name', (opts.full ? SYNERGY_NAMES : SYNERGY_SHORT)[closest.key]), el('span', 'syn-badge-tier', gap))
    box.append(badge)
  } else if (!active.length) box.append(el('span', 'syn-badge-hint', T.noSynergyShort))
  return box
}

// ---- 羈絆變化預告 ----

// ---- 羈絆秘技 ----
