import { describe, expect, it } from 'vitest'
import fixtureV3 from './__fixtures__/club-v3-phase3.json'
import fixtureV11 from './__fixtures__/club-v11-phase9.json'
import fixtureV13 from './__fixtures__/club-v13-phase9.json'
import { validateClub, type ClubSave } from './club'
import { CHAMPIONSHIP_CONFIG, championshipEligibility, championshipIssues, championshipView, newChampionshipState, recordSeriesGame, seriesGameSeed, seriesIdFor, teamStyle, userSideForGame, type SeriesGame } from './championship'
import { migrateToLatest } from './migration'
import { championOpponent } from '../application/championshipService'

const club = (): ClubSave => migrateToLatest(structuredClone(fixtureV13))
const game = (c: ClubSave, seq: number, n: number, won: boolean): SeriesGame => ({ game: n, matchId: `${c.clubId}#s${seq}g${n}`, seed: seriesGameSeed(c.clubSeed, seq, n), userSide: userSideForGame(n), won, runsFor: won ? 5 : 2, runsAgainst: won ? 2 : 5, innings: 9, at: 1, matchIndexAt: c.idle.nextMatchIndex, requestKey: 'game:' })
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
      expect(championshipIssues(c.championship, { clubId: c.clubId, clubSeed: c.clubSeed, nextMatchIndex: c.idle.nextMatchIndex })).toEqual([])
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

// ---- PR #24 review：確定性種子、冠軍隊快照、系列賽完整性 ----

/** 改壞存檔後一定被拒絕，錯誤訊息包含 why */
function rejects(base: ClubSave, edit: (x: ClubSave) => void, why: string | RegExp) {
  const bad = structuredClone(base)
  edit(bad)
  expect(() => validateClub(bad)).toThrow(why)
}

describe('確定性種子', () => {
  it('正確的種子通過；不同的合法整數、負數、小數都拒絕；冠軍隊種子也要符合推導', () => {
    const c = club()
    const mid = withSeries(c, 'WL')
    expect(() => validateClub(mid)).not.toThrow()
    const g0 = mid.championship.active!.games[0]
    rejects(mid, (x) => (x.championship.active!.games[0].seed = g0.seed + 1), '第 1 場的種子跟球團種子推導出來的不符')
    rejects(mid, (x) => (x.championship.active!.games[0].seed = seriesGameSeed(c.clubSeed, 0, 2)), '種子跟球團種子推導出來的不符')
    rejects(mid, (x) => (x.championship.active!.games[1].seed = -5), '第 2 場的種子必須是 0 以上的整數')
    rejects(mid, (x) => (x.championship.active!.games[1].seed = g0.seed + 0.5), '第 2 場的種子必須是 0 以上的整數')
    rejects(mid, (x) => (x.championship.active!.opponent.seed += 1), '冠軍隊的種子跟球團種子推導出來的不符')
    // 換一個球團種子：同樣的系列賽就對不起來
    rejects(mid, (x) => (x.clubSeed = c.clubSeed + 1), '種子跟球團種子推導出來的不符')
  })

  it('比賽編號、2-3-2、場次重複或跳號都拒絕，錯誤訊息說明是哪一場', () => {
    const mid = withSeries(club(), 'WLW')
    rejects(mid, (x) => (x.championship.active!.games[1].matchId = `${x.clubId}#s1g2`), '第 2 場的比賽編號不對')
    rejects(mid, (x) => (x.championship.active!.games[2].userSide = 'away'), '第 3 場的主客場不對')
    rejects(mid, (x) => (x.championship.active!.games[2] = { ...x.championship.active!.games[1] }), '場次必須從 1 開始連續、不能重複')
    rejects(mid, (x) => x.championship.active!.games.splice(1, 1), '場次必須從 1 開始連續、不能重複')
    rejects(mid, (x) => (x.championship.active!.games[0].matchIndexAt = x.idle.nextMatchIndex + 1), '超過目前的結算游標')
  })
})

