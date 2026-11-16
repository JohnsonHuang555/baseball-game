// 單一可寫分頁：瀏覽器不支援 Web Locks（ClubLock.crossTab === false）時，V2 不能讓多個分頁自由寫入。
// 做法是「最後開啟（或按下『在此分頁繼續』）的分頁可寫」：可寫的分頁把自己的編號寫進一個獨立的 key，
// 其他分頁從 storage 事件知道之後變成唯讀。哪個分頁可寫一律以 key 目前的值為準，不靠事件的先後，
// 所以兩個分頁幾乎同時接手時，最後寫入的那個可寫、另一個唯讀。
// 這不是交易鎖：接手的那一刻，前一個分頁如果正在存檔，仍可能撞上；那種情況會被 revision 檢查擋下（conflict），不會靜默覆蓋。
// 有 Web Locks（crossTab === true）時不需要這個限制，所有分頁都可寫。
import type { KeyValueStorage } from '../infrastructure/clubRepository'

export const WRITER_KEY = 'dice-baseball.club.v3.writer'

/** window 的最小子集：只需要 storage 事件 */
export interface StorageEventSource {
  addEventListener(type: 'storage', listener: (e: { key: string | null; newValue: string | null }) => void): void
  removeEventListener(type: 'storage', listener: (e: { key: string | null; newValue: string | null }) => void): void
}

export interface WriterGuard {
  /** shared：每個分頁都可寫（有跨分頁鎖）；exclusive：同時只有一個分頁可寫 */
  readonly mode: 'shared' | 'exclusive'
  canWrite(): boolean
  /** 讓這個分頁變成可寫的分頁（其他分頁會變唯讀） */
  takeOver(): void
  /** 可寫狀態可能改變時通知 */
  subscribe(listener: () => void): () => void
  dispose(): void
}

export interface WriterGuardOptions {
  crossTab: boolean
  storage: KeyValueStorage | null
  events?: StorageEventSource
  tabId: string
}

export function createWriterGuard(opts: WriterGuardOptions): WriterGuard {
  if (opts.crossTab) {
    return { mode: 'shared', canWrite: () => true, takeOver: () => undefined, subscribe: () => () => undefined, dispose: () => undefined }
  }
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  const current = (): string | null => {
    try {
      return opts.storage?.getItem(WRITER_KEY) ?? null
    } catch {
      return null
    }
  }
  const takeOver = () => {
    try {
      opts.storage?.setItem(WRITER_KEY, opts.tabId)
    } catch {
      // 寫不進去：之後存檔一樣會失敗，畫面會顯示存檔錯誤
    }
    notify()
  }
  const onStorage = (e: { key: string | null }) => {
    if (e.key === WRITER_KEY || e.key === null) notify()
  }
  opts.events?.addEventListener('storage', onStorage)
  // 開啟就接手：最後開的分頁可寫
  takeOver()
  return {
    mode: 'exclusive',
    // 儲存不能用時沒有可以搶的東西，交給存檔本身報錯
    canWrite: () => !opts.storage || current() === opts.tabId,
    takeOver,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      opts.events?.removeEventListener('storage', onStorage)
      listeners.clear()
    },
  }
}

export function randomTabId(): string {
  const c = globalThis.crypto
  return c?.randomUUID ? c.randomUUID() : `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}
