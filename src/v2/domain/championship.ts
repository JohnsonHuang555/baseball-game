// 傳奇總冠軍賽（Phase 10 PR 1）：資格、七戰四勝狀態機、首次奪冠紀錄、存檔驗證。全部是純函式、確定性。
//
// 狀態機（championshipView 是唯一的判斷，畫面不另外判斷規則）：
//   locked ──（到傳奇）──▶ not-eligible ──（條件都達到）──▶ eligible ──（開始系列賽）──▶ in-progress
//   in-progress ──（先拿 4 勝）──▶ won（首次奪冠紀錄、冠軍次數 +1）──▶ cooldown ──▶ eligible／not-eligible
//   in-progress ──（先輸 4 場）──▶ lost ──▶ cooldown ──▶ …
// - 還沒開始系列賽：降級就失去資格（回到 locked／not-eligible）
// - 已經開始的系列賽：中途降級照樣可以打完（active 不清掉）；打完後球團留在實際所在的聯盟
// - 冠軍賽不影響聯盟積分、一般比賽游標、收益、生涯數據、特性訓練、MVP；冠軍頭銜永久保留
//
// 編號與種子（只由球團種子與序號決定，重新整理、跨分頁都一樣）：
//   系列賽：seriesSeq = championship.nextSeriesSeq，seriesId = `<球團>#s<seq>`
//   對手：deriveSeed(clubSeed, seriesSeq, SEED_SALT.championshipOpponent) 產生，開始時把整支球隊存進系列賽（之後不再重新產生）
//   第 n 場（1～7）：matchId = `<球團>#s<seq>g<n>`，種子 deriveSeed(clubSeed, seriesSeq × 8 + n, SEED_SALT.championship)
//   主客場 2-3-2：冠軍隊（對手）第 1、2、6、7 場主場，我方第 3、4、5 場主場
import type { Side } from '../../sim/game'
import type { Team } from '../../sim/types'
import type { MatchReplay } from '../application/matchRunner'
import { ARCHETYPES, type Archetype } from '../../sim/types'
import type { ClubSave } from './club'
import { recentWinRate } from './league'
import { MAX_TIER, PROMOTION_CONFIG } from './leagueConfig'
import { isObj, type Obj } from './validation'

export const CHAMPIONSHIP_CONFIG = {
  /** 只有傳奇聯盟可以挑戰 */
  tier: MAX_TIER,
  /** 資格：沿用晉級的本聯盟場數、最近 60 場勝率，加上傳奇的競技積分 */
  minMatches: PROMOTION_CONFIG.minMatches,
  window: PROMOTION_CONFIG.window,
  winRate: PROMOTION_CONFIG.winRate,
  minPoints: 70,
  /** 七戰四勝 */
  winsNeeded: 4,
  maxGames: 7,
  /** 冠軍隊的能力中心（傳奇一般對手 6.6、傳奇的晉級挑戰 6.85）。見 docs/balance/v2-phase10-championship.md */
  opponentMean: 7.1,
  /**
   * 系列賽結束（不管輸贏）後，要再打幾場一般比賽才能再開始下一個系列賽：288 場（連續遊玩 24 小時；
   * 離線最多算 96 場，所以每天上線 2 次大約要 1.5 天）。
   * 96 場（8 小時）時強隊每次上線都能再打一輪（120 天最多 167 個系列賽），冠軍次數失去意義；
   * 改成 288 場，第一次奪冠的時間與挑戰次數幾乎不變（平衡報告 D 節）
   */
  retryAfterMatches: 288,
  /** 保留最近幾個已結束的系列賽 */
  historyLimit: 10,
  /** 冠軍隊的固定隊名 */
  opponentName: '傳奇王朝',
} as const

// ---- 資料 ----

/** 一場冠軍賽的結果 */
export interface SeriesGame {
  /** 第幾場（1～7） */
  game: number
  matchId: string
  seed: number
  userSide: Side
  won: boolean
  runsFor: number
  runsAgainst: number
  innings: number
  /** 打這場的時間、當時一般比賽的結算游標（只做紀錄） */
  at: number
  matchIndexAt: number
  /** 請求內容：重送時比對 */
  requestKey: string
}

