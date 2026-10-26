// 鍵盤快捷鍵：每個畫面登記自己的按鍵，切換畫面時整組換掉
import { el } from './playerCard'

/** 鍵名：一般字元用小寫（'r'、'1'），特殊鍵用 KeyboardEvent.key（'Enter'、'Escape'、'ArrowLeft'），空白鍵是 'Space' */
export type KeyMap = Record<string, () => void>

let current: KeyMap = {}

/** 換成這組按鍵，回傳原本那組，讓彈出視窗關閉時可以還原 */
export function setKeys(map: KeyMap): KeyMap {
  const previous = current
  current = map
  return previous
}

function keyName(e: KeyboardEvent): string {
  if (e.key === ' ') return 'Space'
  return e.key.length === 1 ? e.key.toLowerCase() : e.key
}

document.addEventListener('keydown', (e) => {
  // 打字中（例如改隊名）不攔截；也不處理組合鍵與按住不放的連發
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
  const handler = current[keyName(e)]
  if (!handler) return
  e.preventDefault()
  handler()
})

/** 鍵帽提示，只在有實體鍵盤滑鼠的裝置上顯示（CSS 依 hover／pointer 判斷） */
export function kbd(label: string): HTMLElement {
  return el('kbd', 'kbd', label)
}
