// @vitest-environment node
// Phase 7B 競技積分與降級的純函式（domain/league.ts）
import { describe, expect, it } from 'vitest'
import {
  applyRankedResult,
  canRelegate,
  eligibility,
  leagueAtTier,
  leagueViolations,
  matchesBeforePossibleRelegation,
  newLeagueState,
  promotedRanked,
  rankedEnabled,
  rankedView,
  recordLeagueResult,
  relegate,
  type LeagueState,
} from './league'
import { MAX_TIER, PROMOTION_CONFIG, RANKED_CONFIG } from './leagueConfig'

const R = RANKED_CONFIG
const at = (tier: number, extra: Partial<LeagueState> = {}) => leagueAtTier(newLeagueState(), tier, extra)
/** 依序記好幾場（W／L 字串），回傳最後的狀態與每場紀錄 */
function play(s: LeagueState, results: string, from = 0) {
  const records = []
  for (const [i, c] of [...results].entries()) {
    const out = applyRankedResult(recordLeagueResult(s, c === 'W'), c === 'W', from + i, 1000 + i)
    s = out.state
    records.push(out.record)
  }
  return { state: s, records }
}

describe('競技積分：哪些聯盟計分', () => {
  it('新秀、業餘不計分（沒有積分、沒有紀錄）；挑戰者以上計分', () => {
    for (const t of [0, 1]) {
      const s = at(t)
      expect(s.points).toBeNull()
      expect(rankedEnabled(t)).toBe(false)
      expect(applyRankedResult(s, true, 0, 0)).toEqual({ state: s, record: null })
    }
    for (const t of [2, 3, 4]) {
      expect(at(t).points).toBe(R.initialPoints)
      expect(applyRankedResult(at(t), true, 0, 0).record).not.toBeNull()
    }
  })

  it(`勝 +${R.winPoints}、敗 ${R.lossPoints}；上限 ${R.maxPoints}、下限 ${R.minPoints}`, () => {
    const s = at(2)
    expect(play(s, 'W').state.points).toBe(R.initialPoints + R.winPoints)
    expect(play(s, 'L').state.points).toBe(R.initialPoints + R.lossPoints)
    const { state, records } = play(s, 'W'.repeat(30))
    expect(state.points).toBe(R.maxPoints)
    expect(records.at(-1)).toMatchObject({ before: 100, after: 100, delta: 0 })
    expect(play(s, 'L'.repeat(40)).state.points).toBe(R.minPoints)
  })

  it('紀錄：前後積分、實際變化、剩下的保護、有沒有降級', () => {
    const { records } = play(at(3), 'WL')
    expect(records[0]).toEqual({ tier: 3, before: 50, after: 53, delta: 3, protected: false, protectionRemaining: 0, relegatedTo: null })
    expect(records[1]).toEqual({ tier: 3, before: 53, after: 51, delta: -2, protected: false, protectionRemaining: 0, relegatedTo: null })
  })
})