/** 冠軍隊：開始系列賽時產生並整支存下來，整個系列賽都是同一支 */
export interface ChampionOpponent {
  name: string
  /** 風格（由陣容的流派決定，只做顯示） */
  style: Archetype
  mean: number
  seed: number
  team: Team
}

export interface ActiveSeries {
  seq: number
  id: string
  startedAt: number
  startedAtMatch: number
  /** 開始時的聯盟（一定是傳奇；之後降級不影響這個系列賽） */
  requestKey: string
  opponent: ChampionOpponent
  games: SeriesGame[]
}

/** 已結束的系列賽（精簡） */
export interface SeriesRecord {
  seq: number
  id: string
  opponentName: string
  won: boolean
  wins: number
  losses: number
  startedAt: number
  completedAt: number
  completedAtMatch: number
  /** 每一場：[我方得分, 對手得分]（勝負由比分決定） */
  scores: [number, number][]
}

/** 首次奪冠（永久，之後再奪冠也不會改） */
export interface FirstTitle {
  seriesSeq: number
  seriesId: string
  at: number
  wins: number
  losses: number
  clubId: string
  clubName: string
  /** 奪冠時一般比賽的結算游標 */
  matchIndexAt: number
}

export interface ChampionshipState {
  /** 下一個系列賽的序號（開始系列賽的請求帶上它） */
  nextSeriesSeq: number
  active: ActiveSeries | null
  history: SeriesRecord[]
  /** 累積冠軍次數 */
  titles: number
  firstTitle: FirstTitle | null
  /** 一般比賽的結算游標要到這個數字，才能開始下一個系列賽（系列賽結束後的冷卻） */
  readyAt: number
  /**
   * 最近一場冠軍賽：結果與完整 Replay（只留一場，跟一般比賽、晉級挑戰的 Replay 分開）。
   * 系列賽結束後 active 會清掉，所以「決定勝負那一場」的重送靠這裡辨認
   */
  lastGame: { seriesSeq: number; game: SeriesGame; replay: MatchReplay } | null
}

export const newChampionshipState = (): ChampionshipState => ({ nextSeriesSeq: 0, active: null, history: [], titles: 0, firstTitle: null, readyAt: 0, lastGame: null })

// ---- 編號與種子 ----

export const seriesIdFor = (club: Pick<ClubSave, 'clubId'>, seq: number) => `${club.clubId}#s${seq}`
export const gameMatchIdFor = (club: Pick<ClubSave, 'clubId'>, seq: number, game: number) => `${club.clubId}#s${seq}g${game}`
/** 種子用的序號：每個系列賽保留 8 個（第 1～7 場） */
export const gameSeedIndex = (seq: number, game: number) => seq * 8 + game
/** 2-3-2：冠軍隊第 1、2、6、7 場主場 */
export const userSideForGame = (game: number): Side => (game >= 3 && game <= 5 ? 'home' : 'away')

/** 陣容的流派：先發九棒裡最多的那一種（同數取流派順序前面的） */
export function teamStyle(team: Team): Archetype {
  const count = new Map<Archetype, number>(ARCHETYPES.map((a) => [a, 0]))
  for (const s of team.roster.lineup) count.set(s.player.archetype, (count.get(s.player.archetype) ?? 0) + 1)
  return [...ARCHETYPES].sort((a, b) => count.get(b)! - count.get(a)! || ARCHETYPES.indexOf(a) - ARCHETYPES.indexOf(b))[0]
}

// ---- 系列賽的狀態 ----

export const seriesWins = (s: Pick<ActiveSeries, 'games'>) => s.games.filter((g) => g.won).length
export const seriesLosses = (s: Pick<ActiveSeries, 'games'>) => s.games.filter((g) => !g.won).length
/** 系列賽結束了嗎：一方先拿到 4 勝 */
export const seriesOver = (s: Pick<ActiveSeries, 'games'>) => seriesWins(s) >= CHAMPIONSHIP_CONFIG.winsNeeded || seriesLosses(s) >= CHAMPIONSHIP_CONFIG.winsNeeded

// ---- 資格 ----

