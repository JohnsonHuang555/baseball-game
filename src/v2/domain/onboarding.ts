// 新手任務（Phase 6A）：讓第一次玩的人透過實際操作理解遊戲。都是純函式，不碰儲存與時間。
//
// 能從既有紀錄推導的任務一律推導，不另外存：
// - 完成第一場比賽：總戰績（勝 + 敗）≥ 1
// - 培養球員：花過經驗（只有升級花經驗；招募只花資金、釋出不花錢）
// 推導不出來的才存在 club.onboarding（schemaVersion 8 起）：
// - watchedLive：成功進入過直播觀戰
// - claimedRewards：成功領取過一次「不是 0」的收益（在領取的同一次存檔裡記下）。不用 assets > 0 推導：
//   之後可能有直接進資產的初始資源，花掉之後 assets 也會變回 0；領取序號也不行，因為服務層允許領取 0
// - lineupChanged：成功儲存過一次「真的有變」的陣容（在 updateSettings 的同一次存檔裡記下，不另外寫入）
// - collapsed：玩家把任務區塊收起來了
// 旗標只會從 false 變 true（collapsed 例外，玩家可以再展開），所以不同分頁的寫入不會讓任務「變回未完成」。
import type { ClubSave } from './club'

export interface OnboardingState {
  watchedLive: boolean
  claimedRewards: boolean
  lineupChanged: boolean
  collapsed: boolean
}

export function newOnboarding(): OnboardingState {
  return { watchedLive: false, claimedRewards: false, lineupChanged: false, collapsed: false }
}

export const ONBOARDING_TASK_IDS = ['club', 'watch', 'firstMatch', 'claim', 'upgrade', 'lineup'] as const
export type OnboardingTaskId = (typeof ONBOARDING_TASK_IDS)[number]

export interface OnboardingTask {
  id: OnboardingTaskId
  done: boolean
}

export interface OnboardingProgress {
  tasks: OnboardingTask[]
  done: number
  total: number
  allDone: boolean
  collapsed: boolean
}

type OnboardingInput = Pick<ClubSave, 'onboarding' | 'record' | 'economy'>

/**
 * 舊存檔（遷移時）有沒有領過不是 0 的收益：assets + spent = 歷來領取的總額 = earned − unclaimed。
 * 到 schemaVersion 7 為止沒有任何直接進資產的收入，所以這個推導在遷移當下是準的；之後一律看 claimedRewards
 */
export function claimedBefore(club: Pick<ClubSave, 'economy'>): boolean {
  const { economy: e } = club
  const claimedTotal = e.earned.funds - e.unclaimed.funds + (e.earned.experience - e.unclaimed.experience)
  return e.nextClaimSeq > 0 && claimedTotal > 0
}

/** 有沒有升級過球員 */
export function hasUpgraded(club: Pick<ClubSave, 'economy'>): boolean {
  return club.economy.spent.experience > 0 || club.economy.recentOps.some((op) => op.kind === 'upgrade')
}

/** 每個任務完成了沒有（不要求順序） */
export function onboardingProgress(club: OnboardingInput): OnboardingProgress {
  const o = club.onboarding
  const done: Record<OnboardingTaskId, boolean> = {
    club: true,
    watch: o.watchedLive,
    firstMatch: club.record.wins + club.record.losses >= 1,
    claim: o.claimedRewards,
    upgrade: hasUpgraded(club),
    lineup: o.lineupChanged,
  }
  const tasks = ONBOARDING_TASK_IDS.map((id) => ({ id, done: done[id] }))
  const count = tasks.filter((t) => t.done).length
  return { tasks, done: count, total: tasks.length, allDone: count === tasks.length, collapsed: o.collapsed }
}
