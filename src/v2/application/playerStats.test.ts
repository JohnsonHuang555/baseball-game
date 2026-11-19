// @vitest-environment node
// Phase 8：正式結算流程裡的球員數據（生涯、近期視窗、冪等、多分頁、中斷、降級、升級、換陣容、釋出、舊存檔）
import { describe, expect, it } from 'vitest'
import golden from './__golden__/club-golden.json'
import { GOLDEN_CLUBS, clubGolden } from './__golden__/clubGolden'
import { type ClubSave, type SettledMatch } from '../domain/club'
import { leagueAtTier } from '../domain/league'
import { battingRates, careerTotals, pitchingRates, totalsByPlayer, type Totals } from '../domain/stats'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../testkit'
import { runMatch } from './matchRunner'
import { planMatches } from './batchRunner'
import { releasePlayer, upgrade } from './economyService'
import { leaderboard, periodTotals, playerStats } from './statsQuery'
import { applySettingsChange, settleDue, settleOutcomes } from './settlementService'

type Deps = ReturnType<typeof tab>

async function setup(edit: (c: ClubSave) => ClubSave = (c) => c, storage = new MemoryStorage(), locks: FakeLockManager | undefined = new FakeLockManager()) {
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, locks)
  const c0 = deps.store.createClub({ clubName: '數據測試', clubSeed: 808, clubId: 'club-stats', now: T0 })
  deps.store.saveClub(edit(c0), c0.revision)
  return { storage, clock, deps, locks }
}
const load = (d: Deps) => d.store.loadClub()!

/** 生涯 = 所有已結算比賽的 lines 加總（每一場只算一次） */
function expectCareerMatches(club: ClubSave, settled: readonly SettledMatch[]): void {
  const sums = totalsByPlayer(settled)
  expect(Object.keys(club.stats.players).sort()).toEqual([...sums.keys()].sort())
  for (const [id, rec] of Object.entries(club.stats.players)) expect(careerTotals(rec)).toEqual(sums.get(id))
  expect(club.stats.throughMatch).toBe(club.idle.nextMatchIndex)
}

describe('Golden：加入球員數據後，勝負、收益、競技積分與降級完全不變', () => {
  it.each(GOLDEN_CLUBS.map((c) => [`c${c[0]}-t${c[1]}`, c] as const))('%s', async (id, [seed, tier, n]) => {
    expect(await clubGolden(seed, tier, n)).toEqual((golden as Record<string, unknown>)[id])
  })
})

