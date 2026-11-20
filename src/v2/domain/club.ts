// V2 球團存檔（schemaVersion 12）：球團、永久球員名單、陣容配置、戰術（四種風格）、經濟、聯盟進度、放置進度、
// 進行中比賽的固定計畫、近期比賽（含 Box Score、球員原始數據與戰術摘要）、特性培養（球員的習得／改善特性與訓練槽）、球員生涯數據、最近一次晉級挑戰的 Replay 與新手任務的旗標。
// 不沿用 V1 的 Tournament：錦標賽是一輪一輪的 roguelike，V2 的球團要一直存在、一直累積。
// 這裡只有資料型別與純函式，不碰儲存、時間或亂數狀態。舊的 schemaVersion 3 見 legacyV3.ts、遷移（3 → 4 → … → 11 → 12）見 migration.ts
import type { Side } from '../../sim/game'
import { TRAITS, type TraitId } from '../../sim/traits'
import type { Player, Position, Roster } from '../../sim/types'
import { COACH_STYLES, type CoachParams, type CoachStyle } from '../application/autoCoach'
import type { MatchPlan } from '../application/batchRunner'
import type { MatchReplay } from '../application/matchRunner'
import { tacticsRecordIssue, type TacticsRecord } from './matchTactics'
import { lineupIssues } from './lineup'
import { leagueViolations, newLeagueState, type LeagueState, type RankedMatchRecord } from './league'
import { MAX_TIER } from './leagueConfig'
import { newOnboarding, type OnboardingState } from './onboarding'
import { MAX_LEVEL, RECRUIT_CONFIG, SPEND_LOG_LIMIT } from './progressionConfig'
import { resolveRoster } from './roster'
import { BAT_STORE, PIT_STORE, newClubStats, type ClubStats, type MatchLines } from './stats'
import { coachParamIssues } from './tactics'
import { matchMvpIssue, mvpIssues, unpackMvp, type MatchMvpRecord, type MvpRecord } from './mvp'
import { POTENTIAL_VERSION, TRAINING_CONFIG, TRAINING_RECENT_LIMIT, developmentIssues, newTrainingState, staticTrainingBlock, trainingClass, type TrainingKind, type TrainingState } from './traitTraining'
import { ClubValidationError, arr, int, invalid, isObj, num, obj, player, str, validateMatches, type Obj } from './validation'

export { ClubValidationError, type ClubValidationCode } from './validation'

export const CLUB_SCHEMA_VERSION = 13

/**
 * 換算好的陣容：先發、板凳、投手都是完整的球員物件（養成後的能力），也就是模擬引擎吃的 Roster。
 * 畫面編輯陣容、比賽開打前的快照都用這個；存檔裡存的是只有球員 ID 的 RosterAssignment
 */
export type PersistentRoster = Roster

/** 陣容配置：只存球員 ID。不在配置裡的球員是預備名單 */
export interface RosterAssignment {
  lineup: { playerId: string; position: Position }[]
  bench: string[]
  starter: string
  relievers: string[]
  captain?: string
}

export type PlayerOrigin = 'founding' | 'recruit' | 'migrated'

/** 永久球員資料：原始能力（Lv.1）、等級。養成後的能力由 progression.ts 算出來，不另外存 */
export interface PlayerRecord {
  player: Player
  level: number
  origin: PlayerOrigin
  /** 加入時是第幾場比賽（結算游標） */
  joinedAtMatch: number
  /** 特性培養的結果（schemaVersion 12 起；沒有養成就不寫）：習得的正面特性、已改善的原生負面特性，見 traitTraining.ts */
  dev?: { learned: TraitId[]; removed: TraitId[] }
  /** 單場 MVP 的生涯次數與永久能力成長（schemaVersion 13 起；從沒得過 MVP 就不寫），見 mvp.ts */
  mvp?: MvpRecord
}

/** 球團的戰術設定；effectiveFromMatch 是這份設定從第幾場開始生效 */
export interface TeamStrategies {
  coach: { style: CoachStyle; params?: Partial<CoachParams> }
  effectiveFromMatch: number
}

export interface Resources {
  funds: number
  experience: number
}

/** 一筆名單操作（升級、招募、釋出）：原因、對象、金額（釋出是 0）、時間，以及用來辨識重送的請求內容 */
export interface SpendRecord {
  seq: number
  /** trainStart：開始特性訓練（扣款）；trainCancel：取消訓練（0 元，不退款）；schemaVersion 12 起 */
  kind: 'upgrade' | 'recruit' | 'release' | 'trainStart' | 'trainCancel'
  playerId: string
  cost: Resources
  at: number
  /** 請求內容（序號以外）：同一個序號重送時比對，確認是同一個請求 */
  requestKey: string
  fromLevel?: number
  toLevel?: number
  recruitIndex?: number
  /** 招募：簽下的是候選名單的第幾位（0～2）。舊版的隨機招募沒有這個欄位 */
  candidateIndex?: number
  /** 特性訓練：訓練的特性 */
  trait?: TraitId
}

