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

/**
 * 等級徽章。lite 用在列表與比賽中的打者列：字母不上等級色，只有 S、A 保留顏色當強項提示；
 * 等級色只留給球員本身是主角的地方（球員詳細資料、新球員的總評）
 */
export function gradeBadge(value: number, size: 'sm' | 'md' | 'lg' | 'xl' = 'md', lite = false): HTMLElement {
  const g = gradeOf(value)
  const plain = lite && g !== 'S' && g !== 'A'
  return el('span', `grade grade-${size} ${plain ? 'grade-lite' : `grade-${g}`}`, g)
}

export function overallBadge(p: Player, size: 'sm' | 'md' | 'lg' | 'xl' = 'md', lite = false): HTMLElement {
  return gradeBadge(overall(p), size, lite)
}
