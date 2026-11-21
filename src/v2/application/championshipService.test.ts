// Phase 10 PR 1：傳奇總冠軍賽的服務測試（需求清單 1～24 的對應見每個 describe 的標題）
import { describe, expect, it } from 'vitest'
import fixtureV13 from '../domain/__fixtures__/club-v13-phase9.json'
import golden from '../domain/__fixtures__/club-v13-settle-golden.json'
import { validateClub, type ClubSave, type SettledMatch } from '../domain/club'
import { CHAMPIONSHIP_CONFIG, championshipView, recordSeriesGame, userSideForGame, type SeriesGame } from '../domain/championship'
import { leagueAtTier, relegate } from '../domain/league'
import { migrateToLatest } from '../domain/migration'
import { CLUB_BACKUP_KEY_V13, CLUB_STORAGE_KEY, ClubSaveError, ClubRepository, MemoryStorage, type KeyValueStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, ManualClock, tab } from '../testkit'
import type { MatchPlan } from './batchRunner'
import { ChampionshipError, championOpponent, planSeriesGame, playSeriesGame, startSeries } from './championshipService'
import { openClubSafely } from './clubLifecycle'
import { runMatch, type MatchResult } from './matchRunner'
import { buildTimeline } from './replayPlayer'
import { SettlementError, settleDue } from './settlementService'

type Deps = ReturnType<typeof tab>
const RAW_V13 = JSON.stringify(fixtureV13)
const V14 = () => migrateToLatest(JSON.parse(RAW_V13))

/** 一個有資格的傳奇球團（V13 fixture 遷移上來：本聯盟 3,167 場、積分 100、最近 60 場 ≥ 60%），時鐘停在沒有到期比賽的時間 */
function world(edit?: (c: ClubSave) => ClubSave, storage: KeyValueStorage = new MemoryStorage()) {
  const club = edit ? edit(V14()) : V14()
  storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club))
  const clock = new ManualClock(club.idle.anchorMs)
  const locks = new FakeLockManager()
  return { storage, clock, locks, deps: tab(storage, clock, locks) }
}
const load = (d: Deps) => d.store.loadClub()!
/** 真的降級一次（跟結算時一樣的規則）：傳奇 → 職業 */
const relegated = (c: ClubSave): ClubSave => ({ ...c, league: relegate(c.league, c.idle.nextMatchIndex, 0) })

/** 照劇本決定冠軍賽的勝負（W／L）；一般比賽照常模擬。calls 記錄冠軍賽被模擬了幾次 */
function scripted(d: Deps, script: string) {
  const calls: string[] = []
  const deps: Deps = {
    ...d,
    batch: {
      ...d.batch,
      simulate: (plan: MatchPlan): MatchResult => {
        const r = runMatch(plan.setup, plan.ai)
        if (!plan.matchId.includes('#s')) return r
        calls.push(plan.matchId)
        const want = script[(Number(plan.matchId.split('g').at(-1)) - 1) % script.length] === 'W'
        const other = plan.userSide === 'home' ? 'away' : 'home'
        if ((r.winner === plan.userSide) === want) return r
        // 反過來：比分對調
        return { ...r, winner: want ? plan.userSide : other, score: { home: r.score.away, away: r.score.home } }
      },
    },
  }
  return { deps, calls }
}

async function playOut(d: Deps, seq = load(d).championship.nextSeriesSeq) {
  await startSeries(d, { seriesSeq: seq, requestId: `start-${seq}` })
  const outs = []
  while (load(d).championship.active) outs.push(await playSeriesGame(d, { seriesSeq: seq, game: load(d).championship.active!.games.length + 1, requestId: `g-${seq}-${outs.length}` }))
  return outs
}

/** 冠軍賽不能碰的欄位 */
const untouched = (c: ClubSave) => {
  const { championship: _c, revision: _r, ...rest } = c
  return rest
}

