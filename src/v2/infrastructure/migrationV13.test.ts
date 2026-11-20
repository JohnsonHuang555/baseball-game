// @vitest-environment node
// Phase 9 PR 4：schemaVersion 12 → 13（單場 MVP 與永久能力成長）的遷移。
// fixture 是 main（PR 3 合併後，commit 624b8b8）的程式實際產生的 V12 存檔：挑戰者聯盟、1152 場、
// 已習得特性（觸擊）、已改善負面特性（守備不穩）、進行中的訓練（95／200）、固定的進行中比賽、3 份 Replay、14 位生涯數據。
// club-v12-settle-golden.json 也是 main 的程式產生的：同一份 V12 打開後離線 8 小時結算的每一場與最後狀態。
import { describe, expect, it } from 'vitest'
import fixtureV12 from '../domain/__fixtures__/club-v12-phase9.json'
import golden from '../domain/__fixtures__/club-v12-settle-golden.json'
import fixtureV11 from '../domain/__fixtures__/club-v11-phase9.json'
import fixtureV9 from '../domain/__fixtures__/club-v9-phase7b.json'
import fixtureV3 from '../domain/__fixtures__/club-v3-phase3.json'
import type { MatchPlan } from '../application/batchRunner'
import { openClubSafely } from '../application/clubLifecycle'
import { runMatch } from '../application/matchRunner'
import { settleDue } from '../application/settlementService'
import { CLUB_SCHEMA_VERSION, validateClub, type ClubSave } from '../domain/club'
import type { ClubSaveV12 } from '../domain/legacyV12'
import { MIGRATABLE_VERSIONS, migrateToLatest, sourceVersion } from '../domain/migration'
import { unpackMvp } from '../domain/mvp'
import { FakeLockManager, HOUR, ManualClock, tab, withoutMvpGrowth } from '../testkit'
import { CLUB_BACKUP_KEY_V11, CLUB_BACKUP_KEY_V12, CLUB_STORAGE_KEY, ClubRepository, MemoryStorage } from './clubRepository'

const RAW_V12 = JSON.stringify(fixtureV12)
const v12 = () => JSON.parse(RAW_V12) as ClubSaveV12

class SpyStorage extends MemoryStorage {
  failKey: string | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error('quota')
    super.setItem(key, value)
  }
}

const rowOf = (m: ClubSave['recentMatches'][number]) =>
  [m.matchIndex, m.result.runsFor, m.result.runsAgainst, m.result.innings, m.earnedFunds, m.earnedExperience, m.ranked ? `${m.ranked.before}>${m.ranked.after}` : '-', JSON.stringify(m.tactics)].join(' ')

async function settleFixture(): Promise<{ settled: ClubSave['recentMatches']; club: ClubSave }> {
  const storage = new MemoryStorage()
  storage.setItem(CLUB_STORAGE_KEY, RAW_V12)
  const clock = new ManualClock(fixtureV12.idle.anchorMs)
  const deps = tab(storage, clock, new FakeLockManager())
  await openClubSafely(deps)
  clock.advance(8 * HOUR)
  const r = await settleDue(deps)
  return { settled: r.settled, club: r.club }
}

