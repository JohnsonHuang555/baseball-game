// @vitest-environment node
// 平衡模擬工具本身的測試：可重現、符合離線上限、沒有 NaN、沒有負資產、統計正確
import { describe, expect, it } from 'vitest'
import { RECRUIT_CONFIG } from '../../src/v2/domain/progressionConfig'
import { recruitCost } from '../../src/v2/domain/recruitment'
import { censoredQuantiles, dist, pairedDiff, simulate } from './simulate'

describe('平衡模擬', () => {
  it('同樣的種子與參數，結果完全一樣（可重現）', async () => {
    const a = await simulate({ strategy: 'E', seed: 7, sessionsPerDay: 2, days: 2 })
    const b = await simulate({ strategy: 'E', seed: 7, sessionsPerDay: 2, days: 2 })
    expect(a).toEqual(b)
  }, 60_000)

  it('不同登入頻率符合離線 8 小時上限：一天 1 次 96 場、2 次 192 場、3 次與 6 次 288 場', async () => {
    for (const [n, per] of [
      [1, 96],
      [2, 192],
      [3, 288],
      [6, 288],
    ] as const) {
      const r = await simulate({ strategy: 'A', seed: 3, sessionsPerDay: n, days: 1 })
      expect(r.snapshots[0].matches).toBe(per)
      expect(r.snapshots[0].sessions).toBe(n)
      expect(r.snapshots[0].settledHours).toBeLessThanOrEqual(r.snapshots[0].realHours)
    }
  }, 120_000)

  it('每種策略：沒有 NaN、Infinity、負資產；收支守恆（收入 = 資產 + 未領取 + 支出）；聯盟不超過最高', async () => {
    for (const strategy of ['A', 'B', 'C', 'D', 'E'] as const) {
      const r = await simulate({ strategy, seed: 11, sessionsPerDay: 3, days: 2 })
      for (const s of r.snapshots) {
        for (const v of [s.power, s.avgLevel, s.assets.funds, s.assets.experience, s.earned.funds, s.earned.experience]) expect(Number.isFinite(v)).toBe(true)
        expect(s.assets.funds).toBeGreaterThanOrEqual(0)
        expect(s.assets.experience).toBeGreaterThanOrEqual(0)
        expect(s.tier).toBeLessThanOrEqual(4)
      }
      const last = r.snapshots.at(-1)!
      for (const k of ['funds', 'experience'] as const) expect(last.assets[k] + last.unclaimed[k] + last.spentUpgrade[k] + last.spentRecruit[k]).toBe(last.earned[k])
      // 收入拆解加起來等於總收入
      const l = r.ledger
      expect(l.baseWinFunds + l.baseLossFunds + l.runFunds + l.multiplierFunds + l.promotion.funds).toBe(last.earned.funds)
      expect(l.baseExp + l.multiplierExp + l.promotion.experience).toBe(last.earned.experience)
    }
  }, 120_000)

  it('新手里程碑：第一次升級的時間、場數都記錄下來', async () => {
    const r = await simulate({ strategy: 'E', seed: 5, sessionsPerDay: 1, days: 1, sessionMinutes: [5, 10, 15, 20, 25, 30, 60] })
    expect(r.milestones.firstMatchMinutes).toBe(5)
    expect(r.milestones.firstUpgradeMinutes).not.toBeNull()
    expect(r.milestones.firstUpgradeMatches).toBe(r.milestones.firstUpgradeMinutes! / 5)
  }, 60_000)
})

describe('積極招募策略 D 的操作成本跟正式遊戲一致', () => {
  it('「釋出 → 招募」都走正式服務：每次簽約的價格是 recruitCost(第幾次)，釋出不花錢也不退款，帳跟遊戲的支出紀錄對得上', async () => {
    const r = await simulate({ strategy: 'D', seed: 1001, sessionsPerDay: 6, days: 7 })
    const last = r.snapshots.at(-1)!
    // 7 天內名單滿了，開始反覆「釋出最差的預備球員 → 再簽一位」
    expect(r.ledger.releaseCount).toBeGreaterThan(0)
    expect(r.recruits).toHaveLength(r.ledger.recruitCount)
    // 第 i 次簽約的價格就是正式公式（招募次數只增不減，釋出不會讓價格變回便宜）
    expect(r.recruits.map((x) => x.cost)).toEqual(r.recruits.map((_, i) => recruitCost(i).funds))
    expect(r.recruits[0].cost).toBe(2000)
    // 招募花費：模擬自己記的 = 每次簽約的價格加總 = 快照裡的累計
    const sum = r.recruits.reduce((a, x) => a + x.cost, 0)
    expect(r.ledger.recruits.funds).toBe(sum)
    expect(last.spentRecruit.funds).toBe(sum)
    // 遊戲本身的帳：收入 = 資產 + 未領取 + 支出（升級＋招募）；釋出成本是 0、沒有退款，所以不會多出或少掉
    expect(last.earned.funds - last.assets.funds - last.unclaimed.funds).toBe(last.spentUpgrade.funds + last.spentRecruit.funds)
    expect(last.players).toBeLessThanOrEqual(RECRUIT_CONFIG.maxPlayers)
  }, 120_000)
})

describe('統計', () => {
  it('分位數、平均、最小、最大', () => {
    const d = dist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, NaN])
    expect(d).toMatchObject({ n: 10, mean: 5.5, p50: 5.5, min: 1, max: 10 })
    expect(d.p10).toBeCloseTo(1.9)
    expect(d.p90).toBeCloseTo(9.1)
  })

  it('沒發生的樣本當作無限大：一半以上沒發生時 P50 是 Infinity', () => {
    expect(censoredQuantiles([1, 2, null, null, null])).toMatchObject({ reached: 2, p50: Infinity })
    expect(censoredQuantiles([1, 2, 3, null])).toMatchObject({ reached: 3, p50: 2, p90: Infinity })
  })

  it('成對差異的信賴區間包含真實差異', () => {
    const a = Array.from({ length: 30 }, (_, i) => 0.5 + ((i * 7) % 11) / 100)
    const b = a.map((x, i) => x - 0.05 + (i % 2 ? 0.01 : -0.01))
    const d = pairedDiff(a, b)
    expect(d.mean).toBeCloseTo(0.05)
    expect(d.hi - d.lo).toBeGreaterThan(0)
    expect(d.lo).toBeLessThanOrEqual(0.05)
    expect(d.hi).toBeGreaterThanOrEqual(0.05)
  })
})
