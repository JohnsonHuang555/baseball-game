// @vitest-environment node
// 降級通知只描述存檔裡可驗證的實際事件（PR #17 review P2）
import { describe, expect, it } from 'vitest'
import type { ClubSave, SettledMatch } from '../domain/club'
import { leagueAtTier, type RankedMatchRecord } from '../domain/league'
import { ClubRepository, MemoryStorage } from '../infrastructure/clubRepository'
import { atMatch, T0 } from '../testkit'
import type { ChallengeRecord } from '../domain/league'
import { parseSeen, pendingRelegation } from './relegationNotice'

const base = () => new ClubRepository(new MemoryStorage()).createClub({ clubName: '通知', clubSeed: 3, clubId: 'club-n', now: T0 })

/** 一場造成降級（或只是計分）的比賽紀錄 */
const match = (matchIndex: number, tier: number, relegatedTo: number | null): SettledMatch => ({
  matchId: `club-n#${matchIndex}`,
  matchIndex,
  seed: 1,
  result: { userSide: 'home', opponentName: 'x', runsFor: 0, runsAgainst: 1, won: false, innings: 9, highlights: [], rulesVersion: 1, coachVersion: 1, leagueTier: tier },
  earnedFunds: 1,
  earnedExperience: 1,
  settledAt: T0,
  ranked: { tier, before: 2, after: 0, delta: -2, protected: false, protectionRemaining: 0, relegatedTo } as RankedMatchRecord,
})
const won = (seq: number, fromTier: number, matchIndexAt: number): ChallengeRecord => ({
  seq,
  fromTier,
  toTier: fromTier + 1,
  won: true,
  runsFor: 3,
  runsAgainst: 1,
  opponentName: 'x',
  innings: 9,
  at: T0,
  matchIndexAt,
  reward: { funds: 0, experience: 0 },
  requestKey: 'k',
})

/**
 * 依照事件序列組出球團：events 是 ['R', from, matchIndex]（降級）或 ['P', from, matchIndexAt]（晉級）。
 * 先放在 startTier（每一級都晉級過），最後的游標是 now
 */
function club(startTier: number, events: (['R' | 'P', number, number])[], now: number, keepFrom = 0): ClubSave {
  const c = base()
  let league = leagueAtTier(c.league, startTier)
  const recent: SettledMatch[] = []
  const challenges: ChallengeRecord[] = []
  for (const [kind, from, at] of events) {
    if (kind === 'R') {
      league = { ...league, tier: from - 1, relegations: league.relegations + 1, lastRelegation: { fromTier: from, toTier: from - 1, matchIndex: at, at: T0 } }
      recent.push(match(at, from, from - 1))
    } else {
      league = { ...league, tier: from + 1, promotions: league.promotions + 1 }
      challenges.push(won(challenges.length, from, at))
    }
  }
  // 近期比賽只保留 keepFrom 以後（用一場普通比賽標出保留範圍的起點）
  const kept = recent.filter((m) => m.matchIndex >= keepFrom)
  if (keepFrom > 0) kept.unshift(match(keepFrom, league.tier, null))
  return { ...c, league: { ...league, challenges, nextChallengeSeq: challenges.length }, recentMatches: kept, ...atMatch(c, now) }
}

describe('pendingRelegation', () => {
  it('D 單次降級（職業 → 挑戰者）：通知一次；已讀之後不再通知', () => {
    const c = club(3, [['R', 3, 40]], 60)
    expect(pendingRelegation(c, 0)).toEqual({ seq: 1, fromTier: 3, toTier: 2, count: 1, unverified: 0 })
    expect(pendingRelegation(c, 1)).toBeNull()
  })

  it('A 降級後重新晉級：不通知（不會出現「傳奇 → 傳奇」），有沒有已讀紀錄都一樣', () => {
    const c = club(4, [['R', 4, 40], ['P', 3, 70]], 80)
    expect(c.league).toMatchObject({ tier: 4, relegations: 1 })
    expect(pendingRelegation(c, 0)).toBeNull()
    expect(pendingRelegation(c, null)).toBeNull()
  })

  it('B 傳奇 → 職業 → 傳奇 → 職業：累計 2 次，但只通知最後一次（不是連降兩級）', () => {
    const c = club(4, [['R', 4, 40], ['P', 3, 60], ['R', 4, 90]], 100)
    expect(c.league.relegations).toBe(2)
    expect(pendingRelegation(c, 0)).toEqual({ seq: 2, fromTier: 4, toTier: 3, count: 1, unverified: 0 })
    expect(pendingRelegation(c, 1)).toEqual({ seq: 2, fromTier: 4, toTier: 3, count: 1, unverified: 0 })
    expect(pendingRelegation(c, null)).toEqual({ seq: 2, fromTier: 4, toTier: 3, count: 1, unverified: 0 })
  })

  it('C 一次離線連降兩級（傳奇 → 職業 → 挑戰者）：合併成一個通知，從傳奇到挑戰者', () => {
    const c = club(4, [['R', 4, 30], ['R', 3, 70]], 96)
    expect(pendingRelegation(c, 0)).toEqual({ seq: 2, fromTier: 4, toTier: 2, count: 2, unverified: 0 })
    // 已經通知過第一次：只剩第二次
    expect(pendingRelegation(c, 1)).toEqual({ seq: 2, fromTier: 3, toTier: 2, count: 1, unverified: 0 })
  })

  it('較早的降級紀錄已經不在近期比賽裡：不猜路徑，只說有幾次沒有細節', () => {
    const c = club(4, [['R', 4, 10], ['R', 3, 90]], 100, 50)
    expect(c.recentMatches.filter((m) => m.ranked?.relegatedTo != null)).toHaveLength(1)
    expect(pendingRelegation(c, 0)).toEqual({ seq: 2, fromTier: 3, toTier: 2, count: 1, unverified: 1 })
  })

  it('較早的紀錄不在、但之後晉級過：那些一定是歷史事件，不提', () => {
    const c = club(4, [['R', 4, 10], ['P', 3, 60], ['R', 4, 90]], 100, 50)
    expect(pendingRelegation(c, 0)).toEqual({ seq: 2, fromTier: 4, toTier: 3, count: 1, unverified: 0 })
  })

  it('這個裝置沒有已讀紀錄：只通知最近一次離線結算範圍內的降級；更早的不打擾', () => {
    expect(pendingRelegation(club(3, [['R', 3, 40]], 100), null)).not.toBeNull()
    expect(pendingRelegation(club(3, [['R', 3, 40]], 400), null)).toBeNull()
  })

  it('沒有降級過：不通知', () => {
    expect(pendingRelegation(club(4, [], 100), 0)).toBeNull()
    expect(pendingRelegation(club(4, [], 100), null)).toBeNull()
  })
})

describe('已讀紀錄', () => {
  it('沿用第一版格式 { clubId, count }；別的球團、壞掉的資料都當作沒有紀錄', () => {
    expect(parseSeen(JSON.stringify({ clubId: 'a', count: 2 }), 'a')).toBe(2)
    expect(parseSeen(JSON.stringify({ clubId: 'b', count: 2 }), 'a')).toBeNull()
    expect(parseSeen('{oops', 'a')).toBeNull()
    expect(parseSeen(JSON.stringify({ clubId: 'a', count: -1 }), 'a')).toBeNull()
    expect(parseSeen(null, 'a')).toBeNull()
  })
})
