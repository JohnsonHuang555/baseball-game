// 網站入口：V2 是唯一的遊戲。開 / 直接進 V2；舊網址 /#v2 也照常進來，並把 #v2 從網址清掉。
// 只建立一次 App：沒有 hashchange／popstate 監聽，也不會因為返回鍵或重複呼叫而建立第二個 V2
import { openV2, type V2App, type V2AppOptions } from './app'

/** 以前從 V1 首頁進 V2 時網址帶的 hash（書籤、分享連結可能還有） */
export const LEGACY_V2_HASH = '#v2'

type Loc = Pick<Location, 'hash' | 'pathname' | 'search'>
type Hist = Pick<History, 'replaceState' | 'state'>

/** 舊網址 /#v2 → /：用 replaceState，不重新載入、不新增瀏覽紀錄、不觸發 hashchange；其他 hash 不動 */
export function cleanLegacyHash(loc: Loc, hist: Hist): boolean {
  if (loc.hash !== LEGACY_V2_HASH) return false
  hist.replaceState(hist.state, '', loc.pathname + loc.search)
  return true
}

/** 每個 root 目前開著的 App；App 關閉時自己移除（只移除自己那一筆，不會清掉之後重新啟動的新 App） */
const started = new WeakMap<HTMLElement, V2App>()

/**
 * 在 root 啟動 V2。同一個 root 已經有開著的 App 就回傳它，不會重複初始化；
 * 那個 App close() 之後再呼叫，會建立一個新的 App
 */
export function startV2(root: HTMLElement, opts: V2AppOptions & { location?: Loc; history?: Hist } = {}): V2App {
  const existing = started.get(root)
  if (existing && !existing.closed) return existing
  const { location: loc = globalThis.location, history: hist = globalThis.history, ...appOpts } = opts
  if (loc && hist) cleanLegacyHash(loc, hist)
  const inner = openV2(root, appOpts)
  const app: V2App = {
    controller: inner.controller,
    show: (tab) => inner.show(tab),
    close() {
      if (started.get(root) === app) started.delete(root)
      inner.close()
    },
    get closed() {
      return inner.closed
    },
  }
  started.set(root, app)
  return app
}