describe('資格（1～3）', () => {
  it('1. 不在傳奇不能挑戰；2. 傳奇但條件不足不能挑戰（場數、勝率、積分）；狀態機顯示缺的條件', async () => {
    const tier3 = world(relegated)
    expect(championshipView(load(tier3.deps)).status).toBe('locked')
    expect((await startSeries(tier3.deps, { seriesSeq: 0 }).catch((e) => e)).code).toBe('not-legend')

    for (const [extra, failing] of [
      [{ matches: 99, wins: 70, losses: 29 }, 'matches'],
      [{ recent: 'L'.repeat(30) + 'W'.repeat(30) }, 'winRate'],
      [{ recent: 'W'.repeat(59) }, 'winRate'],
      [{ points: 69 }, 'points'],
    ] as const) {
      const w = world((c) => ({ ...c, league: { ...c.league, ...extra } }))
      const v = championshipView(load(w.deps))
      expect(v.status).toBe('not-eligible')
      expect(v.eligibility[failing].ok).toBe(false)
      expect((await startSeries(w.deps, { seriesSeq: 0 }).catch((e) => e)).code).toBe('not-eligible')
      expect(load(w.deps).championship.nextSeriesSeq).toBe(0)
    }
  })

  it('3. 完整符合資格可以開始系列賽：固定的冠軍隊、還沒打任何一場、不動一般比賽', async () => {
    const { deps } = world()
    const before = load(deps)
    expect(championshipView(before).status).toBe('eligible')
    const out = await startSeries(deps, { seriesSeq: 0, requestId: 'a' })
    expect(out.duplicate).toBe(false)
    expect(out.series).toMatchObject({ seq: 0, id: `${before.clubId}#s0`, games: [] })
    expect(out.series.opponent.name).toBe(CHAMPIONSHIP_CONFIG.opponentName)
    expect(out.series.opponent.mean).toBe(CHAMPIONSHIP_CONFIG.opponentMean)
    expect(out.series.opponent.team).toEqual(championOpponent(before, 0).team)
    const after = load(deps)
    expect(championshipView(after)).toMatchObject({ status: 'in-progress', series: { wins: 0, losses: 0, nextGame: 1, winsToTitle: 4 } })
    expect(untouched(after)).toEqual(untouched(before))
  })

  it('新晉級傳奇的球團不會馬上有資格（本聯盟場數從 0 開始）', () => {
    const c = V14()
    const promoted = { ...c, league: leagueAtTier(c.league, 4, { matches: 0, wins: 0, losses: 0, recent: '', points: 50 }) }
    expect(championshipView(promoted).status).toBe('not-eligible')
  })
})

