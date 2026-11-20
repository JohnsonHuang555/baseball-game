// @vitest-environment node
import { v8League } from '../testkit'
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/club-v3-phase3.json'
import fixtureV4 from './__fixtures__/club-v4-phase4.json'
import fixtureV5 from './__fixtures__/club-v5-phase5.json'
import fixtureV6 from './__fixtures__/club-v6-phase5b.json'
import { CLUB_SCHEMA_VERSION, economyViolations, validateClub } from './club'
import { eligibility } from './league'
import { validateClubV3 } from './legacyV3'
import { MigrationError, migrateToLatest, migrateV3ToV4, needsMigration, sourceVersion } from './migration'
import { reserves, resolveRoster } from './roster'

/** Phase 3 的程式實際產生的 V3 存檔（36 場、領取過一次、換過陣容與戰術） */
/** 遷移會替還保留完整 Replay 的比賽補上 Box Score；比較其他欄位時先拿掉 */
const withoutBox = <T extends { recentMatches: { box?: unknown }[] }>(c: T): T => ({ ...c, recentMatches: c.recentMatches.map(({ box: _b, ...m }) => m) })

const v3 = () => structuredClone(fixture) as unknown as ReturnType<typeof validateClubV3>
/** Phase 4 的程式實際產生的 V4 存檔（114 場、升級過、招募過一位預備球員、多次領取） */
const v4 = () => structuredClone(fixtureV4) as unknown as Record<string, unknown> & typeof fixtureV4

describe('V3 → V7 遷移（經過 V4、V5、V6）', () => {
  it('fixture 是合法的 V3 存檔', () => {
    expect(needsMigration(v3())).toBe(true)
    expect(sourceVersion(v3())).toBe(3)
    expect(validateClubV3(v3()).schemaVersion).toBe(3)
  })

  it('球員、陣容、守位、棒次、能力、特性、隊長完全不變，全部 Lv.1', () => {
    const old = v3()
    const club = migrateToLatest(old)
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(resolveRoster(club)).toEqual(old.roster)
    expect(club.players).toHaveLength(14)
    expect(club.players.every((r) => r.level === 1 && r.origin === 'migrated')).toBe(true)
    expect(reserves(club)).toEqual([])
  })

  it('資金、經驗、戰績、結算游標、時間錨點、戰術、近期比賽與 replay 不變；從新秀聯盟開始', () => {
    const old = v3()
    const club = migrateToLatest(old)
    expect(club.economy.assets).toEqual(old.economy.assets)
    expect(club.economy.unclaimed).toEqual(old.economy.unclaimed)
    expect(club.economy.earned).toEqual(old.economy.lifetime)
    expect(club.economy.spent).toEqual({ funds: 0, experience: 0 })
    expect(club.economy.nextClaimSeq).toBe(old.economy.nextClaimSeq)
    expect(club.economy.lastClaim).toEqual(old.economy.lastClaim)
    expect(club.record).toEqual(old.record)
    expect(club.idle).toEqual(old.idle)
    expect(club.strategy).toEqual(old.strategy)
    expect(withoutBox(club).recentMatches).toEqual(old.recentMatches)
    expect(club.replays).toEqual(old.replays)
    expect([club.clubId, club.clubName, club.clubSeed, club.createdAt]).toEqual([old.clubId, old.clubName, old.clubSeed, old.createdAt])
    expect(club.revision).toBe(old.revision + 1)
    expect(club.migratedFrom).toEqual({ schemaVersion: 3, revision: old.revision })
    expect(club.league.tier).toBe(0)
    expect(club.league.matches).toBe(old.record.wins + old.record.losses)
    expect(economyViolations(club.economy)).toEqual([])
    expect(validateClub(club)).toBe(club)
  })

  it('確定性：同一份 V3 遷移幾次都一樣，也不改輸入；中間的 V4 也是確定性的', () => {
    const old = v3()
    const before = JSON.stringify(old)
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v3()))
    expect(migrateV3ToV4(old)).toEqual(migrateV3ToV4(v3()))
    expect(JSON.stringify(old)).toBe(before)
  })

  it('V3 本身不合法：丟 MigrationError', () => {
    const broken = { ...v3(), economy: { ...v3().economy, assets: { funds: -1, experience: 0 } } }
    expect(() => migrateToLatest(broken)).toThrow(MigrationError)
    expect(() => migrateToLatest({ schemaVersion: 3 })).toThrow(MigrationError)
  })
})