export interface ChampionshipEligibility {
  ok: boolean
  /** 各條件：是否在傳奇、本聯盟場數、最近 60 場勝率（場數不足 60 不算達標）、競技積分、冷卻 */
  tier: { have: number; need: number; ok: boolean }
  matches: { have: number; need: number; ok: boolean }
  winRate: { have: number; need: number; games: number; window: number; ok: boolean }
  points: { have: number; need: number; ok: boolean }
  cooldown: { remaining: number; ok: boolean }
}

/** 能不能開始新的系列賽（跟有沒有進行中的系列賽無關；進行中由狀態機另外處理） */
export function championshipEligibility(club: Pick<ClubSave, 'league' | 'idle' | 'championship'>): ChampionshipEligibility {
  const L = club.league
  const C = CHAMPIONSHIP_CONFIG
  const tier = { have: L.tier, need: C.tier, ok: L.tier === C.tier }
  const matches = { have: L.matches, need: C.minMatches, ok: tier.ok && L.matches >= C.minMatches }
  const winRate = { have: recentWinRate(L), need: C.winRate, games: L.recent.length, window: C.window, ok: tier.ok && L.recent.length >= C.window && recentWinRate(L) >= C.winRate }
  const points = { have: L.points ?? 0, need: C.minPoints, ok: tier.ok && (L.points ?? 0) >= C.minPoints }
  const remaining = Math.max(0, club.championship.readyAt - club.idle.nextMatchIndex)
  const cooldown = { remaining, ok: remaining === 0 }
  return { ok: tier.ok && matches.ok && winRate.ok && points.ok && cooldown.ok, tier, matches, winRate, points, cooldown }
}

// ---- 狀態機（畫面只讀這裡） ----

export type ChampionshipStatus =
  /** 不在傳奇聯盟、也沒有進行中的系列賽 */
  | 'locked'
  /** 在傳奇，但還沒達到條件 */
  | 'not-eligible'
  /** 剛結束一個系列賽，冷卻中 */
  | 'cooldown'
  /** 可以開始系列賽 */
  | 'eligible'
  /** 系列賽進行中（中途降級也照樣可以打完） */
  | 'in-progress'

export interface ChampionshipView {
  status: ChampionshipStatus
  eligibility: ChampionshipEligibility
  /** 進行中的系列賽 */
  series: { seq: number; id: string; wins: number; losses: number; nextGame: number; winsToTitle: number; lossesToElimination: number; opponent: { name: string; style: Archetype; mean: number }; games: SeriesGame[] } | null
  /** 進行中但已經不在傳奇（中途降級）：照樣可以打完 */
  relegatedDuringSeries: boolean
  /** 曾經到過傳奇、現在降級了（沒有進行中的系列賽） */
  relegated: boolean
  /** 最近一個已結束的系列賽 */
  last: SeriesRecord | null
  titles: number
  firstTitle: FirstTitle | null
  /** 下一個系列賽的序號（開始請求帶上它） */
  nextSeriesSeq: number
}

export function championshipView(club: Pick<ClubSave, 'league' | 'idle' | 'championship'>): ChampionshipView {
  const ch = club.championship
  const e = championshipEligibility(club)
  const a = ch.active
  const series = a
    ? (() => {
        const wins = seriesWins(a)
        const losses = seriesLosses(a)
        return {
          seq: a.seq,
          id: a.id,
          wins,
          losses,
          nextGame: a.games.length + 1,
          winsToTitle: CHAMPIONSHIP_CONFIG.winsNeeded - wins,
          lossesToElimination: CHAMPIONSHIP_CONFIG.winsNeeded - losses,
          opponent: { name: a.opponent.name, style: a.opponent.style, mean: a.opponent.mean },
          games: a.games,
        }
      })()
    : null
  let status: ChampionshipStatus
  if (a) status = 'in-progress'
  else if (!e.tier.ok) status = 'locked'
  else if (!e.cooldown.ok) status = 'cooldown'
  else if (!e.ok) status = 'not-eligible'
  else status = 'eligible'
  return {
    status,
    eligibility: e,
    series,
    relegatedDuringSeries: !!a && club.league.tier !== CHAMPIONSHIP_CONFIG.tier,
    relegated: !a && club.league.highestTier >= CHAMPIONSHIP_CONFIG.tier && club.league.tier < CHAMPIONSHIP_CONFIG.tier,
    last: ch.history.at(-1) ?? null,
    titles: ch.titles,
    firstTitle: ch.firstTitle,
    nextSeriesSeq: ch.nextSeriesSeq,
  }
}

