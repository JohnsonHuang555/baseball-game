import { overall } from '../sim/generate'
import type { Player } from '../sim/types'
import { el } from './playerCard'

/** 野球魂式的字母等級，S 最強、G 最弱 */
export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

/** 1～10 的能力值（或平均值）換成字母等級；5 分是聯盟平均的 D */
export function gradeOf(value: number): Grade {
  if (value >= 8.5) return 'S'
  if (value >= 7.5) return 'A'
  if (value >= 6.5) return 'B'
  if (value >= 5.5) return 'C'
  if (value >= 4.5) return 'D'
  if (value >= 3.5) return 'E'
  if (value >= 2.5) return 'F'
  return 'G'
}

export function gradeBadge(value: number, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const g = gradeOf(value)
  return el('span', `grade grade-${g} grade-${size}`, g)
}

export function overallBadge(p: Player, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  return gradeBadge(overall(p), size)
}
