// schemaVersion 12 的存檔格式（Phase 9 PR 3）：凍結在這裡只給遷移用，之後不要再改。
// 跟 13 的差別只有：球員沒有 MVP 紀錄（mvp），比賽沒有 MVP（mvp）
import type { ClubSaveV13, PlayerRecord, SettledMatch } from './club'

export type PlayerRecordV12 = Omit<PlayerRecord, 'mvp'>
export type SettledMatchV12 = Omit<SettledMatch, 'mvp'>

export interface ClubSaveV12 extends Omit<ClubSaveV13, 'schemaVersion' | 'players' | 'recentMatches' | 'migratedFrom'> {
  schemaVersion: 12
  players: PlayerRecordV12[]
  recentMatches: SettledMatchV12[]
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11; revision: number }
}