// ---- 狀態轉換（純函式，不改輸入） ----

/** 開始系列賽：呼叫端已經確認資格與序號 */
export function startSeriesState(club: ClubSave, opponent: ChampionOpponent, requestKey: string, now: number): ClubSave {
  const ch = club.championship
  if (ch.active) throw new RangeError('已經有進行中的系列賽')
  const seq = ch.nextSeriesSeq
  const active: ActiveSeries = { seq, id: seriesIdFor(club, seq), startedAt: now, startedAtMatch: club.idle.nextMatchIndex, requestKey, opponent, games: [] }
  return { ...club, championship: { ...ch, active, nextSeriesSeq: seq + 1 } }
}

/**
 * 記一場冠軍賽（呼叫端已經確認是進行中系列賽的下一場）。系列賽一方拿到 4 勝就結束：
 * 移進歷史、設冷卻；贏了冠軍次數 +1，第一次奪冠寫首次奪冠紀錄（之後不再改）
 */
export function recordSeriesGame(club: ClubSave, game: SeriesGame, replay: MatchReplay, now: number): ClubSave {
  const ch = club.championship
  const a = ch.active
  if (!a) throw new RangeError('沒有進行中的系列賽')
  if (seriesOver(a)) throw new RangeError('系列賽已經結束')
  if (game.game !== a.games.length + 1) throw new RangeError(`應該是第 ${a.games.length + 1} 場，收到第 ${game.game} 場`)
  const active: ActiveSeries = { ...a, games: [...a.games, game] }
  const lastGame = { seriesSeq: a.seq, game, replay }
  if (!seriesOver(active)) return { ...club, championship: { ...ch, active, lastGame } }
  const wins = seriesWins(active)
  const losses = seriesLosses(active)
  const won = wins >= CHAMPIONSHIP_CONFIG.winsNeeded
  const record: SeriesRecord = {
    seq: a.seq,
    id: a.id,
    opponentName: a.opponent.name,
    won,
    wins,
    losses,
    startedAt: a.startedAt,
    completedAt: now,
    completedAtMatch: club.idle.nextMatchIndex,
    scores: active.games.map((g) => [g.runsFor, g.runsAgainst]),
  }
  const firstTitle: FirstTitle | null =
    ch.firstTitle ?? (won ? { seriesSeq: a.seq, seriesId: a.id, at: now, wins, losses, clubId: club.clubId, clubName: club.clubName, matchIndexAt: club.idle.nextMatchIndex } : null)
  return {
    ...club,
    championship: {
      ...ch,
      active: null,
      history: [...ch.history, record].slice(-CHAMPIONSHIP_CONFIG.historyLimit),
      titles: ch.titles + (won ? 1 : 0),
      firstTitle,
      readyAt: club.idle.nextMatchIndex + CHAMPIONSHIP_CONFIG.retryAfterMatches,
      lastGame,
    },
  }
}

// ---- 存檔驗證 ----

const isInt = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min

function gameIssues(g: unknown, i: number, seq: number, clubId: string): string[] {
  if (!isObj(g)) return [`第 ${i + 1} 場格式不對`]
  const out: string[] = []
  if (g.game !== i + 1) out.push(`第 ${i + 1} 場的場次編號不對`)
  if (g.matchId !== `${clubId}#s${seq}g${i + 1}`) out.push(`第 ${i + 1} 場的比賽編號不對`)
  if (!isInt(g.seed)) out.push(`第 ${i + 1} 場的種子不對`)
  if (g.userSide !== userSideForGame(i + 1)) out.push(`第 ${i + 1} 場的主客場不對`)
  if (typeof g.won !== 'boolean' || !isInt(g.runsFor) || !isInt(g.runsAgainst) || !isInt(g.innings, 9)) out.push(`第 ${i + 1} 場的結果格式不對`)
  else if (g.won !== (g.runsFor > g.runsAgainst)) out.push(`第 ${i + 1} 場的勝負跟比分不符`)
  if (typeof g.at !== 'number' || !isInt(g.matchIndexAt) || typeof g.requestKey !== 'string') out.push(`第 ${i + 1} 場的紀錄不完整`)
  return out
}

