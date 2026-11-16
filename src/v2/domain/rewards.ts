// 暫定的比賽獎勵公式；數值都在 config.ts 的 REWARD_CONFIG
import type { Resources } from './club'
import { REWARD_CONFIG } from './config'

/** 一場比賽的獎勵：勝負的基本獎勵，加上得分換的資金（有上限） */
export function rewardFor(won: boolean, runsFor: number): Resources {
  const base = won ? REWARD_CONFIG.win : REWARD_CONFIG.loss
  const runFunds = Math.min(REWARD_CONFIG.maxRunFunds, Math.max(0, runsFor) * REWARD_CONFIG.fundsPerRun)
  return { funds: base.funds + runFunds, experience: base.experience }
}
