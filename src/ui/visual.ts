// 圖像化的球員元件：小卡、詳細資料、能力值、特性、toast
import { cardTier, isSpecial } from '../sim/generate'
import { repertoire } from '../sim/pitches'
import { fieldingAtPosition, positionPenalty } from '../sim/positions'
import { TRAITS } from '../sim/traits'
import type { Batter, Pitcher, Player, Position, Tendency } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { gradeBadge, gradeOf, overallBadge } from './grades'
import { el, potentialTag, traitTag } from './playerCard'
import { play } from './sound'
import { archetypeChip } from './synergyUi'
import { PITCH_TRAIT_DESC, PITCH_TRAIT_NAMES, POSITION_SPOT, RATING_FULL, RATING_LABELS, T, TRAIT_DESC } from './strings'

/** 球場動畫用的隊伍顏色，和頭像帽子同色：我方藍、對手橘 */
export const USER_COLOR = '#2D7CFF'
export const CPU_COLOR = '#FF7A1A'

export interface CardState {
  selected?: boolean
  /** 剛抽到的球員要翻牌，稀有的再加特效 */
  reveal?: boolean
}

export function applyCardState(node: HTMLElement, p: Player, state: CardState): void {
  node.classList.add(`tier-${cardTier(p)}`)
  if (p.traits.some((t) => TRAITS[t].tier === 'gold')) node.classList.add('has-gold')
  if (state.selected) node.classList.add('selected')
  if (state.reveal) node.classList.add(isSpecial(p) ? 'reveal-special' : 'reveal')
}

/** 小卡：卡色底、頭像、總評字母、名字 */
export function miniCard(p: Player, label: string, team: AvatarTeam = 'user', state: CardState = {}): HTMLButtonElement {
  const card = el('button', 'mini-card')
  applyCardState(card, p, state)
  const top = el('span', 'mini-top')
  top.append(avatar(p.id, team, 'ring'), overallBadge(p, 'sm'))
  card.append(top, el('span', 'mini-name', p.name))
  if (label) card.append(el('span', 'mini-label', label))
  card.setAttribute('aria-label', `${label} ${p.name}`)
  return card
}

/** 畫面下方短暫出現的提示，幾秒後自己消失 */
/** 擊球方向的箭頭：往左上、正上、右上 */
const TENDENCY_ARROWS: Record<Tendency, string> = {
  left: 'M15 15 L6 6 M6 13 V6 H13',
  even: 'M10 17 V4 M5 9 L10 4 L15 9',
  right: 'M5 15 L14 6 M7 6 H14 V13',
}

/** 擊球方向標籤：箭頭加「偏左／平均／偏右」；full 時寫成「擊球方向：偏左外野」 */
export function tendencyChip(t: Tendency, full = false): HTMLElement {
  const chip = el('span', `tendency-chip ${t}`)
  chip.innerHTML = `<svg aria-hidden="true" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${TENDENCY_ARROWS[t]}"/></svg>`
  chip.append(full ? `${T.tendencyLabel}：${T.tendencyNames[t]}` : T.tendencyShort[t])
  chip.title = `${T.tendencyLabel}：${T.tendencyNames[t]}`
  return chip
}

/** 慣用手標籤：右打、左打、兩打、右投、左投。給 matchup 時用顏色標出同側（不利）或對側 */
export function handChip(p: Player, matchup?: 'same' | 'opposite'): HTMLElement {
  const text = p.role === 'batter' ? T.bats[p.bats] : T.throws[p.throws]
  const chip = el('span', `hand-chip ${matchup ?? ''}`, matchup ? `${text}・${T.matchupNames[matchup]}` : text)
  if (matchup) chip.title = T.matchupTips[matchup]
  return chip
}

/**
 * 投手的球種標籤：精簡版寫「直 滑 曲」，full 時寫全名；看家球種反白標出
 */
export function pitchChip(p: Pitcher, full = false): HTMLElement {
  const kinds = repertoire(p)
  const chip = el('span', `pitch-chip${full ? ' full' : ''}`)
  if (full) chip.append(el('span', 'pitch-chip-label', T.pitchesLabel))
  kinds.forEach((k, i) => {
    // 帶球種特性的球種加上特性名稱，例如「銳利滑球」
    const trait = p.pitchTraits?.[k]
    const name = full ? T.pitchNames[k] : T.pitchShort[k]
    const item = el('span', `pitch-chip-item${i === 1 ? ' primary' : ''}${trait ? ' has-trait' : ''}`, trait && full ? T.pitchTraitName(PITCH_TRAIT_NAMES[trait], name) : name)
    if (trait) item.title = PITCH_TRAIT_DESC[trait]
    chip.append(item)
  })
  chip.title = T.pitchesTitle(kinds.map((k) => T.pitchNames[k]).join('、'), T.pitchNames[kinds[1]])
  return chip
}

