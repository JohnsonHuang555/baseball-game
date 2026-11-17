// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/club-v3-phase3.json'
import { economyViolations, validateClub } from './club'
import { validateClubV3 } from './legacyV3'
import { MigrationError, migrateV3ToV4, needsMigration } from './migration'
import { reserves, resolveRoster } from './roster'

/** Phase 3 的程式實際產生的 V3 存檔（36 場、領取過一次、換過陣容與戰術） */
const v3 = () => structuredClone(fixture) as unknown as ReturnType<typeof validateClubV3>

describe('V3 → V4 遷移', () => {
  it('fixture 是合法的 V3 存檔', () => {
    expect(needsMigration(v3())).toBe(true)
    expect(validateClubV3(v3()).schemaVersion).toBe(3)
  })

  it('球員、陣容、守位、棒次、能力、特性、隊長完全不變，全部 Lv.1', () => {
    const old = v3()
    const club = migrateV3ToV4(old)
    expect(club.schemaVersion).toBe(4)
    expect(resolveRoster(club)).toEqual(old.roster)
    expect(club.players).toHaveLength(14)
    expect(club.players.every((r) => r.level === 1 && r.origin === 'migrated')).toBe(true)
    expect(reserves(club)).toEqual([])
  })

  it('資金、經驗、戰績、結算游標、時間錨點、戰術、近期比賽與 replay 不變', () => {
    const old = v3()
    const club = migrateV3ToV4(old)
    expect(club.economy.assets).toEqual(old.economy.assets)
    expect(club.economy.unclaimed).toEqual(old.economy.unclaimed)
    expect(club.economy.earned).toEqual(old.economy.lifetime)
    expect(club.economy.spent).toEqual({ funds: 0, experience: 0 })
    expect(club.economy.nextClaimSeq).toBe(old.economy.nextClaimSeq)
    expect(club.economy.lastClaim).toEqual(old.economy.lastClaim)
    expect(club.record).toEqual(old.record)
    expect(club.idle).toEqual(old.idle)
    expect(club.strategy).toEqual(old.strategy)
    expect(club.recentMatches).toEqual(old.recentMatches)
    expect(club.replays).toEqual(old.replays)
    expect([club.clubId, club.clubName, club.clubSeed, club.createdAt]).toEqual([old.clubId, old.clubName, old.clubSeed, old.createdAt])
    expect(club.revision).toBe(old.revision + 1)
    expect(club.migratedFrom).toEqual({ schemaVersion: 3, revision: old.revision })
    expect(economyViolations(club.economy)).toEqual([])
    expect(validateClub(club)).toBe(club)
  })

  it('確定性：同一份 V3 遷移幾次都一樣，也不改輸入', () => {
    const old = v3()
    const before = JSON.stringify(old)
    expect(migrateV3ToV4(old)).toEqual(migrateV3ToV4(v3()))
    expect(JSON.stringify(old)).toBe(before)
  })

  it('V3 本身不合法：丟 MigrationError', () => {
    const broken = { ...v3(), economy: { ...v3().economy, assets: { funds: -1, experience: 0 } } }
    expect(() => migrateV3ToV4(broken)).toThrow(MigrationError)
    expect(() => migrateV3ToV4({ schemaVersion: 3 })).toThrow(MigrationError)
  })
})
