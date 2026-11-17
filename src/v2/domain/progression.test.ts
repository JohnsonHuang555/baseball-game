// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateBatter, generatePitcher } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { Batter, Pitcher } from '../../sim/types'
import { MAX_LEVEL, batterGrowth, growthShare, leveled, totalUpgradeCost, upgradeCost } from './progression'
import { MAX_RATING, RECRUIT_CONFIG } from './progressionConfig'
import { recruitCost } from './recruitment'
import { REWARD_CONFIG } from './config'

describe('能力成長', () => {
  const batters = Array.from({ length: 200 }, (_, i) => generateBatter(new Rng(i + 1)))
  const pitchers = Array.from({ length: 100 }, (_, i) => generatePitcher(new Rng(i + 500)))

  it('Lv.1 就是原始能力；相同球員和等級，結果一定相同；不改原始資料', () => {
    for (const b of batters.slice(0, 20)) {
      expect(leveled(b, 1)).toBe(b)
      const before = JSON.stringify(b)
      expect(leveled(b, 7)).toEqual(leveled(structuredClone(b), 7))
      expect(JSON.stringify(b)).toBe(before)
      expect(leveled(b, 7).id).toBe(b.id)
      expect(leveled(b, 7).traits).toEqual(b.traits)
    }
  })

  it('能力只升不降，不超過上限 10，也沒有新的能力欄位', () => {
    for (const p of [...batters, ...pitchers]) {
      let prev = p
      for (let lv = 2; lv <= MAX_LEVEL; lv++) {
        const cur = leveled(p, lv)
        expect(Object.keys(cur.ratings).sort()).toEqual(Object.keys(p.ratings).sort())
        for (const [k, v] of Object.entries(cur.ratings)) {
          expect(v).toBeLessThanOrEqual(MAX_RATING)
          expect(v).toBeGreaterThanOrEqual((prev.ratings as unknown as Record<string, number>)[k])
        }
        prev = cur
      }
    }
  })

  it('每升一級的進步逐漸遞減', () => {
    const gains = Array.from({ length: MAX_LEVEL - 1 }, (_, i) => growthShare(i + 2) - growthShare(i + 1))
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThan(gains[i - 1])
    expect(growthShare(1)).toBe(0)
    expect(growthShare(MAX_LEVEL)).toBe(1)
  })

  it('打者的流派那一項成長最多；不同流派成長方向不同', () => {
    for (const b of batters) {
      const g = batterGrowth(b)
      const primary = { power: 'power', speed: 'speed', skill: 'contact', defense: 'fielding' }[b.archetype] as keyof Batter['ratings']
      expect(Math.max(...Object.values(g))).toBe(g[primary])
    }
  })

  it('成長不分稀有度：低能力球員升滿級的進步，不少於高能力球員', () => {
    const weak: Batter = { ...batters[0], ratings: { contact: 3, power: 3, speed: 3, fielding: 3 }, archetype: 'power' }
    const strong: Batter = { ...batters[0], ratings: { contact: 9, power: 9.5, speed: 9, fielding: 9 }, archetype: 'power' }
    const gain = (p: Batter) => Object.values(leveled(p, MAX_LEVEL).ratings).reduce((a, b) => a + b, 0) - Object.values(p.ratings).reduce((a, b) => a + b, 0)
    expect(gain(weak)).toBeGreaterThan(gain(strong))
  })

  it('投手：球威、控球較高的那項成長最多', () => {
    const p: Pitcher = { ...pitchers[0], ratings: { stuff: 4, control: 7, stamina: 5 } }
    const top = leveled(p, MAX_LEVEL)
    expect(top.ratings.control - 7).toBeGreaterThan(top.ratings.stuff - 4)
  })

  it('不合法的等級直接拒絕', () => {
    for (const lv of [0, 21, 1.5, NaN, -1]) expect(() => leveled(batters[0], lv)).toThrow(RangeError)
  })
})

describe('升級成本', () => {
  it('成本遞增、都是正整數，Lv.20 不能再升', () => {
    let prev = { funds: 0, experience: 0 }
    for (let lv = 1; lv < MAX_LEVEL; lv++) {
      const c = upgradeCost(lv)!
      expect(Number.isInteger(c.funds) && Number.isInteger(c.experience)).toBe(true)
      expect(c.funds).toBeGreaterThan(prev.funds)
      expect(c.experience).toBeGreaterThan(prev.experience)
      prev = c
    }
    expect(upgradeCost(MAX_LEVEL)).toBeNull()
  })

  it('跟每場收益相容：第一次升級只要幾場；前 5 級不到一天；單人滿級要好幾天；整隊滿級是長期目標', () => {
    // 每場最少的收益（輸球、沒得分）
    const perGame = { funds: REWARD_CONFIG.loss.funds, experience: REWARD_CONFIG.loss.experience }
    const games = (c: { funds: number; experience: number }) => Math.max(c.funds / perGame.funds, c.experience / perGame.experience)
    expect(games(upgradeCost(1)!)).toBeLessThanOrEqual(12) // 一小時內
    expect(games(totalUpgradeCost(1, 5))).toBeLessThanOrEqual(96 * 2) // 兩天內（以最少收益算）
    expect(games(totalUpgradeCost(1, 20))).toBeGreaterThan(96 * 7) // 單人滿級超過一週（每天 96 場）
    expect(games(totalUpgradeCost(1, 20)) * 14).toBeGreaterThan(96 * 3 * 30) // 整隊滿級超過一個月（每天 288 場）
  })

  it('招募成本遞增、只花資金', () => {
    for (let i = 0; i < RECRUIT_CONFIG.maxPlayers; i++) {
      expect(recruitCost(i).experience).toBe(0)
      expect(recruitCost(i + 1).funds).toBeGreaterThan(recruitCost(i).funds)
    }
    expect(() => recruitCost(-1)).toThrow(RangeError)
  })
})