/** 非本職的警示三角：紅底、白色驚嘆號 */
export function offPosIcon(size = 12): HTMLElement {
  const icon = el('span', 'offpos-icon')
  icon.innerHTML = `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M12 2.4 22.6 20.8H1.4Z" fill="#D9283C" stroke="#141633" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 8.6v5.6" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="18" r="1.4" fill="#fff"/></svg>`
  return icon
}

/** 本職標籤：「本職 二壘」 */
export function primaryChip(b: Batter): HTMLElement {
  return el('span', 'primary-chip', T.primaryChip(POSITION_SPOT[b.primary]))
}

/** 守非本職時的完整說明：「目前守游擊（非本職）：守備 B → C」加上原因；守本職就回傳 null */
export function offPositionNote(b: Batter, position: Position): HTMLElement | null {
  const penalty = positionPenalty(b.primary, position)
  if (!penalty) return null
  const box = el('div', 'offpos-note')
  const text = el('span', 'offpos-text')
  const from = gradeOf(b.ratings.fielding)
  const to = gradeOf(fieldingAtPosition(b, position))
  text.append(el('strong', '', T.offPositionTitle(POSITION_SPOT[position], from, to)), el('span', '', T.offPositionWhy(penalty, POSITION_SPOT[b.primary])))
  box.append(offPosIcon(24), text)
  return box
}

/** 「我方」或「對手」的小標籤，讓玩家一眼分出自己的球隊 */
export function sideTag(isUser: boolean): HTMLElement {
  return el('span', `side-tag ${isUser ? 'user' : 'opponent'}`, isUser ? T.mySide : T.opponentSide)
}

export function toast(text: string): void {
  play('pop')
  document.querySelector('.toast')?.remove()
  const node = el('div', 'toast')
  node.setAttribute('role', 'status')
  node.innerHTML =
    '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFD23F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
  node.append(text)
  document.body.append(node)
  window.setTimeout(() => node.classList.add('leaving'), 1800)
  window.setTimeout(() => node.remove(), 2200)
}

/** 一行能力值字母：打 B 力 D 速 E 守 C */
export function gradeLine(p: Player): HTMLElement {
  const line = el('span', 'grade-line')
  for (const [key, value] of Object.entries(p.ratings)) {
    const item = el('span', 'gl-item')
    item.append(el('span', 'gl-label', RATING_LABELS[key as keyof typeof RATING_LABELS]), gradeBadge(value, 'sm'))
    line.append(item)
  }
  return line
}

/** 能力值列：全名、字母、依等級上色的長條。給了守位就把守備換成守這個位置的實際值，非本職時字母加紅框 */
export function ratingBars(p: Player, position?: Position): HTMLElement {
  const list = el('div', 'rating-bars')
  for (const [key, raw] of Object.entries(p.ratings)) {
    const row = el('div', 'rating-row')
    const off = key === 'fielding' && p.role === 'batter' && position !== undefined && positionPenalty(p.primary, position) > 0
    const value = off ? fieldingAtPosition(p as Batter, position) : raw
    const badge = gradeBadge(value, 'md')
    if (off) {
      badge.classList.add('off-outline')
      row.classList.add('off')
    }
    const bar = el('span', 'bar')
    const fill = el('span', `bar-fill fill-${badge.textContent}`)
    fill.style.width = `${value * 10}%`
    bar.append(fill)
    row.append(el('span', 'rating-name', RATING_FULL[key as keyof typeof RATING_FULL]), badge, bar)
    list.append(row)
  }
  return list
}

/** 特性與說明 */
export function traitList(p: Player): HTMLElement {
  const list = el('div', 'trait-list')
  for (const t of p.traits) {
    const row = el('div', 'trait-item')
    row.append(traitTag(t), el('span', 'trait-desc', TRAIT_DESC[t]))
    list.append(row)
  }
  const pot = potentialTag(p)
  if (pot && p.potential) {
    const row = el('div', 'trait-item')
    row.append(pot, el('span', 'trait-desc', T.potentialHint(T.potentialStats[p.potential.stat], p.potential.need)))
    list.append(row)
  }
  return list
}

/** 詳細資料的上半部：卡色外框的大頭像、卡色標籤、名字、總評 */
export function playerHeader(p: Player, label: string, team: AvatarTeam = 'user'): HTMLElement {
  const tier = cardTier(p)
  const head = el('div', `detail-head tier-${tier}`)
  const frame = el('div', 'detail-frame')
  frame.append(avatar(p.id, team, 'detail-avatar'))
  const info = el('div', 'detail-info')
  info.append(el('span', 'tier-tag', T.tierNames[tier]), el('h2', 'detail-name', p.name), el('span', 'detail-label', label))
  info.append(handChip(p))
  if (p.role === 'batter') info.append(archetypeChip(p), primaryChip(p), tendencyChip(p.tendency, true))
  else info.append(pitchChip(p, true))
  const ovr = el('div', 'detail-ovr')
  ovr.append(el('span', 'eyebrow-ink', T.overallLabel), overallBadge(p, 'lg'))
  head.append(frame, info, ovr)
  return head
}
