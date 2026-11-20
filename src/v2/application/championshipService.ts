// 傳奇總冠軍賽（Phase 10 PR 1）：開始系列賽、打下一場。
//
// 跟一般比賽完全分開（跟晉級挑戰賽一樣的做法）：
// - 自己的序號（championship.nextSeriesSeq）、自己的種子 salt、自己的比賽編號（<球團>#s<序號>g<場次>）
// - 不動一般比賽的結算游標與時間錨點、不記進總戰績與近期比賽、不改聯盟戰績與積分（不會因此降級）
// - 不發一般比賽的資金與經驗、不加生涯數據、不算特性訓練的出賽、不選 MVP
// - Replay 另外存在 championship.lastGame（只留最近一場），不蓋掉一般比賽與晉級挑戰的 Replay
// - 用既有的 Game／MatchRunner／AutoCoach：buildPlan + runBatch，跟一般比賽同一套模擬
//
// 快照：冠軍隊在開始系列賽時產生、整支存進存檔（之後重新整理、換分頁、改程式的生成器都還是同一支）；
// 我方每一場開打時快照當下的陣容、等級、特性、MVP 加成與戰術（系列賽中途升級、換人、改戰術，從下一場開始生效）。
//
// 冪等（跟晉級挑戰一樣）：請求帶上畫面顯示時的序號（系列賽序號、第幾場）與這次操作的 requestId。
// - 序號等於存檔目前的值：檢查、模擬、記錄，一次存檔
// - 是最近一次成功的請求（序號與 requestId 都一樣）：同一個請求重送，回傳原本的結果，不再模擬
// - 其他（別的分頁已經開始或打完這一場、畫面過期）：拒絕，請重新讀取
// 所以重複點擊、重送、兩個分頁同時按，都只會開始一次系列賽、每一場只打一次。
//
// 一致性：在 ClubLock 裡「讀最新存檔 → 結算到期的一般比賽 → 檢查 → 模擬 → 一次存檔」。
// - 結算失敗：打完的一般比賽照樣存檔，不打冠軍賽
// - 檢查不通過：到期的一般比賽照樣存檔，丟 ChampionshipError（帶上存好的球團）
// - 冠軍賽模擬失敗：到期的一般比賽照樣存檔，這一場沒有打（可以重試，同一場一定是同一個種子）
// - 存檔寫入失敗：丟 ClubSaveError，什麼都沒變，不會回報成功；重試會得到同一個結果（確定性）
import { generateTeam } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { Side } from '../../sim/game'
import { SEED_SALT, deriveSeed, type ClubSave } from '../domain/club'
import {
  CHAMPIONSHIP_CONFIG,
  championshipEligibility,
  gameMatchIdFor,
  gameSeedIndex,
  recordSeriesGame,
  startSeriesState,
  teamStyle,
  userSideForGame,
  type ActiveSeries,
  type ChampionOpponent,
  type SeriesGame,
  type SeriesRecord,
} from '../domain/championship'
import { buildPlan, runBatch, type MatchPlan } from './batchRunner'
import { SettlementError, settleDueUnsaved, type SettlementDeps } from './settlementService'

export type ChampionshipErrorCode =
  /** 請求格式不對 */
  | 'bad-request'
  /** 畫面過期：別的分頁已經開始系列賽或打完這一場 */
  | 'stale-request'
  /** 不在傳奇聯盟 */
  | 'not-legend'
  /** 在傳奇，但還沒達到條件 */
  | 'not-eligible'
  /** 剛結束一個系列賽，還在冷卻 */
  | 'cooldown'
  /** 已經有進行中的系列賽 */
  | 'in-progress'
  /** 沒有進行中的系列賽 */
  | 'no-series'

