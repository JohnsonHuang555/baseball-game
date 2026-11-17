// schemaVersion 7 的存檔格式（Phase 5B）：凍結在這裡只給遷移用，之後不要再改。
// 跟 8 的差別只有：沒有 onboarding（新手任務的旗標）
import type { ClubSaveV8 } from './club'

export interface ClubSaveV7 extends Omit<ClubSaveV8, 'schemaVersion' | 'onboarding' | 'migratedFrom'> {
  schemaVersion: 7
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6; revision: number }
}