/**
 * 經濟：unclaimed（已結算、還沒領取）、assets（已領取、可以花的）、earned（累計所有收入）、spent（累計所有支出）。
 * 不變量：assets + unclaimed + spent = earned（資金、經驗分開算，見 economyViolations）。
 * 之後如果有免費獎勵，算進 earned；退款也算收入（earned），spent 只增不減
 */
export interface EconomyState {
  assets: Resources
  unclaimed: Resources
  earned: Resources
  spent: Resources
  /**
   * 領取序號：下一次領取必須帶這個號碼，成功後加 1。號碼比它小的請求一律當作已處理，
   * 所以不管過了多久、領了幾次，舊請求重送都不會再入帳；存檔只多一個整數
   */
  nextClaimSeq: number
  /** 上一次成功的領取：重送同一個請求時回傳當時領到的數字 */
  lastClaim: { seq: number; claimed: Resources } | null
  /** 支出序號：升級、招募共用。用法跟 nextClaimSeq 一樣，比目前小的請求不會再生效 */
  nextOpSeq: number
  /** 最近的支出（最多 SPEND_LOG_LIMIT 筆，最後一筆一定是 nextOpSeq − 1）；累計在 spent */
  recentOps: SpendRecord[]
}

/** 放置進度：anchorMs 之前的時間已經換成比賽；nextMatchIndex 是結算游標，比它小的場次都已結算 */
export interface IdleState {
  anchorMs: number
  nextMatchIndex: number
  lastSettledAt: number | null
}

/** 已結算的戰績：永久保存 */
export interface ClubRecord {
  wins: number
  losses: number
  runsFor: number
  runsAgainst: number
}

export interface SummaryHighlight {
  kind: 'homeRun' | 'clutchHit' | 'walkOff'
  inning: number
  half: 'top' | 'bottom'
  playerId: string
  playerName: string
  runs: number
  /** 我方做的（不是對手） */
  ours: boolean
}

/** 一場比賽留在存檔裡的摘要（完整結果太大，不長期保存） */
export interface MatchSummary {
  userSide: Side
  opponentName: string
  /** 我方、對手的得分 */
  runsFor: number
  runsAgainst: number
  won: boolean
  innings: number
  highlights: SummaryHighlight[]
  rulesVersion: number
  coachVersion: number
  /** 這場比賽所屬的聯盟階級（schemaVersion 5 起才有；更早的比賽都是新秀聯盟強度） */
  leagueTier?: number
}

/** Box Score 的打者成績（我方，依出場順序）：[名字, 打席, 安打, 全壘打, 打點, 被三振]，用陣列省空間 */
export type BoxBatter = [name: string, pa: number, hits: number, hr: number, rbi: number, so: number]

/** Box Score 的投手成績（我方）：[名字, 抓到的出局數, 失分, 三振] */
export type BoxPitcher = [name: string, outs: number, runs: number, k: number]

/** 結算時存下的精簡數據：看歷史戰報不需要重新模擬（schemaVersion 7 起） */
export interface BoxScore {
  linescore: Record<Side, number[]>
  hits: Record<Side, number>
  errors: Record<Side, number>
  batters: BoxBatter[]
  pitchers: BoxPitcher[]
}

/** 一場已結算的比賽 */
export interface SettledMatch {
  matchId: string
  matchIndex: number
  seed: number
  result: MatchSummary
  earnedFunds: number
  earnedExperience: number
  settledAt: number
  /** 預定結束時間（比賽日期）；schemaVersion 7 以前的比賽沒有 */
  playedAt?: number
  /** Box Score；schemaVersion 7 以前、而且沒有保留完整 Replay 的比賽沒有 */
  box?: BoxScore
  /** 這場的競技積分變化（schemaVersion 9 起、挑戰者以上的比賽才有；舊比賽沒有，畫面顯示「未記錄」） */
  ranked?: RankedMatchRecord
  /**
   * 我方每位出場球員的完整原始數據（schemaVersion 10 起的比賽才有，以 playerId 為 key）。
   * 有這個欄位時 box.batters／box.pitchers 是空陣列（不重複存）；舊比賽沒有，戰報缺的欄位顯示「未記錄」
   */
  lines?: MatchLines
  /** 我方這場實際執行的戰術（schemaVersion 11 起的比賽才有，精簡格式見 matchTactics.ts）；舊比賽沒有，戰報顯示「未記錄」，不用目前的戰術回填 */
  tactics?: TacticsRecord
  /** 我方這場的 MVP（schemaVersion 13 起的正式一般比賽才有）；舊比賽沒有，戰報顯示「未記錄」，不用目前的能力與舊數據回填 */
  mvp?: MatchMvpRecord
}

