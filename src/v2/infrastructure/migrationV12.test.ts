// @vitest-environment node
// Phase 9 PR 3：schemaVersion 11 → 12（特性培養）的遷移。
// fixture 是 main（PR 2 合併後，commit d0be450）的程式實際產生的 V11 存檔：挑戰者聯盟、384 場、機動型（自訂）、固定的進行中比賽。
// club-v11-settle-golden.json 也是 main 的程式產生的：同一份 V11 打開後離線 8 小時結算的每一場與最後狀態。
// 遷移到 V12 之後用新的程式結算，結果必須一模一樣（遷移不改比賽、沒有訓練的球團不受影響）
import { describe, expect, it } from 'vitest'
import fixtureV11 from '../domain/__fixtures__/club-v11-phase9.json'
import golden from '../domain/__fixtures__/club-v11-settle-golden.json'
import fixtureV9 from '../domain/__fixtures__/club-v9-phase7b.json'
import fixtureV3 from '../domain/__fixtures__/club-v3-phase3.json'
import { openClubSafely } from '../application/clubLifecycle'
import type { MatchPlan } from '../application/batchRunner'
import { runMatch } from '../application/matchRunner'
import { settleDue } from '../application/settlementService'
import { CLUB_SCHEMA_VERSION, validateClub } from '../domain/club'
import type { ClubSaveV11 } from '../domain/legacyV11'
import { MIGRATABLE_VERSIONS, migrateToLatest, sourceVersion } from '../domain/migration'
import { TRAINING_CONFIG, TRAINING_RULES, potentialPool, trainingBlock, staticTrainingBlock, trainingClass, type TrainingKind } from '../domain/traitTraining'
import { TRAITS, conflicts, type TraitId } from '../../sim/traits'
import type { ClubSave, PlayerRecord } from '../domain/club'
import { ClubRepository } from './clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab, withoutMvpGrowth } from '../testkit'
import { CLUB_BACKUP_KEY_V10, CLUB_BACKUP_KEY_V11, CLUB_STORAGE_KEY, MemoryStorage } from './clubRepository'

const RAW_V11 = JSON.stringify(fixtureV11)
const v11 = () => JSON.parse(RAW_V11) as ClubSaveV11

class SpyStorage extends MemoryStorage {
  failKey: string | null = null
  override setItem(key: string, value: string): void {
    if (key === this.failKey) throw new Error('quota')
    super.setItem(key, value)
  }
}