/** 冠軍賽資料的不變量（空陣列代表正常） */
export function championshipIssues(value: unknown, club: { clubId: string; nextMatchIndex: number }): string[] {
  if (!isObj(value)) return ['championship 必須是物件']
  const out: string[] = []
  const v = value as Record<string, unknown>
  if (!isInt(v.nextSeriesSeq)) out.push('nextSeriesSeq 不合法')
  if (!isInt(v.titles)) out.push('冠軍次數不合法')
  if (!isInt(v.readyAt)) out.push('冷卻場次不合法')
  if (!Array.isArray(v.history)) return [...out, 'history 必須是陣列']
  const next = v.nextSeriesSeq as number
  const history = v.history as unknown[]
  if (history.length > CHAMPIONSHIP_CONFIG.historyLimit) out.push('系列賽紀錄超過保留上限')
  let lastSeq = -1
  for (const [i, h] of history.entries()) {
    if (!isObj(h)) {
      out.push(`history[${i}] 格式不對`)
      continue
    }
    const r = h as unknown as SeriesRecord
    if (!isInt(r.seq) || r.seq <= lastSeq || r.seq >= next) out.push(`history[${i}] 的序號不對`)
    else lastSeq = r.seq
    if (r.id !== `${club.clubId}#s${r.seq}`) out.push(`history[${i}] 的系列賽編號不對`)
    if (!Array.isArray(r.scores) || r.scores.some((s) => !Array.isArray(s) || s.length !== 2 || !isInt(s[0]) || !isInt(s[1]) || s[0] === s[1])) {
      out.push(`history[${i}] 的比分不對`)
      continue
    }
    const wins = r.scores.filter((s) => s[0] > s[1]).length
    const losses = r.scores.length - wins
    if (r.wins !== wins || r.losses !== losses) out.push(`history[${i}] 的勝敗跟比分不符`)
    if (r.won !== (wins === CHAMPIONSHIP_CONFIG.winsNeeded) || (wins !== CHAMPIONSHIP_CONFIG.winsNeeded && losses !== CHAMPIONSHIP_CONFIG.winsNeeded)) out.push(`history[${i}] 不是打完的七戰四勝`)
    if (wins > CHAMPIONSHIP_CONFIG.winsNeeded || losses > CHAMPIONSHIP_CONFIG.winsNeeded || r.scores.length > CHAMPIONSHIP_CONFIG.maxGames) out.push(`history[${i}] 超過七戰四勝`)
    // 最後一場決定勝負：之前不能已經有一方 4 勝
    const pre = r.scores.slice(0, -1)
    const preW = pre.filter((s) => s[0] > s[1]).length
    if (preW >= CHAMPIONSHIP_CONFIG.winsNeeded || pre.length - preW >= CHAMPIONSHIP_CONFIG.winsNeeded) out.push(`history[${i}] 在系列賽結束後還有比賽`)
    if (!isInt(r.completedAtMatch) || r.completedAtMatch > club.nextMatchIndex) out.push(`history[${i}] 的結束場次不對`)
  }
  const wonInHistory = history.filter((h) => isObj(h) && (h as { won?: unknown }).won === true).length
  if (isInt(v.titles) && (v.titles as number) < wonInHistory) out.push('冠軍次數少於紀錄裡的冠軍')
  // 首次奪冠
  const ft = v.firstTitle
  if (ft === null) {
    if ((v.titles as number) > 0) out.push('有冠軍次數卻沒有首次奪冠紀錄')
  } else if (!isObj(ft)) out.push('首次奪冠紀錄格式不對')
  else {
    const f = ft as unknown as FirstTitle
    if ((v.titles as number) < 1) out.push('有首次奪冠紀錄但冠軍次數是 0')
    if (!isInt(f.seriesSeq) || f.seriesSeq >= next || f.seriesId !== `${club.clubId}#s${f.seriesSeq}`) out.push('首次奪冠的系列賽不對')
    if (f.wins !== CHAMPIONSHIP_CONFIG.winsNeeded || !isInt(f.losses) || f.losses >= CHAMPIONSHIP_CONFIG.winsNeeded) out.push('首次奪冠的比分不對')
    if (typeof f.clubId !== 'string' || typeof f.clubName !== 'string' || typeof f.at !== 'number' || !isInt(f.matchIndexAt)) out.push('首次奪冠紀錄不完整')
    const h = history.find((x) => isObj(x) && (x as { seq?: unknown }).seq === f.seriesSeq) as SeriesRecord | undefined
    if (h && (!h.won || h.wins !== f.wins || h.losses !== f.losses)) out.push('首次奪冠紀錄跟系列賽紀錄不符')
  }
  // 進行中的系列賽
  const a = v.active
  if (a !== null) {
    if (!isObj(a)) out.push('active 格式不對')
    else {
      const s = a as unknown as ActiveSeries
      if (s.seq !== next - 1) out.push('進行中系列賽的序號應該是 nextSeriesSeq − 1')
      if (s.seq <= lastSeq) out.push('進行中系列賽的序號比已結束的還小')
      if (s.id !== `${club.clubId}#s${s.seq}`) out.push('進行中系列賽的編號不對')
      if (!isInt(s.startedAtMatch) || s.startedAtMatch > club.nextMatchIndex || typeof s.startedAt !== 'number' || typeof s.requestKey !== 'string') out.push('進行中系列賽的紀錄不完整')
      const o = s.opponent as unknown as Partial<ChampionOpponent> | null
      if (!isObj(o) || typeof o.name !== 'string' || !ARCHETYPES.includes(o.style as Archetype) || typeof o.mean !== 'number' || !isInt(o.seed) || !teamLooksValid(o.team)) {
        out.push('冠軍隊資料不對')
      }
      if (!Array.isArray(s.games)) out.push('進行中系列賽的比賽必須是陣列')
      else {
        if (s.games.length >= CHAMPIONSHIP_CONFIG.maxGames) out.push('進行中系列賽的比賽太多')
        s.games.forEach((g, i) => out.push(...gameIssues(g, i, s.seq, club.clubId)))
        if (s.games.every((g) => isObj(g) && typeof g.won === 'boolean') && seriesOver(s)) out.push('系列賽已經有一方 4 勝，不應該還在進行中')
      }
    }
  }
  // 最近一場：一定是進行中系列賽的最後一場，或最近結束的系列賽的最後一場
  const r = v.lastGame
  if (r === undefined) out.push('缺少 lastGame')
  else if (r !== null) {
    const x = r as { seriesSeq?: unknown; game?: unknown; replay?: unknown }
    if (!isObj(r) || !isInt(x.seriesSeq) || !isObj(x.replay) || !isObj((x.replay as Obj).setup) || !Array.isArray((x.replay as Obj).commands)) out.push('最近一場冠軍賽的格式不對')
    else {
      const seq = x.seriesSeq as number
      const g = x.game as { game?: unknown } | undefined
      const issues = isObj(g) && isInt(g.game, 1) ? gameIssues(g, (g.game as number) - 1, seq, club.clubId) : ['最近一場冠軍賽的比賽格式不對']
      out.push(...issues.map((s) => `最近一場：${s}`))
      const act = isObj(a) ? (a as unknown as ActiveSeries) : null
      const lastHist = history.at(-1) as SeriesRecord | undefined
      const matchesActive = act && act.seq === seq && Array.isArray(act.games) && act.games.length === (g?.game as number) && JSON.stringify(act.games.at(-1)) === JSON.stringify(g)
      const matchesHistory = (!act || (Array.isArray(act.games) && act.games.length === 0)) && isObj(lastHist) && lastHist.seq === seq && Array.isArray(lastHist.scores) && lastHist.scores.length === (g?.game as number)
      if (!issues.length && !matchesActive && !matchesHistory) out.push('最近一場冠軍賽跟系列賽對不起來')
    }
  } else if (isObj(a) && Array.isArray((a as unknown as ActiveSeries).games) && (a as unknown as ActiveSeries).games.length > 0) out.push('進行中的系列賽打過比賽，卻沒有最近一場的紀錄')
  return out
}

function teamLooksValid(t: unknown): boolean {
  if (!isObj(t) || typeof t.name !== 'string' || !isObj(t.roster)) return false
  const r = t.roster as Record<string, unknown>
  return Array.isArray(r.lineup) && r.lineup.length === 9 && Array.isArray(r.bench) && isObj(r.starter) && Array.isArray(r.relievers)
}