describe('生涯數據只在正式結算時累積，同一場只算一次', () => {
  it('連續 96 場離線結算：生涯 = 每場加總；每場的打擊、投球都對得起比分', async () => {
    const { deps, clock } = await setup()
    clock.advance(8 * HOUR)
    const report = await settleDue(deps)
    expect(report.settled).toHaveLength(96)
    const c = load(deps)
    expectCareerMatches(c, report.settled)
    for (const m of report.settled) {
      const t = totalsByPlayer([m])
      let runs = 0
      let hits = 0
      let allowed = 0
      for (const x of t.values()) {
        runs += x.bat.r
        hits += x.bat.h
        allowed += x.pit.r
        expect(x.pit.er).toBeLessThanOrEqual(x.pit.r)
        expect(x.bat.pa).toBe(x.bat.ab + x.bat.bb + x.bat.hbp + x.bat.sf + x.bat.sh)
      }
      expect(runs).toBe(m.result.runsFor)
      expect(allowed).toBe(m.result.runsAgainst)
      const side = m.result.userSide
      expect(hits).toBe(m.box!.hits[side])
      // 新格式：Box Score 不再重複存名字陣列
      expect(m.box!.batters).toEqual([])
    }
  })

  it('重送同一批結果：略過已結算的場次，生涯不會加兩次', async () => {
    const { deps, clock } = await setup()
    clock.advance(HOUR)
    const report = await settleDue(deps)
    const c = load(deps)
    const again = settleOutcomes(c, [], T0)
    expect(again.club.stats).toEqual(c.stats)
    // 直接把同一場的結果再送一次（例如舊分頁重送）
    const plan = planMatches({ ...c, idle: { ...c.idle, nextMatchIndex: report.settled[0].matchIndex } }, report.settled[0].matchIndex, 1)[0]
    const dup = settleOutcomes(c, [{ plan, result: runMatch(plan.setup, plan.ai) }], T0)
    expect(dup.duplicates).toBe(1)
    expect(dup.club.stats).toEqual(c.stats)
  })

  it('中斷後恢復：分兩次結算（中間換一個分頁）跟一次結算完全一樣', async () => {
    const once = await setup()
    once.clock.advance(4 * HOUR)
    await settleDue(once.deps)

    const split = await setup()
    split.clock.advance(HOUR)
    const first = await settleDue(split.deps)
    split.clock.advance(3 * HOUR)
    const second = await settleDue(tab(split.storage, split.clock, split.locks))
    expect(first.settled.length + second.settled.length).toBe(48)
    expect(load(split.deps).stats).toEqual(load(once.deps).stats)
    expectCareerMatches(load(split.deps), [...first.settled, ...second.settled])
  })

  it('多個分頁同時結算：只算一次', async () => {
    const shared = await setup()
    shared.clock.advance(2 * HOUR)
    const tabs = [shared.deps, tab(shared.storage, shared.clock, shared.locks), tab(shared.storage, shared.clock, shared.locks)]
    const reports = await Promise.all(tabs.map((t) => settleDue(t)))
    const settled = reports.flatMap((r) => r.settled)
    expect(settled).toHaveLength(24)
    expectCareerMatches(load(shared.deps), settled)
  })

  it('離線結算中途降級：降級前後的比賽都照樣累積，沒有漏掉或重複', async () => {
    const weak = (c: ClubSave): ClubSave => ({
      ...c,
      league: leagueAtTier(c.league, 4, { points: 6 }),
      players: c.players.map((r) => ({ ...r, player: { ...r.player, ratings: Object.fromEntries(Object.keys(r.player.ratings).map((k) => [k, 1])) } as unknown as typeof r.player })),
    })
    const { deps, clock } = await setup(weak)
    clock.advance(8 * HOUR)
    const report = await settleDue(deps)
    const c = load(deps)
    expect(c.league.relegations).toBeGreaterThan(0)
    expect(report.settled).toHaveLength(96)
    expectCareerMatches(c, report.settled)
  })

  it('升級、換陣容：同一個 playerId 的數據繼續累積，不重置', async () => {
    const { deps, clock } = await setup((c) => ({ ...c, economy: { ...c.economy, assets: { funds: 1e6, experience: 1e5 }, earned: { funds: 1e6, experience: 1e5 } } }))
    clock.advance(HOUR)
    const a = await settleDue(deps)
    const before = load(deps)
    const star = before.roster.lineup[0].playerId
    await upgrade(deps, { opSeq: before.economy.nextOpSeq, playerId: star, expectedLevel: 1 })
    // 把板凳第一位換上第九棒
    const c1 = load(deps)
    const benchIn = c1.roster.bench[0]
    const out = c1.roster.lineup[8].playerId
    const roster = { ...c1.roster, lineup: c1.roster.lineup.map((s, i) => (i === 8 ? { ...s, playerId: benchIn } : s)), bench: [out, ...c1.roster.bench.slice(1)] }
    let changed: ClubSave | null = null
    try {
      changed = applySettingsChange(c1, { roster })
    } catch {
      changed = null
    }
    if (changed) deps.store.saveClub(changed, c1.revision)
    clock.advance(HOUR)
    const b = await settleDue(deps)
    const c = load(deps)
    expect(c.players.find((p) => p.player.id === star)!.level).toBe(2)
    expectCareerMatches(c, [...a.settled, ...b.settled])
    expect(c.stats.players[star].bg).toBe(a.settled.length + b.settled.length)
  })

  it('釋出：生涯紀錄留著（唯讀），最近戰報與詳情仍找得到名字；排行只列在隊上的球員', async () => {
    const { deps, clock } = await setup()
    clock.advance(HOUR)
    await settleDue(deps)
    const c = load(deps)
    // 把板凳第一位移出陣容（變成預備）再釋出
    const id = c.roster.lineup[8].playerId
    const swapIn = c.roster.bench[0]
    const reserve: ClubSave = { ...c, roster: { ...c.roster, lineup: c.roster.lineup.map((s, i) => (i === 8 ? { ...s, playerId: swapIn } : s)), bench: c.roster.bench.slice(1) } }
    const out = releasePlayer(reserve, { opSeq: reserve.economy.nextOpSeq, playerId: id }, T0)
    const r = out.club
    expect(r.players.some((p) => p.player.id === id)).toBe(false)
    expect(r.stats.players[id]).toMatchObject({ releasedAt: r.idle.nextMatchIndex })
    expect(careerTotals(r.stats.players[id])).toEqual(careerTotals(c.stats.players[id]))
    const view = playerStats(r, id, 'career')!
    expect(view).toMatchObject({ status: 'released', name: c.players.find((p) => p.player.id === id)!.player.name })
    expect(leaderboard(r, 'batter', 'career', 'ops').ranked.some((x) => x.playerId === id)).toBe(false)
  })
})

