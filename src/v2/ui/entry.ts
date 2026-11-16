// V1 首頁上的模式選擇：V2 放置經營放在最上面最好找，V1 原版的按鈕照舊保留在下面
import { el } from '../../ui/playerCard'
import { V2T } from './strings'

/** 進入 V2 的大按鈕 */
export function v2EntryButton(onClick: () => void): HTMLButtonElement {
  const b = el('button', 'v2-entry')
  b.type = 'button'
  b.dataset.mode = 'v2'
  const text = el('span', 'v2-entry-text')
  text.append(el('span', 'v2-entry-title', V2T.modeTitle), el('span', 'v2-entry-desc', V2T.modeDesc))
  b.append(text, el('span', 'v2-entry-badge', V2T.modeBadge))
  b.onclick = onClick
  return b
}

/** V1 按鈕群上方的小標題 */
export function v1Label(): HTMLElement {
  return el('p', 'v1-label', V2T.classicLabel)
}

/** 網址帶 #v2 就直接進 V2（重新整理後回到原本的模式） */
export const V2_HASH = '#v2'
