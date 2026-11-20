// schemaVersion 9 的存檔格式（Phase 7B）：凍結在這裡只給遷移用，之後不要再改。
// 跟 10 的差別只有：沒有球員數據（stats），比賽沒有 lines
import type { SettledMatchV10, ClubSaveV10 } from './legacyV10'

export type SettledMatchV9 = Omit<SettledMatchV10, 'lines'>

export interface ClubSaveV9 extends Omit<ClubSaveV10, 'schemaVersion' | 'stats' | 'recentMatches' | 'migratedFrom'> {
  schemaVersion: 9
  recentMatches: SettledMatchV9[]
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8; revision: number }
}