describe('V12 → V13（純函式）', () => {
  it('fixture 是真的 V12：已習得、已改善、進行中的訓練、固定的進行中比賽、Replay、完整生涯數據；沒有 MVP', () => {
    const f = v12()
    expect(sourceVersion(f)).toBe(12)
    expect(MIGRATABLE_VERSIONS).toContain(12)
    expect(f.players.some((p) => p.dev?.learned.length)).toBe(true)
    expect(f.players.some((p) => p.dev?.removed.length)).toBe(true)
    expect(f.training.active).not.toBeNull()
    expect(f.training.recent.length).toBeGreaterThanOrEqual(2)
    expect(f.liveMatch?.matchIndex).toBe(f.idle.nextMatchIndex)
    expect(f.replays.length).toBeGreaterThan(0)
    expect(Object.keys(f.stats.players).length).toBeGreaterThanOrEqual(14)
    expect(f.players.some((p) => 'mvp' in p)).toBe(false)
    expect(f.recentMatches.some((m) => 'mvp' in m)).toBe(false)
  })

  it('只改版本：原生能力、等級、特性培養成果、進行中的訓練、戰術、聯盟、積分、帳務、招募、固定的比賽、Replay、生涯數據、比賽紀錄一個字都不動', () => {
    const old = v12()
    const club = migrateToLatest(old)
    const { schemaVersion, revision, migratedFrom, championship: _ch, ...rest } = club
    const { schemaVersion: _s, revision: oldRevision, migratedFrom: _m, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 12, revision: oldRevision })
    // 舊球員 0 次、沒有加成；舊比賽沒有 MVP（不回填）
    expect(club.players.every((p) => p.mvp === undefined)).toBe(true)
    expect(club.recentMatches.every((m) => m.mvp === undefined)).toBe(true)
  })

  it('確定性、不改輸入；遷移完的存檔不會再遷移一次', () => {
    const old = v12()
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v12()))
    expect(JSON.stringify(old)).toBe(RAW_V12)
    expect(sourceVersion(migrateToLatest(old))).toBeNull()
  })

  it('V3、V9、V11 → V13 的完整遷移鏈：沒有 MVP 紀錄、訓練槽空的', () => {
    for (const [fx, from] of [
      [fixtureV3, 3],
      [fixtureV9, 9],
      [fixtureV11, 11],
    ] as const) {
      const c = migrateToLatest(structuredClone(fx))
      expect(c.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
      expect(c.migratedFrom?.schemaVersion).toBe(from)
      expect(c.players.every((p) => p.mvp === undefined)).toBe(true)
      expect(c.recentMatches.every((m) => m.mvp === undefined)).toBe(true)
    }
  })

  it('V13 驗證：MVP 紀錄、單場 MVP 的格式與一致性', () => {
    const club = migrateToLatest(v12())
    const p = club.players[0]
    const withMvp = (mvp: unknown) => validateClub({ ...club, players: club.players.map((r) => (r === p ? { ...r, mvp } : r)) })
    expect(withMvp({ count: 12, grants: [{ rating: p.player.role === 'batter' ? 'power' : 'stuff', atMatch: 1100 }] }).players[0].mvp!.count).toBe(12)
    expect(() => withMvp({ count: 5, grants: [{ rating: 'power', atMatch: 1 }] })).toThrow(/mvp/)
    expect(() => withMvp({ count: 'x', grants: [] })).toThrow(/mvp/)
    const m = club.recentMatches.at(-1)!
    const someone = m.lines!.bat[0][0]
    const withMatch = (mvp: unknown) => validateClub({ ...club, recentMatches: [...club.recentMatches.slice(0, -1), { ...m, mvp }] })
    expect(withMatch([someone, 0, 1200, 1, 0, 0, 0]).recentMatches.at(-1)!.mvp).toEqual([someone, 0, 1200, 1, 0, 0, 0])
    expect(() => withMatch([someone, 1, 1200, 1, 0, 0, 0])).toThrow(/投球紀錄/)
    expect(() => withMatch(['nobody', 0, 1200, 1, 0, 0, 0])).toThrow(/打擊紀錄/)
    expect(() => withMatch([someone, 0, 1200, 0, 0, 0, 0])).toThrow(/次數/)
  })
})

