// @vitest-environment node
// Phase 6C：平衡數值本身的不變量（成本、成長、上限、聯盟、晉級條件）
import { describe, expect, it } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { REWARD_CONFIG } from './config'
import { eligibility, newLeagueState } from './league'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from './leagueConfig'
import { MAX_LEVEL, MAX_RATING, RECRUIT_CONFIG } from './progressionConfig'
import { checkLevel, leveled, totalUpgradeCost, upgradeCost } from './progression'
import { recruitCost } from './recruitment'
import { rewardFor } from './rewards'

describe('升級成本與成長', () => {
  it('每一級的成本為正、單調遞增；資金固定是經驗的 8 倍；滿級沒有下一級', () => {
    let prev = 0
    for (let lv = 1; lv < MAX_LEVEL; lv++) {
      const c = upgradeCost(lv)!
      expect(c.experience).toBeGreaterThan(prev)
      expect(c.funds).toBe(c.experience * 8)
      prev = c.experience
    }
    expect(upgradeCost(MAX_LEVEL)).toBeNull()
    expect(totalUpgradeCost(1, MAX_LEVEL)).toEqual({ funds: 128_880, experience: 16_110 })
  })

  it('等級不會溢出；能力永遠不超過上限 10、不低於原始能力，而且隨等級單調不減', () => {
    expect(() => checkLevel(MAX_LEVEL + 1)).toThrow()
    expect(() => checkLevel(0)).toThrow()
    for (let seed = 1; seed <= 30; seed++) {
      const r = generateRoster(new Rng(seed))
      for (const p of [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers]) {
        let prev = p.ratings as unknown as Record<string, number>
        for (let lv = 1; lv <= MAX_LEVEL; lv++) {
          const now = leveled(p, lv).ratings as unknown as Record<string, number>
          for (const k of Object.keys(now)) {
            expect(now[k]).toBeLessThanOrEqual(MAX_RATING)
            expect(now[k]).toBeGreaterThanOrEqual((p.ratings as unknown as Record<string, number>)[k])
            expect(now[k]).toBeGreaterThanOrEqual(prev[k])
          }
          prev = now
        }
      }
    }
  })

  it('招募成本：2,000 起，每次 +400（2,000、2,400、2,800…）；只花資金', () => {
    expect(RECRUIT_CONFIG).toMatchObject({ baseFunds: 2000, stepFunds: 400, maxPlayers: 30, mean: 5 })
    expect(recruitCost(0)).toEqual({ funds: 2000, experience: 0 })
    expect([recruitCost(1).funds, recruitCost(2).funds]).toEqual([2400, 2800])
    for (let i = 0; i < 40; i++) expect(recruitCost(i)).toEqual({ funds: 2000 + 400 * i, experience: 0 })
  })
})

describe('聯盟與收益', () => {
  it('5 個聯盟：對手每級 +0.4（Phase 6C）、收益倍率遞增；晉級獎勵只在第一級以上', () => {
    expect(LEAGUES.map((l) => l.opponentMean)).toEqual([5.0, 5.4, 5.8, 6.2, 6.6])
    expect(LEAGUES.map((l) => l.rewardMultiplier)).toEqual([1, 1.15, 1.3, 1.45, 1.6])
    expect(MAX_TIER).toBe(4)
    expect(LEAGUES[0].promotionReward).toEqual({ funds: 0, experience: 0 })
  })

  it('比賽收益乘上聯盟倍率（四捨五入）；得分資金有上限', () => {
    for (const l of LEAGUES) {
      const win = rewardFor(true, 3, l.rewardMultiplier)
      expect(win.funds).toBe(Math.round((REWARD_CONFIG.win.funds + 15) * l.rewardMultiplier))
      expect(win.experience).toBe(Math.round(REWARD_CONFIG.win.experience * l.rewardMultiplier))
    }
    expect(rewardFor(true, 99).funds).toBe(REWARD_CONFIG.win.funds + REWARD_CONFIG.maxRunFunds)
  })

  it('晉級條件：場數、最近勝率（場數不足視窗不算）、冷卻都要滿足；最高聯盟不能再挑戰', () => {
    const n = PROMOTION_CONFIG.minMatches
    const ok = { ...newLeagueState(), matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }
    expect(eligibility(ok, n).ok).toBe(true)
    expect(eligibility({ ...ok, matches: n - 1, wins: n - 1 }, n).ok).toBe(false)
    expect(eligibility({ ...ok, recent: 'W'.repeat(PROMOTION_CONFIG.window - 1) }, n).ok).toBe(false)
    const need = Math.ceil(PROMOTION_CONFIG.window * PROMOTION_CONFIG.winRate)
    expect(eligibility({ ...ok, recent: 'W'.repeat(need) + 'L'.repeat(PROMOTION_CONFIG.window - need) }, n).ok).toBe(true)
    expect(eligibility({ ...ok, recent: 'W'.repeat(need - 1) + 'L'.repeat(PROMOTION_CONFIG.window - need + 1) }, n).ok).toBe(false)
    expect(eligibility({ ...ok, challengeReadyAt: n + 1 }, n).ok).toBe(false)
    expect(eligibility({ ...ok, tier: MAX_TIER, highestTier: MAX_TIER, promotions: MAX_TIER }, n).ok).toBe(false)
  })
})
