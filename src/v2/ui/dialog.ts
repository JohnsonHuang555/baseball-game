// V2 的對話框（設計稿 v7 元件表「對話框」）：標題列有 ✕、內容可以捲動、主要動作固定在底部。
// Esc、點外面、右上 ✕、底部「關閉」都能關。sheet：手機從底部滑出的面板（球員養成、招募），電腦版置中 600 寬
import { currentKeys, setKeys, type KeyMap } from '../../ui/keys'
import { el } from '../../ui/playerCard'
import { icon, type IconName } from './icons'
import { V2T } from './strings'

// ---- 對話框堆疊：焦點與鍵盤 ----
// 每個開著的 V2 對話框都在堆疊裡。只有最上層的對話框處理 Tab／Shift+Tab（焦點限制在對話框內）與 Escape（關閉它）；
// 「最上層」除了看堆疊，也看畫面：如果之後又蓋了別的 aria-modal（例如從挑戰結果打開的觀戰畫面），就讓給那一層處理。
// 第一個對話框打開時把畫面的快捷鍵換成空的、最後一個關閉時還原，所以多層對話框不論用什麼順序關閉，快捷鍵都不會錯亂。

/** 對話框為什麼關閉：user 是玩家或畫面流程關的；dispose 是整個 App 關閉時一起清掉（不要再觸發任何後續動作） */
export type CloseReason = 'user' | 'dispose'

interface Layer {
  /** 限制焦點的範圍（對話框本體） */
  box: HTMLElement
  /** 誰開的（同一個 App 用同一個 owner）；App 關閉時只清掉自己的對話框 */
  owner: unknown
  /** 正式關閉這一層（跟按 ✕ 走同一條清理流程） */
  close: (reason: CloseReason) => void
  /** Escape：通常是關閉這一層 */
  escape: () => void
  /** 打開前的焦點，關閉時還原 */
  opener: Element | null
}

const stack: Layer[] = []
let savedKeys: KeyMap | null = null
let ownKeys: KeyMap | null = null
let listening = false

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 範圍內可以用 Tab 走到的元素（排除停用、隱藏） */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (x) => !(x as HTMLButtonElement).disabled && !x.closest('[hidden]') && !x.closest('[inert]') && x.getAttribute('aria-hidden') !== 'true',
  )
}

/** 這一層是不是畫面上真正的最上層（之後沒有蓋上別的 aria-modal） */
function isTopmost(layer: Layer): boolean {
  if (stack[stack.length - 1] !== layer) return false
  const modals = document.querySelectorAll('[aria-modal="true"]')
  const last = modals[modals.length - 1]
  return !last || last === layer.box || layer.box.contains(last) || last.contains(layer.box)
}

/** 焦點限制的範圍：對話框裡如果有第二次確認（role="alertdialog"），就只在那個小框裡 */
function trapRoot(layer: Layer): HTMLElement {
  const inner = layer.box.querySelectorAll<HTMLElement>('[role="alertdialog"]')
  return inner[inner.length - 1] ?? layer.box
}

function onKeydown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1]
  if (!top || !isTopmost(top)) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    top.escape()
    return
  }
  if (e.key !== 'Tab') return
  const root = trapRoot(top)
  const items = focusables(root)
  e.preventDefault()
  if (!items.length) {
    root.focus?.()
    return
  }
  const i = items.indexOf(document.activeElement as HTMLElement)
  // 焦點不在範圍內（例如剛從觀戰畫面回來）：Tab 到第一個、Shift+Tab 到最後一個
  const next = i < 0 ? (e.shiftKey ? items.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length
  items[next].focus()
}

/** 焦點放回最上層對話框（從蓋在上面的畫面回來時用）；沒有對話框就不動 */
export function refocusTopDialog(): void {
  const top = stack[stack.length - 1]
  if (!top || !top.box.isConnected) return
  if (top.box.contains(document.activeElement)) return
  focusables(trapRoot(top))[0]?.focus({ preventScroll: true })
}

function pushLayer(layer: Layer): void {
  if (!stack.length) {
    document.addEventListener('keydown', onKeydown, true)
    listening = true
    // 對話框開著時，畫面的快捷鍵都不作用
    savedKeys = setKeys({})
    ownKeys = currentKeys()
  }
  stack.push(layer)
}

/** 關閉後焦點去哪裡：還在畫面上的原本元素 → 下一層對話框 → 目前的導覽分頁 → 主畫面 */
function restoreFocus(layer: Layer): void {
  const below = stack[stack.length - 1]
  const opener = layer.opener as HTMLElement | null
  if (below) {
    if (opener?.isConnected && below.box.contains(opener) && focusables(below.box).includes(opener)) opener.focus({ preventScroll: true })
    else focusables(trapRoot(below))[0]?.focus({ preventScroll: true })
    return
  }
  if (opener?.isConnected && opener !== document.body && !(opener as HTMLButtonElement).disabled && !opener.closest('[hidden]')) {
    opener.focus({ preventScroll: true })
    return
  }
  const fallback =
    document.querySelector<HTMLElement>('.v2-nav-btn[aria-current="page"]') ??
    document.querySelector<HTMLElement>('.v2-main button:not(:disabled)') ??
    document.querySelector<HTMLElement>('.v2-main')
  fallback?.focus({ preventScroll: true })
}