describe('期間：最近 10／30 場與生涯', () => {
  it('視窗是球團最近的 10／30 場；沒上場的比賽不增加 G、PA、IP，但仍佔視窗', async () => {
    const { deps, clock } = await setup()
    clock.advance(4 * HOUR)
    await settleDue(deps)
    const c = load(deps)
    const p10 = periodTotals(c, 'last10')
    const p30 = periodTotals(c, 'last30')
    expect(p10.info).toMatchObject({ matches: 10, recorded: 10, fromMatch: 38, toMatch: 47 })
    expect(p30.info).toMatchObject({ matches: 30, recorded: 30, fromMatch: 18, toMatch: 47 })
    expect(periodTotals(c, 'career').info).toMatchObject({ matches: 48, recorded: 48, fromMatch: 0, sinceMatch: 0 })
    // 先發打者每場都上；投手輪不到的場次 gp 不增加
    const starterBatter = c.roster.lineup[0].playerId
    expect(p10.byPlayer.get(starterBatter)!.g).toBe(10)
    for (const t of p10.byPlayer.values()) {
      expect(t.g).toBeLessThanOrEqual(10)
      expect(t.gp).toBeLessThanOrEqual(10)
    }
    const reliever = c.roster.relievers.at(-1)!
    const rel: Totals | undefined = p30.byPlayer.get(reliever)
    if (rel) expect(rel.gp).toBeLessThan(30)
  })

  it('近期與生涯共用同一組公式：只有一段期間時兩者相等', async () => {
    const { deps, clock } = await setup()
    clock.advance(HOUR / 2)
    await settleDue(deps)
    const c = load(deps)
    expect(c.idle.nextMatchIndex).toBeLessThanOrEqual(10)
    const last10 = periodTotals(c, 'last10').byPlayer
    const career = periodTotals(c, 'career').byPlayer
    for (const [id, t] of career) {
      expect(last10.get(id)).toEqual(t)
      expect(battingRates(last10.get(id)!.bat)).toEqual(battingRates(t.bat))
      expect(pitchingRates(last10.get(id)!.pit)).toEqual(pitchingRates(t.pit))
    }
  })
})

describe('排行', () => {
  it('ERA、WHIP 越低越前面；樣本不足與沒出場的不會因為 0 排第一', async () => {
    const { deps, clock } = await setup()
    clock.advance(HOUR)
    await settleDue(deps)
    const c = load(deps)
    const era = leaderboard(c, 'pitcher', 'last10', 'era')
    const values = era.ranked.map((r) => pitchingRates(r.totals.pit).era!)
    expect(values).toEqual([...values].sort((a, b) => a - b))
    for (const r of era.ranked) expect(r.totals.pit.outs).toBeGreaterThanOrEqual(30)
    for (const r of [...era.smallSample, ...era.none]) expect(era.ranked).not.toContain(r)
    const ops = leaderboard(c, 'batter', 'last10', 'ops')
    const opsValues = ops.ranked.map((r) => battingRates(r.totals.bat).ops!)
    expect(opsValues).toEqual([...opsValues].sort((a, b) => b - a))
    // 沒出場的板凳（全部 0）在最後
    for (const r of ops.none) expect(r.totals.bat.pa).toBe(0)
    const hr = leaderboard(c, 'batter', 'last10', 'hr')
    expect(hr.smallSample).toEqual([])
    expect(hr.ranked.map((r) => r.totals.bat.hr)).toEqual(hr.ranked.map((r) => r.totals.bat.hr).sort((a, b) => b - a))
  })

  it('還沒有任何比賽：全部都在「沒出場」', async () => {
    const { deps } = await setup()
    const c = load(deps)
    const b = leaderboard(c, 'batter', 'career', 'ops')
    expect(b.ranked).toEqual([])
    expect(b.none.length).toBe(c.players.filter((p) => p.player.role === 'batter').length)
    expect(periodTotals(c, 'last10').info).toMatchObject({ matches: 0, fromMatch: null })
  })
})
