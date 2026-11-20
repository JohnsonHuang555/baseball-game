// schemaVersion 11 的存檔格式（Phase 9 PR 2）：凍結在這裡只給遷移用，之後不要再改。
// 跟 12 的差別只有：沒有特性培養（training），球員沒有 dev，支出紀錄沒有訓練（trainStart／trainCancel）
import type { ClubSaveV12, PlayerRecord, SpendRecord } from './club'

export type PlayerRecordV11 = Omit<PlayerRecord, 'dev'>
export type SpendRecordV11 = Omit<SpendRecord, 'kind' | 'trait'> & { kind: 'upgrade' | 'recruit' | 'release' }

export interface ClubSaveV11 extends Omit<ClubSaveV12, 'schemaVersion' | 'training' | 'players' | 'economy' | 'migratedFrom'> {
  schemaVersion: 11
  players: PlayerRecordV11[]
  economy: Omit<ClubSaveV12['economy'], 'recentOps'> & { recentOps: SpendRecordV11[] }
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10; revision: number }
}