describe('V4 → V7 遷移（經過 V5、V6）', () => {
  it('fixture 是 Phase 4 的 V4 存檔', () => {
    expect(sourceVersion(v4())).toBe(4)
    expect(needsMigration({ ...v4(), schemaVersion: CLUB_SCHEMA_VERSION })).toBe(false)
  })

  it('除了 league、challengeReplay、liveMatch、Box Score、schemaVersion、revision、migratedFrom 以外，每個欄位都一模一樣', () => {
    const old = v4()
    const club = migrateToLatest(old)
    const { schemaVersion, stats: newStats, league, revision, migratedFrom, challengeReplay, liveMatch, onboarding: _o, ...rest } = withoutBox(club)
    expect(newStats).toEqual({ sinceMatch: club.idle.nextMatchIndex, throughMatch: club.idle.nextMatchIndex, players: {} })
    expect(challengeReplay).toBeNull()
    expect(liveMatch).toBeNull()
    const { schemaVersion: _s, revision: oldRevision, migratedFrom: _m, ...oldRest } = old as typeof old & { migratedFrom?: unknown }
    expect(rest).toEqual(oldRest)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 4, revision: oldRevision })
    // 等級、名單、陣容、資產、支出、結算游標、時間錨點都沒變
    expect(club.players.map((p) => p.level)).toEqual(old.players.map((p) => p.level))
    expect(club.idle).toEqual(old.idle)
    expect(club.economy).toEqual(old.economy)
    expect(club.recruitment).toEqual(old.recruitment)
    expect(league).toMatchObject({ tier: 0, highestTier: 0, promotions: 0, nextChallengeSeq: 0, challenges: [], rewardedTiers: [] })
  })

  it('本聯盟戰績用既有戰績：場次 = 總勝敗，最近戰績取自近期比賽，不發任何獎勵', () => {
    const old = v4()
    const { league, economy } = migrateToLatest(old)
    expect([league.matches, league.wins, league.losses]).toEqual([old.record.wins + old.record.losses, old.record.wins, old.record.losses])
    const tail = old.recentMatches.slice(-league.recent.length).map((m) => (m.result.won ? 'W' : 'L')).join('')
    expect(league.recent).toBe(tail)
    expect(economy.earned).toEqual(old.economy.earned)
    // 舊球團如果已經達到晉級條件，遷移後就能挑戰（不必重打）
    expect(eligibility(league, old.idle.nextMatchIndex).matches.have).toBe(old.idle.nextMatchIndex)
  })

  it('確定性、不改輸入；壞掉的 V4 丟 MigrationError', () => {
    const old = v4()
    const before = JSON.stringify(old)
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v4()))
    expect(JSON.stringify(old)).toBe(before)
    const broken = { ...v4(), economy: { ...v4().economy, spent: { funds: 1, experience: 0 } } }
    expect(() => migrateToLatest(broken)).toThrow(MigrationError)
    expect(() => migrateToLatest({ schemaVersion: 4 })).toThrow(MigrationError)
  })

  it('已經是目前格式或未知版本：不是可遷移的舊版', () => {
    expect(sourceVersion({ schemaVersion: CLUB_SCHEMA_VERSION })).toBeNull()
    expect(() => migrateToLatest({ schemaVersion: CLUB_SCHEMA_VERSION })).toThrow(MigrationError)
  })
})

/** Phase 5A 的程式實際產生的 V5 存檔（324 場、招募 2 次、釋出 1 次、挑戰 2 次都失敗、30 筆支出紀錄） */
const v5 = () => structuredClone(fixtureV5) as unknown as Record<string, unknown> & typeof fixtureV5

