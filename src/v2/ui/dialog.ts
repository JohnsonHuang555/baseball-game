// V2 的對話框（設計稿 v7 元件表「對話框」）：標題列有 ✕、內容可以捲動、主要動作固定在底部。
// Esc、點外面、右上 ✕、底部「關閉」都能關。sheet：手機從底部滑出的面板（球員養成、招募），電腦版置中 600 寬
import { setKeys } from '../../ui/keys'
import { el } from '../../ui/playerCard'
import { icon, type IconName } from './icons'
import { V2T } from './strings'

export interface V2ModalOptions {
  /** 底部關閉按鈕的文字（預設「關閉」） */
  closeLabel?: string
  /** 不放底部關閉按鈕（只用右上 ✕；底部留給主要動作） */
  noCloseButton?: boolean
  /** 固定在底部、跟關閉按鈕放在一起的內容（例如升級成本與按鈕） */
  footer?: HTMLElement
  /** 手機版用底部面板 */
  sheet?: boolean
  /** 標題列的額外內容（取代純文字標題，例如球員頭像與名字）；仍保留標題給輔助科技 */
  header?: HTMLElement
  /** 對話框的額外 class */
  className?: string
}

export function v2Modal(title: string, body: HTMLElement, onClose?: () => void, opts: string | V2ModalOptions = {}): () => void {
  const o: V2ModalOptions = typeof opts === 'string' ? { closeLabel: opts } : opts
  const overlay = el('div', 'modal-overlay v2-modal-overlay')
  const box = el('section', `v2-modal${o.sheet ? ' sheet' : ''}${o.className ? ` ${o.className}` : ''}`)
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const head = el('header', 'v2-modal-head')
  const heading = el('h2', `modal-title${o.header ? ' v2-sr-only' : ''}`, title)
  heading.id = `v2-modal-${Math.random().toString(36).slice(2)}`
  box.setAttribute('aria-labelledby', heading.id)
  const x = el('button', 'v2-modal-x v2-modal-close')
  x.type = 'button'
  x.setAttribute('aria-label', V2T.close)
  x.append(icon('close', 14))
  if (o.header) head.append(o.header)
  head.append(heading, x)
  const content = el('div', 'v2-modal-body')
  content.append(body)
  box.append(head, content)
  const foot = el('footer', 'v2-modal-foot')
  if (o.footer) foot.append(o.footer)
  if (!o.noCloseButton) {
    const close = el('button', 'btn-white v2-modal-close v2-modal-bottom', o.closeLabel ?? V2T.close)
    close.type = 'button'
    close.onclick = () => done()
    foot.append(close)
  }
  if (foot.childNodes.length) box.append(foot)
  overlay.append(box)
  document.body.append(overlay)
  const previous = setKeys({ Escape: () => done() })
  let closed = false
  function done(): void {
    if (closed) return
    closed = true
    overlay.remove()
    setKeys(previous)
    onClose?.()
  }
  x.onclick = done
  overlay.onclick = (e) => {
    if (e.target === overlay) done()
  }
  // 焦點放在關閉鈕，但不要捲動：從頭開始看
  x.focus({ preventScroll: true })
  content.scrollTop = 0
  return done
}

export interface AnnounceButton {
  label: string
  /** data-action */
  action?: string
  /** 按下後關閉對話框（會呼叫 onClose） */
  closes?: boolean
  run?: () => void
}

export interface AnnounceOptions {
  icon: IconName
  /** 頂端徽章的底色 */
  badge?: 'white' | 'yellow'
  title: string
  /** 標題的 class（測試與樣式用） */
  titleClass?: string
  sub?: string
  content?: HTMLElement[]
  primary: AnnounceButton
  secondary?: AnnounceButton
  /** 彩帶（減少動態效果時不顯示） */
  celebrate?: boolean
  className?: string
  /** Esc、點外面、或按了會關閉的按鈕 */
  onClose?: () => void
}

/**
 * 公告型對話框（歡迎回來、晉級挑戰）：頂端圓形徽章、置中的大標題與說明、內容，按鈕直排（主要黃色在上）。
 * Esc 與點外面等同關閉
 */
export function announceModal(o: AnnounceOptions): () => void {
  const overlay = el('div', 'modal-overlay v2-modal-overlay v2-announce-overlay')
  const box = el('section', `v2-announce${o.className ? ` ${o.className}` : ''}${o.celebrate ? ' celebrate' : ''}`)
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const badge = el('span', `v2-announce-badge ${o.badge ?? 'white'}`)
  badge.append(icon(o.icon, 40))
  const title = el('h2', `v2-announce-title${o.titleClass ? ` ${o.titleClass}` : ''}`, o.title)
  title.id = `v2-modal-${Math.random().toString(36).slice(2)}`
  box.setAttribute('aria-labelledby', title.id)
  box.append(badge, title)
  if (o.sub) box.append(el('p', 'v2-announce-sub', o.sub))
  if (o.content) box.append(...o.content)
  const buttons = el('div', 'v2-announce-buttons')
  const make = (b: AnnounceButton, cls: string) => {
    const btn = el('button', `${cls}${b.closes ? ' v2-modal-close' : ''}`, b.label)
    btn.type = 'button'
    if (b.action) btn.dataset.action = b.action
    btn.onclick = () => {
      if (b.closes) done()
      b.run?.()
    }
    return btn
  }
  const primary = make(o.primary, 'btn-yellow')
  buttons.append(primary)
  if (o.secondary) buttons.append(make(o.secondary, 'btn-white'))
  box.append(buttons)
  if (o.celebrate) {
    const confetti = el('span', 'v2-confetti')
    confetti.setAttribute('aria-hidden', 'true')
    for (let i = 0; i < 18; i++) {
      const c = el('i')
      c.style.setProperty('--x', `${(i * 47 + 13) % 100}%`)
      c.style.setProperty('--d', `${(i % 6) * 0.15}s`)
      c.style.setProperty('--c', ['#FFD23F', '#2D7CFF', '#FF7A1A', '#22A35A', '#E5383B', '#FFFFFF'][i % 6])
      confetti.append(c)
    }
    overlay.append(confetti)
  }
  overlay.append(box)
  document.body.append(overlay)
  const previous = setKeys({ Escape: () => done() })
  let closed = false
  function done(): void {
    if (closed) return
    closed = true
    overlay.remove()
    setKeys(previous)
    o.onClose?.()
  }
  overlay.onclick = (e) => {
    if (e.target === overlay) done()
  }
  primary.focus({ preventScroll: true })
  return done
}
