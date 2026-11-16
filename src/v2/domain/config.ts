// V2 放置系統的可調數值，集中在這裡：時間、獎勵、資料保留、批次大小。
// 改這些數值不會影響已經結算的比賽（結算過的結果直接存起來，不會重算）

/** 放置的時間規則 */
export const IDLE_CONFIG = {
  /** 每幾毫秒打完一場 */
  MATCH_INTERVAL_MS: 5 * 60 * 1000,
  /** 離線時間最多累積多久，超過的部分捨棄 */
  MAX_OFFLINE_MS: 8 * 60 * 60 * 1000,
  /** 一次結算最多幾場 */
  MAX_BATCH_MATCHES: 96,
} as const

/** 暫定的獎勵公式：勝負給基本獎勵，得分另外加資金（有上限） */
export const REWARD_CONFIG = {
  win: { funds: 100, experience: 12 },
  loss: { funds: 40, experience: 8 },
  fundsPerRun: 5,
  maxRunFunds: 50,
} as const

/** 存檔裡保留多少資料：戰績、資產、游標永久保存；近期比賽、精彩事件、完整 replay 只留最近的 */
export const RETENTION_CONFIG = {
  /** 近期比賽的摘要 */
  recentMatches: 50,
  /** 每場摘要保留幾個精彩事件 */
  highlightsPerMatch: 3,
  /** 完整的比賽 replay（含雙方陣容，一份約 10 KB） */
  replays: 3,
  /** 記住最近幾次領取的編號，讓重送的領取不會重複入帳 */
  claimIds: 20,
} as const

/** 批次模擬：每打幾場就讓出一次主執行緒 */
export const BATCH_CONFIG = {
  chunkSize: 8,
} as const