describe('V5 → V7 遷移（經過 V6）', () => {
  it('fixture 是 Phase 5A 的 V5 存檔', () => {
    expect(sourceVersion(v5())).toBe(5)
  })

  it('只加上 challengeReplay、liveMatch = null 與 Box Score；其他每個欄位都一模一樣（聯盟、挑戰紀錄、支出、游標、錨點）', () => {
    const old = v5()
    const club = migrateToLatest(old)
    const { schemaVersion, stats: newStats, revision, migratedFrom, challengeReplay, liveMatch, onboarding: _o, ...rest } = withoutBox(club)
    expect(newStats).toEqual({ sinceMatch: club.idle.nextMatchIndex, throughMatch: club.idle.nextMatchIndex, players: {} })
    const { schemaVersion: _s, revision: oldRevision, ...oldRest } = old
    expect({ ...rest, league: v8League(rest.league) }).toEqual(oldRest)
    expect(liveMatch).toBeNull()
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(challengeReplay).toBeNull()
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 5, revision: oldRevision })
    expect(v8League(club.league)).toEqual(old.league)
    expect(club.idle).toEqual(old.idle)
    expect(club.economy).toEqual(old.economy)
    expect(economyViolations(club.economy)).toEqual([])
  })

  it('確定性、不改輸入；壞掉的 V5 丟 MigrationError', () => {
    const old = v5()
    const before = JSON.stringify(old)
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v5()))
    expect(JSON.stringify(old)).toBe(before)
    expect(() => migrateToLatest({ ...v5(), league: { ...v5().league, tier: 9 } })).toThrow(MigrationError)
    expect(() => migrateToLatest({ schemaVersion: 5 })).toThrow(MigrationError)
  })
})

/** PR #9 草稿（觀看歷史 Replay 的版本）實際產生的 V6 存檔：150 場、招募過、升級過、晉級過一次（有挑戰 Replay） */
const v6 = () => structuredClone(fixtureV6) as unknown as Record<string, unknown> & typeof fixtureV6

describe('V6 → V7 遷移', () => {
  it('只加上 liveMatch = null 與 Box Score；挑戰 Replay、聯盟、經濟、游標、錨點全部照舊', () => {
    const old = v6()
    expect(sourceVersion(old)).toBe(6)
    const club = migrateToLatest(old)
    const { schemaVersion, stats: newStats, revision, migratedFrom, liveMatch, onboarding: _o, ...rest } = withoutBox(club)
    expect(newStats).toEqual({ sinceMatch: club.idle.nextMatchIndex, throughMatch: club.idle.nextMatchIndex, players: {} })
    const { schemaVersion: _s, revision: oldRevision, ...oldRest } = old
    expect({ ...rest, league: v8League(rest.league) }).toEqual(oldRest)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(liveMatch).toBeNull()
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 6, revision: oldRevision })
    expect(club.challengeReplay).toEqual(old.challengeReplay)
  })

  it('還保留完整 Replay 的場次補上 Box Score（各局加總等於比分）；其他舊場次維持只有摘要', () => {
    const old = v6()
    const club = migrateToLatest(old)
    const kept = new Set(old.replays.map((r) => r.matchId))
    for (const m of club.recentMatches) {
      if (!kept.has(m.matchId)) {
        expect(m.box).toBeUndefined()
        continue
      }
      const box = m.box!
      const side = m.result.userSide as 'home' | 'away'
      const other = side === 'home' ? 'away' : 'home'
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
      expect(sum(box.linescore[side])).toBe(m.result.runsFor)
      expect(sum(box.linescore[other])).toBe(m.result.runsAgainst)
      expect(box.batters.length).toBeGreaterThanOrEqual(9)
      expect(box.pitchers.length).toBeGreaterThanOrEqual(1)
    }
    expect(club.recentMatches.filter((m) => m.box)).toHaveLength(kept.size)
  })

  it('確定性、不改輸入', () => {
    const old = v6()
    const before = JSON.stringify(old)
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v6()))
    expect(JSON.stringify(old)).toBe(before)
  })
})
