// 圖像化的球員小元件：球種、守位、我方／對手標籤、能力等級列、特性列、toast（V2 畫面共用）
import { repertoire } from '../sim/pitches'
import type { Batter, Pitcher, Player } from '../sim/types'
import { gradeBadge } from './grades'
import { el, potentialTag, traitTag } from './playerCard'
import { play } from './sound'
import { PITCH_TRAIT_DESC, PITCH_TRAIT_NAMES, POSITION_SPOT, RATING_LABELS, T, TRAIT_DESC } from './strings'

/** 球場動畫用的隊伍顏色，和頭像帽子同色：我方藍、對手橘 */
export const USER_COLOR = '#2D7CFF'
export const CPU_COLOR = '#FF7A1A'

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
