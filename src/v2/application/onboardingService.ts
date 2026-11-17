// 新手任務旗標的寫入：成功進入直播觀戰、收合／展開任務區塊。
// 都在 ClubLock 裡讀最新存檔、只改 onboarding，用 revision 存檔（別的分頁改過就是 conflict，不會用舊資料覆蓋）。
// 已經是想要的值就不寫入：打開首頁、重繪畫面、重複點觀戰都不會反覆寫 localStorage。
// 不結算比賽、不固定比賽計畫：onboarding 不是比賽計畫的輸入，寫入它不會改變任何一場比賽的結果
import type { ClubSave } from '../domain/club'
import type { OnboardingState } from '../domain/onboarding'
import { SettlementError, type SettlementDeps } from './settlementService'

export interface OnboardingWrite {
  club: ClubSave
  /** 這次有沒有真的寫入 */
  changed: boolean
}

/** 把 onboarding 的某些旗標設成指定的值（只改有差別的那幾個） */
export function setOnboarding(deps: Pick<SettlementDeps, 'store' | 'lock'>, patch: Partial<OnboardingState>): Promise<OnboardingWrite> {
  return deps.lock.run(async () => {
    const club = deps.store.loadClub()
    if (!club) throw new SettlementError('no-club', '還沒有球團存檔')
    const keys = Object.keys(patch) as (keyof OnboardingState)[]
    if (keys.every((k) => club.onboarding[k] === patch[k])) return { club, changed: false }
    const next = { ...club, onboarding: { ...club.onboarding, ...patch } }
    return { club: deps.store.saveClub(next, club.revision), changed: true }
  })
}

/** 成功進入直播觀戰：只會從 false 變 true */
export function markWatchedLive(deps: Pick<SettlementDeps, 'store' | 'lock'>): Promise<OnboardingWrite> {
  return setOnboarding(deps, { watchedLive: true })
}
