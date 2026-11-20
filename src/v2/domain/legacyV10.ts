// schemaVersion 10 的存檔格式（Phase 8）：凍結在這裡只給遷移用，之後不要再改。
// 跟 11 的差別只有：戰術風格只有均衡（strategy.coach.style 一定是 'balanced'）、比賽沒有戰術摘要（tactics）
import type { SettledMatch } from './club'
import type { ClubSaveV11 } from './legacyV11'

export type SettledMatchV10 = Omit<SettledMatch, 'tactics'>

export interface ClubSaveV10 extends Omit<ClubSaveV11, 'schemaVersion' | 'recentMatches' | 'migratedFrom'> {
  schemaVersion: 10
  recentMatches: SettledMatchV10[]
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9; revision: number }
}