/**
 * 進行中那一場比賽的固定計畫：任何會改變球團的操作（換設定、升級、招募、釋出、晉級），
 * 都會先用「修改前」的狀態把這一場的計畫存下來，所以已經開始的比賽不受之後的修改影響。
 * 結算這一場時用這份計畫，結算完就清掉（見 application/liveMatch.ts）
 */
export interface LiveMatch {
  matchIndex: number
  plan: MatchPlan
}

/** 最近一次晉級挑戰賽的完整 Replay（只留一場）：seq 一定是最近一次挑戰的序號 */
export interface ChallengeReplay {
  seq: number
  matchId: string
  replay: MatchReplay
}

export interface ClubSaveV13 {
  schemaVersion: typeof CLUB_SCHEMA_VERSION
  clubId: string
  clubName: string
  /** 球團種子：每一場的種子、對手、每一次招募都由它推導 */
  clubSeed: number
  createdAt: number
  /** 永久球員名單：ID 唯一、不會被覆蓋 */
  players: PlayerRecord[]
  roster: RosterAssignment
  /** 已招募的次數：第幾次招募的亂數、成本、球員編號都由它決定，只增不減（釋出也不會減） */
  recruitment: { count: number }
  /** 聯盟進度：階級、本聯盟戰績、晉級挑戰 */
  league: LeagueState
  strategy: TeamStrategies
  economy: EconomyState
  idle: IdleState
  record: ClubRecord
  /** 近期比賽，舊的在前，最多 RETENTION_CONFIG.recentMatches 場 */
  recentMatches: SettledMatch[]
  /** 最近幾場的完整 replay，最多 RETENTION_CONFIG.replays 份 */
  replays: { matchId: string; replay: MatchReplay }[]
  /** 最近一次晉級挑戰賽的完整 Replay（schemaVersion 6 起）；還沒挑戰過、或遷移前挑戰的都是 null */
  challengeReplay: ChallengeReplay | null
  /** 進行中那一場的固定計畫（schemaVersion 7 起）；沒有被固定時是 null，代表用目前的球團算出來的計畫就是開賽時的計畫 */
  liveMatch: LiveMatch | null
  /** 新手任務裡推導不出來的部分（schemaVersion 8 起），見 onboarding.ts */
  onboarding: OnboardingState
  /** 球員比賽數據（schemaVersion 10 起）：生涯累計與記錄起點，見 stats.ts */
  stats: ClubStats
  /** 特性培養（schemaVersion 12 起）：訓練槽與最近完成的訓練，見 traitTraining.ts */
  training: TrainingState
  /** 從舊格式遷移來的：原本的版本與 revision（只做紀錄；從 3 升上來時是 3） */
  migratedFrom?: { schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12; revision: number }
  /** 每存一次加 1：用來發現別的分頁已經改過存檔 */
  revision: number
}

/** 目前格式的球團存檔 */
export type ClubSave = ClubSaveV13

export interface NewClubInput {
  clubId: string
  clubName: string
  clubSeed: number
  roster: PersistentRoster
  now: number
}

const zero = (): Resources => ({ funds: 0, experience: 0 })

/** 由完整陣容拆成永久球員名單（Lv.1）與只有 ID 的配置 */
export function splitRoster(roster: Roster, origin: PlayerOrigin, joinedAtMatch = 0): { players: PlayerRecord[]; roster: RosterAssignment } {
  const all: Player[] = [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]
  return {
    players: all.map((p) => ({ player: structuredClone(p), level: 1, origin, joinedAtMatch })),
    roster: {
      lineup: roster.lineup.map((s) => ({ playerId: s.player.id, position: s.position })),
      bench: roster.bench.map((p) => p.id),
      starter: roster.starter.id,
      relievers: roster.relievers.map((p) => p.id),
      ...(roster.captain ? { captain: roster.captain } : {}),
    },
  }
}

/** 新球團：時間錨點就是建立的時間，第一場在 5 分鐘後打完 */
export function newClub(input: NewClubInput): ClubSave {
  const { players, roster } = splitRoster(input.roster, 'founding')
  return {
    schemaVersion: CLUB_SCHEMA_VERSION,
    clubId: input.clubId,
    clubName: input.clubName,
    clubSeed: input.clubSeed >>> 0,
    createdAt: input.now,
    players,
    roster,
    recruitment: { count: 0 },
    league: newLeagueState(),
    strategy: { coach: { style: 'balanced' }, effectiveFromMatch: 0 },
    economy: { assets: zero(), unclaimed: zero(), earned: zero(), spent: zero(), nextClaimSeq: 0, lastClaim: null, nextOpSeq: 0, recentOps: [] },
    idle: { anchorMs: input.now, nextMatchIndex: 0, lastSettledAt: null },
    record: { wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 },
    recentMatches: [],
    replays: [],
    challengeReplay: null,
    liveMatch: null,
    onboarding: newOnboarding(),
    stats: newClubStats(0),
    training: newTrainingState(),
    revision: 0,
  }
}

