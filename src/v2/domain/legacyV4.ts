// schemaVersion 4 的存檔格式（Phase 4）：凍結在這裡只給遷移用，之後不要再改。
// 跟 5 的差別只有：沒有 league、支出紀錄沒有 'release'、每場比賽的摘要沒有 leagueTier
import type { SpendRecord } from './club'
import type { ClubSaveV5 } from './legacyV5'

export interface ClubSaveV4 extends Omit<ClubSaveV5, 'schemaVersion' | 'league' | 'migratedFrom' | 'economy'> {
  schemaVersion: 4
  economy: Omit<ClubSaveV5['economy'], 'recentOps'> & { recentOps: (SpendRecord & { kind: 'upgrade' | 'recruit' })[] }
  migratedFrom?: { schemaVersion: 3; revision: number }
}
