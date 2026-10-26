import { TRAITS, type TraitId } from '../sim/traits'
import type { Player } from '../sim/types'
import { TRAIT_NAMES } from './strings'

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

/** 特性的圖示：金特星號、藍特加號、紅特減號，不靠顏色也分得出來 */
const TRAIT_ICONS = {
  gold: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z"/></svg>',
  blue: '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  red: '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
}

export function traitTag(t: TraitId): HTMLElement {
  const tier = TRAITS[t].tier
  const tag = el('span', `trait trait-${tier}`)
  tag.innerHTML = TRAIT_ICONS[tier]
  tag.append(TRAIT_NAMES[t])
  return tag
}

export function traitChips(p: Player): HTMLElement {
  const wrap = el('div', 'traits')
  for (const t of p.traits) wrap.append(traitTag(t))
  return wrap
}
