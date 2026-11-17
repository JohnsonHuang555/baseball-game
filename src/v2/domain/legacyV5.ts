// schemaVersion 5 的存檔格式（Phase 5A）：凍結在這裡只給遷移用，之後不要再改。
// 跟 6 的差別只有：沒有 challengeReplay
import type { ClubSaveV6 } from './club'

export interface ClubSaveV5 extends Omit<ClubSaveV6, 'schemaVersion' | 'challengeReplay' | 'migratedFrom'> {
  schemaVersion: 5
  migratedFrom?: { schemaVersion: 3 | 4; revision: number }
}
