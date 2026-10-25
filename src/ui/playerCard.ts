import { TRAITS } from '../sim/traits'
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

export function traitChips(p: Player): HTMLElement {
  const wrap = el('div', 'traits')
  for (const t of p.traits) wrap.append(el('span', `trait trait-${TRAITS[t].tier}`, TRAIT_NAMES[t]))
  return wrap
}