/** 每一場比賽的唯一編號 */
export function matchIdFor(club: Pick<ClubSave, 'clubId'>, matchIndex: number): string {
  return `${club.clubId}#${matchIndex}`
}

/** 用途區分：同一場的比賽種子和對手種子不能相同 */
/** 不同用途的種子用不同的 salt：晉級挑戰賽用自己的序號與 salt，跟一般比賽的種子永遠不會重疊 */
export const SEED_SALT = { match: 0, opponent: 1, recruit: 2, challenge: 3, challengeOpponent: 4, recruitCandidate: 5, potential: 6 } as const

/** 由球團種子與場次序號穩定推導出 32 位元種子（不靠任何亂數狀態，第幾場永遠是同一個種子） */
export function deriveSeed(clubSeed: number, matchIndex: number, salt = 0): number {
  let h = mix((clubSeed ^ 0x9e3779b9) >>> 0)
  h = mix((h ^ (matchIndex >>> 0)) >>> 0)
  h = mix((h ^ Math.floor(matchIndex / 2 ** 32)) >>> 0)
  return mix((h ^ salt) >>> 0)
}

function mix(x: number): number {
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** 這一場我方是主隊還是客隊：輪流 */
export function userSideFor(matchIndex: number): Side {
  return matchIndex % 2 === 0 ? 'home' : 'away'
}

// ---- 帳務不變量 ----

/**
 * 經濟的不變量，回傳違反的項目（空陣列代表正常）：
 * 1. 每筆都 ≥ 0；2. assets + unclaimed + spent = earned（資金、經驗分開）；
 * 3. lastClaim 一定是上一個領取序號；4. 最近一筆支出一定是上一個支出序號，支出紀錄的序號遞增
 */
export function economyViolations(e: EconomyState): string[] {
  const out: string[] = []
  for (const k of ['funds', 'experience'] as const) {
    if (e.assets[k] < 0 || e.unclaimed[k] < 0 || e.earned[k] < 0 || e.spent[k] < 0) out.push(`${k} 出現負數`)
    if (e.assets[k] + e.unclaimed[k] + e.spent[k] !== e.earned[k]) {
      out.push(`${k}：資產 ${e.assets[k]} + 未領取 ${e.unclaimed[k]} + 支出 ${e.spent[k]} ≠ 總收入 ${e.earned[k]}`)
    }
  }
  if (e.lastClaim === null ? e.nextClaimSeq !== 0 : e.lastClaim.seq !== e.nextClaimSeq - 1) out.push('領取序號與上一次領取對不起來')
  const last = e.recentOps.at(-1)
  if (last === undefined ? e.nextOpSeq !== 0 : last.seq !== e.nextOpSeq - 1) out.push('支出序號與最近一筆支出對不起來')
  if (e.recentOps.some((op, i) => i > 0 && op.seq <= e.recentOps[i - 1].seq)) out.push('支出紀錄的序號沒有遞增')
  if (e.recentOps.length > SPEND_LOG_LIMIT) out.push('支出紀錄超過保留上限')
  return out
}

// ---- 驗證 ----

/** 檢查讀進來的資料是不是合法的 V4 存檔；不合法就丟 ClubValidationError，說明哪個欄位錯 */
export function validateClub(value: unknown): ClubSave {
  if (!isObj(value)) throw invalid('$', '不是物件')
  if (value.schemaVersion !== CLUB_SCHEMA_VERSION) {
    const v = value.schemaVersion
    const hint = typeof v === 'number' && v > CLUB_SCHEMA_VERSION ? '（存檔來自較新的版本）' : ''
    throw new ClubValidationError('unsupported-version', `不支援的存檔版本：${String(v)}${hint}`)
  }
  str(value, 'clubId')
  str(value, 'clubName')
  int(value, 'clubSeed')
  num(value, 'createdAt')
  int(value, 'revision')
  validatePlayers(value)
  const recruitment = obj(value, 'recruitment')
  int(recruitment, 'count', 'recruitment')
  validateAssignment(value)
  const strategy = obj(value, 'strategy')
  const coach = obj(strategy, 'coach', 'strategy')
  if (!(COACH_STYLES as readonly unknown[]).includes(coach.style)) throw invalid('strategy.coach.style', '不支援的戰術風格')
  if (coach.params !== undefined && !isObj(coach.params)) throw invalid('strategy.coach.params', '必須是物件')
  const paramIssues = coach.params === undefined ? [] : coachParamIssues(coach.params as Partial<CoachParams>)
  if (paramIssues.length) throw invalid('strategy.coach.params', paramIssues.join('；'))
  int(strategy, 'effectiveFromMatch', 'strategy')
  validateEconomy(obj(value, 'economy'))
  validateLeague(obj(value, 'league'))
  validateChallengeReplay(value.challengeReplay, obj(value, 'league'))
  validateLiveMatch(value.liveMatch, obj(value, 'idle'), value.clubId as string)
  const onboarding = obj(value, 'onboarding')
  for (const key of ['watchedLive', 'claimedRewards', 'lineupChanged', 'collapsed']) if (typeof onboarding[key] !== 'boolean') throw invalid(`onboarding.${key}`, '必須是 true 或 false')
  arr(value, 'recentMatches').forEach((m, i) => {
    const path = `recentMatches[${i}]`
    const match = m as Obj
    if (match.playedAt !== undefined) num(match, 'playedAt', path)
    if (match.box !== undefined) validateBox(match.box, `${path}.box`)
    if (match.ranked !== undefined) validateRankedRecord(match.ranked, `${path}.ranked`)
    if (match.lines !== undefined) validateLines(match.lines, `${path}.lines`)
    if (match.tactics !== undefined) validateTactics(match.tactics, `${path}.tactics`)
    if (match.mvp !== undefined) validateMatchMvp(match, `${path}.mvp`)
  })
  const idle = obj(value, 'idle')
  num(idle, 'anchorMs', 'idle')
  int(idle, 'nextMatchIndex', 'idle')
  if (idle.lastSettledAt !== null) num(idle, 'lastSettledAt', 'idle')
  const record = obj(value, 'record')
  for (const key of ['wins', 'losses', 'runsFor', 'runsAgainst']) int(record, key, 'record')
  validateMatches(value)
  validateStats(value)
  validateTraining(value)
  return value as unknown as ClubSave
}

const isCountList = (x: unknown, max: number) => Array.isArray(x) && x.length <= max && x.every((n) => Number.isInteger(n) && (n as number) >= 0)

function validateLines(value: unknown, path: string): void {
  if (!isObj(value)) throw invalid(path, '格式不對')
  for (const [key, max] of [['bat', BAT_STORE.length], ['pit', PIT_STORE.length]] as const) {
    const ids = new Set<string>()
    arr(value, key, path).forEach((row, i) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || !isCountList(row.slice(1), max)) throw invalid(`${path}.${key}[${i}]`, '格式不對')
      if (ids.has(row[0] as string)) throw invalid(`${path}.${key}[${i}]`, `同一場出現兩次：${row[0] as string}`)
      ids.add(row[0] as string)
    })
  }
}

