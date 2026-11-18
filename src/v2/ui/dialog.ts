// V2 的對話框（設計稿 v7 元件表「對話框」）：標題列有 ✕、內容可以捲動、主要動作固定在底部。
// Esc、點外面、右上 ✕、底部「關閉」都能關。sheet：手機從底部滑出的面板（球員養成、招募），電腦版置中 600 寬
import { setKeys } from '../../ui/keys'
import { el } from '../../ui/playerCard'
import { icon } from './icons'
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
