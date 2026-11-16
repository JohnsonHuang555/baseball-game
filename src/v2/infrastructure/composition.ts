// V2 的依賴組裝入口（composition root）：UI 只從這裡拿結算、領取、建立／重設球團要用的依賴，
// 正式環境的預設一次到位：localStorage、Web Locks（不支援時降級並標明 crossTab: false）、系統時間、
// 批次每 BATCH_CONFIG.chunkSize 場用 yieldToMain 讓出主執行緒。測試可以逐項覆寫
import { yieldToMain, type BatchOptions } from '../application/batchRunner'
import type { LifecycleDeps } from '../application/clubLifecycle'
import type { Clock } from '../application/idleEngine'
import type { ClubLock, SettlementDeps } from '../application/settlementService'
import { BATCH_CONFIG } from '../domain/config'
import { ClubRepository, browserStorage, createClubLock, type KeyValueStorage, type LockManagerLike } from './clubRepository'
import { systemClock } from './systemClock'

export type V2Deps = SettlementDeps &
  LifecycleDeps & {
    store: ClubRepository
    lock: ClubLock
    batch: NonNullable<SettlementDeps['batch']>
    /** 存檔所在的儲存：畫面用來放「可寫分頁」標記、讀取原始存檔做備份；不能用來寫存檔 */
    storage: KeyValueStorage | null
  }

export interface V2DepsOverrides {
  /** 不給就用 localStorage（被停用時是 null，存取會丟 storage-unavailable） */
  storage?: KeyValueStorage | null
  /** 不給就看 navigator.locks */
  navigator?: { locks?: LockManagerLike }
  lock?: ClubLock
  clock?: Clock
  batch?: Omit<BatchOptions, 'completed' | 'signal'>
}

export function createV2Deps(overrides: V2DepsOverrides = {}): V2Deps {
  const storage = overrides.storage !== undefined ? overrides.storage : browserStorage()
  const nav = 'navigator' in overrides ? overrides.navigator : (globalThis.navigator as { locks?: LockManagerLike } | undefined)
  return {
    storage: storage ?? null,
    store: new ClubRepository(storage ?? null),
    lock: overrides.lock ?? createClubLock(nav),
    clock: overrides.clock ?? systemClock,
    batch: { chunkSize: BATCH_CONFIG.chunkSize, yieldControl: yieldToMain, ...overrides.batch },
  }
}