describe('降級', () => {
  it('挑戰者 0 分不降級（保底），積分停在 0、可以再往上', () => {
    const { state } = play(at(2), 'L'.repeat(40))
    expect(state).toMatchObject({ tier: 2, points: 0, relegations: 0, lastRelegation: null })
    expect(canRelegate(2)).toBe(false)
    expect(play(state, 'W').state.points).toBe(3)
    expect(leagueViolations(state)).toEqual([])
  })

  it('職業 0 分降到挑戰者；傳奇 0 分降到職業；一次只降一級', () => {
    for (const [from, to] of [
      [3, 2],
      [4, 3],
    ]) {
      const s = at(from, { points: 4, rewardedTiers: [1, 2, 3, 4].slice(0, from), matches: 150, wins: 70, losses: 80, recent: 'L'.repeat(60), challengeReadyAt: 999 })
      const { state, records } = play(s, 'LL', 500)
      expect(records[1]).toMatchObject({ before: 2, after: 0, relegatedTo: to })
      expect(state).toMatchObject({ tier: to, highestTier: from, promotions: from, relegations: 1, points: R.initialPoints, protectionRemaining: 0 })
      expect(state.lastRelegation).toEqual({ fromTier: from, toTier: to, matchIndex: 501, at: 1001 })
      // 新聯盟的戰績與晉級資格重新累積；冷卻清掉
      expect(state).toMatchObject({ matches: 0, wins: 0, losses: 0, recent: '', challengeReadyAt: 0 })
      expect(eligibility(state, 0).ok).toBe(false)
      // 已發的獎勵、挑戰紀錄、最高階級都留著
      expect(state.rewardedTiers).toEqual(s.rewardedTiers)
      expect(leagueViolations(state)).toEqual([])
    }
  })

  it('職業降到挑戰者後再一路輸：停在挑戰者 0 分，不會再降回業餘', () => {
    const { state } = play(at(3, { points: 2 }), 'L'.repeat(100))
    expect(state).toMatchObject({ tier: 2, points: 0, relegations: 1 })
  })

  it('傳奇連續輸到降兩次：每次只降一級，降級後重設 50 分', () => {
    const { state, records } = play(at(4, { points: 2 }), 'L'.repeat(26))
    expect(records.filter((r) => r?.relegatedTo !== null).map((r) => r!.relegatedTo)).toEqual([3, 2])
    expect(state).toMatchObject({ tier: 2, relegations: 2, points: R.initialPoints })
    expect(state.lastRelegation).toMatchObject({ fromTier: 3, toTier: 2 })
  })

  it('relegate 只接受職業、傳奇', () => {
    for (const t of [0, 1, 2]) expect(() => relegate(at(t), 0, 0)).toThrow(RangeError)
  })
})

describe('晉級後保護', () => {
  it(`前 ${R.promotionProtectionMatches} 場：輸球照扣分但最低停在 1，每場扣一次保護；之後恢復降級`, () => {
    const s = at(3, { ...promotedRanked(3), points: 4 })
    expect(s.protectionRemaining).toBe(R.promotionProtectionMatches)
    const { state, records } = play(s, 'L'.repeat(R.promotionProtectionMatches))
    expect(state).toMatchObject({ tier: 3, points: 1, protectionRemaining: 0 })
    expect(records.filter((r) => r!.protected).length).toBeGreaterThan(0)
    expect(records.map((r) => r!.protectionRemaining)).toEqual(Array.from({ length: R.promotionProtectionMatches }, (_, i) => R.promotionProtectionMatches - 1 - i))
    // 保護期間贏球照常加分
    expect(play(s, 'W').state).toMatchObject({ points: 7, protectionRemaining: R.promotionProtectionMatches - 1 })
    // 保護結束後下一場輸就降級
    expect(play(state, 'L').state.tier).toBe(2)
  })

  it('晉級：積分重設為起始值、開啟保護；挑戰者以下沒有積分也沒有保護', () => {
    expect(promotedRanked(1)).toEqual({ points: null, protectionRemaining: 0 })
    for (const t of [2, 3, 4]) expect(promotedRanked(t)).toEqual({ points: R.initialPoints, protectionRemaining: R.promotionProtectionMatches })
  })
})

describe('分段結算用的「一定不會降級」場數', () => {
  it('不會降級的聯盟是無限；保護期是剩下的保護場數；之後是最快歸零的連敗場數', () => {
    for (const t of [0, 1, 2]) expect(matchesBeforePossibleRelegation(at(t))).toBe(Number.POSITIVE_INFINITY)
    expect(matchesBeforePossibleRelegation(at(3, { protectionRemaining: 7 }))).toBe(7)
    expect(matchesBeforePossibleRelegation(at(3, { points: 50 }))).toBe(25)
    expect(matchesBeforePossibleRelegation(at(4, { points: 7 }))).toBe(4)
    expect(matchesBeforePossibleRelegation(at(4, { points: 1 }))).toBe(1)
  })

  it('保證：從任何積分開始，前 n − 1 場一定不會降級', () => {
    for (let p = 1; p <= 100; p++) {
      const s = at(4, { points: p })
      const n = matchesBeforePossibleRelegation(s)
      if (n > 1) expect(play(s, 'L'.repeat(n - 1)).state.tier).toBe(4)
      expect(play(s, 'L'.repeat(n)).state.tier).toBe(3)
    }
  })
})