describe('V11 → V12（純函式）', () => {
  it('fixture 是真的 V11：機動型、固定的進行中比賽、近期比賽有戰術摘要、沒有訓練資料', () => {
    expect(sourceVersion(v11())).toBe(11)
    expect(MIGRATABLE_VERSIONS).toContain(11)
    expect(fixtureV11.strategy.coach.style).toBe('speed')
    expect(fixtureV11.liveMatch?.matchIndex).toBe(fixtureV11.idle.nextMatchIndex)
    expect(fixtureV11.recentMatches.some((m) => 'tactics' in m)).toBe(true)
    expect('training' in fixtureV11).toBe(false)
    expect(fixtureV11.players.some((p) => 'dev' in p)).toBe(false)
  })

  it('只加上空的訓練槽：球員、等級、原生能力與特性、生涯、戰術、帳務、招募次數、聯盟、積分、固定的比賽、Replay、比賽紀錄一個字都不動', () => {
    const old = v11()
    const club = migrateToLatest(old)
    const { schemaVersion, revision, migratedFrom, training, championship: _ch, ...rest } = club
    const { schemaVersion: _s, revision: oldRevision, migratedFrom: _m, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    expect(training).toEqual({ potentialVersion: 1, active: null, recent: [] })
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 11, revision: oldRevision })
    expect(club.players.every((p) => p.dev === undefined && p.mvp === undefined)).toBe(true)
  })

  it('確定性、不改輸入；遷移完的存檔不會再遷移一次', () => {
    const old = v11()
    expect(migrateToLatest(old)).toEqual(migrateToLatest(v11()))
    expect(JSON.stringify(old)).toBe(RAW_V11)
    expect(sourceVersion(migrateToLatest(old))).toBeNull()
  })

  it('V3 → V12、V9 → V12 的完整遷移鏈：訓練槽空的、沒有養成資料', () => {
    for (const [fx, from] of [
      [fixtureV3, 3],
      [fixtureV9, 9],
    ] as const) {
      const c = migrateToLatest(structuredClone(fx))
      expect(c.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
      expect(c.migratedFrom?.schemaVersion).toBe(from)
      expect(c.training).toEqual({ potentialVersion: 1, active: null, recent: [] })
      expect(c.players.every((p) => p.dev === undefined)).toBe(true)
    }
  })

  it('V12 驗證：訓練中的球員一定在名單、項目一定能訓練、進度不超過結算場數；養成資料合法', () => {
    const club = migrateToLatest(v11())
    const p = club.players.find((r) => r.player.role === 'batter')!
    const trait = potentialPool(club.clubSeed, p.player).find((t) => trainingClass(t) === 'common' && staticTrainingBlock(club.clubSeed, p, t, 'learn') === null)!
    const good = { playerId: p.player.id, trait, kind: 'learn', progress: 0, need: TRAINING_CONFIG.common.appearances, startedAtMatch: club.idle.nextMatchIndex + 1, lastCountedMatch: null }
    const withActive = (a: object) => validateClub({ ...club, training: { ...club.training, active: { ...good, ...a } } })
    expect(withActive({}).training.active).toMatchObject({ playerId: p.player.id })
    expect(() => withActive({ playerId: 'nobody' })).toThrow(/名單/)
    expect(() => withActive({ playerId: club.players.find((r) => r.player.role === 'pitcher')!.player.id })).toThrow(/不能訓練/)
    expect(() => withActive({ need: 10 })).toThrow(/設定/)
    expect(() => withActive({ progress: 5 })).toThrow(/進度/)
    expect(() => validateClub({ ...club, training: { ...club.training, potentialVersion: 2 } })).toThrow(/potentialVersion/)
    const players = club.players.map((r) => (r === p ? { ...r, dev: { learned: ['ironArm'], removed: [] } } : r))
    expect(() => validateClub({ ...club, players })).toThrow(/dev/)
  })
})

