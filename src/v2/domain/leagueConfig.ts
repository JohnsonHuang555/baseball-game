// V2 聯盟的可調數值：名稱、對手強度、一般比賽收益倍率、晉級條件、晉級獎勵。
// 初版數值由 scripts/balance-v2.ts 的 30 天模擬調整過，推導見 ADR-0011
import type { Resources } from './club'

export interface LeagueDef {
  /** 階級 0～4 */
  tier: number
  name: string
  /** 徽章的顏色 */
  color: string
  /** 一般比賽對手的能力分布中心（產生器的 mean，跟初始球員的 5 同一個尺度） */
  opponentMean: number
  /** 一般比賽的資金、經驗倍率 */
  rewardMultiplier: number
  /** 第一次晉級到這個聯盟的獎勵（新秀聯盟沒有） */
  promotionReward: Resources
}

export const LEAGUES: readonly LeagueDef[] = [
  { tier: 0, name: '新秀聯盟', color: '#3FA34D', opponentMean: 5.0, rewardMultiplier: 1.0, promotionReward: { funds: 0, experience: 0 } },
  { tier: 1, name: '業餘聯盟', color: '#2D7CFF', opponentMean: 5.5, rewardMultiplier: 1.15, promotionReward: { funds: 6_000, experience: 600 } },
  { tier: 2, name: '挑戰者聯盟', color: '#8E44E8', opponentMean: 6.0, rewardMultiplier: 1.3, promotionReward: { funds: 12_000, experience: 1_200 } },
  { tier: 3, name: '職業聯盟', color: '#E8573F', opponentMean: 6.5, rewardMultiplier: 1.45, promotionReward: { funds: 20_000, experience: 2_000 } },
  { tier: 4, name: '傳奇聯盟', color: '#D4A017', opponentMean: 7.0, rewardMultiplier: 1.6, promotionReward: { funds: 32_000, experience: 3_200 } },
]

export const MAX_TIER = LEAGUES.length - 1

/** 晉級條件與挑戰賽 */
export const PROMOTION_CONFIG = {
  /** 本聯盟至少要打幾場 */
  minMatches: 100,
  /** 看最近幾場的勝率 */
  window: 60,
  /** 最近 window 場的勝率門檻 */
  winRate: 0.6,
  /** 挑戰失敗後，要再打幾場一般比賽才能再挑戰 */
  retryAfterMatches: 12,
  /** 挑戰賽的對手比下一級聯盟的一般對手再強多少 */
  challengeBonus: 0.25,
  /** 保留最近幾次挑戰的紀錄 */
  historyLimit: 10,
} as const
