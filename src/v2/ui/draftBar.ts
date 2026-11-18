// 草稿儲存列（陣容、戰術共用；設計稿 v7 元件表「儲存列」）：
// clean 已儲存（綠點，不浮動）／dirty 有變更（橘點，還原＋儲存）／stale 已在其他分頁更新（紅色，只能載入最新設定）／
// selected 陣容選取中（再點一位交換）／invalid 陣容不合法（說明原因）
import { el } from '../../ui/playerCard'
import { icon, type IconName } from './icons'

export type DraftBarKind = 'clean' | 'dirty' | 'stale' | 'selected' | 'invalid'

export function draftBar(kind: DraftBarKind, status: string, sub: string, buttons: HTMLElement[]): HTMLElement {
  const bar = el('div', `v2-savebar ${kind}`)
  bar.setAttribute('role', 'status')
  bar.dataset.state = kind
  const lead =
    kind === 'stale' || kind === 'invalid' ? icon('alert', 20, 'v2-savebar-icon') : kind === 'selected' ? icon('swap', 20, 'v2-savebar-icon') : el('span', 'v2-savebar-dot')
  const text = el('span', 'v2-savebar-text')
  const s = el('span', 'v2-savebar-status', status)
  if (kind === 'stale' || kind === 'invalid') s.classList.add('error')
  text.append(s)
  if (sub) text.append(el('span', 'v2-savebar-sub', sub))
  const box = el('div', 'v2-savebar-buttons')
  box.append(...buttons)
  bar.append(lead, text)
  if (buttons.length) bar.append(box)
  return bar
}

export function barButton(cls: string, label: string, action: string, run: () => void, ico?: IconName): HTMLButtonElement {
  const b = el('button', cls)
  b.type = 'button'
  b.dataset.action = action
  if (ico) b.append(icon(ico, 16))
  b.append(label)
  b.onclick = run
  return b
}
