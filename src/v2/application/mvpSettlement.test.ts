// @vitest-environment node
// Phase 9 PR 4：單場 MVP 的正式結算：每場一位、次數與能力成長跟比賽一起存檔；
// 離線 96 場在成長那一場切段（之前用舊能力、之後用新能力、每場只模擬一次）；跟訓練完成、降級同時發生；中斷重試；重送；多分頁；存檔失敗；資料異常
import { describe, expect, it } from 'vitest'
import type { ClubSave, SettledMatch } from '../domain/club'
import { leagueAtTier } from '../domain/league'
import { MVP_CONFIG, awardMvp, mvpBonusUnits, unpackMvp } from '../domain/mvp'
import { recordOf } from '../domain/roster'
import { effectiveTraits, trainingOptions } from '../domain/traitTraining'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, MINUTE, ManualClock, T0, atMatch, tab, withoutMvpGrowth } from '../testkit'
import type { MatchPlan } from './batchRunner'
import { createClubSafely } from './clubLifecycle'
import { freezeLiveMatch } from './liveMatch'
import { runMatch, type MatchResult } from './matchRunner'
import { SettlementError, matchesBeforePossibleChange, settleDue } from './settlementService'

type Deps = ReturnType<typeof tab>
const rich = { funds: 10_000_000, experience: 1_000_000 }

async function setup(seed = 42, storage: MemoryStorage | FlakyStorage = new MemoryStorage()) {
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, new FakeLockManager())
  await createClubSafely(deps, { clubName: 'MVP 測試', clubSeed: seed, clubId: `club-mvp-${seed}` })
  const c = deps.store.loadClub()!
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { ...rich }, earned: { ...rich } } }, c.revision)
  return { deps, clock, storage }
}
const load = (d: Deps) => d.store.loadClub()!
const save = (d: Deps, edit: (c: ClubSave) => ClubSave) => {
  const c = load(d)
  d.store.saveClub(edit(c), c.revision)
}
const setCount = (c: ClubSave, id: string, count: number): ClubSave => ({ ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, mvp: { count, grants: [] } } : r)) })
/** 用同一份存檔與時間，在另一個儲存裡關掉成長打一次：MVP 的順序（成長前的每一場都會一樣） */
async function dryRun(club: ClubSave, now: number): Promise<SettledMatch[]> {
  return withoutMvpGrowth(async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club))
    return (await settleDue(tab(storage, new ManualClock(now), new FakeLockManager()))).settled
  })
}
/** 結算並記下每一場計畫裡這位球員的能力與特性，以及每一場模擬了幾次 */
async function settleLogged(d: Deps, playerId: string, extra: Partial<NonNullable<Deps['batch']>> = {}) {
  const log: { index: number; ratings: Record<string, number>; traits: string[] }[] = []
  const simulate = (plan: MatchPlan) => {
    const r = plan.setup[plan.userSide].roster
    const p = [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].find((x) => x.id === playerId)!
    log.push({ index: plan.matchIndex, ratings: { ...(p.ratings as unknown as Record<string, number>) }, traits: [...p.traits] })
    return runMatch(plan.setup, plan.ai)
  }
  const report = await settleDue({ ...d, batch: { simulate, yieldControl: null, ...extra } })
  return { report, log }
}
const mvpIds = (s: readonly SettledMatch[]) => s.map((m) => unpackMvp(m.mvp!).playerId)
const lineupOrStarter = (c: ClubSave) => new Set([...c.roster.lineup.map((x) => x.playerId), c.roster.starter])
/**
 * 找一位先發（每場都上場）、在這批離線比賽裡「第一次得獎是第 k 場」的球員（k 從 1 數）。
 * 把他的 MVP 次數設成 9，他就會在第 k 場拿到第 10 次 → 成長；在那之前他不會得獎，所以前 k − 1 場跟關掉成長時一模一樣
 */
async function playerFirstWinningAt(d: Deps, clock: ManualClock, k: number, hours = 8) {
  clock.advance(hours * HOUR)
  const club = load(d)
  const seq = mvpIds(await dryRun(club, clock.now()))
  const regulars = lineupOrStarter(club)
  const id = seq[k - 1]
  if (!regulars.has(id) || seq.indexOf(id) !== k - 1) return null
  return { id, seq }
}

