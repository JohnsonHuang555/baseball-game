// 圖像化的球員元件：小卡、球場守位、詳細資料
import { cardTier, isSpecial } from '../sim/generate'
import { TRAITS } from '../sim/traits'
import type { Player } from '../sim/types'
import { avatar } from './avatar'
import { gradeBadge, overallBadge } from './grades'
import { el } from './playerCard'
import { RATING_FULL, RATING_LABELS, TRAIT_DESC, TRAIT_NAMES } from './strings'

export const USER_COLOR = '#3b82f6'
export const CPU_COLOR = '#ef4444'

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

/** 小卡：頭像、名字、標籤、總評字母 */
export function miniCard(p: Player, label: string, color: string, state: CardState = {}): HTMLButtonElement {
  const card = el('button', 'mini-card')
  applyCardState(card, p, state)
  const face = el('div', 'mini-face')
  face.append(avatar(p.id, color), overallBadge(p, 'sm'))
  card.append(face, el('div', 'mini-name', p.name), el('div', 'mini-label', label))
  return card
}

/** 畫面下方短暫出現的提示，幾秒後自己消失 */
export function toast(text: string): void {
  document.querySelector('.toast')?.remove()
  const node = el('div', 'toast', text)
  document.body.append(node)
  window.setTimeout(() => node.classList.add('leaving'), 1800)
  window.setTimeout(() => node.remove(), 2200)
}

/** 一行能力值字母：打 B 力 D 速 E */
export function gradeLine(p: Player): HTMLElement {
  const line = el('span', 'grade-line')
  for (const [key, value] of Object.entries(p.ratings)) {
    const item = el('span', 'gl-item')
    item.append(el('span', 'gl-label', RATING_LABELS[key as keyof typeof RATING_LABELS]), gradeBadge(value, 'sm'))
    line.append(item)
  }
  return line
}

/** 能力值列：全名、字母、長條 */
export function ratingBars(p: Player): HTMLElement {
  const list = el('div', 'rating-bars')
  for (const [key, value] of Object.entries(p.ratings)) {
    const row = el('div', 'rating-row')
    const bar = el('div', 'bar')
    const fill = el('div', 'bar-fill')
    fill.style.width = `${value * 10}%`
    bar.append(fill)
    row.append(el('span', 'rating-name', RATING_FULL[key as keyof typeof RATING_FULL]), gradeBadge(value), bar)
    list.append(row)
  }
  return list
}

/** 特性與說明 */
export function traitList(p: Player): HTMLElement {
  const list = el('div', 'trait-list')
  for (const t of p.traits) {
    const row = el('div', 'trait-item')
    row.append(el('span', `trait trait-${TRAITS[t].tier}`, TRAIT_NAMES[t]), el('span', 'trait-desc', TRAIT_DESC[t]))
    list.append(row)
  }
  return list
}

/** 詳細資料的上半部：大頭像、名字、總評 */
export function playerHeader(p: Player, label: string, color: string): HTMLElement {
  const head = el('div', `detail-head tier-${cardTier(p)}`)
  const face = el('div', 'detail-face')
  face.append(avatar(p.id, color))
  const info = el('div', 'detail-info')
  info.append(el('div', 'eyebrow', label), el('div', 'detail-name', p.name))
  head.append(face, info, overallBadge(p, 'lg'))
  return head
}