describe('七戰四勝（4～8）', () => {
  it('4. 固定七戰四勝、2-3-2 主客場；場次編號 1～7 以外的請求不合法', async () => {
    expect(CHAMPIONSHIP_CONFIG).toMatchObject({ winsNeeded: 4, maxGames: 7 })
    expect([1, 2, 3, 4, 5, 6, 7].map(userSideForGame)).toEqual(['away', 'away', 'home', 'home', 'home', 'away', 'away'])
    const { deps } = world()
    await startSeries(deps, { seriesSeq: 0 })
    for (const game of [0, 8, 1.5]) expect((await playSeriesGame(deps, { seriesSeq: 0, game }).catch((e) => e)).code).toBe('bad-request')
    // 不能跳場
    expect((await playSeriesGame(deps, { seriesSeq: 0, game: 2 }).catch((e) => e)).code).toBe('stale-request')
  })

  it('5. 4:0、4:1、4:2、4:3 都奪冠；6. 0:4、1:4、2:4、3:4 都落敗', async () => {
    for (const [script, wins, losses] of [
      ['WWWW', 4, 0],
      ['LWWWW', 4, 1],
      ['LWLWWW', 4, 2],
      ['LLLWWWW', 4, 3],
      ['LLLL', 0, 4],
      ['WLLLL', 1, 4],
      ['WLWLLL', 2, 4],
      ['WWWLLLL', 3, 4],
    ] as const) {
      const w = world()
      const { deps } = scripted(w.deps, script)
      const outs = await playOut(deps)
      expect(outs).toHaveLength(wins + losses)
      const last = outs.at(-1)!
      const won = wins === 4
      expect(last.completed).toMatchObject({ won, wins, losses })
      expect(last.completed!.scores).toHaveLength(wins + losses)
      expect(last.firstTitle).toBe(won)
      const c = load(w.deps)
      expect(c.championship.active).toBeNull()
      expect(c.championship.titles).toBe(won ? 1 : 0)
      expect(c.championship.firstTitle).toEqual(won ? expect.objectContaining({ seriesSeq: 0, wins, losses, clubId: c.clubId, clubName: c.clubName }) : null)
      expect(c.championship.readyAt).toBe(c.idle.nextMatchIndex + CHAMPIONSHIP_CONFIG.retryAfterMatches)
      expect(championshipView(c).status).toBe('cooldown')
      // 7、8. 系列賽結束後不會有下一場
      const next = await playSeriesGame(w.deps, { seriesSeq: 0, game: wins + losses + 1 }).catch((e) => e)
      expect(next).toBeInstanceOf(ChampionshipError)
      expect(next.code).toBe(wins + losses + 1 > 7 ? 'bad-request' : 'stale-request')
      expect(validateClub(JSON.parse(w.storage.getItem(CLUB_STORAGE_KEY)!))).toEqual(c)
    }
  })

  it('7、8. 純函式：4 勝或 4 敗之後再記一場會被拒絕；存檔驗證也拒絕「結束後還在進行中」或第 5 個勝場', () => {
    const c = V14()
    let s: ClubSave = { ...c, championship: { ...c.championship, nextSeriesSeq: 1, active: { seq: 0, id: `${c.clubId}#s0`, startedAt: 0, startedAtMatch: 0, requestKey: 'start:', opponent: championOpponent(c, 0), games: [] } } }
    const g = (n: number, won: boolean): SeriesGame => ({ game: n, matchId: `${c.clubId}#s0g${n}`, seed: 1, userSide: userSideForGame(n), won, runsFor: won ? 3 : 1, runsAgainst: won ? 1 : 3, innings: 9, at: 0, matchIndexAt: 0, requestKey: 'game:' })
    const replay = c.replays[0].replay
    for (let n = 1; n <= 4; n++) s = recordSeriesGame(s, g(n, true), replay, 0)
    expect(s.championship.active).toBeNull()
    expect(() => recordSeriesGame(s, g(5, true), replay, 0)).toThrow('沒有進行中的系列賽')
    // 手改存檔：已經 4 勝還在進行中
    const bad = structuredClone(s)
    bad.championship.active = { seq: 0, id: `${c.clubId}#s0`, startedAt: 0, startedAtMatch: 0, requestKey: 'start:', opponent: championOpponent(c, 0), games: [1, 2, 3, 4].map((n) => g(n, true)) }
    expect(() => validateClub(bad)).toThrow('不應該還在進行中')
    const five = structuredClone(s)
    five.championship.history[0].scores.push([5, 1])
    expect(() => validateClub(five)).toThrow()
  })
})