describe('V13 讀檔：MVP 成長紀錄驗證（PR #23 review P2）', () => {
  const club = () => migrateToLatest(v12())
  /** 把第一位打者的 MVP 紀錄換掉，走正式的 validateClub（讀檔也是這個） */
  const withMvp = (c: ClubSave, mvp: unknown, joinedAtMatch?: number) => {
    const i = c.players.findIndex((r) => r.player.role === 'batter')
    return { ...c, players: c.players.map((r, j) => (j === i ? { ...r, mvp, ...(joinedAtMatch !== undefined ? { joinedAtMatch } : {}) } : r)) }
  }
  const g = (rating: string, atMatch: number) => ({ rating, atMatch })
  const expectRejected = (value: unknown, re: RegExp) => {
    expect(() => validateClub(value)).toThrow(re)
    // 讀檔也拒絕，主存檔原文不變
    const storage = new MemoryStorage()
    const raw = JSON.stringify(value)
    storage.setItem(CLUB_STORAGE_KEY, raw)
    expect(() => new ClubRepository(storage).loadClub()).toThrow()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
  }

  it('兩筆相同場次的成長：拒絕', () => {
    expectRejected(withMvp(club(), { count: 20, grants: [g('power', 100), g('contact', 100)] }), /嚴格遞增/)
  })

  it('成長場次早於加入球團：拒絕', () => {
    expectRejected(withMvp(club(), { count: 10, grants: [g('power', 99)] }, 100), /早於加入/)
  })

  it('成長場次等於、大於結算游標：拒絕', () => {
    const c = club()
    const next = c.idle.nextMatchIndex
    expectRejected(withMvp(c, { count: 10, grants: [g('power', next)] }), /還沒結算/)
    expectRejected(withMvp(c, { count: 10, grants: [g('power', next + 5)] }), /還沒結算/)
  })

  it('成長超過 MVP 門檻、超過上限 +0.3、能力不屬於角色：拒絕', () => {
    expectRejected(withMvp(club(), { count: 19, grants: [g('power', 10), g('power', 11)] }), /超過 MVP 次數/)
    expectRejected(withMvp(club(), { count: 90, grants: [1, 2, 3, 4].map((i) => g('power', i)) }), /上限 3/)
    expectRejected(withMvp(club(), { count: 10, grants: [g('stuff', 5)] }), /能力不合法/)
    const c = club()
    const pi = c.players.findIndex((r) => r.player.role === 'pitcher')
    expectRejected({ ...c, players: c.players.map((r, j) => (j === pi ? { ...r, mvp: { count: 10, grants: [g('power', 5)] } } : r)) }, /能力不合法/)
  })

  it('正常連續成長、已達上限後次數繼續增加、沒有紀錄的舊球員：通過', () => {
    expect(validateClub(withMvp(club(), { count: 31, grants: [g('power', 10), g('power', 20), g('contact', 30)] })).players.find((r) => r.mvp)!.mvp!.count).toBe(31)
    expect(validateClub(withMvp(club(), { count: 87, grants: [g('power', 10), g('power', 20), g('power', 30)] })).players.find((r) => r.mvp)!.mvp!.count).toBe(87)
    expect(() => validateClub(club())).not.toThrow()
  })

  it('V12 遷移後繼續玩、拿到 MVP 與成長的球員：存檔照樣通過（不會因為驗證變嚴而讀不回來）', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V12)
    const clock = new ManualClock(fixtureV12.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    for (let i = 0; i < 3; i++) {
      clock.advance(8 * HOUR)
      await settleDue(deps)
    }
    const c = new ClubRepository(storage).loadClub()!
    expect(c.players.some((p) => (p.mvp?.grants.length ?? 0) > 0)).toBe(true)
    for (const p of c.players) for (const gr of p.mvp?.grants ?? []) expect(gr.atMatch).toBeGreaterThanOrEqual(fixtureV12.idle.nextMatchIndex)
    expect(validateClub(JSON.parse(JSON.stringify(c)))).toEqual(c)
  })
})

