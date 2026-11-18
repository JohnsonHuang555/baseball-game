// Phase 7 模擬專用積分規則的單元測試：只驗證模擬的影子狀態，不是正式規則
import { describe, expect, it } from 'vitest'
import { createClubSafely } from '../../src/v2/application/clubLifecycle'
import { MemoryStorage } from '../../src/v2/infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../../src/v2/testkit'
import { createRankedHook, RANKED_VARIANTS, type PointsRules, type RankedHook } from './ranked'

async function clubAt(tier: number) {
  const d = tab(new MemoryStorage(), new ManualClock(T0), new FakeLockManager())
  await createClubSafely(d, { clubName: '模擬', clubSeed: 1, clubId: 'rk' })
  const c = d.store.loadClub()!
  d.store.saveClub({ ...c, league: { ...c.league, tier, highestTier: tier, promotions: tier, rewardedTiers: Array.from({ length: tier }, (_, i) => i + 1) } }, c.revision)
  return d
}
const games = (tier: number, results: string) => [...results].map((r) => ({ result: { won: r === 'W', leagueTier: tier } }))
/** 讓影子狀態晉級到 tier（模擬一次挑戰成功） */
const promote = (h: RankedHook, d: Awaited<ReturnType<typeof clubAt>>, tier: number) =>
  h.prepareChallenge(d)({ challenge: { won: true, toTier: tier, reward: { funds: 0, experience: 0 } } } as never, 0)

const rules = RANKED_VARIANTS['A+3-2'] as PointsRules

describe('模擬用的積分規則', () => {
  it('積分計算：勝 +3／敗 −2、上限 100、下限 0；不同聯盟的比賽不計分', () => {
    const hook = createRankedHook({ ...rules, rankedFrom: 0, relegateTiers: [] })
    const fake = { store: { loadClub: () => null, saveClub: () => null } } as never
    hook.afterSettle(fake, games(0, 'WWW'), 0)
    expect(hook.points()).toBe(59)
    hook.afterSettle(fake, games(1, 'LLLL'), 0)
    expect(hook.points()).toBe(59)
    hook.afterSettle(fake, games(0, 'L'.repeat(40)), 0)
    expect(hook.points()).toBe(0)
    hook.afterSettle(fake, games(0, 'W'.repeat(60)), 0)
    expect(hook.points()).toBe(100)
  })

  it('會降級的聯盟積分歸零就降一級，存檔仍通過現行驗證；一次上線從安全區直接降級會被記下', async () => {
    const d = await clubAt(1)
    const h = createRankedHook({ ...rules, rankedFrom: 0, relegateTiers: [1], start: 50 })
    promote(h, d, 1)
    expect(h.points()).toBe(50)
    h.afterSettle(d, games(1, 'L'.repeat(25 + rules.protectMatches)), 2)
    const c = d.store.loadClub()!
    expect(c.league).toMatchObject({ tier: 0, highestTier: 0, promotions: 0 })
    expect(h.log.events.at(-1)).toMatchObject({ kind: 'relegate', from: 1, to: 0 })
    expect(h.log.oneBatchRelegations).toBe(1)
    expect(h.points()).toBe(rules.afterRelegation)
  })

  it('保底聯盟（不在 relegateTiers）積分歸零也不降級', async () => {
    const d = await clubAt(2)
    const h = createRankedHook(rules)
    promote(h, d, 2)
    h.afterSettle(d, games(2, 'L'.repeat(80)), 1)
    expect(h.points()).toBe(0)
    expect(d.store.loadClub()!.league.tier).toBe(2)
  })

  it('晉級後的保護期內積分不會低於 1', async () => {
    const d = await clubAt(1)
    const h = createRankedHook({ ...rules, rankedFrom: 0, relegateTiers: [1], start: 2, protectMatches: 5 })
    promote(h, d, 1)
    h.afterSettle(d, games(1, 'LLLLL'), 1)
    expect(h.points()).toBe(1)
    expect(d.store.loadClub()!.league.tier).toBe(1)
    h.afterSettle(d, games(1, 'L'), 1)
    expect(d.store.loadClub()!.league.tier).toBe(0)
  })

  it('classic 晉級：積分多少都照現行 eligibility', async () => {
    const d = await clubAt(2)
    const h = createRankedHook(RANKED_VARIANTS['C+3-2']!)
    promote(h, d, 2)
    h.afterSettle(d, games(2, 'W'.repeat(30)), 1)
    expect(h.points()).toBe(100)
    expect(h.canChallenge(d.store.loadClub()!)).toBe(false)
  })
})
