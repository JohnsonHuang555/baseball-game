// schemaVersion 13 的存檔格式（Phase 9 PR 4）：凍結在這裡只給遷移用，之後不要再改。
// 跟 14 的差別只有：沒有傳奇總冠軍賽（championship）
import type { ClubSaveV14 } from './club'

export interface ClubSaveV13 extends Omit<ClubSaveV14, 'schemaVersion' | 'championship' | 'migratedFrom'> {
  schemaVersion: 13
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12; revision: number }
}