describe('每一場正式比賽都有一位 MVP', () => {
  it('勝場、敗場都有；MVP 是我方這場有出場的球員；生涯次數 = 得獎場數；舊比賽沒有', async () => {
    const { deps, clock } = await setup()
    clock.advance(8 * HOUR)
    const r = await settleDue(deps)
    const c = load(deps)
    expect(r.settled).toHaveLength(96)
    expect(r.settled.some((m) => m.result.won) && r.settled.some((m) => !m.result.won)).toBe(true)
    for (const m of r.settled) {
      const mvp = unpackMvp(m.mvp!)
      const rows = mvp.role === 'batter' ? m.lines!.bat : m.lines!.pit
      expect(rows.some((x) => x[0] === mvp.playerId)).toBe(true)
      expect(recordOf(c, mvp.playerId)).toBeDefined()
    }
    const total = c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)
    expect(total).toBe(96)
    // 打者、投手都有得獎
    const roles = new Set(r.settled.map((m) => unpackMvp(m.mvp!).role))
    expect(roles).toEqual(new Set(['batter', 'pitcher']))
  })

  it('確定性：同一份存檔、同一個時間，MVP 與成長一模一樣（不用時間、不用 Math.random）', async () => {
    const runs = await Promise.all([1, 2].map(async () => {
      const { deps, clock } = await setup(7)
      clock.advance(8 * HOUR)
      await settleDue(deps)
      clock.advance(8 * HOUR)
      await settleDue(deps)
      const c = load(deps)
      return { mvps: c.recentMatches.map((m) => m.mvp), players: c.players.map((p) => p.mvp ?? null) }
    }))
    expect(runs[0]).toEqual(runs[1])
  })

  it('晉級挑戰賽不發 MVP、觀看 Replay 不發 MVP（只有正式一般比賽的結算會記）', async () => {
    // 挑戰：leagueService.test.ts 的「挑戰成功」驗證了 players 完全不變；這裡確認 Replay 重播不會改存檔
    const { deps, clock } = await setup()
    clock.advance(2 * HOUR)
    await settleDue(deps)
    const before = JSON.stringify(load(deps))
    const rep = load(deps).replays[0]
    runMatch(structuredClone(rep.replay.setup), rep.replay.ai)
    expect(JSON.stringify(load(deps))).toBe(before)
  })
})