describe('冠軍隊快照', () => {
  const mid = () => withSeries(club(), 'W')
  const team = (x: ClubSave) => x.championship.active!.opponent.team
  it('合法的冠軍隊通過（服務產生的就是合法的）', () => {
    expect(() => validateClub(mid())).not.toThrow()
    for (let seq = 0; seq < 20; seq++) expect(() => validateClub(withSeries(club(), '', seq))).not.toThrow()
  })

  it('打線少一人、ID 重複、打者放投手、投手放打者、守位重複或不合法都拒絕', () => {
    const m = mid()
    rejects(m, (x) => team(x).roster.lineup.pop(), '先發必須剛好 9 人')
    rejects(m, (x) => (team(x).roster.bench[0].id = team(x).roster.lineup[0].player.id), '同一名球員不能出現在兩個位置')
    rejects(m, (x) => ((team(x).roster as { starter: unknown }).starter = team(x).roster.lineup[0].player), '冠軍隊.roster.starter 不是合法的投手')
    rejects(m, (x) => ((team(x).roster.relievers as unknown[])[0] = team(x).roster.bench[0]), '冠軍隊.roster.relievers[0] 不是合法的投手')
    rejects(m, (x) => ((team(x).roster.lineup[0] as { player: unknown }).player = team(x).roster.starter), '冠軍隊.roster.lineup[0].player 不是合法的打者')
    rejects(m, (x) => ((team(x).roster.bench as unknown[])[0] = team(x).roster.relievers[0]), '冠軍隊.roster.bench[0] 不是合法的打者')
    rejects(m, (x) => (team(x).roster.lineup[1].position = team(x).roster.lineup[0].position), '每個守位都要剛好一人')
    rejects(m, (x) => ((team(x).roster.lineup[1] as { position: string }).position = 'P'), 'position 不合法')
    rejects(m, (x) => (team(x).name = ''), '隊名')
  })

  it('能力 NaN、Infinity（存檔裡是 null）、超過 10、少一項都拒絕；特性不存在、角色不符、重複都拒絕', () => {
    const m = mid()
    const bat = (x: ClubSave) => team(x).roster.lineup[0].player.ratings as unknown as Record<string, unknown>
    rejects(m, (x) => (bat(x).power = NaN), '必須是 0～10 的數字')
    rejects(m, (x) => (bat(x).power = Infinity), '必須是 0～10 的數字')
    rejects(m, (x) => (bat(x).power = null), '必須是 0～10 的數字')
    rejects(m, (x) => (bat(x).power = 10.5), '必須是 0～10 的數字')
    rejects(m, (x) => delete bat(x).power, '能力項目不對')
    rejects(m, (x) => ((team(x).roster.starter.ratings as unknown as Record<string, unknown>).stuff = -1), '必須是 0～10 的數字')
    rejects(m, (x) => ((team(x).roster.lineup[0].player.traits as string[]) = ['flying']), '不認識的特性：flying')
    rejects(m, (x) => ((team(x).roster.lineup[0].player.traits as string[]) = ['closer']), 'closer 不是打者的特性')
    rejects(m, (x) => ((team(x).roster.starter.traits as string[]) = ['slugger']), 'slugger 不是投手的特性')
    rejects(m, (x) => ((team(x).roster.lineup[0].player.traits as string[]) = ['eye', 'eye']), '有重複的特性')
    rejects(m, (x) => ((team(x).roster.lineup[0].player as { archetype: string }).archetype = 'magic'), 'archetype 不合法')
  })

  it('讀檔時不重新產生、不修正：不合法的冠軍隊直接拒絕，原文不變', async () => {
    const { ClubRepository, CLUB_STORAGE_KEY, MemoryStorage } = await import('../infrastructure/clubRepository')
    const bad = structuredClone(mid())
    ;(bad.championship.active!.opponent.team.roster.lineup[0].player.ratings as unknown as Record<string, unknown>).power = 99
    const raw = JSON.stringify(bad)
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, raw)
    expect(() => new ClubRepository(storage).loadClub()).toThrow()
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
  })
})

describe('系列賽完整性', () => {
  it('4:0～4:3、0:4～3:4 的已完成系列賽都通過；進行中也通過', () => {
    const c = club()
    for (const r of ['WWWW', 'LWWWW', 'LLWWWW', 'LLLWWWW', 'LLLL', 'WLLLL', 'WWLLLL', 'WWWLLLL', 'W', 'WLWLWL']) expect(() => validateClub(withSeries(c, r)), r).not.toThrow()
  })

  it('四勝後第五勝、四敗後還在打、lastGame 跟最後一場不符都拒絕', () => {
    const won = withSeries(club(), 'WWWW')
    rejects(won, (x) => (x.championship.history[0].scores.push([5, 1]), (x.championship.history[0].wins = 5)), '超過七戰四勝')
    rejects(won, (x) => (x.championship.history[0].scores.push([1, 3]), (x.championship.history[0].losses = 1)), '在系列賽結束後還有比賽')
    const lost = withSeries(club(), 'LLLL')
    rejects(lost, (x) => (x.championship.history[0].scores.push([1, 2]), (x.championship.history[0].losses = 5)), '超過七戰四勝')
    rejects(won, (x) => (x.championship.lastGame!.game.runsFor += 1), '最近一場冠軍賽跟系列賽對不起來')
    const mid = withSeries(club(), 'WLW')
    rejects(mid, (x) => (x.championship.lastGame = { ...x.championship.lastGame!, game: { ...x.championship.active!.games[1] } }), '最近一場冠軍賽跟系列賽對不起來')
  })

  it('其他不變量：冷卻、首次奪冠、超出結算游標', () => {
    const c = club()
    const won = withSeries(c, 'WLWWW')
    rejects(withSeries(c, 'W'), (x) => (x.championship.readyAt = 5), '冷卻場次應該是 0')
    rejects(won, (x) => (x.championship.readyAt = x.championship.history[0].completedAtMatch - 1), '冷卻場次早於')
    rejects(won, (x) => (x.championship.firstTitle!.clubId = 'other'), '不屬於這個球團')
    rejects(won, (x) => (x.championship.firstTitle!.matchIndexAt = x.idle.nextMatchIndex + 1), '超過目前的結算游標')
    rejects(won, (x) => (x.championship.history[0].completedAtMatch = x.idle.nextMatchIndex + 1), '結束場次不對')
    // 兩座冠軍：首次奪冠一定是比較早的那一座
    const two = withSeries(won, 'WWWW', 1)
    expect(() => validateClub(two)).not.toThrow()
    rejects(two, (x) => (x.championship.firstTitle = { ...x.championship.firstTitle!, seriesSeq: 1, seriesId: `${x.clubId}#s1`, losses: 0 }), '比首次奪冠更早的冠軍')
  })
})