export class ChampionshipError extends Error {
  override name = 'ChampionshipError'
  /** 被拒絕之前，到期的一般比賽已經結算並存檔：這是存好的球團 */
  settled?: { club: ClubSave; matches: number }
  constructor(
    readonly code: ChampionshipErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface StartSeriesRequest {
  /** 畫面顯示時的 championship.nextSeriesSeq */
  seriesSeq: number
  requestId?: string
}

export interface PlayGameRequest {
  /** 進行中系列賽的序號 */
  seriesSeq: number
  /** 要打第幾場（1～7）：畫面顯示時的「下一場」 */
  game: number
  requestId?: string
}

export interface StartSeriesOutcome {
  club: ClubSave
  series: ActiveSeries
  duplicate: boolean
  settledMatches: number
}

export interface PlayGameOutcome {
  club: ClubSave
  game: SeriesGame
  /** 這一場結束了系列賽：系列賽紀錄 */
  completed: SeriesRecord | null
  /** 這一場拿下的是第一座冠軍 */
  firstTitle: boolean
  duplicate: boolean
  settledMatches: number
}

// ---- 純函式 ----

/** 第 seq 個系列賽的冠軍隊：只由球團種子與序號決定 */
export function championOpponent(club: Pick<ClubSave, 'clubSeed'>, seq: number): ChampionOpponent {
  const seed = deriveSeed(club.clubSeed, seq, SEED_SALT.championshipOpponent)
  const mean = CHAMPIONSHIP_CONFIG.opponentMean
  const team = generateTeam(new Rng(seed), mean)
  team.name = CHAMPIONSHIP_CONFIG.opponentName
  return { name: team.name, style: teamStyle(team), mean, seed, team }
}

/** 進行中系列賽第 game 場的計畫：冠軍隊用系列賽開始時存下的那一支；我方快照「現在」的陣容與戰術 */
export function planSeriesGame(club: ClubSave, series: ActiveSeries, game: number): MatchPlan {
  const userSide: Side = userSideForGame(game)
  return buildPlan(club, {
    matchId: gameMatchIdFor(club, series.seq, game),
    matchIndex: gameSeedIndex(series.seq, game),
    seed: deriveSeed(club.clubSeed, gameSeedIndex(series.seq, game), SEED_SALT.championship),
    userSide,
    leagueTier: CHAMPIONSHIP_CONFIG.tier,
    opponentSeed: series.opponent.seed,
    opponentMean: series.opponent.mean,
    opponent: series.opponent.team,
  })
}

const validId = (id: unknown) => id === undefined || (typeof id === 'string' && id.length > 0 && id.length <= 200)
const startKey = (req: StartSeriesRequest) => `start:${req.requestId ?? ''}`
const gameKey = (req: PlayGameRequest) => `game:${req.requestId ?? ''}`

/** 開始系列賽的檢查（用結算完到期比賽之後的球團）：可以開始回傳 null；重送回傳原本的系列賽 */
export function checkStart(club: ClubSave, req: StartSeriesRequest): ActiveSeries | null {
  if (!Number.isSafeInteger(req.seriesSeq) || req.seriesSeq < 0 || !validId(req.requestId)) throw new ChampionshipError('bad-request', '開始系列賽的請求不合法')
  const ch = club.championship
  if (ch.active && ch.active.seq === req.seriesSeq && ch.active.requestKey === startKey(req)) return ch.active
  if (req.seriesSeq !== ch.nextSeriesSeq) throw new ChampionshipError('stale-request', '冠軍賽狀態已經改變（可能其他分頁剛開始或打完系列賽），請重新讀取後再試一次')
  if (ch.active) throw new ChampionshipError('in-progress', '已經有進行中的系列賽')
  const e = championshipEligibility(club)
  if (!e.tier.ok) throw new ChampionshipError('not-legend', '只有傳奇聯盟的球團可以挑戰總冠軍賽')
  if (!e.cooldown.ok) throw new ChampionshipError('cooldown', `還要再打 ${e.cooldown.remaining} 場一般比賽才能再挑戰`)
  if (!e.ok) throw new ChampionshipError('not-eligible', '還沒有達到總冠軍賽的資格')
  return null
}

/** 打下一場的檢查：可以打回傳 null；重送回傳原本那一場 */
export function checkGame(club: ClubSave, req: PlayGameRequest): SeriesGame | null {
  if (!Number.isSafeInteger(req.seriesSeq) || req.seriesSeq < 0 || !Number.isSafeInteger(req.game) || req.game < 1 || req.game > CHAMPIONSHIP_CONFIG.maxGames || !validId(req.requestId)) {
    throw new ChampionshipError('bad-request', '冠軍賽的請求不合法')
  }
  const ch = club.championship
  const last = ch.lastGame
  if (last && last.seriesSeq === req.seriesSeq && last.game.game === req.game && last.game.requestKey === gameKey(req)) return last.game
  const a = ch.active
  if (!a) {
    if (req.seriesSeq < ch.nextSeriesSeq) throw new ChampionshipError('stale-request', '這個系列賽已經結束，請重新讀取')
    throw new ChampionshipError('no-series', '沒有進行中的系列賽')
  }
  if (a.seq !== req.seriesSeq || a.games.length + 1 !== req.game) throw new ChampionshipError('stale-request', '這一場已經打過了（可能其他分頁剛打完），請重新讀取後再試一次')
  return null
}

// ---- 服務 ----

/** 在鎖裡：讀存檔、結算到期的一般比賽；回傳結算後的球團與「只存結算」的函式 */
async function settleFirst(deps: SettlementDeps, what: string) {
  const club = deps.store.loadClub()
  if (!club) throw new SettlementError('no-club', '還沒有球團存檔')
  const now = deps.clock.now()
  const { next, batch } = await settleDueUnsaved(club, now, deps)
  const settledMatches = next.settled.length
  const saveSettled = () => (settledMatches > 0 ? deps.store.saveClub(next.club, club.revision) : club)
  if (batch.status !== 'completed') {
    saveSettled()
    throw new SettlementError('simulation-failed', `${what}前的結算沒有完成：${batch.failedMatchId ?? batch.status}`, undefined, { cause: batch.error })
  }
  return { club, now, settled: next.club, settledMatches, saveSettled }
}

const withSettled = (e: unknown, settledMatches: number, save: () => ClubSave) => {
  if (e instanceof ChampionshipError && settledMatches > 0) e.settled = { club: save(), matches: settledMatches }
  return e
}

/** 開始系列賽（冪等）：先結算到期的一般比賽，再檢查資格、產生並固定冠軍隊，一次存檔。不打任何一場 */
export function startSeries(deps: SettlementDeps, req: StartSeriesRequest): Promise<StartSeriesOutcome> {
  return deps.lock.run(async () => {
    const s = await settleFirst(deps, '開始系列賽')
    let dup: ActiveSeries | null
    try {
      dup = checkStart(s.settled, req)
    } catch (e) {
      throw withSettled(e, s.settledMatches, s.saveSettled)
    }
    if (dup) return { club: s.saveSettled(), series: dup, duplicate: true, settledMatches: s.settledMatches }
    const seq = s.settled.championship.nextSeriesSeq
    const started = startSeriesState(s.settled, championOpponent(s.settled, seq), startKey(req), s.now)
    const saved = deps.store.saveClub(started, s.club.revision)
    return { club: saved, series: saved.championship.active!, duplicate: false, settledMatches: s.settledMatches }
  })
}

/** 打進行中系列賽的下一場（冪等）：先結算到期的一般比賽，再模擬這一場、記錄（必要時結束系列賽），一次存檔 */
export function playSeriesGame(deps: SettlementDeps, req: PlayGameRequest): Promise<PlayGameOutcome> {
  return deps.lock.run(async () => {
    const s = await settleFirst(deps, '冠軍賽')
    let dup: SeriesGame | null
    try {
      dup = checkGame(s.settled, req)
    } catch (e) {
      throw withSettled(e, s.settledMatches, s.saveSettled)
    }
    if (dup) {
      const club = s.saveSettled()
      const completed = club.championship.active ? null : (club.championship.history.find((h) => h.seq === req.seriesSeq) ?? null)
      return { club, game: dup, completed, firstTitle: !!completed?.won && club.championship.firstTitle?.seriesSeq === req.seriesSeq, duplicate: true, settledMatches: s.settledMatches }
    }
    const series = s.settled.championship.active!
    const plan = planSeriesGame(s.settled, series, req.game)
    const run = await runBatch([plan], { ...deps.batch })
    if (run.status !== 'completed' || run.outcomes.length !== 1) {
      s.saveSettled()
      throw new SettlementError('simulation-failed', '冠軍賽模擬失敗，這一場沒有打，可以再試一次', undefined, { cause: run.error })
    }
    const { result } = run.outcomes[0]
    const other: Side = plan.userSide === 'home' ? 'away' : 'home'
    const game: SeriesGame = {
      game: req.game,
      matchId: plan.matchId,
      seed: plan.seed,
      userSide: plan.userSide,
      won: result.winner === plan.userSide,
      runsFor: result.score[plan.userSide],
      runsAgainst: result.score[other],
      innings: result.innings,
      at: s.now,
      matchIndexAt: s.settled.idle.nextMatchIndex,
      requestKey: gameKey(req),
    }
    const hadTitle = s.settled.championship.firstTitle !== null
    const recorded = recordSeriesGame(s.settled, game, structuredClone(result.replay), s.now)
    const saved = deps.store.saveClub(recorded, s.club.revision)
    const completed = saved.championship.active ? null : saved.championship.history.at(-1)!
    return { club: saved, game, completed, firstTitle: !hadTitle && saved.championship.firstTitle !== null, duplicate: false, settledMatches: s.settledMatches }
  })
}
