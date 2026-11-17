// V2 球團存檔（schemaVersion 5）：球團、永久球員名單、陣容配置、戰術、經濟、聯盟進度、放置進度與近期比賽。
// 不沿用 V1 的 Tournament：錦標賽是一輪一輪的 roguelike，V2 的球團要一直存在、一直累積。
// 這裡只有資料型別與純函式，不碰儲存、時間或亂數狀態。舊的 schemaVersion 3 見 legacyV3.ts、遷移（3 → 4 → 5）見 migration.ts
import type { Side } from '../../sim/game'
import type { Player, Position, Roster } from '../../sim/types'
import type { CoachParams, CoachStyle } from '../application/autoCoach'
import type { MatchReplay } from '../application/matchRunner'
import { lineupIssues } from './lineup'
import { leagueViolations, newLeagueState, type LeagueState } from './league'
import { MAX_TIER } from './leagueConfig'
import { MAX_LEVEL, RECRUIT_CONFIG, SPEND_LOG_LIMIT } from './progressionConfig'
import { resolveRoster } from './roster'
import { coachParamIssues } from './tactics'
import { ClubValidationError, arr, int, invalid, isObj, num, obj, player, str, validateMatches, type Obj } from './validation'

export { ClubValidationError, type ClubValidationCode } from './validation'

export const CLUB_SCHEMA_VERSION = 5

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
  kind: 'upgrade' | 'recruit' | 'release'
  playerId: string
  cost: Resources
  at: number
  /** 請求內容（序號以外）：同一個序號重送時比對，確認是同一個請求 */
  requestKey: string
  fromLevel?: number
  toLevel?: number
  recruitIndex?: number
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

/** 一場已結算的比賽 */
export interface SettledMatch {
  matchId: string
  matchIndex: number
  seed: number
  result: MatchSummary
  earnedFunds: number
  earnedExperience: number
  settledAt: number
}

export interface ClubSaveV5 {
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
  /** 從舊格式遷移來的：原本的版本與 revision（只做紀錄；從 3 升上來時是 3） */
  migratedFrom?: { schemaVersion: 3 | 4; revision: number }
  /** 每存一次加 1：用來發現別的分頁已經改過存檔 */
  revision: number
}

/** 目前格式的球團存檔 */
export type ClubSave = ClubSaveV5

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
    revision: 0,
  }
}

/** 每一場比賽的唯一編號 */
export function matchIdFor(club: Pick<ClubSave, 'clubId'>, matchIndex: number): string {
  return `${club.clubId}#${matchIndex}`
}

/** 用途區分：同一場的比賽種子和對手種子不能相同 */
/** 不同用途的種子用不同的 salt：晉級挑戰賽用自己的序號與 salt，跟一般比賽的種子永遠不會重疊 */
export const SEED_SALT = { match: 0, opponent: 1, recruit: 2, challenge: 3, challengeOpponent: 4 } as const

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
  if (coach.style !== 'balanced') throw invalid('strategy.coach.style', '不支援的戰術風格')
  if (coach.params !== undefined && !isObj(coach.params)) throw invalid('strategy.coach.params', '必須是物件')
  const paramIssues = coach.params === undefined ? [] : coachParamIssues(coach.params as Partial<CoachParams>)
  if (paramIssues.length) throw invalid('strategy.coach.params', paramIssues.join('；'))
  int(strategy, 'effectiveFromMatch', 'strategy')
  validateEconomy(obj(value, 'economy'))
  validateLeague(obj(value, 'league'))
  const idle = obj(value, 'idle')
  num(idle, 'anchorMs', 'idle')
  int(idle, 'nextMatchIndex', 'idle')
  if (idle.lastSettledAt !== null) num(idle, 'lastSettledAt', 'idle')
  const record = obj(value, 'record')
  for (const key of ['wins', 'losses', 'runsFor', 'runsAgainst']) int(record, key, 'record')
  validateMatches(value)
  return value as unknown as ClubSave
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

function validateLeague(league: Obj): void {
  for (const key of ['tier', 'matches', 'wins', 'losses', 'promotions', 'highestTier', 'nextChallengeSeq', 'challengeReadyAt']) int(league, key, 'league')
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
    if (!isObj(op) || (op.kind !== 'upgrade' && op.kind !== 'recruit' && op.kind !== 'release')) throw invalid(path, '格式不對')
    int(op, 'seq', path)
    str(op, 'playerId', path)
    str(op, 'requestKey', path)
    num(op, 'at', path)
    const cost = obj(op, 'cost', path)
    num(cost, 'funds', `${path}.cost`)
    num(cost, 'experience', `${path}.cost`)
  })
  const violations = economyViolations(economy as unknown as EconomyState)
  if (violations.length > 0) throw invalid('economy', `帳務對不起來：${violations.join('；')}`)
}
