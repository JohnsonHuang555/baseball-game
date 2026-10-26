// 圖像化的球員元件：小卡、詳細資料、能力值、特性、toast
import { cardTier, isSpecial } from '../sim/generate'
import { TRAITS } from '../sim/traits'
import type { Player } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { gradeBadge, overallBadge } from './grades'
import { el, traitTag } from './playerCard'
import { play } from './sound'
import { RATING_FULL, RATING_LABELS, T, TRAIT_DESC } from './strings'

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

/** 能力值列：全名、字母、依等級上色的長條 */
export function ratingBars(p: Player): HTMLElement {
  const list = el('div', 'rating-bars')
  for (const [key, value] of Object.entries(p.ratings)) {
    const row = el('div', 'rating-row')
    const badge = gradeBadge(value, 'md')
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
  const ovr = el('div', 'detail-ovr')
  ovr.append(el('span', 'eyebrow-ink', T.overallLabel), overallBadge(p, 'lg'))
  head.append(frame, info, ovr)
  return head
}
