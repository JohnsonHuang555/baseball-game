// @vitest-environment node
// 舊比賽的 Replay 不受之後的養成、釋出、晉級影響；重新整理後最近的 Replay 仍可觀看
import { describe, expect, it } from 'vitest'
import type { ClubSave } from '../domain/club'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { reserves } from '../domain/roster'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { createClubSafely, openClubSafely } from './clubLifecycle'
import { recruit, release, upgrade } from './economyService'
import { challengeNextLeague } from './leagueService'
import { buildTimeline } from './replayPlayer'
import { claim, settleDue } from './settlementService'

const expectationOf = (c: ClubSave, matchId: string) => {
  const r = c.recentMatches.find((m) => m.matchId === matchId)!.result
  return { userSide: r.userSide, runsFor: r.runsFor, runsAgainst: r.runsAgainst, won: r.won, innings: r.innings }
}

describe('Replay 與球團進度互不影響', () => {
  it('升級、釋出（含上過場的球員）、晉級之後，舊 Replay 的時間軸完全不變；重新整理後還能看', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const d = tab(storage, clock, locks)
    const load = () => d.store.loadClub()!
    await createClubSafely(d, { clubName: '回放隊', clubSeed: 404, clubId: 'club-flow-replay' })
    // 先招募一位預備打者，讓他上場打這幾場，之後再釋出
    {
      const c = load()
      const rich = { funds: 9_000_000, experience: 900_000 }
      d.store.saveClub({ ...c, economy: { ...c.economy, assets: rich, earned: rich } }, c.revision)
    }
    const { op } = await recruit(d, { opSeq: load().economy.nextOpSeq, role: 'batter' })
    {
      const c = load()
      const lineup = c.roster.lineup.map((s, i) => (i === 8 ? { ...s, playerId: op.playerId } : s))
      // 原本的第九棒變成預備球員
      d.store.saveClub({ ...c, roster: { ...c.roster, lineup } }, c.revision)
    }
    clock.advance(HOUR)
    await settleDue(d)
    await claim(d, load().economy.nextClaimSeq)
    const kept = structuredClone(load().replays.at(-1)!)
    const exp = expectationOf(load(), kept.matchId)
    const before = buildTimeline(kept.replay, exp)
    // 這場比賽裡有那位新球員
    expect(before.players.has(op.playerId)).toBe(true)

    // 升級所有上場球員、把那位球員換下來後釋出、晉級
    for (const id of [load().roster.starter, ...load().roster.lineup.map((s) => s.playerId)]) {
      const r = load().players.find((p) => p.player.id === id)!
      await upgrade(d, { opSeq: load().economy.nextOpSeq, playerId: id, expectedLevel: r.level })
    }
    {
      const c = load()
      const back = reserves(c).find((p) => p.role === 'batter' && p.id !== op.playerId)!
      const lineup = c.roster.lineup.map((s) => (s.playerId === op.playerId ? { ...s, playerId: back.id } : s))
      d.store.saveClub({ ...c, roster: { ...c.roster, lineup } }, c.revision)
    }
    await release(d, { opSeq: load().economy.nextOpSeq, playerId: op.playerId })
    expect(load().players.some((r) => r.player.id === op.playerId)).toBe(false)
    {
      const c = load()
      const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
      d.store.saveClub({ ...c, league: { ...c.league, matches: n, wins: n, losses: 0, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...c.idle } }, c.revision)
    }
    await challengeNextLeague(d, { challengeSeq: 0, fromTier: 0, requestId: 'x' })

    // 存檔裡的同一份 Replay：內容沒變，時間軸完全相同
    const stored = load().replays.find((r) => r.matchId === kept.matchId)
    expect(stored).toEqual(kept)
    const after = buildTimeline(stored!.replay, exp)
    expect(after.frames).toEqual(before.frames)
    expect(after.final).toEqual(before.final)
    expect(after.players.get(op.playerId)).toEqual(before.players.get(op.playerId))

    // 重新整理（新的分頁）：最近的 Replay 還在、還能播
    const reopened = await openClubSafely(tab(storage, new ManualClock(clock.now()), locks))
    const again = reopened.value.club!.replays.find((r) => r.matchId === kept.matchId)!
    expect(buildTimeline(again.replay, exp).final).toEqual(before.final)
  })
})