/**
 * 球員數據：生涯已經算到結算游標（同一場不會記兩次）、記錄起點不晚於游標、
 * 最近比賽裡出現的球員一定有生涯紀錄（被釋出也一樣，戰報才叫得出名字）
 */
function validateStats(value: Obj): void {
  const stats = obj(value, 'stats')
  int(stats, 'sinceMatch', 'stats')
  int(stats, 'throughMatch', 'stats')
  const idle = value.idle as Obj
  if (stats.throughMatch !== idle.nextMatchIndex) throw invalid('stats.throughMatch', `必須等於結算游標 ${String(idle.nextMatchIndex)}`)
  if ((stats.sinceMatch as number) > (stats.throughMatch as number) || (stats.sinceMatch as number) < 0) throw invalid('stats.sinceMatch', '不能晚於結算游標')
  const players = obj(stats, 'players', 'stats')
  for (const [id, rec] of Object.entries(players)) {
    const path = `stats.players.${id}`
    if (!isObj(rec)) throw invalid(path, '格式不對')
    str(rec, 'name', path)
    if (rec.role !== 'batter' && rec.role !== 'pitcher') throw invalid(`${path}.role`, '不認識的角色')
    for (const key of ['bg', 'pg', 'first', 'last']) int(rec, key, path)
    if (rec.releasedAt !== undefined) int(rec, 'releasedAt', path)
    if (rec.bat !== null && !(isCountList(rec.bat, BAT_STORE.length) && (rec.bat as unknown[]).length === BAT_STORE.length)) throw invalid(`${path}.bat`, '格式不對')
    if (rec.pit !== null && !(isCountList(rec.pit, PIT_STORE.length) && (rec.pit as unknown[]).length === PIT_STORE.length)) throw invalid(`${path}.pit`, '格式不對')
    if ((rec.bat === null) !== (rec.bg === 0) || (rec.pit === null) !== (rec.pg === 0)) throw invalid(path, '出場數跟數據對不起來')
    if ((rec.first as number) < (stats.sinceMatch as number) || (rec.last as number) >= (stats.throughMatch as number) || (rec.first as number) > (rec.last as number)) throw invalid(path, '出場場次不在記錄範圍內')
  }
  ;(value.recentMatches as Obj[]).forEach((m, i) => {
    const lines = m.lines as MatchLines | undefined
    if (!lines) return
    if ((m.matchIndex as number) < (stats.sinceMatch as number)) throw invalid(`recentMatches[${i}].lines`, '記錄起點之前的比賽不該有球員數據')
    for (const row of [...lines.bat, ...lines.pit]) if (!isObj(players[row[0]])) throw invalid(`recentMatches[${i}].lines`, `找不到球員 ${row[0]} 的生涯紀錄`)
  })
}