describe('不變量', () => {
  it('目前階級 = 晉級次數 − 降級次數，不高於最高階級；重返也算一次晉級', () => {
    const relegated = play(at(4, { points: 2 }), 'L').state
    expect(leagueViolations(relegated)).toEqual([])
    // 重返傳奇：晉級次數 5、降級 1、目前 4
    const back = { ...relegated, tier: 4, promotions: 5, ...promotedRanked(4) }
    expect(leagueViolations(back)).toEqual([])
    expect(leagueViolations({ ...relegated, promotions: 3 })).toContain('晉級次數、降級次數與目前階級對不起來')
    expect(leagueViolations({ ...relegated, highestTier: 5 })).toContain('最高階級不合法')
  })

  it('積分：挑戰者以上是 0～100 的整數，以下是 null；職業、傳奇不會停在 0；保護、降級次數不為負', () => {
    expect(leagueViolations(at(2, { points: 101 }))).toContain('競技積分不合法')
    expect(leagueViolations(at(2, { points: 1.5 }))).toContain('競技積分不合法')
    expect(leagueViolations(at(2, { points: null }))).toContain('競技積分不合法')
    expect(leagueViolations(at(1, { points: 50 }))).toContain('這個聯盟不應該有競技積分')
    expect(leagueViolations(at(3, { points: 0 }))).toContain('會降級的聯盟積分不會停在 0')
    expect(leagueViolations(at(3, { protectionRemaining: -1 }))).toContain('保護場次不合法')
    expect(leagueViolations(at(1, { protectionRemaining: 3 }))).toContain('這個聯盟不應該有保護場次')
    expect(leagueViolations(at(3, { relegations: -1 }))).toContain('降級次數不合法')
  })

  it('降級紀錄：只會從職業、傳奇降一級；有紀錄就一定有降級次數', () => {
    const ok = play(at(3, { points: 2 }), 'L').state
    expect(leagueViolations({ ...ok, lastRelegation: { ...ok.lastRelegation!, fromTier: 2, toTier: 1 } })).toContain('降級紀錄不合法')
    expect(leagueViolations({ ...ok, lastRelegation: { ...ok.lastRelegation!, toTier: 1 } })).toContain('降級紀錄不合法')
    expect(leagueViolations({ ...at(2), relegations: 1, promotions: 3 })).toContain('有降級次數卻沒有降級紀錄')
  })

  it('已發獎勵不會因為降級消失；仍然不能超過最高階級', () => {
    const s = play(at(MAX_TIER, { points: 2 }), 'L').state
    expect(s.rewardedTiers).toEqual([1, 2, 3, 4])
    expect(leagueViolations(s)).toEqual([])
  })
})

describe('畫面用的競技狀態', () => {
  it('沒有積分、保底、安全、危險', () => {
    expect(rankedView(at(1))).toMatchObject({ enabled: false, zone: 'off', points: null })
    expect(rankedView(at(2, { points: 5 }))).toMatchObject({ enabled: true, zone: 'floor', canRelegate: false, relegateTo: null })
    expect(rankedView(at(3, { points: 58 }))).toMatchObject({ zone: 'safe', canRelegate: true, relegateTo: 2, aboveDanger: 38, toZero: 58 })
    expect(rankedView(at(4, { points: R.dangerThreshold }))).toMatchObject({ zone: 'danger', relegateTo: 3, aboveDanger: 0 })
    expect(rankedView(at(4, { points: 100 }))).toMatchObject({ atMax: true })
  })

  it('積分不影響晉級資格：35 分也能挑戰，100 分不代表有資格', () => {
    const n = PROMOTION_CONFIG.minMatches
    const good = { matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }
    expect(eligibility(at(3, { ...good, points: 35 }), 0).ok).toBe(true)
    expect(eligibility(at(3, { points: 100 }), 0).ok).toBe(false)
  })
})
