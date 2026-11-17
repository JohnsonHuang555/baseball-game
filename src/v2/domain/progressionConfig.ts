// V2 養成、招募的可調數值。由 scripts/balance-v2.ts 對照 REWARD_CONFIG 的實測收益反推，推導過程見 ADR-0010。
//
// 實測收益（初始球隊對同強度的對手）：每場約 90 資金、10 經驗，勝率約 53%。
// 一天上線 1 次（離線上限 8 小時）約 96 場 ≈ 8,600 資金、970 經驗；一天 3 次約 288 場 ≈ 26,000 資金、2,900 經驗。

/** 球員最高等級 */
export const MAX_LEVEL = 20

/** 能力值上限（跟 V1 的成長、裝備一樣是 10） */
export const MAX_RATING = 10

/**
 * Lv.1 → Lv.20 的總成長。打者：流派那一項成長最多，其他三項依原始能力高低遞減；
 * 投手：球威、控球較高的那一項成長最多，耐力最少。不分稀有度，高能力的球員反而先碰到上限 10
 */
export const GROWTH = {
  batterPrimary: 2.0,
  batterOthers: [1.2, 0.9, 0.6],
  pitcherPrimary: 2.0,
  pitcherSecondary: 1.4,
  pitcherStamina: 0.8,
  /** 成長曲線的指數：小於 1 代表前面成長快、後面遞減（0.5 是開根號） */
  curve: 0.6,
} as const

/**
 * 升級成本：從 Lv.L 升到 Lv.L+1 要 round(EXP_BASE × L^EXP_POWER) 經驗，資金是經驗的 FUNDS_PER_EXP 倍。
 * 經驗是主要的限制（每場只有約 10 點），資金另外要留給招募
 */
export const UPGRADE_COST = {
  expBase: 40,
  expPower: 1.3,
  fundsPerExp: 8,
} as const

/** 招募：第 n 次（從 0 起算）招募要 base + n × step 資金，不花經驗 */
export const RECRUIT_CONFIG = {
  baseFunds: 4000,
  stepFunds: 800,
  /** 整個球團最多幾名球員（初始 14 人） */
  maxPlayers: 30,
  /** 招募到的球員能力分布中心（跟初始球員、對手一樣） */
  mean: 5,
} as const

/** 支出紀錄保留幾筆（累計數字另外永久保存） */
export const SPEND_LOG_LIMIT = 30