describe('V11 → V12（打開存檔）', () => {
  it('自動遷移：原始文字逐字備份到 backup-schema11，舊的 schema10 備份不動', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V11)
    storage.setItem(CLUB_BACKUP_KEY_V10, '舊的 V10 備份')
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV11.idle.anchorMs), new FakeLockManager()))
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V11)).toBe(RAW_V11)
    expect(storage.getItem(CLUB_BACKUP_KEY_V10)).toBe('舊的 V10 備份')
    expect(value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
  })

  it('寫入失敗（備份或主存檔）時原本的 V11 存檔不變，之後可以再遷移', async () => {
    for (const failKey of [CLUB_BACKUP_KEY_V11, CLUB_STORAGE_KEY]) {
      const storage = new SpyStorage()
      storage.setItem(CLUB_STORAGE_KEY, RAW_V11)
      storage.failKey = failKey
      const deps = tab(storage, new ManualClock(fixtureV11.idle.anchorMs), new FakeLockManager())
      expect((await openClubSafely(deps).catch((e) => e)).code).toBe('write-failed')
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(RAW_V11)
      storage.failKey = null
      expect((await openClubSafely(deps)).value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    }
  })

  // Phase 9 PR 4 起遷移到 V13、會選 MVP：關掉 MVP 能力成長時跟 main（PR 3 之前）的結果一模一樣（golden 沒有重新產生）
  it('Golden：遷移後離線 8 小時結算的 96 場（比分、收益、積分、戰術摘要）與最後的帳務、聯盟、生涯，跟 main 的程式一模一樣', () => withoutMvpGrowth(async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V11)
    const clock = new ManualClock(fixtureV11.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    await openClubSafely(deps)
    clock.advance(8 * HOUR)
    const r = await settleDue(deps)
    const c = r.club
    const rows = r.settled.map((m) => [m.matchIndex, m.result.runsFor, m.result.runsAgainst, m.result.innings, m.earnedFunds, m.earnedExperience, m.ranked ? `${m.ranked.before}>${m.ranked.after}` : '-', JSON.stringify(m.tactics)].join(' '))
    expect(rows).toEqual(golden.rows)
    expect(JSON.stringify({ record: c.record, economy: c.economy, league: c.league, stats: c.stats, next: c.idle.nextMatchIndex })).toBe(golden.final)
  }))

  it('Replay 相容：固定的進行中比賽與保留的 Replay，用遷移前的資料重新模擬，比分跟戰報一致', () => {
    const club = migrateToLatest(v11())
    const plan = club.liveMatch!.plan as MatchPlan
    expect(plan).toEqual(fixtureV11.liveMatch!.plan)
    const live = runMatch(structuredClone(plan.setup), plan.ai)
    const first = golden.rows[0].split(' ')
    const other = plan.userSide === 'home' ? 'away' : 'home'
    expect([live.score[plan.userSide], live.score[other]]).toEqual([Number(first[1]), Number(first[2])])
    for (const rep of club.replays) {
      const m = club.recentMatches.find((x) => x.matchId === rep.matchId)!
      const again = runMatch(structuredClone(rep.replay.setup), rep.replay.ai)
      const side = rep.replay.setup.userSide
      expect([again.score[side], again.score[side === 'home' ? 'away' : 'home']]).toEqual([m.result.runsFor, m.result.runsAgainst])
    }
  })
})

