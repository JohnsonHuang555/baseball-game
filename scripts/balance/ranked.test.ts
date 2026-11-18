// Phase 7 模擬專用積分規則的單元測試：只驗證模擬的影子狀態，不是正式規則
import { describe, expect, it } from 'vitest'
import { createClubSafely } from '../../src/v2/application/clubLifecycle'
import { MemoryStorage } from '../../src/v2/infrastructure/clubRepository'
import { FakeLockManager, ManualClock, T0, tab } from '../../src/v2/testkit'
import { createRankedHook, RANKED_VARIANTS, type PointsRules, type RankedHook } from './ranked'
import { simulate } from './simulate'

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
    h.startSession()
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

  it('chunk：保證一段之內只會在最後一場降級；不會降級的聯盟不切段', async () => {
    const d = await clubAt(1)
    const h = createRankedHook({ ...rules, rankedFrom: 0, relegateTiers: [1], start: 7, protectMatches: 3 })
    expect(h.chunk()).toBe(Infinity) // 影子狀態還在新秀
    promote(h, d, 1)
    expect(h.chunk()).toBe(3) // 保護期
    h.afterSettle(d, games(1, 'WWW'), 0)
    expect(h.points()).toBe(16)
    expect(h.chunk()).toBe(8)
    h.afterSettle(d, games(1, 'L'.repeat(7)), 0)
    expect(h.points()).toBe(2)
    expect(d.store.loadClub()!.league.tier).toBe(1)
    expect(h.chunk()).toBe(1)
  })

  it('保級緩衝：第一次歸零回到 20 分，第二次才降級', async () => {
    const d = await clubAt(3)
    const h = createRankedHook(RANKED_VARIANTS['C+3-2r']!)
    promote(h, d, 3)
    h.afterSettle(d, games(3, 'L'.repeat(25)), 1)
    expect(h.points()).toBe(20)
    expect(h.log.events.filter((e) => e.kind === 'rescue')).toHaveLength(1)
    expect(d.store.loadClub()!.league.tier).toBe(3)
    h.afterSettle(d, games(3, 'L'.repeat(10)), 1)
    expect(d.store.loadClub()!.league.tier).toBe(2)
  })

  it('分段結算跟整批結算的比賽完全相同（沒有降級時）', async () => {
    const noRelegation = { ...(RANKED_VARIANTS['C+3-2'] as PointsRules), relegateTiers: [] }
    const run = (approx: boolean) => simulate({ strategy: 'E', seed: 3, sessionsPerDay: 1, days: 2, ranked: createRankedHook(noRelegation), rankedApprox: approx })
    const [a, b] = [await run(true), await run(false)]
    expect(b.snapshots.map((x) => [x.matches, x.wins, x.tier, x.earned.funds])).toEqual(a.snapshots.map((x) => [x.matches, x.wins, x.tier, x.earned.funds]))
  }, 60_000)
})