describe('離線 96 場：成長那一場切段', () => {
  it('9 次 MVP 的球員在離線第 5 場拿到第 10 次：第 1～5 場用原能力、第 6 場起用新能力；每場只模擬一次；前 5 場跟關掉成長時一模一樣', async () => {
    let found: Awaited<ReturnType<typeof playerFirstWinningAt>> = null
    let env: Awaited<ReturnType<typeof setup>> | null = null
    for (let seed = 1; seed < 60 && !found; seed++) {
      env = await setup(seed)
      found = await playerFirstWinningAt(env.deps, env.clock, 5)
    }
    expect(found).not.toBeNull()
    const { deps } = env!
    const { id, seq } = found!
    save(deps, (c) => setCount(c, id, 9))
    const first = load(deps).idle.nextMatchIndex
    // 一定不會在第 5 場之前成長：最快 1 場（他已經 9 次）；其他人都是 0 次、最快 10 場
    expect(matchesBeforePossibleChange(load(deps))).toBe(1)
    const { report, log } = await settleLogged(deps, id)
    const c = load(deps)
    expect(report.settled).toHaveLength(96)
    expect(log.map((x) => x.index)).toEqual(Array.from({ length: 96 }, (_, i) => first + i))
    // 前 5 場：MVP 跟關掉成長時相同
    expect(mvpIds(report.settled).slice(0, 5)).toEqual(seq.slice(0, 5))
    const grow = unpackMvp(report.settled[4].mvp!)
    expect(grow).toMatchObject({ playerId: id, count: 10 })
    expect(grow.growth).not.toBeNull()
    const k = grow.growth!
    const rec = recordOf(c, id)!
    expect(rec.mvp!.grants[0]).toEqual({ rating: k, atMatch: first + 4 })
    // 第 1～5 場同一個能力；第 6 場起 +0.1（直到這批可能還有別的成長）
    const before = log[0].ratings[k]
    for (const x of log.slice(0, 5)) expect(x.ratings[k]).toBe(before)
    expect(log[5].ratings[k]).toBeCloseTo(Math.min(10, before + 0.1), 6)
    // 次數：每場只記一次，總數 = 96 ＋ 原本的 9
    expect(c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(96 + 9)
    expect(c.stats.throughMatch).toBe(c.idle.nextMatchIndex)
    // 重送（同一時間再結算）：不會再發 MVP
    expect((await settleDue(deps)).settled).toEqual([])
    expect(JSON.stringify(load(deps).players)).toBe(JSON.stringify(c.players))
  })

  it('MVP 成長與特性訓練在同一場完成：兩種都生效、都從下一場起，一種都不會遺失；之前的場次不受影響', async () => {
    // 找一位先發：這批離線第 k 場第一次得獎、而且有特性可以學。把他設成 9 次 MVP、訓練差 k 場（他每場都上場），兩件事都在第 k 場發生
    let pick: { deps: Deps; clock: ManualClock; id: string; k: number; trait: string; seq: string[] } | null = null
    for (let seed = 1; seed < 60 && !pick; seed++) {
      const { deps, clock } = await setup(seed)
      save(deps, (c) => ({ ...c, ...atMatch(c, 700) }))
      clock.advance(8 * HOUR)
      const club = load(deps)
      const seq = mvpIds(await dryRun(club, clock.now()))
      for (let k = 3; k <= 12 && !pick; k++) {
        const id = seq[k - 1]
        if (!lineupOrStarter(club).has(id) || seq.indexOf(id) !== k - 1) continue
        const o = trainingOptions(club.clubSeed, recordOf(club, id)!, { active: null, assets: rich }).find((x) => x.kind === 'learn' && x.block === null)
        if (o) pick = { deps, clock, id, k, trait: o.trait, seq }
      }
    }
    expect(pick).not.toBeNull()
    const { deps, id, k, trait, seq } = pick!
    const need = trainingOptions(load(deps).clubSeed, recordOf(load(deps), id)!, { active: null, assets: rich }).find((x) => x.trait === trait)!.need
    save(deps, (c) => {
      const next = c.idle.nextMatchIndex
      const progress = need - k
      return setCount({ ...c, training: { ...c.training, active: { playerId: id, trait: trait as never, kind: 'learn', progress, need, startedAtMatch: next - progress, lastCountedMatch: next - 1 } } }, id, 9)
    })
    const first = load(deps).idle.nextMatchIndex
    const { report, log } = await settleLogged(deps, id)
    const c = load(deps)
    expect(report.settled).toHaveLength(96)
    expect(log.map((x) => x.index)).toEqual(Array.from({ length: 96 }, (_, i) => first + i))
    expect(mvpIds(report.settled).slice(0, k)).toEqual(seq.slice(0, k))
    const at = first + k - 1
    const grow = unpackMvp(report.settled[k - 1].mvp!)
    expect(grow).toMatchObject({ playerId: id, count: 10 })
    expect(c.training.recent.at(-1)).toMatchObject({ playerId: id, trait, completedAtMatch: at, effectiveFromMatch: at + 1 })
    expect(recordOf(c, id)!.mvp!.grants[0]).toEqual({ rating: grow.growth, atMatch: at })
    expect(effectiveTraits(recordOf(c, id)!)).toContain(trait)
    const r0 = log[0].ratings[grow.growth!]
    for (const x of log) {
      const after = x.index > at
      expect(x.traits.includes(trait)).toBe(after)
      if (x.index <= at) expect(x.ratings[grow.growth!]).toBe(r0)
    }
    expect(log.find((x) => x.index === at + 1)!.ratings[grow.growth!]).toBeCloseTo(Math.min(10, r0 + 0.1), 6)
    expect(c.stats.throughMatch).toBe(c.idle.nextMatchIndex)
  })

  it('MVP 成長與聯盟降級在同一批：兩者都套用、各自從下一場起；降級後的比賽用新聯盟規劃，每場只記一次', async () => {
    const { deps, clock } = await setup(6)
    save(deps, (c) => ({ ...c, ...atMatch(c, 800), league: { ...leagueAtTier(c.league, 4), points: 6, protectionRemaining: 0 }, players: c.players.map((r) => ({ ...r, mvp: { count: 9, grants: [] } })) }))
    clock.advance(8 * HOUR)
    const r = await settleDue(deps)
    const c = load(deps)
    expect(r.settled).toHaveLength(96)
    expect(new Set(r.settled.map((m) => m.matchIndex)).size).toBe(96)
    expect(c.league.relegations).toBeGreaterThan(0)
    const relegatedAt = r.settled.find((m) => m.ranked?.relegatedTo != null)!.matchIndex
    // 降級之後的比賽是新聯盟的
    for (const m of r.settled) expect(m.result.leagueTier).toBe(m.matchIndex <= relegatedAt ? 4 : 3)
    const grants = c.players.flatMap((p) => (p.mvp?.grants ?? []).map((g) => ({ id: p.player.id, ...g })))
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) expect(unpackMvp(r.settled.find((m) => m.matchIndex === g.atMatch)!.mvp!)).toMatchObject({ playerId: g.id, growth: g.rating })
    expect(c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(9 * c.players.length + 96)
    expect(c.stats.throughMatch).toBe(c.idle.nextMatchIndex)
  })

  it('MVP 成長、訓練完成、降級在同一批離線比賽：三種都套用、各自從下一場起；每場只記一次', async () => {
    const { deps, clock } = await setup(5)
    // 傳奇聯盟、積分很低：很快就可能降級；第一棒差 4 場完成訓練；全隊都已經 9 次 MVP（第一場就會有人成長）
    save(deps, (c) => {
      const lead = c.roster.lineup[0].playerId
      const o = trainingOptions(c.clubSeed, recordOf(c, lead)!, { active: null, assets: rich }).find((x) => x.kind === 'learn' && x.block === null)!
      const n = { ...c, ...atMatch(c, 800), league: { ...leagueAtTier(c.league, 4), points: 6, protectionRemaining: 0 } }
      const next = 800
      const players = n.players.map((r) => ({ ...r, mvp: { count: 9, grants: [] } }))
      return { ...n, players, training: { ...n.training, active: { playerId: lead, trait: o.trait, kind: 'learn', progress: o.need - 4, need: o.need, startedAtMatch: next - (o.need - 4), lastCountedMatch: next - 1 } } }
    })
    expect(matchesBeforePossibleChange(load(deps))).toBe(1)
    clock.advance(8 * HOUR)
    const lead = load(deps).roster.lineup[0].playerId
    const { report, log } = await settleLogged(deps, lead)
    const c = load(deps)
    expect(report.settled).toHaveLength(96)
    expect(new Set(log.map((x) => x.index)).size).toBe(96)
    // 每場一位 MVP，次數 = 9 × 人數 ＋ 96
    expect(c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(9 * c.players.length + 96)
    // 成長：每一筆都對應到那一場的 MVP，而且是第 10 的倍數那一次
    const grants = c.players.flatMap((p) => (p.mvp?.grants ?? []).map((g) => ({ id: p.player.id, ...g })))
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) {
      const m = report.settled.find((x) => x.matchIndex === g.atMatch)!
      expect(unpackMvp(m.mvp!)).toMatchObject({ playerId: g.id, growth: g.rating })
      expect(unpackMvp(m.mvp!).count % MVP_CONFIG.perGrowth).toBe(0)
    }
    expect(c.training.recent.at(-1)!.completedAtMatch).toBe(803)
    expect(c.league.relegations).toBeGreaterThan(0)
    expect(c.stats.throughMatch).toBe(c.idle.nextMatchIndex)
    // 第一棒：訓練完成（第 4 場）之後才有新特性
    const trait = c.training.recent.at(-1)!.trait
    for (const x of log) expect(x.traits.includes(trait)).toBe(x.index > 803)
  })
})

describe('第 20、30、40 次 MVP（上限 +0.3）', () => {
  /**
   * 全隊都已經拿過 10n 次 MVP（照正式規則成長 n 次，場次在結算游標之前），再 10 次才會成長；
   * 找一位先發在這批第 5 場第一次得獎，把他設成 10n + 9 次：他一定在第 5 場拿到第 10n + 10 次
   */
  async function nthGrowthAt(n: number) {
    for (let seed = 1; seed < 60; seed++) {
      const { deps, clock } = await setup(seed)
      save(deps, (c) => {
        const base = { ...c, ...atMatch(c, 700) }
        return { ...base, players: base.players.map((r) => {
          let x = r
          for (let i = 0; i < 10 * n; i++) x = awardMvp(x, 600 + i).record
          return x
        }) }
      })
      clock.advance(8 * HOUR)
      const club = load(deps)
      const seq = mvpIds(await dryRun(club, clock.now()))
      const id = seq[4]
      if (!lineupOrStarter(club).has(id) || seq.indexOf(id) !== 4) continue
      save(deps, (c) => ({ ...c, players: c.players.map((r) => (r.player.id === id ? { ...r, mvp: { ...r.mvp!, count: 10 * n + 9 } } : r)) }))
      return { deps, id, seq }
    }
    throw new Error('找不到種子')
  }

  for (const n of [1, 2]) {
    it(`第 ${10 * n + 10} 次 MVP：成長到 +0.${n + 1}，第 5 場用舊能力、第 6 場起生效`, async () => {
      const { deps, id, seq } = await nthGrowthAt(n)
      const first = load(deps).idle.nextMatchIndex
      const units0 = recordOf(load(deps), id)!.mvp!.grants.length
      expect(units0).toBe(n)
      const { report, log } = await settleLogged(deps, id)
      const c = load(deps)
      expect(report.settled).toHaveLength(96)
      expect(log.map((x) => x.index)).toEqual(Array.from({ length: 96 }, (_, i) => first + i))
      expect(mvpIds(report.settled).slice(0, 5)).toEqual(seq.slice(0, 5))
      const grow = unpackMvp(report.settled[4].mvp!)
      expect(grow).toMatchObject({ playerId: id, count: 10 * n + 10 })
      const k = grow.growth!
      expect(k).not.toBeNull()
      const rec = recordOf(c, id)!
      expect(rec.mvp!.grants).toHaveLength(n + 1)
      expect(rec.mvp!.grants[n]).toEqual({ rating: k, atMatch: first + 4 })
      const before = log[0].ratings[k]
      for (const x of log.slice(0, 5)) expect(x.ratings[k]).toBe(before)
      expect(log[5].ratings[k]).toBeCloseTo(Math.min(10, before + 0.1), 6)
      expect(c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(10 * n * c.players.length + 9 + 96)
      expect((await settleDue(deps)).settled).toEqual([])
    })
  }

  it('第 40 次 MVP（已達 +0.3）：次數照樣累加、不再提升能力、也不需要因為成長而切段', async () => {
    const { deps, id } = await nthGrowthAt(3)
    expect(recordOf(load(deps), id)!.mvp!.grants).toHaveLength(MVP_CONFIG.maxUnits)
    // 全隊都已經到上限：MVP 不會讓任何人成長，上限是 Infinity（新秀聯盟不會降級、沒有訓練）
    expect(matchesBeforePossibleChange(load(deps))).toBe(Infinity)
    const ratingsBefore = { ...(recordOf(load(deps), id)!.player.ratings as unknown as Record<string, number>) }
    const { report, log } = await settleLogged(deps, id)
    const c = load(deps)
    expect(report.settled).toHaveLength(96)
    expect(report.segments).toBe(1)
    expect(unpackMvp(report.settled[4].mvp!)).toMatchObject({ playerId: id, count: 40, growth: null })
    expect(report.settled.every((m) => unpackMvp(m.mvp!).growth === null)).toBe(true)
    // 能力從頭到尾一樣；紀錄還是 3 筆
    for (const x of log) expect(x.ratings).toEqual(log[0].ratings)
    expect(recordOf(c, id)!.mvp!.grants).toHaveLength(3)
    expect(recordOf(c, id)!.player.ratings).toEqual(ratingsBefore)
    expect(recordOf(c, id)!.mvp!.count).toBeGreaterThanOrEqual(40)
    expect(c.players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(30 * c.players.length + 9 + 96)
  })
})

describe('中斷、重送、多分頁、存檔失敗、資料異常', () => {
  it('批次中斷後重試：已經結算的保留（含 MVP 與成長），接著打的結果跟一次打完相同', async () => {
    const runs: unknown[] = []
    for (const interrupt of [false, true]) {
      const { deps, clock } = await setup(9)
      save(deps, (c) => ({ ...c, players: c.players.map((r) => ({ ...r, mvp: { count: 8, grants: [] } })) }))
      clock.advance(8 * HOUR)
      if (interrupt) {
        const ctl = new AbortController()
        let n = 0
        const simulate = (plan: MatchPlan) => {
          if (++n === 7) ctl.abort()
          return runMatch(plan.setup, plan.ai)
        }
        const partial = await settleDue({ ...deps, batch: { simulate, yieldControl: null, chunkSize: 1 } }, { signal: ctl.signal })
        expect(partial.status).toBe('aborted')
        expect(load(deps).players.reduce((a, p) => a + (p.mvp?.count ?? 0), 0)).toBe(8 * load(deps).players.length + partial.settled.length)
      }
      await settleDue(deps)
      const c = load(deps)
      runs.push({ players: c.players, matches: c.recentMatches.map((m) => [m.matchIndex, m.result.runsFor, m.result.runsAgainst, m.mvp]), stats: c.stats })
    }
    expect(runs[1]).toEqual(runs[0])
  })

  it('兩個分頁同時結算：MVP 次數與成長只記一次', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock(T0)
    const locks = new FakeLockManager()
    const a = tab(storage, clock, locks)
    const b = tab(storage, clock, locks)
    await createClubSafely(a, { clubName: '兩個分頁', clubSeed: 11, clubId: 'two-tabs' })
    clock.advance(8 * HOUR)
    await Promise.all([settleDue(a), settleDue(b)])
    const c = a.store.loadClub()!
    expect(c.idle.nextMatchIndex).toBe(96)
    expect(c.players.reduce((x, p) => x + (p.mvp?.count ?? 0), 0)).toBe(96)
  })

  it('存檔寫入失敗：比賽、MVP 次數、能力成長全部沒有存（不會只有成長成功）；之後可以重試，結果相同', async () => {
    const flaky = new FlakyStorage()
    const { deps, clock } = await setup(13, flaky)
    save(deps, (c) => ({ ...c, players: c.players.map((r) => ({ ...r, mvp: { count: 9, grants: [] } })) }))
    const raw = flaky.getItem(CLUB_STORAGE_KEY)
    clock.advance(8 * HOUR)
    flaky.failWrites = true
    await expect(settleDue(deps)).rejects.toThrow()
    expect(flaky.getItem(CLUB_STORAGE_KEY)).toBe(raw)
    flaky.failWrites = false
    const r = await settleDue(deps)
    expect(r.settled).toHaveLength(96)
    expect(load(deps).players.some((p) => (p.mvp?.grants.length ?? 0) > 0)).toBe(true)
  })

  it('正式新比賽沒有我方球員數據（資料異常）：明確丟錯、整批不記，不默默指定第一位球員', async () => {
    const { deps, clock, storage } = await setup(15)
    const raw = storage.getItem(CLUB_STORAGE_KEY)
    clock.advance(1 * HOUR)
    const simulate = (plan: MatchPlan): MatchResult => {
      const r = runMatch(plan.setup, plan.ai)
      return { ...r, players: r.players.filter((p) => p.side !== plan.userSide) }
    }
    const error = await settleDue({ ...deps, batch: { simulate, yieldControl: null } }).catch((e) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect(error.code).toBe('invalid-result')
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
  })
})

describe('固定的進行中比賽', () => {
  it('在固定的那一場成長：那一場用開賽時的計畫（舊能力），下一場起才用新能力', async () => {
    let pick: { deps: Deps; clock: ManualClock; id: string } | null = null
    for (let seed = 1; seed < 40 && !pick; seed++) {
      const { deps, clock } = await setup(seed)
      clock.advance(2 * HOUR)
      await settleDue(deps)
      // 固定進行中的那一場（任何支出操作都會這樣做）
      save(deps, (c) => freezeLiveMatch(c))
      const live = load(deps).liveMatch!
      clock.advance(1 * HOUR)
      const seq = mvpIds(await dryRun(load(deps), clock.now()))
      if (lineupOrStarter(load(deps)).has(seq[0])) pick = { deps, clock, id: seq[0] }
      void live
    }
    expect(pick).not.toBeNull()
    const { deps, id } = pick!
    save(deps, (c) => setCount(c, id, 9))
    const live = load(deps).liveMatch!
    const { report, log } = await settleLogged(deps, id)
    const grow = unpackMvp(report.settled[0].mvp!)
    expect(report.settled[0].matchIndex).toBe(live.matchIndex)
    expect(grow).toMatchObject({ playerId: id, count: 10 })
    const k = grow.growth!
    const frozen = [...live.plan.setup[live.plan.userSide].roster.lineup.map((s) => s.player), live.plan.setup[live.plan.userSide].roster.starter].find((p) => p.id === id)!
    expect(log[0].ratings[k]).toBe((frozen.ratings as unknown as Record<string, number>)[k])
    expect(log[1].ratings[k]).toBeCloseTo(Math.min(10, log[0].ratings[k] + 0.1), 6)
    expect(load(deps).liveMatch).toBeNull()
    expect(mvpBonusUnits(recordOf(load(deps), id)!)).toEqual({ [k]: 1 })
  })
})

void MINUTE
