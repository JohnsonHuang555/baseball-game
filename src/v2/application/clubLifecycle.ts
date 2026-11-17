// 球團的建立與重設：跟結算、領取、換設定用同一把 ClubLock，鎖內才讀寫存檔。
// UI 一律透過這裡建立／重設球團；infrastructure 的 ClubRepository.createClub / resetClub 是沒有上鎖的底層操作。
// 鎖沒有跨分頁保證（crossTab: false）時，回傳值會照實標明，呼叫端不能當作跨分頁安全
import type { ClubSave, PersistentRoster } from '../domain/club'
import type { Clock } from './idleEngine'
import type { ClubLock, ClubStore } from './settlementService'

export interface NewClubRequest {
  clubName: string
  clubSeed?: number
  clubId?: string
  roster?: PersistentRoster
}

/** 能建立、刪除球團的存檔（由 infrastructure 的 ClubRepository 實作） */
export interface ClubAdminStore extends ClubStore {
  /** 已經有存檔（包含壞掉的）就丟錯 */
  createClub(input: NewClubRequest & { now: number }): ClubSave
  resetClub(): void
  /** 把舊格式的存檔升級到目前格式（要在鎖內呼叫）；沒有存檔回傳 null */
  migrateClub(): ClubSave | null
}

export interface LifecycleDeps {
  store: ClubAdminStore
  lock: ClubLock
  clock: Clock
}

export interface LifecycleResult<T> {
  value: T
  /** 這次操作有沒有跨分頁互斥的保證 */
  crossTab: boolean
}

/**
 * 建立新球團：在鎖內確認還沒有存檔才建立，兩個分頁同時建立只會有一個成功，另一個收到 already-exists
 */
export function createClubSafely(deps: LifecycleDeps, request: NewClubRequest): Promise<LifecycleResult<ClubSave>> {
  return deps.lock.run(async () => ({ value: deps.store.createClub({ ...request, now: deps.clock.now() }), crossTab: deps.lock.crossTab }))
}

/**
 * 重設（刪除）球團：等正在進行的結算、領取、換設定結束才刪，刪完之後那些操作不會再把舊球團寫回去
 */
export function resetClubSafely(deps: LifecycleDeps): Promise<LifecycleResult<void>> {
  return deps.lock.run(async () => {
    deps.store.resetClub()
    return { value: undefined, crossTab: deps.lock.crossTab }
  })
}

/**
 * 讀取球團；存檔是舊格式就在鎖內升級。多個分頁同時打開時只會有一個真的寫入：
 * 有 Web Locks 時其他分頁排隊、輪到時讀到的已經是新格式；沒有 Web Locks 時 migrateClub 寫入前會比對原始文字，
 * 被搶先的一方收到 conflict（遷移本身是確定性的，兩邊算出來的結果一模一樣）
 */
export function openClubSafely(deps: LifecycleDeps): Promise<LifecycleResult<{ club: ClubSave | null; migrated: boolean }>> {
  return deps.lock.run(async () => {
    try {
      return { value: { club: deps.store.loadClub(), migrated: false }, crossTab: deps.lock.crossTab }
    } catch (e) {
      if ((e as { code?: string }).code !== 'needs-migration') throw e
      return { value: { club: deps.store.migrateClub(), migrated: true }, crossTab: deps.lock.crossTab }
    }
  })
}