/** 訓練槽：訓練中的球員一定在名單裡、項目一定是這位球員能訓練的、進度不超過開始以來結算的場數 */
function validateTraining(value: Obj): void {
  const t = obj(value, 'training')
  if (t.potentialVersion !== POTENTIAL_VERSION) throw invalid('training.potentialVersion', `必須是 ${POTENTIAL_VERSION}`)
  const recent = arr(t, 'recent', 'training')
  if (recent.length > TRAINING_RECENT_LIMIT) throw invalid('training.recent', `最多 ${TRAINING_RECENT_LIMIT} 筆`)
  recent.forEach((c, i) => {
    const path = `training.recent[${i}]`
    if (!isObj(c) || typeof c.playerId !== 'string' || typeof c.playerName !== 'string' || !(String(c.trait) in TRAITS) || (c.kind !== 'learn' && c.kind !== 'improve')) throw invalid(path, '格式不對')
    int(c, 'completedAtMatch', path)
    if (c.effectiveFromMatch !== (c.completedAtMatch as number) + 1) throw invalid(`${path}.effectiveFromMatch`, '必須是完成的下一場')
  })
  if (t.active === null) return
  const a = obj(t, 'active', 'training')
  if (typeof a.playerId !== 'string' || !(String(a.trait) in TRAITS) || (a.kind !== 'learn' && a.kind !== 'improve')) throw invalid('training.active', '格式不對')
  for (const key of ['progress', 'need', 'startedAtMatch']) int(a, key, 'training.active')
  const next = (obj(value, 'idle').nextMatchIndex as number) ?? 0
  if ((a.progress as number) >= (a.need as number) || (a.need as number) < 1) throw invalid('training.active.progress', '進度必須小於所需場數')
  if ((a.startedAtMatch as number) > next + 1) throw invalid('training.active.startedAtMatch', '不能晚於下一場')
  if ((a.progress as number) > Math.max(0, next - (a.startedAtMatch as number))) throw invalid('training.active.progress', '進度超過開始以來結算的場數')
  if (a.lastCountedMatch !== null && !(Number.isInteger(a.lastCountedMatch) && (a.lastCountedMatch as number) < next && (a.lastCountedMatch as number) >= (a.startedAtMatch as number))) {
    throw invalid('training.active.lastCountedMatch', '必須是開始之後、已經結算的場次')
  }
  if ((a.progress as number) > 0 && a.lastCountedMatch === null) throw invalid('training.active.lastCountedMatch', '有進度就一定有最後計入的場次')
  const record = (arr(value, 'players') as Obj[]).find((r) => isObj(r.player) && r.player.id === a.playerId)
  if (!record) throw invalid('training.active.playerId', '訓練中的球員不在名單裡')
  const kind = a.kind as TrainingKind
  const trait = a.trait as TraitId
  if (TRAINING_CONFIG[trainingClass(trait)].appearances !== a.need) throw invalid('training.active.need', '所需場數跟設定不符')
  // 跟開始訓練同一套「靜態資格」（不看訓練槽與資源：合法的進行中訓練不會因為現在錢不夠而變成不合法）
  const rec = record as unknown as PlayerRecord
  const st = staticTrainingBlock(value.clubSeed as number, rec, trait, kind)
  if (st) throw invalid('training.active.trait', `這位球員不能訓練這一項（${st.block}）`)
}

/** 單場 MVP：格式正確、一定有 lines，而且 MVP 是那場有出場的我方球員（打者有打擊列、投手有投球列） */
function validateMatchMvp(match: Obj, path: string): void {
  const issue = matchMvpIssue(match.mvp)
  if (issue) throw invalid(path, issue)
  const m = unpackMvp(match.mvp as MatchMvpRecord)
  const lines = match.lines as { bat: [string][]; pit: [string][] } | undefined
  if (!lines) throw invalid(path, '有 MVP 的比賽一定要有球員數據')
  const rows = m.role === 'batter' ? lines.bat : lines.pit
  if (!rows.some((r) => r[0] === m.playerId)) throw invalid(path, `MVP ${m.playerId} 這場沒有${m.role === 'batter' ? '打擊' : '投球'}紀錄`)
}