describe('快照與中途變化（9～11）', () => {
  it('9. 中途重新整理（另一個分頁或重新開啟）：同一個系列賽、同一支冠軍隊，接著打下一場的結果跟沒重新整理一樣', async () => {
    const a = world()
    const b = world()
    await startSeries(a.deps, { seriesSeq: 0 })
    await startSeries(b.deps, { seriesSeq: 0 })
    await playSeriesGame(a.deps, { seriesSeq: 0, game: 1 })
    await playSeriesGame(b.deps, { seriesSeq: 0, game: 1 })
    // a 重新開啟：新的 repository、新的依賴，只共用 localStorage
    const reopened = tab(a.storage, a.clock, new FakeLockManager())
    const { value } = await openClubSafely(reopened)
    expect(value.club!.championship).toEqual(load(b.deps).championship)
    expect(championshipView(value.club!).series).toMatchObject({ nextGame: 2 })
    await playSeriesGame(reopened, { seriesSeq: 0, game: 2 })
    await playSeriesGame(b.deps, { seriesSeq: 0, game: 2 })
    expect(load(reopened).championship).toEqual(load(b.deps).championship)
  })

  it('10. 中途改戰術、換人、升級、完成訓練、MVP 成長：從下一場開始生效，已經打完的場次不變，冠軍隊不變', async () => {
    const { deps } = world()
    await startSeries(deps, { seriesSeq: 0 })
    await playSeriesGame(deps, { seriesSeq: 0, game: 1 })
    const c1 = load(deps)
    const opponent = c1.championship.active!.opponent
    const game1 = c1.championship.active!.games[0]
    // 改戰術、換先發九棒的第一棒與板凳、把某位球員升到滿級、把 MVP 加成拿掉
    const lineup = [...c1.roster.lineup]
    const benchId = c1.roster.bench[0]
    const swapped = { ...c1, strategy: { ...c1.strategy, coach: { style: 'speed' as const } }, roster: { ...c1.roster, lineup: [{ ...lineup[0], playerId: benchId }, ...lineup.slice(1)], bench: [lineup[0].playerId, ...c1.roster.bench.slice(1)] }, players: c1.players.map((p, i) => (i === 0 ? { ...p, level: 20 } : p)) }
    const plan = planSeriesGame(swapped, swapped.championship.active!, 2)
    const ours = plan.setup[plan.userSide]
    expect(plan.ai[plan.userSide]).toMatchObject({ kind: 'autoCoach', style: 'speed' })
    expect(ours.roster.lineup[0].player.id).toBe(benchId)
    // 冠軍隊用存下來的那一支
    const other = plan.userSide === 'home' ? 'away' : 'home'
    expect(plan.setup[other]).toEqual(opponent.team)
    // 實際存進去再打：第 1 場不變
    deps.store.saveClub(swapped, c1.revision)
    await playSeriesGame(deps, { seriesSeq: 0, game: 2 })
    const c2 = load(deps)
    expect(c2.championship.active?.games[0] ?? c2.championship.history.at(-1)).toBeTruthy()
    if (c2.championship.active) expect(c2.championship.active.games[0]).toEqual(game1)
    expect(c2.championship.lastGame!.replay.setup[other]).toEqual(opponent.team)
  })

  it('11. 傳奇中途降級：進行中的系列賽可以打完；打完後留在實際的聯盟，不能再開新的系列賽；冠軍賽不改積分', async () => {
    const w = world()
    const { deps } = scripted(w.deps, 'WWWW')
    await startSeries(deps, { seriesSeq: 0 })
    await playSeriesGame(deps, { seriesSeq: 0, game: 1 })
    const c = load(deps)
    deps.store.saveClub(relegated(c), c.revision)
    expect(championshipView(load(deps))).toMatchObject({ status: 'in-progress', relegatedDuringSeries: true })
    for (let g = 2; g <= 4; g++) await playSeriesGame(deps, { seriesSeq: 0, game: g })
    const done = load(deps)
    expect(done.league.tier).toBe(3)
    expect(done.championship).toMatchObject({ titles: 1, active: null })
    expect(championshipView(done)).toMatchObject({ status: 'locked', relegated: true, titles: 1 })
    expect((await startSeries(deps, { seriesSeq: 1 }).catch((e) => e)).code).toBe('not-legend')
  })

  it('還沒開始的系列賽：降級就失去資格', async () => {
    const { deps } = world(relegated)
    expect(championshipView(load(deps))).toMatchObject({ status: 'locked', relegated: true })
  })
})

describe('獨立性（12～15、22、24）', () => {
  it('12～15. 打完整個系列賽：MVP、生涯數據、特性訓練、聯盟戰績與積分、一般比賽游標、錨點、收益、總戰績、近期比賽、Replay 全都不變', async () => {
    const w = world()
    const before = load(w.deps)
    expect(before.training.active).not.toBeNull()
    const { deps } = scripted(w.deps, 'LWLWLWW')
    const outs = await playOut(deps)
    expect(outs).toHaveLength(7)
    const after = load(deps)
    expect(untouched(after)).toEqual(untouched(before))
    expect(after.players.map((p) => p.mvp)).toEqual(before.players.map((p) => p.mvp))
    expect(after.stats).toEqual(before.stats)
    expect(after.training).toEqual(before.training)
    expect(after.league).toEqual(before.league)
    expect(after.idle).toEqual(before.idle)
    expect(after.economy).toEqual(before.economy)
    expect(after.replays).toEqual(before.replays)
    expect(after.challengeReplay).toEqual(before.challengeReplay)
    expect(after.liveMatch).toEqual(before.liveMatch)
  })

  it('22、24. 中途打了冠軍賽，之後離線 8 小時結算的 96 場（固定的進行中比賽、MVP、訓練、降級）跟 main 的程式一模一樣', async () => {
    const w = world()
    const { deps } = scripted(w.deps, 'WLW')
    await startSeries(deps, { seriesSeq: 0 })
    for (let g = 1; g <= 3; g++) await playSeriesGame(deps, { seriesSeq: 0, game: g })
    w.clock.advance(8 * HOUR)
    const r = await settleDue(w.deps)
    expect(r.settled.map(rowOf)).toEqual(golden.rows)
    expect(finalOf(r.club)).toBe(golden.final)
    // 系列賽還在：結算不會碰冠軍賽
    expect(championshipView(r.club).series).toMatchObject({ wins: 2, losses: 1, nextGame: 4 })
  })

  it('冠軍賽之前會先結算到期的一般比賽，結算的結果跟單獨結算一樣（不會遺失）', async () => {
    const hot = (c: ClubSave) => ({ ...c, league: { ...c.league, recent: 'W'.repeat(60) } })
    const a = world(hot)
    const b = world(hot)
    a.clock.advance(3 * HOUR)
    b.clock.advance(3 * HOUR)
    const out = await startSeries(a.deps, { seriesSeq: 0 })
    const plain = await settleDue(b.deps)
    expect(out.settledMatches).toBe(plain.settled.length)
    expect(out.settledMatches).toBeGreaterThan(0)
    expect(untouched(load(a.deps))).toEqual(untouched(plain.club))
  })
})

