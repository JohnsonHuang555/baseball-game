import { describe, expect, it } from 'vitest'
import fixtureV3 from './__fixtures__/club-v3-phase3.json'
import fixtureV11 from './__fixtures__/club-v11-phase9.json'
import fixtureV13 from './__fixtures__/club-v13-phase9.json'
import { validateClub, type ClubSave } from './club'
import { CHAMPIONSHIP_CONFIG, championshipEligibility, championshipIssues, championshipView, newChampionshipState, recordSeriesGame, seriesIdFor, teamStyle, userSideForGame, type SeriesGame } from './championship'
import { migrateToLatest } from './migration'
import { championOpponent } from '../application/championshipService'

const club = (): ClubSave => migrateToLatest(structuredClone(fixtureV13))
const game = (c: ClubSave, seq: number, n: number, won: boolean): SeriesGame => ({ game: n, matchId: `${c.clubId}#s${seq}g${n}`, seed: 1, userSide: userSideForGame(n), won, runsFor: won ? 5 : 2, runsAgainst: won ? 2 : 5, innings: 9, at: 1, matchIndexAt: c.idle.nextMatchIndex, requestKey: 'game:' })
function withSeries(c: ClubSave, results: string, seq = 0): ClubSave {
  let s: ClubSave = { ...c, championship: { ...c.championship, nextSeriesSeq: seq + 1, active: { seq, id: seriesIdFor(c, seq), startedAt: 1, startedAtMatch: c.idle.nextMatchIndex, requestKey: 'start:', opponent: championOpponent(c, seq), games: [] } } }
  ;[...results].forEach((r, i) => (s = recordSeriesGame(s, game(c, seq, i + 1, r === 'W'), c.replays[0].replay, 2)))
  return s
}

describe('冠軍賽資料', () => {
  it('新球團與完整遷移鏈（V3、V11、V13 → V14）：空的冠軍賽資料、通過驗證、沒有冠軍', () => {
    for (const fx of [fixtureV3, fixtureV11, fixtureV13]) {
      const c = migrateToLatest(structuredClone(fx))
      expect(c.championship).toEqual(newChampionshipState())
      expect(championshipIssues(c.championship, { clubId: c.clubId, nextMatchIndex: c.idle.nextMatchIndex })).toEqual([])
    }
  })

  it('資格：傳奇、≥ 100 場、最近 60 場 ≥ 60%（不足 60 場不算）、積分 ≥ 70、冷卻結束', () => {
    const c = club()
    expect(championshipEligibility(c).ok).toBe(true)
    expect(CHAMPIONSHIP_CONFIG).toMatchObject({ tier: 4, minMatches: 100, window: 60, winRate: 0.6, minPoints: 70 })
    const cool = { ...c, championship: { ...c.championship, readyAt: c.idle.nextMatchIndex + 5 } }
    expect(championshipEligibility(cool)).toMatchObject({ ok: false, cooldown: { remaining: 5, ok: false } })
    expect(championshipView(cool).status).toBe('cooldown')
  })

  it('冠軍隊：同一個序號永遠是同一支、固定隊名；不同序號是不同陣容；風格由陣容決定', () => {
    const c = club()
    expect(championOpponent(c, 0)).toEqual(championOpponent(club(), 0))
    expect(championOpponent(c, 0).name).toBe(CHAMPIONSHIP_CONFIG.opponentName)
    expect(championOpponent(c, 1).team).not.toEqual(championOpponent(c, 0).team)
    expect(championOpponent(c, 0).style).toBe(teamStyle(championOpponent(c, 0).team))
  })

  it('驗證：正常的進行中與已結束系列賽都通過', () => {
    const c = club()
    for (const r of ['', 'W', 'WLW', 'WWWW', 'LLLL', 'WLWLWLW']) expect(() => validateClub(withSeries(c, r))).not.toThrow()
    // 上一個系列賽結束後開始新的（還沒打）：lastGame 指向上一個系列賽
    const done = withSeries(c, 'WWWW')
    const again: ClubSave = { ...done, championship: { ...done.championship, nextSeriesSeq: 2, active: { seq: 1, id: seriesIdFor(c, 1), startedAt: 3, startedAtMatch: c.idle.nextMatchIndex, requestKey: 'start:', opponent: championOpponent(c, 1), games: [] } } }
    expect(() => validateClub(again)).not.toThrow()
  })

  it('驗證：拒絕被改壞的存檔（冠軍次數、首次奪冠、序號、編號、比分、主客場、勝負、Replay）', () => {
    const c = club()
    const won = withSeries(c, 'WLWWW')
    const mid = withSeries(c, 'WL')
    const cases: [string, (x: ClubSave) => void, ClubSave][] = [
      ['冠軍次數少於紀錄', (x) => (x.championship.titles = 0), won],
      ['有首次奪冠但 0 冠', (x) => ((x.championship.titles = 0), (x.championship.history = [])), won],
      ['有冠軍卻沒有首次奪冠', (x) => (x.championship.firstTitle = null), won],
      ['首次奪冠比分不符', (x) => (x.championship.firstTitle!.losses = 0), won],
      ['紀錄勝敗跟比分不符', (x) => (x.championship.history[0].wins = 3), won],
      ['序號超過 nextSeriesSeq', (x) => (x.championship.nextSeriesSeq = 0), won],
      ['進行中的編號不對', (x) => (x.championship.active!.id = 'x#s0'), mid],
      ['比賽編號不對', (x) => (x.championship.active!.games[0].matchId = 'other#s0g1'), mid],
      ['主客場不對', (x) => (x.championship.active!.games[0].userSide = 'home'), mid],
      ['勝負跟比分不符', (x) => (x.championship.active!.games[0].won = false), mid],
      ['和局', (x) => (x.championship.active!.games[0].runsAgainst = x.championship.active!.games[0].runsFor), mid],
      ['最近一場跟系列賽對不起來', (x) => (x.championship.lastGame!.game = { ...x.championship.lastGame!.game, runsFor: 9 }), mid],
      ['打過比賽卻沒有最近一場', (x) => (x.championship.lastGame = null), mid],
      ['冠軍隊壞掉', (x) => ((x.championship.active!.opponent as { team: unknown }).team = {}), mid],
      ['缺 championship', (x) => delete (x as Partial<ClubSave>).championship, mid],
    ]
    for (const [name, edit, base] of cases) {
      const bad = structuredClone(base)
      edit(bad)
      expect(() => validateClub(bad), name).toThrow()
    }
  })

  it('首次奪冠：記錄時間、系列賽、比分、球團；之後再奪冠不改；不發任何資源', () => {
    const c = club()
    const s = withSeries(c, 'LWWWW')
    expect(s.championship.firstTitle).toEqual({ seriesSeq: 0, seriesId: `${c.clubId}#s0`, at: 2, wins: 4, losses: 1, clubId: c.clubId, clubName: c.clubName, matchIndexAt: c.idle.nextMatchIndex })
    expect(s.economy).toEqual(c.economy)
    const s2 = withSeries({ ...s, championship: { ...s.championship } }, 'WWWW', 1)
    expect(s2.championship.titles).toBe(2)
    expect(s2.championship.firstTitle).toEqual(s.championship.firstTitle)
  })
})
