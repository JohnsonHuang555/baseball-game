// V2 測試共用的替身：可控制的時鐘、共用的假 Web Locks、會寫入失敗的儲存。只給測試和效能量測用
import type { Clock } from './application/idleEngine'
import { MemoryStorage, type KeyValueStorage, type LockManagerLike } from './infrastructure/clubRepository'
import { createV2Deps, type V2Deps } from './infrastructure/composition'

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
/** 測試用的起始時間：2026-01-01 00:00 UTC */
export const T0 = Date.UTC(2026, 0, 1)

export class ManualClock implements Clock {
  constructor(public t = T0) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
  set(t: number): void {
    this.t = t
  }
}

/** 模擬瀏覽器的 navigator.locks：同一個實例代表同一個來源，所有「分頁」共用 */
export class FakeLockManager implements LockManagerLike {
  private readonly tails = new Map<string, Promise<unknown>>()
  request<T>(name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(name) ?? Promise.resolve()
    const result = tail.then(callback, callback)
    this.tails.set(
      name,
      result.catch(() => undefined),
    )
    return result
  }
}

/** 包住另一個儲存，可以讓寫入失敗（例如容量不足） */
export class FlakyStorage implements KeyValueStorage {
  failWrites = false
  constructor(readonly inner: KeyValueStorage = new MemoryStorage()) {}
  getItem(key: string): string | null {
    return this.inner.getItem(key)
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    this.inner.setItem(key, value)
  }
  removeItem(key: string): void {
    this.inner.removeItem(key)
  }
}

/** 讓出控制權但不用計時器：只等一個微任務，測試裡兩個「分頁」會交錯執行 */
export const microYield = () => Promise.resolve()

/**
 * 一個「分頁」：用正式的組裝入口建立依賴，只換掉儲存、時鐘、navigator.locks 與讓出方式。
 * 儲存與鎖可以跟其他分頁共用；不給 locks 就是不支援 Web Locks 的瀏覽器
 */
export function tab(storage: KeyValueStorage, clock: Clock, locks?: LockManagerLike): V2Deps {
  return createV2Deps({ storage, clock, navigator: locks ? { locks } : {}, batch: { yieldControl: microYield, chunkSize: 4 } })
}
