// @vitest-environment node
// Phase 5 的完整流程：建立 → 自動比賽 → 領取 → 升級 → 招募 → 達到晉級條件 → 挑戰 → 對手變強
// → 名單滿 → 釋出預備球員 → 再招募 → 重新整理（新的分頁）後進度都在
import { describe, expect, it } from 'vitest'
import { economyViolations, validateClub } from '../domain/club'
import { eligibility } from '../domain/league'
import { LEAGUES } from '../domain/leagueConfig'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { reserves } from '../domain/roster'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { createClubSafely, openClubSafely } from './clubLifecycle'
import { recruit, release, upgrade } from './economyService'
import { challengeNextLeague } from './leagueService'
import { claim, settleDue } from './settlementService'

describe('Phase 5 完整流程', () => {
  it('從建立球團一路玩到晉級、名單滿、釋出、再招募，重新整理後全部保留', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const d = tab(storage, clock, locks)
    const load = () => d.store.loadClub()!
    await createClubSafely(d, { clubName: '完整流程隊', clubSeed: 2026, clubId: 'club-flow' })

    // 自動比賽、領取
    clock.advance(2 * HOUR)
    expect((await settleDue(d)).settled).toHaveLength(24)
    await claim(d, load().economy.nextClaimSeq)
    expect(load().economy.unclaimed).toEqual({ funds: 0, experience: 0 })

    // 升級、招募（真的花自己賺的錢）
    const starter = load().roster.lineup[0].playerId
    await upgrade(d, { opSeq: load().economy.nextOpSeq, playerId: starter, expectedLevel: 1 })
    expect(load().players.find((r) => r.player.id === starter)!.level).toBe(2)
    // 為了在合理的測試時間內晉級，直接補一筆資源（同時記進收入，帳務不變量照樣成立），把上場球員養強
    {
      const c = load()
      const bonus = { funds: 5_000_000, experience: 600_000 }
      d.store.saveClub({ ...c, economy: { ...c.economy, assets: { funds: c.economy.assets.funds + bonus.funds, experience: c.economy.assets.experience + bonus.experience }, earned: { funds: c.economy.earned.funds + bonus.funds, experience: c.economy.earned.experience + bonus.experience } } }, c.revision)
    }
    for (let round = 0; round < 19; round++) {
      for (const id of [...load().roster.lineup.map((s) => s.playerId), load().roster.starter, ...load().roster.relievers, ...load().roster.bench]) {
        const r = load().players.find((p) => p.player.id === id)!
        if (r.level < 20) await upgrade(d, { opSeq: load().economy.nextOpSeq, playerId: id, expectedLevel: r.level })
      }
    }
    await recruit(d, { opSeq: load().economy.nextOpSeq, role: 'batter' })
    expect(load().players).toHaveLength(15)

    // 打到符合晉級條件，挑戰到晉級為止（失敗要再打幾場）
    let promoted = false
    for (let i = 0; i < 40 && !promoted; i++) {
      clock.advance(HOUR)
      await settleDue(d)
      const c = load()
      if (!eligibility(c.league, c.idle.nextMatchIndex).ok) continue
      const out = await challengeNextLeague(d, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
      promoted = out.challenge.won
    }
    expect(promoted).toBe(true)
    const afterPromotion = load()
    expect(afterPromotion.league.tier).toBe(1)
    expect(afterPromotion.league.matches).toBe(0)

    // 對手變強：之後的比賽都是業餘聯盟，收益用業餘聯盟的倍率
    clock.advance(HOUR)
    const next = await settleDue(d)
    expect(next.settled.every((m) => m.result.leagueTier === 1)).toBe(true)
    expect(next.settled[0].matchIndex).toBe(afterPromotion.idle.nextMatchIndex)
    await claim(d, load().economy.nextClaimSeq)

    // 名單滿 → 釋出預備球員 → 再招募（新球員編號沒用過）
    while (load().players.length < RECRUIT_CONFIG.maxPlayers) await recruit(d, { opSeq: load().economy.nextOpSeq, role: 'pitcher' })
    expect((await recruit(d, { opSeq: load().economy.nextOpSeq, role: 'batter' }).catch((e) => e)).code).toBe('roster-full')
    const everSeen = new Set(load().players.map((r) => r.player.id))
    const victim = reserves(load())[0]
    await release(d, { opSeq: load().economy.nextOpSeq, playerId: victim.id })
    const again = await recruit(d, { opSeq: load().economy.nextOpSeq, role: 'batter' })
    expect(everSeen.has(again.op.playerId)).toBe(false)
    expect(again.op.playerId).not.toBe(victim.id)

    // 重新整理：新的分頁打開同一份存檔，進度完全一樣
    const before = load()
    expect(economyViolations(before.economy)).toEqual([])
    const reopened = await openClubSafely(tab(storage, new ManualClock(clock.now()), locks))
    expect(reopened.value.migrated).toBe(false)
    expect(reopened.value.club).toEqual(before)
    expect(validateClub(structuredClone(before))).toEqual(before)
    expect(before.league).toMatchObject({ tier: 1, highestTier: 1, promotions: 1, rewardedTiers: [1] })
    expect(before.economy.earned.funds).toBeGreaterThanOrEqual(LEAGUES[1].promotionReward.funds)
  }, 60_000)
})