function validatePlayers(value: Obj): void {
  const list = arr(value, 'players')
  if (list.length > RECRUIT_CONFIG.maxPlayers) throw invalid('players', `最多 ${RECRUIT_CONFIG.maxPlayers} 人`)
  const ids = new Set<string>()
  list.forEach((r, i) => {
    const path = `players[${i}]`
    if (!isObj(r) || !isObj(r.player)) throw invalid(path, '格式不對')
    const role = r.player.role === 'pitcher' ? 'pitcher' : 'batter'
    player(r.player, role, `${path}.player`)
    if (!Number.isInteger(r.level) || (r.level as number) < 1 || (r.level as number) > MAX_LEVEL) throw invalid(`${path}.level`, `必須是 1～${MAX_LEVEL} 的整數`)
    if (r.origin !== 'founding' && r.origin !== 'recruit' && r.origin !== 'migrated') throw invalid(`${path}.origin`, '不認識的來源')
    int(r, 'joinedAtMatch', path)
    if (r.dev !== undefined) {
      if (!isObj(r.dev) || !Array.isArray(r.dev.learned) || !Array.isArray(r.dev.removed)) throw invalid(`${path}.dev`, '格式不對')
      const issues = developmentIssues(r as unknown as PlayerRecord)
      if (issues.length) throw invalid(`${path}.dev`, issues.join('；'))
    }
    if (r.mvp !== undefined) {
      const issues = mvpIssues(r as unknown as PlayerRecord)
      if (issues.length) throw invalid(`${path}.mvp`, issues.join('；'))
    }
    const id = r.player.id as string
    if (ids.has(id)) throw invalid(`${path}.player.id`, `球員編號重複：${id}`)
    ids.add(id)
  })
}

function validateAssignment(value: Obj): void {
  const roster = obj(value, 'roster')
  const lineup = arr(roster, 'lineup', 'roster')
  lineup.forEach((s, i) => {
    if (!isObj(s) || typeof s.playerId !== 'string' || typeof s.position !== 'string') throw invalid(`roster.lineup[${i}]`, '格式不對')
  })
  for (const key of ['bench', 'relievers']) if (!arr(roster, key, 'roster').every((x) => typeof x === 'string')) throw invalid(`roster.${key}`, '必須是球員編號')
  str(roster, 'starter', 'roster')
  let resolved: Roster
  try {
    resolved = resolveRoster(value as unknown as ClubSave)
  } catch (e) {
    throw invalid('roster', (e as Error).message)
  }
  const issues = lineupIssues(resolved)
  if (issues.length) throw invalid('roster', issues.join('；'))
}

function validateLiveMatch(value: unknown, idle: Obj, clubId: string): void {
  if (value === null) return
  if (!isObj(value)) throw invalid('liveMatch', '必須是 null 或物件')
  int(value, 'matchIndex', 'liveMatch')
  const plan = obj(value, 'plan', 'liveMatch')
  str(plan, 'matchId', 'liveMatch.plan')
  int(plan, 'matchIndex', 'liveMatch.plan')
  int(plan, 'leagueTier', 'liveMatch.plan')
  if (!isObj(plan.setup) || !isObj(plan.ai)) throw invalid('liveMatch.plan', '格式不對')
  // 結算後就清掉：固定的一定是還沒結算的那一場
  if (value.matchIndex !== idle.nextMatchIndex || plan.matchIndex !== value.matchIndex) throw invalid('liveMatch.matchIndex', '不是進行中的那一場')
  if (plan.matchId !== `${clubId}#${value.matchIndex}`) throw invalid('liveMatch.plan.matchId', '不屬於這個球團')
}

function validateTactics(value: unknown, path: string): void {
  const issue = tacticsRecordIssue(value)
  if (issue) throw invalid(path, issue)
}

function validateRankedRecord(value: unknown, path: string): void {
  if (!isObj(value)) throw invalid(path, '格式不對')
  for (const key of ['tier', 'before', 'after', 'protectionRemaining']) int(value, key, path)
  if (!Number.isInteger(value.delta)) throw invalid(`${path}.delta`, '必須是整數')
  if (typeof value.protected !== 'boolean') throw invalid(`${path}.protected`, '必須是 true 或 false')
  if (value.relegatedTo !== null) int(value, 'relegatedTo', path)
  if ((value.after as number) - (value.before as number) !== value.delta) throw invalid(`${path}.delta`, '跟前後積分對不起來')
}

