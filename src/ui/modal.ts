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