function popLayer(layer: Layer, reason: CloseReason = 'user'): void {
  const i = stack.indexOf(layer)
  if (i < 0) return
  const wasTop = i === stack.length - 1
  // 先關掉的是底下那層：上面那層如果是從它裡面打開的，改成記住它的開啟元素（關閉時才有地方可以回去）
  for (const above of stack.slice(i + 1)) if (above.opener && layer.box.contains(above.opener)) above.opener = layer.opener
  stack.splice(i, 1)
  if (!stack.length) {
    document.removeEventListener('keydown', onKeydown, true)
    listening = false
    // 只有快捷鍵還是我們設的那組時才還原（中間有別的畫面換過，就交給它自己還原）
    if (savedKeys && currentKeys() === ownKeys) setKeys(savedKeys)
    savedKeys = null
    ownKeys = null
  }
  // 關掉的不是最上層（例如底下的對話框先被程式關掉）：焦點留在原本的最上層；App 關閉時不搬動焦點
  if (wasTop && reason === 'user') restoreFocus(layer)
}

/**
 * 關閉某個 owner 開的所有對話框（App 關閉時用）：從最上層往下，每一層都走正式的關閉流程
 * （移除畫面、離開堆疊、還原快捷鍵、移除鍵盤監聽、呼叫 onClose），onClose 會收到 'dispose'。
 * 其他 owner（另一個 App）的對話框不受影響。回傳關掉幾層
 */
export function closeDialogs(owner: unknown): number {
  const mine = stack.filter((l) => l.owner === owner).reverse()
  for (const l of mine) l.close('dispose')
  return mine.length
}

/** 測試用：堆疊與鍵盤監聽的狀態 */
export function dialogDebug(): { layers: number; listening: boolean } {
  return { layers: stack.length, listening }
}

/** 測試用：目前開著幾層 */
export function openDialogCount(): number {
  return stack.length
}

export interface V2ModalOptions {
  /** 底部關閉按鈕的文字（預設「關閉」） */
  closeLabel?: string
  /** 不放底部關閉按鈕（只用右上 ✕；底部留給主要動作） */
  noCloseButton?: boolean
  /** 固定在底部、跟關閉按鈕放在一起的內容（例如升級成本與按鈕） */
  footer?: HTMLElement
  /** 手機版用底部面板 */
  sheet?: boolean
  /** 全畫面視窗（遊戲指南、聯盟之路）：蓋住整個畫面，右上是「✕ 關閉」 */
  full?: boolean
  /** 標題列的額外內容（取代純文字標題，例如球員頭像與名字）；仍保留標題給輔助科技 */
  header?: HTMLElement
  /** 對話框的額外 class */
  className?: string
  /** Escape 先交給它；回傳 true 代表已經處理（例如取消第二次確認），對話框不關 */
  onEscape?: () => boolean
  /** 誰開的（App 關閉時用 closeDialogs(owner) 一起清掉） */
  owner?: unknown
}

export function v2Modal(title: string, body: HTMLElement, onClose?: (reason: CloseReason) => void, opts: string | V2ModalOptions = {}): () => void {
  const o: V2ModalOptions = typeof opts === 'string' ? { closeLabel: opts } : opts
  const overlay = el('div', `modal-overlay v2-modal-overlay${o.full ? ' full' : ''}`)
  const box = el('section', `v2-modal${o.sheet ? ' sheet' : ''}${o.full ? ' full' : ''}${o.className ? ` ${o.className}` : ''}`)
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
  if (o.full) {
    x.classList.add('labeled')
    x.append(el('span', '', V2T.close))
  }
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
  const layer: Layer = { box, owner: o.owner, opener: document.activeElement, escape: () => (o.onEscape?.() ? undefined : done()), close: (r) => done(r) }
  document.body.append(overlay)
  pushLayer(layer)
  let closed = false
  function done(reason: CloseReason = 'user'): void {
    if (closed) return
    closed = true
    overlay.remove()
    popLayer(layer, reason)
    onClose?.(reason)
  }
  x.onclick = () => done()
  overlay.onclick = (e) => {
    if (e.target === overlay) done()
  }
  // 焦點放在關閉鈕，但不要捲動：從頭開始看
  x.focus({ preventScroll: true })
  content.scrollTop = 0
  return () => done()
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
  /** Esc、點外面、或按了會關閉的按鈕；App 關閉時收到 'dispose' */
  onClose?: (reason: CloseReason) => void
  owner?: unknown
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
  const layer: Layer = { box, owner: o.owner, opener: document.activeElement, escape: () => done(), close: (r) => done(r) }
  document.body.append(overlay)
  pushLayer(layer)
  let closed = false
  function done(reason: CloseReason = 'user'): void {
    if (closed) return
    closed = true
    overlay.remove()
    popLayer(layer, reason)
    o.onClose?.(reason)
  }
  overlay.onclick = (e) => {
    if (e.target === overlay) done()
  }
  primary.focus({ preventScroll: true })
  return () => done()
}