function validateBox(value: unknown, path: string): void {
  if (!isObj(value)) throw invalid(path, '格式不對')
  const ls = obj(value, 'linescore', path)
  for (const side of ['home', 'away']) if (!Array.isArray(ls[side]) || !(ls[side] as unknown[]).every((x) => Number.isInteger(x))) throw invalid(`${path}.linescore`, '格式不對')
  for (const key of ['hits', 'errors']) {
    const t = obj(value, key, path)
    int(t, 'home', `${path}.${key}`)
    int(t, 'away', `${path}.${key}`)
  }
  for (const [key, len] of [['batters', 6], ['pitchers', 4]] as const) {
    arr(value, key, path).forEach((x, i) => {
      if (!Array.isArray(x) || x.length !== len || typeof x[0] !== 'string' || !x.slice(1).every((n) => Number.isInteger(n))) throw invalid(`${path}.${key}[${i}]`, '格式不對')
    })
  }
}

function validateChallengeReplay(value: unknown, league: Obj): void {
  if (value === null) return
  if (!isObj(value)) throw invalid('challengeReplay', '必須是 null 或物件')
  int(value, 'seq', 'challengeReplay')
  str(value, 'matchId', 'challengeReplay')
  if (!isObj(value.replay) || !isObj(value.replay.setup) || !Array.isArray(value.replay.commands)) throw invalid('challengeReplay.replay', '格式不對')
  // 只保留最近一次挑戰
  if (value.seq !== (league.nextChallengeSeq as number) - 1) throw invalid('challengeReplay.seq', '不是最近一次挑戰')
}

function validateLeague(league: Obj): void {
  for (const key of ['tier', 'matches', 'wins', 'losses', 'promotions', 'highestTier', 'nextChallengeSeq', 'challengeReadyAt', 'protectionRemaining', 'relegations']) int(league, key, 'league')
  if (league.points !== null) int(league, 'points', 'league')
  if (league.lastRelegation !== null) {
    const r = obj(league, 'lastRelegation', 'league')
    for (const key of ['fromTier', 'toTier', 'matchIndex']) int(r, key, 'league.lastRelegation')
    num(r, 'at', 'league.lastRelegation')
  }
  if ((league.tier as number) > MAX_TIER) throw invalid('league.tier', `必須是 0～${MAX_TIER}`)
  if (typeof league.recent !== 'string') throw invalid('league.recent', '必須是字串')
  arr(league, 'challenges', 'league').forEach((c, i) => {
    const path = `league.challenges[${i}]`
    if (!isObj(c) || typeof c.won !== 'boolean') throw invalid(path, '格式不對')
    for (const key of ['seq', 'fromTier', 'toTier', 'runsFor', 'runsAgainst', 'innings', 'matchIndexAt']) int(c, key, path)
    num(c, 'at', path)
    str(c, 'requestKey', path)
    const reward = obj(c, 'reward', path)
    num(reward, 'funds', `${path}.reward`)
    num(reward, 'experience', `${path}.reward`)
  })
  if (!arr(league, 'rewardedTiers', 'league').every((t) => Number.isInteger(t))) throw invalid('league.rewardedTiers', '必須是整數陣列')
  const violations = leagueViolations(league as unknown as LeagueState)
  if (violations.length) throw invalid('league', violations.join('；'))
}

function validateEconomy(economy: Obj): void {
  for (const key of ['assets', 'unclaimed', 'earned', 'spent']) {
    const r = obj(economy, key, 'economy')
    num(r, 'funds', `economy.${key}`)
    num(r, 'experience', `economy.${key}`)
  }
  int(economy, 'nextClaimSeq', 'economy')
  if (economy.lastClaim !== null) {
    const last = obj(economy, 'lastClaim', 'economy')
    int(last, 'seq', 'economy.lastClaim')
    const claimed = obj(last, 'claimed', 'economy.lastClaim')
    num(claimed, 'funds', 'economy.lastClaim.claimed')
    num(claimed, 'experience', 'economy.lastClaim.claimed')
  }
  int(economy, 'nextOpSeq', 'economy')
  arr(economy, 'recentOps', 'economy').forEach((op, i) => {
    const path = `economy.recentOps[${i}]`
    if (!isObj(op) || !['upgrade', 'recruit', 'release', 'trainStart', 'trainCancel'].includes(op.kind as string)) throw invalid(path, '格式不對')
    int(op, 'seq', path)
    str(op, 'playerId', path)
    str(op, 'requestKey', path)
    num(op, 'at', path)
    const cost = obj(op, 'cost', path)
    num(cost, 'funds', `${path}.cost`)
    num(cost, 'experience', `${path}.cost`)
    // 選用欄位（舊版沒有）：有的話要是 0～2 的整數
    if (op.candidateIndex !== undefined) {
      int(op, 'candidateIndex', path)
      if ((op.candidateIndex as number) < 0 || (op.candidateIndex as number) > 2) throw invalid(`${path}.candidateIndex`, '必須是 0～2')
    }
  })
  const violations = economyViolations(economy as unknown as EconomyState)
  if (violations.length > 0) throw invalid('economy', `帳務對不起來：${violations.join('；')}`)
}
