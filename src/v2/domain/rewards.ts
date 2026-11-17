// 暫定的比賽獎勵公式；數值都在 config.ts 的 REWARD_CONFIG
import type { Resources } from './club'
import { REWARD_CONFIG } from './config'

/**
 * 一場比賽的獎勵：勝負的基本獎勵，加上得分換的資金（有上限），再乘上聯盟的收益倍率（四捨五入成整數）。
 * 倍率由比賽計畫裡記的聯盟決定，不看結算當下的聯盟；新秀聯盟是 1，結果跟 Phase 4 完全相同
 */
export function rewardFor(won: boolean, runsFor: number, multiplier = 1): Resources {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new RangeError(`收益倍率不合法：${multiplier}`)
  const base = won ? REWARD_CONFIG.win : REWARD_CONFIG.loss
  const runFunds = Math.min(REWARD_CONFIG.maxRunFunds, Math.max(0, runsFor) * REWARD_CONFIG.fundsPerRun)
  return { funds: Math.round((base.funds + runFunds) * multiplier), experience: Math.round(base.experience * multiplier) }
}
