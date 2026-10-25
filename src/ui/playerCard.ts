import { cardTier, isSpecial, overall } from '../sim/generate'
import { TRAITS } from '../sim/traits'
import type { Player } from '../sim/types'
import { RATING_LABELS, TIER_NAMES, TRAIT_NAMES, T } from './strings'

export type Reveal = 'none' | 'flip'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

export function ratingsText(p: Player): string {
  return Object.entries(p.ratings)
    .map(([k, v]) => `${RATING_LABELS[k as keyof typeof RATING_LABELS]} ${v}`)
    .join('　')
}

export function traitChips(p: Player): HTMLElement {
  const wrap = el('div', 'traits')
  for (const t of p.traits) wrap.append(el('span', `trait trait-${TRAITS[t].tier}`, TRAIT_NAMES[t]))
  return wrap
}

export function playerCard(p: Player, label: string, opts: { selected?: boolean; reveal?: Reveal } = {}): HTMLElement {
  const tier = cardTier(p)
  const special = isSpecial(p)
  const card = el('button', `card tier-${tier}`)
  if (p.traits.some((t) => TRAITS[t].tier === 'gold')) card.classList.add('has-gold')
  if (opts.selected) card.classList.add('selected')
  if (opts.reveal === 'flip') card.classList.add(special ? 'reveal-special' : 'reveal')

  const head = el('div', 'card-head')
  head.append(el('span', 'card-label', label), el('span', 'card-name', p.name))
  const ovr = el('span', 'card-ovr', overall(p).toFixed(1))
  ovr.title = TIER_NAMES[tier]
  head.append(ovr)
  card.append(head, el('div', 'card-ratings', ratingsText(p)))
  if (p.traits.length) card.append(traitChips(p))
  if (opts.reveal === 'flip' && special) card.append(el('span', 'card-badge', T.rare))
  return card
}