describe('V12 → V13（打開存檔）', () => {
  it('自動遷移：原始文字逐字備份到 backup-schema12，舊的 schema11 備份不動', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V12)
    storage.setItem(CLUB_BACKUP_KEY_V11, '舊的 V11 備份')
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV12.idle.anchorMs), new FakeLockManager()))
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V12)).toBe(RAW_V12)
    expect(storage.getItem(CLUB_BACKUP_KEY_V11)).toBe('舊的 V11 備份')
    expect(value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
  })

  it('寫入失敗（備份或主存檔）時原本的 V12 存檔不變，之後可以再遷移；重複打開不會再遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V12, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V12)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(fixtureV12.idle.anchorMs), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V12)
      storage.failKey = null
      const first = await openClubSafely(deps)
      expect(first.value.migrated).toBe(true)
      const again = await openClubSafely(deps)
      expect(again.value.migrated).toBe(false)
      expect(again.value.club).toEqual(first.value.club)
    }
  })

  it('Golden：關掉 MVP 成長時，遷移後離線 8 小時結算的 96 場與最後的帳務、聯盟、生涯、訓練、特性，跟 main 的程式一模一樣', async () => {
    const { settled, club } = await withoutMvpGrowth(settleFixture)
    expect(settled.map(rowOf)).toEqual(golden.rows)
    const final = JSON.stringify({ record: club.record, economy: club.economy, league: club.league, stats: club.stats, training: club.training, dev: club.players.map((p) => [p.player.id, p.level, p.dev ?? null]), next: club.idle.nextMatchIndex })
    expect(final).toBe(golden.final)
    // MVP 照樣選、照樣記（每場一位）
    expect(settled.every((m) => m.mvp)).toBe(true)
  })

  it('Golden（正式，有 MVP 成長）：第一次成長生效之前的每一場都跟 main 一模一樣；成長的那一場用舊能力，下一場起才可能不同', async () => {
    const { settled } = await settleFixture()
    const rows = settled.map(rowOf)
    const first = settled.findIndex((m) => unpackMvp(m.mvp!).growth)
    // 遷移後大家都是 0 次：最快第 10 場才可能有人成長
    expect(first === -1 || first >= 9).toBe(true)
    const prefix = first === -1 ? rows.length : first + 1
    expect(rows.slice(0, prefix)).toEqual(golden.rows.slice(0, prefix))
    expect(rows).toHaveLength(96)
  })

  it('Replay 相容：固定的進行中比賽與保留的 Replay，用遷移前的資料重新模擬，比分跟戰報一致；舊 Replay 沒有被改', () => {
    const club = migrateToLatest(v12())
    const plan = club.liveMatch!.plan as MatchPlan
    expect(plan).toEqual(fixtureV12.liveMatch!.plan)
    const live = runMatch(structuredClone(plan.setup), plan.ai)
    const first = golden.rows[0].split(' ')
    const other = plan.userSide === 'home' ? 'away' : 'home'
    expect([live.score[plan.userSide], live.score[other]]).toEqual([Number(first[1]), Number(first[2])])
    expect(club.replays).toEqual(fixtureV12.replays)
    for (const rep of club.replays) {
      const m = club.recentMatches.find((x) => x.matchId === rep.matchId)!
      const again = runMatch(structuredClone(rep.replay.setup), rep.replay.ai)
      const side = rep.replay.setup.userSide
      expect([again.score[side], again.score[side === 'home' ? 'away' : 'home']]).toEqual([m.result.runsFor, m.result.runsAgainst])
    }
  })

  it('遷移後繼續玩：進行中的訓練照常累積；已習得、已改善的特性照常生效；新比賽才有 MVP', async () => {
    const { settled, club } = await settleFixture()
    const before = v12()
    const a = before.training.active!
    expect(club.training.active?.playerId ?? club.training.recent.at(-1)!.playerId).toBe(a.playerId)
    if (club.training.active) expect(club.training.active.progress).toBeGreaterThan(a.progress)
    for (const p of before.players.filter((x) => x.dev)) expect(club.players.find((x) => x.player.id === p.player.id)!.dev).toEqual(p.dev)
    expect(club.recentMatches.filter((m) => m.mvp).map((m) => m.matchIndex)).toEqual(settled.map((m) => m.matchIndex).slice(-club.recentMatches.filter((m) => m.mvp).length))
    expect(club.players.reduce((x, p) => x + (p.mvp?.count ?? 0), 0)).toBe(96)
  })
})
