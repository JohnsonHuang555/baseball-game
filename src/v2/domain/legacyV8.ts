// schemaVersion 8 的存檔格式（Phase 6～7A）：凍結在這裡只給遷移用，之後不要再改。
// 跟 9 的差別只有：聯盟沒有競技積分（points、protectionRemaining、relegations、lastRelegation），比賽沒有 ranked
import type { ClubSaveV9, SettledMatch } from './club'
import type { LeagueState } from './league'

export type LeagueStateV8 = Omit<LeagueState, 'points' | 'protectionRemaining' | 'relegations' | 'lastRelegation'>
export type SettledMatchV8 = Omit<SettledMatch, 'ranked'>

export interface ClubSaveV8 extends Omit<ClubSaveV9, 'schemaVersion' | 'league' | 'recentMatches' | 'migratedFrom'> {
  schemaVersion: 8
  league: LeagueStateV8
  recentMatches: SettledMatchV8[]
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7; revision: number }
}