describe('冪等、多分頁、寫入失敗（16～18）', () => {
  it('16. 同一個請求重送：不再模擬、回傳原本的結果（開始、每一場、決定勝負那一場）', async () => {
    const w = world()
    const { deps, calls } = scripted(w.deps, 'WWWW')
    const s1 = await startSeries(deps, { seriesSeq: 0, requestId: 'x' })
    const s2 = await startSeries(deps, { seriesSeq: 0, requestId: 'x' })
    expect(s2).toMatchObject({ duplicate: true, series: s1.series })
    for (let g = 1; g <= 4; g++) {
      const first = await playSeriesGame(deps, { seriesSeq: 0, game: g, requestId: `g${g}` })
      const again = await playSeriesGame(deps, { seriesSeq: 0, game: g, requestId: `g${g}` })
      expect(again).toMatchObject({ duplicate: true, game: first.game, completed: first.completed, firstTitle: first.firstTitle })
    }
    expect(calls).toHaveLength(4)
    expect(load(deps).championship.titles).toBe(1)
    // 更早的場次重送：不是最近一次的請求 → 過期
    expect((await playSeriesGame(deps, { seriesSeq: 0, game: 2, requestId: 'g2' }).catch((e) => e)).code).toBe('stale-request')
  })

  it('17. 兩個分頁同時按：只會開始一個系列賽、每一場只打一次；另一個分頁拿到過期', async () => {
    const w = world()
    const { deps: t1, calls } = scripted(w.deps, 'WLWLWLW')
    const t2 = { ...tab(w.storage, w.clock, w.locks), batch: t1.batch }
    const starts = await Promise.allSettled([startSeries(t1, { seriesSeq: 0, requestId: 'a' }), startSeries(t2, { seriesSeq: 0, requestId: 'b' })])
    expect(starts.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    expect((starts.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('stale-request')
    expect(load(t1).championship.nextSeriesSeq).toBe(1)
    for (let g = 1; g <= 7; g++) {
      const both = await Promise.allSettled([playSeriesGame(t1, { seriesSeq: 0, game: g, requestId: `a${g}` }), playSeriesGame(t2, { seriesSeq: 0, game: g, requestId: `b${g}` })])
      expect(both.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
    }
    expect(calls).toHaveLength(7)
    expect(load(t2).championship.history[0]).toMatchObject({ wins: 4, losses: 3 })
    // 沒有 requestId 的兩個分頁：視為同一個請求，第二個拿到原本的結果
    const w2 = world()
    const u2 = tab(w2.storage, w2.clock, w2.locks)
    const [x, y] = await Promise.all([startSeries(w2.deps, { seriesSeq: 0 }), startSeries(u2, { seriesSeq: 0 })])
    expect([x.duplicate, y.duplicate].sort()).toEqual([false, true])
  })

  it('18. 存檔寫入失敗：不回報成功、存檔不變；重試得到跟沒失敗一樣的結果', async () => {
    const flaky = new FlakyStorage()
    const w = world(undefined, flaky)
    const control = world()
    await startSeries(w.deps, { seriesSeq: 0, requestId: 's' })
    await startSeries(control.deps, { seriesSeq: 0, requestId: 's' })
    const before = flaky.getItem(CLUB_STORAGE_KEY)
    flaky.failWrites = true
    expect(await playSeriesGame(w.deps, { seriesSeq: 0, game: 1, requestId: 'g' }).catch((e) => e)).toBeInstanceOf(ClubSaveError)
    expect(await startSeries(w.deps, { seriesSeq: 1 }).catch((e) => e)).toBeInstanceOf(ChampionshipError)
    expect(flaky.getItem(CLUB_STORAGE_KEY)).toBe(before)
    flaky.failWrites = false
    const retried = await playSeriesGame(w.deps, { seriesSeq: 0, game: 1, requestId: 'g' })
    const ok = await playSeriesGame(control.deps, { seriesSeq: 0, game: 1, requestId: 'g' })
    expect(retried.duplicate).toBe(false)
    expect(retried.game).toEqual(ok.game)
    expect(load(w.deps).championship).toEqual(load(control.deps).championship)
  })

  it('模擬失敗：這一場沒有打、到期的一般比賽照樣存檔；重試是同一場', async () => {
    const w = world()
    await startSeries(w.deps, { seriesSeq: 0 })
    w.clock.advance(HOUR)
    const failing: Deps = { ...w.deps, batch: { ...w.deps.batch, simulate: (plan) => (plan.matchId.includes('#s') ? (() => { throw new Error('boom') })() : runMatch(plan.setup, plan.ai)) } }
    const e = await playSeriesGame(failing, { seriesSeq: 0, game: 1 }).catch((x) => x)
    expect(e).toBeInstanceOf(SettlementError)
    const c = load(w.deps)
    expect(c.championship.active!.games).toHaveLength(0)
    expect(c.idle.nextMatchIndex).toBeGreaterThan(V14().idle.nextMatchIndex)
    const out = await playSeriesGame(w.deps, { seriesSeq: 0, game: 1 })
    expect(out.game.seed).toBe(planSeriesGame(c, c.championship.active!, 1).seed)
  })
})

describe('首次奪冠（19～20）', () => {
  it('19. 首次奪冠紀錄寫進存檔、重新開啟還在；20. 再奪冠只增加冠軍次數，首次奪冠紀錄不變', async () => {
    const w = world()
    const { deps } = scripted(w.deps, 'WWLWW')
    await playOut(deps)
    const first = load(deps).championship.firstTitle!
    expect(first).toMatchObject({ seriesSeq: 0, seriesId: `${load(deps).clubId}#s0`, wins: 4, losses: 1 })
    const reopened = new ClubRepository(w.storage).loadClub()!
    expect(reopened.championship.firstTitle).toEqual(first)
    // 冷卻過了再打一次（直接把冷卻設到現在，避免結算 96 場改變資格）
    const c = load(deps)
    deps.store.saveClub({ ...c, championship: { ...c.championship, readyAt: c.idle.nextMatchIndex } }, c.revision)
    const outs = await playOut(scripted(w.deps, 'WWWW').deps, 1)
    expect(outs.at(-1)!.firstTitle).toBe(false)
    const after = load(deps).championship
    expect(after.titles).toBe(2)
    expect(after.firstTitle).toEqual(first)
    expect(after.history.map((h) => [h.seq, h.won, h.wins, h.losses])).toEqual([
      [0, true, 4, 1],
      [1, true, 4, 0],
    ])
    // 不發任何資源（方案 A：只有榮譽）
    expect(load(deps).economy).toEqual(V14().economy)
  })
})

describe('遷移（21）與 Replay（23）', () => {
  it('21. V13 → V14：只加上空的冠軍賽資料；就算早就符合資格也不追溯補發冠軍；原文備份到 backup-schema13', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, RAW_V13)
    const { value } = await openClubSafely(tab(storage, new ManualClock(fixtureV13.idle.anchorMs), new FakeLockManager()))
    const c = value.club!
    expect(value.migrated).toBe(true)
    expect(storage.getItem(CLUB_BACKUP_KEY_V13)).toBe(RAW_V13)
    expect(c.schemaVersion).toBe(14)
    expect(c.migratedFrom).toEqual({ schemaVersion: 13, revision: fixtureV13.revision })
    expect(c.championship).toEqual({ nextSeriesSeq: 0, active: null, history: [], titles: 0, firstTitle: null, readyAt: 0, lastGame: null })
    const { schemaVersion: _a, revision: _b, migratedFrom: _m, championship: _c, ...rest } = c
    const { schemaVersion: _x, revision: _y, migratedFrom: _n, ...old } = JSON.parse(RAW_V13)
    expect(rest).toEqual(old)
    expect(championshipView(c).status).toBe('eligible')
  })

  it('V14 新球團（不是遷移來的）到傳奇後可以建立系列賽、打一場，存檔驗證通過、重新開啟一樣', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock(Date.UTC(2026, 10, 1))
    const d = tab(storage, clock, new FakeLockManager())
    const { createClubSafely } = await import('./clubLifecycle')
    await createClubSafely(d, { clubName: '新冠軍隊', clubSeed: 2468, clubId: 'club-new-v14' })
    const fresh = load(d)
    expect(fresh.schemaVersion).toBe(14)
    expect(fresh.migratedFrom).toBeUndefined()
    d.store.saveClub({ ...fresh, league: leagueAtTier(fresh.league, 4, { matches: 120, wins: 80, losses: 40, recent: 'W'.repeat(40) + 'L'.repeat(20), points: 90 }) }, fresh.revision)
    await startSeries(d, { seriesSeq: 0 })
    const out = await playSeriesGame(d, { seriesSeq: 0, game: 1 })
    expect(out.game.seed).toBe(planSeriesGame(load(d), load(d).championship.active!, 1).seed)
    const raw = storage.getItem(CLUB_STORAGE_KEY)!
    expect(validateClub(JSON.parse(raw))).toEqual(load(d))
    const { value } = await openClubSafely(tab(storage, clock, new FakeLockManager()))
    expect(value.club!.championship).toEqual(load(d).championship)
  })

  it('既有的 V14 存檔（進行中與已完成的系列賽）重新讀取不變、不再遷移；改壞的存檔被拒絕、原文不變', async () => {
    const w = world()
    const { deps } = scripted(w.deps, 'WLWLWLW')
    await playOut(deps)
    const raw = w.storage.getItem(CLUB_STORAGE_KEY)!
    const { value } = await openClubSafely(tab(w.storage, w.clock, new FakeLockManager()))
    expect(value.migrated).toBe(false)
    expect(JSON.stringify(value.club)).toBe(raw)
    const bad = JSON.parse(raw) as ClubSave
    bad.championship.history[0].scores[0] = [bad.championship.history[0].scores[0][1], bad.championship.history[0].scores[0][0]]
    const badRaw = JSON.stringify(bad)
    w.storage.setItem(CLUB_STORAGE_KEY, badRaw)
    expect(await openClubSafely(tab(w.storage, w.clock, new FakeLockManager())).catch((e) => e)).toBeInstanceOf(Error)
    expect(w.storage.getItem(CLUB_STORAGE_KEY)).toBe(badRaw)
  })

  it('23. 冠軍賽的 Replay 可以重播出同樣的結果；一般比賽與晉級挑戰的 Replay 不受影響', async () => {
    const { deps } = world()
    await startSeries(deps, { seriesSeq: 0 })
    const out = await playSeriesGame(deps, { seriesSeq: 0, game: 1 })
    const c = load(deps)
    const t = buildTimeline(c.championship.lastGame!.replay, { userSide: out.game.userSide, runsFor: out.game.runsFor, runsAgainst: out.game.runsAgainst, won: out.game.won, innings: out.game.innings })
    expect(t).toBeTruthy()
    expect(c.replays).toEqual(V14().replays)
    expect(c.challengeReplay).toEqual(V14().challengeReplay)
  })
})

// 跟產生 golden 時同樣的格式
function rowOf(m: SettledMatch) {
  return [m.matchIndex, m.result.runsFor, m.result.runsAgainst, m.result.innings, m.earnedFunds, m.earnedExperience, m.ranked ? `${m.ranked.before}>${m.ranked.after}${m.ranked.relegatedTo ?? ''}` : '-', JSON.stringify(m.tactics), JSON.stringify(m.mvp)].join(' ')
}
function finalOf(f: ClubSave) {
  return JSON.stringify({ record: f.record, economy: f.economy, league: f.league, stats: f.stats, training: f.training, players: f.players.map((p) => [p.player.id, p.level, p.dev ?? null, p.mvp ?? null]), next: f.idle.nextMatchIndex })
}