describe('V12 讀檔：進行中的訓練跟開始訓練用同一套靜態資格（PR #22 review P2）', () => {
  const base = () => migrateToLatest(v11())
  const isPos = (t: TraitId) => TRAITS[t].tier !== 'red'
  /** 把一名打者改成指定的特性與養成資料，掛上一項訓練（所需場數照設定，進度 0） */
  const withTraining = (club: ClubSave, traits: TraitId[], dev: PlayerRecord['dev'] | undefined, trait: TraitId, kind: TrainingKind) => {
    const i = club.players.findIndex((r) => r.player.role === 'batter')
    const players = club.players.map((r, j) => (j === i ? { ...r, player: { ...r.player, traits }, ...(dev ? { dev } : {}) } : r))
    const active = { playerId: club.players[i].player.id, trait, kind, progress: 0, need: TRAINING_CONFIG[trainingClass(trait)].appearances, startedAtMatch: club.idle.nextMatchIndex + 1, lastCountedMatch: null }
    return { ...club, players, training: { ...club.training, active } }
  }
  /** 一名打者 + 他的潛能池（原生特性固定成 traits） */
  const poolOf = (club: ClubSave, traits: TraitId[]) => {
    const r = club.players.find((x) => x.player.role === 'batter')!
    return potentialPool(club.clubSeed, { ...r.player, traits } as PlayerRecord['player'])
  }
  const expectInvalid = (value: unknown, re: RegExp) => {
    expect(() => validateClub(value)).toThrow(re)
    // 讀檔也一樣拒絕（invalid-schema），而且主存檔的原文不會被改寫
    const storage = new MemoryStorage()
    const raw = JSON.stringify(value)
    storage.setItem(CLUB_STORAGE_KEY, raw)
    expect(() => new ClubRepository(storage).loadClub()).toThrow()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
  }

  it('合法的進行中訓練可以讀取：不看訓練槽與資金（動態條件只在開始時檢查）', () => {
    const club = base()
    const pool = poolOf(club, ['freeSwinger'])
    const t = pool.find((x) => isPos(x))!
    const v = withTraining(club, ['freeSwinger'], undefined, t, 'learn')
    const poor = v
    // 同一項如果「現在才要開始」會因為訓練槽被自己占用、資金不足而不行；讀檔不該因此拒絕
    const r = poor.players.find((x) => x.player.id === poor.training.active!.playerId)!
    expect(trainingBlock(poor.clubSeed, r, t, 'learn', { active: poor.training.active, assets: poor.economy.assets })).toBe('slot-busy')
    expect(trainingBlock(poor.clubSeed, r, t, 'learn', { active: null, assets: { funds: 0, experience: 0 } })).toBe('insufficient')
    expect(validateClub(poor).training.active!.trait).toBe(t)
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(poor))
    expect(new ClubRepository(storage).loadClub()!.training.active?.trait).toBe(t)
    // 改善原生的負面特性也可以
    expect(validateClub(withTraining(club, ['freeSwinger'], undefined, 'freeSwinger', 'improve')).training.active?.kind).toBe('improve')
  })

  it('不在潛能池的特性：拒絕讀取', () => {
    const club = base()
    const pool = poolOf(club, [])
    const outside = (Object.keys(TRAITS) as TraitId[]).find((t) => TRAITS[t].role === 'batter' && isPos(t) && !pool.includes(t))!
    expectInvalid(withTraining(club, [], undefined, outside, 'learn'), /not-eligible/)
  })

  it('已擁有的特性不能再學（原生或已習得）', () => {
    const club = base()
    const t = poolOf(club, [])[0]
    expectInvalid(withTraining(club, [], { learned: [t], removed: [] }, t, 'learn'), /owned/)
  })

  /** 找一個球團種子，讓這名打者（原生特性 traits）的潛能池裡有符合條件的特性 */
  const seedWhere = (club: ClubSave, traits: TraitId[], want: (t: TraitId) => boolean) => {
    const r = club.players.find((x) => x.player.role === 'batter')!
    for (let s = 1; s < 20000; s++) {
      const t = potentialPool(s, { ...r.player, traits } as PlayerRecord['player']).find(want)
      if (t) return { seed: s, trait: t }
    }
    throw new Error('找不到種子')
  }

  it('跟有效特性互斥（原生的負面特性還沒改善）：拒絕讀取；改善之後就合法', () => {
    const club = base()
    const neg: TraitId = 'errorProne'
    const { seed, trait } = seedWhere(club, [neg], (t) => isPos(t) && conflicts(t, neg))
    const v = { ...withTraining(club, [neg], undefined, trait, 'learn'), clubSeed: seed }
    expectInvalid(v, /conflict/)
    expect(validateClub({ ...withTraining(club, [neg], { learned: [], removed: [neg] }, trait, 'learn'), clubSeed: seed }).training.active?.trait).toBe(trait)
  })

  it('正面特性已達上限：拒絕讀取', () => {
    const club = base()
    const natives = (Object.keys(TRAITS) as TraitId[]).filter((t) => TRAITS[t].role === 'batter' && isPos(t))
    const three: TraitId[] = []
    for (const t of natives) if (three.length < TRAINING_RULES.maxPositive && three.every((x) => !conflicts(x, t))) three.push(t)
    expect(three).toHaveLength(3)
    const { seed, trait } = seedWhere(club, three, (t) => isPos(t) && three.every((x) => !conflicts(x, t)))
    expectInvalid({ ...withTraining(club, three, undefined, trait, 'learn'), clubSeed: seed }, /cap/)
  })

  it('負面特性不能 learn、正面特性不能 improve、非原生的負面特性不能改善', () => {
    const club = base()
    expectInvalid(withTraining(club, ['freeSwinger'], undefined, 'freeSwinger', 'learn'), /wrong-kind/)
    expectInvalid(withTraining(club, ['clutch'], undefined, 'clutch', 'improve'), /wrong-kind/)
    expectInvalid(withTraining(club, [], undefined, 'freeSwinger', 'improve'), /not-eligible/)
    expectInvalid(withTraining(club, ['freeSwinger'], { learned: [], removed: ['freeSwinger'] }, 'freeSwinger', 'improve'), /improved/)
  })
})
