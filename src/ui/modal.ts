// 確認視窗：取代瀏覽器內建的 confirm，樣式跟遊戲一致
import { kbd, setKeys } from './keys'
import { el } from './playerCard'
import { T } from './strings'

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 確定會清掉東西（例如存檔）：確定鈕用警示色 */
  danger?: boolean
}

/** 跳出確認視窗；按確定 resolve true，取消、Esc、點外面 resolve false */
export function confirmModal(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay')
    const box = el('section', 'modal-box')
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-labelledby', 'modal-title')
    box.setAttribute('aria-describedby', 'modal-message')
    const title = el('h2', 'modal-title', opts.title)
    title.id = 'modal-title'
    const message = el('p', 'modal-message', opts.message)
    message.id = 'modal-message'
    const buttons = el('div', 'modal-buttons')
    const cancel = el('button', 'btn-white', opts.cancelLabel ?? T.cancel)
    cancel.type = 'button'
    cancel.append(kbd('ESC'))
    const ok = el('button', opts.danger ? 'btn-danger' : 'btn-yellow', opts.confirmLabel ?? T.confirm)
    ok.type = 'button'
    ok.append(kbd('ENTER'))
    buttons.append(cancel, ok)
    box.append(title, message, buttons)
    overlay.append(box)
    document.body.append(overlay)

    const previousKeys = setKeys({})
    const close = (answer: boolean) => {
      overlay.remove()
      setKeys(previousKeys)
      resolve(answer)
    }
    cancel.onclick = () => close(false)
    ok.onclick = () => close(true)
    overlay.onclick = (e) => {
      if (e.target === overlay) close(false)
    }
    setKeys({ Enter: () => close(true), Escape: () => close(false) })
    // 會清掉東西的確認，預設焦點放在取消，避免手滑
    ;(opts.danger ? cancel : ok).focus()
  })
}

export interface ChoiceOption<V> {
  value: V
  label: string
  /** 第二行說明 */
  sub?: string
  /** 左邊的小圖（HTML 字串，例如頭像 SVG） */
  icon?: string
  /** 鎖住的原因；有給就不能選 */
  locked?: string
  /** 目前選中的那一個 */
  current?: boolean
}

/** 跳出選項視窗：點一個選項 resolve 它的值，取消、Esc、點外面 resolve null。數字鍵 1～9 對應各選項 */
export function choiceModal<V>(opts: { title: string; message?: string; options: ChoiceOption<V>[] }): Promise<V | null> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay')
    const box = el('section', 'modal-box choice-box')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-labelledby', 'modal-title')
    const title = el('h2', 'modal-title', opts.title)
    title.id = 'modal-title'
    box.append(title)
    if (opts.message) box.append(el('p', 'modal-message', opts.message))
    const list = el('div', 'choice-list')
    const keys: Record<string, () => void> = { Escape: () => close(null) }
    opts.options.forEach((o, i) => {
      const btn = el('button', `choice-option${o.current ? ' current' : ''}${o.locked ? ' locked' : ''}`)
      btn.type = 'button'
      btn.disabled = !!o.locked
      if (o.current) btn.setAttribute('aria-current', 'true')
      if (o.icon) {
        const icon = el('span', 'choice-icon')
        icon.innerHTML = o.icon
        btn.append(icon)
      }
      const words = el('span', 'choice-words')
      words.append(el('span', 'choice-label', o.label))
      const sub = o.locked ?? o.sub
      if (sub) words.append(el('span', 'choice-sub', sub))
      btn.append(words)
      if (!o.locked && i < 9) {
        btn.append(kbd(String(i + 1)))
        keys[String(i + 1)] = () => close(o.value)
      }
      btn.onclick = () => close(o.value)
      list.append(btn)
    })
    const cancel = el('button', 'btn-white choice-cancel', T.cancel)
    cancel.type = 'button'
    cancel.append(kbd('ESC'))
    cancel.onclick = () => close(null)
    box.append(list, cancel)
    overlay.append(box)
    document.body.append(overlay)

    const previousKeys = setKeys(keys)
    function close(value: V | null): void {
      overlay.remove()
      setKeys(previousKeys)
      resolve(value)
    }
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null)
    }
    ;(list.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus()
  })
}
