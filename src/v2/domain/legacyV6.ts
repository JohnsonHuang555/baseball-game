// schemaVersion 6 的存檔格式（PR #9 的草稿，觀看歷史 Replay 的版本）：凍結在這裡只給遷移用。
// 跟 7 的差別：沒有 liveMatch，比賽沒有 box、playedAt
import type { ClubSaveV7 } from './club'

export interface ClubSaveV6 extends Omit<ClubSaveV7, 'schemaVersion' | 'liveMatch' | 'migratedFrom'> {
  schemaVersion: 6
  migratedFrom?: { schemaVersion: 3 | 4 | 5; revision: number }
}
