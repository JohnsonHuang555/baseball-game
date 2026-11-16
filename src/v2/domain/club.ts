// V2 球團存檔（schemaVersion 3）：球團、球員、戰術、經濟、放置進度與近期比賽。
// 不沿用 V1 的 Tournament：錦標賽是一輪一輪的 roguelike，V2 的球團要一直存在、一直累積。
// 這裡只有資料型別與純函式，不碰儲存、時間或亂數狀態
import type { Side } from '../../sim/game'
import type { Roster } from '../../sim/types'
import type { CoachParams, CoachStyle } from '../application/autoCoach'
import type { MatchReplay } from '../application/matchRunner'

export const CLUB_SCHEMA_VERSION = 3

/** 球員與陣容：Phase 2 不做養成，直接沿用模擬用的名單結構（9 先發、板凳、先發投手、後援） */
export type PersistentRoster = Roster

/** 球團的戰術設定；effectiveFromMatch 是這份設定從第幾場開始生效 */
export interface TeamStrategies {
  coach: { style: CoachStyle; params?: Partial<CoachParams> }
  effectiveFromMatch: number
}

export interface Resources {
  funds: number
  experience: number
}

/**
 * 經濟：三筆分開記，避免「結算一次、領取一次」被算成兩次。
 * unclaimed：已結算、還沒領取；assets：已領取、算進球團資產；lifetime：總共賺過多少（= assets 累計領取 + unclaimed，核對用）
 */
export interface EconomyState {
  assets: Resources
  unclaimed: Resources
  lifetime: Resources
  /** 最近幾次領取的編號：同一個編號重送不會再入帳 */
  recentClaimIds: string[]
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

export interface ClubSaveV3 {
  schemaVersion: typeof CLUB_SCHEMA_VERSION
  clubId: string
  clubName: string
  /** 球團種子：每一場的種子、對手都由它和場次序號推導 */
  clubSeed: number
  createdAt: number
  roster: PersistentRoster
  strategy: TeamStrategies
  economy: EconomyState
  idle: IdleState
  record: ClubRecord
  /** 近期比賽，舊的在前，最多 RETENTION_CONFIG.recentMatches 場 */
  recentMatches: SettledMatch[]
  /** 最近幾場的完整 replay，最多 RETENTION_CONFIG.replays 份 */
  replays: { matchId: string; replay: MatchReplay }[]
  /** 每存一次加 1：用來發現別的分頁已經改過存檔 */
  revision: number
}

export interface NewClubInput {
  clubId: string
  clubName: string
  clubSeed: number
  roster: PersistentRoster
  now: number
}

const zero = (): Resources => ({ funds: 0, experience: 0 })

/** 新球團：時間錨點就是建立的時間，第一場在 5 分鐘後打完 */
export function newClub(input: NewClubInput): ClubSaveV3 {
  return {
    schemaVersion: CLUB_SCHEMA_VERSION,
    clubId: input.clubId,
    clubName: input.clubName,
    clubSeed: input.clubSeed >>> 0,
    createdAt: input.now,
    roster: structuredClone(input.roster),
    strategy: { coach: { style: 'balanced' }, effectiveFromMatch: 0 },
    economy: { assets: zero(), unclaimed: zero(), lifetime: zero(), recentClaimIds: [] },
    idle: { anchorMs: input.now, nextMatchIndex: 0, lastSettledAt: null },
    record: { wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 },
    recentMatches: [],
    replays: [],
    revision: 0,
  }
}

/** 每一場比賽的唯一編號 */
export function matchIdFor(club: Pick<ClubSaveV3, 'clubId'>, matchIndex: number): string {
  return `${club.clubId}#${matchIndex}`
}

/** 用途區分：同一場的比賽種子和對手種子不能相同 */
export const SEED_SALT = { match: 0, opponent: 1 } as const

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

// ---- 驗證 ----

export type ClubValidationCode = 'unsupported-version' | 'invalid-schema'

export class ClubValidationError extends Error {
  override name = 'ClubValidationError'
  constructor(
    readonly code: ClubValidationCode,
    message: string,
  ) {
    super(message)
  }
}

type Obj = Record<string, unknown>

/** 檢查讀進來的資料是不是合法的 V3 存檔；不合法就丟 ClubValidationError，說明哪個欄位錯 */
export function validateClub(value: unknown): ClubSaveV3 {
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
  validateRoster(obj(value, 'roster'), 'roster')
  const strategy = obj(value, 'strategy')
  const coach = obj(strategy, 'coach', 'strategy')
  if (coach.style !== 'balanced') throw invalid('strategy.coach.style', '不支援的戰術風格')
  if (coach.params !== undefined && !isObj(coach.params)) throw invalid('strategy.coach.params', '必須是物件')
  int(strategy, 'effectiveFromMatch', 'strategy')
  const economy = obj(value, 'economy')
  for (const key of ['assets', 'unclaimed', 'lifetime']) {
    const r = obj(economy, key, 'economy')
    num(r, 'funds', `economy.${key}`)
    num(r, 'experience', `economy.${key}`)
  }
  const claims = arr(economy, 'recentClaimIds', 'economy')
  if (!claims.every((c) => typeof c === 'string')) throw invalid('economy.recentClaimIds', '必須是字串陣列')
  const idle = obj(value, 'idle')
  num(idle, 'anchorMs', 'idle')
  int(idle, 'nextMatchIndex', 'idle')
  if (idle.lastSettledAt !== null) num(idle, 'lastSettledAt', 'idle')
  const record = obj(value, 'record')
  for (const key of ['wins', 'losses', 'runsFor', 'runsAgainst']) int(record, key, 'record')
  arr(value, 'recentMatches').forEach((m, i) => {
    const path = `recentMatches[${i}]`
    if (!isObj(m)) throw invalid(path, '不是物件')
    str(m, 'matchId', path)
    int(m, 'matchIndex', path)
    int(m, 'seed', path)
    num(m, 'earnedFunds', path)
    num(m, 'earnedExperience', path)
    num(m, 'settledAt', path)
    const r = obj(m, 'result', path)
    int(r, 'runsFor', `${path}.result`)
    int(r, 'runsAgainst', `${path}.result`)
    arr(r, 'highlights', `${path}.result`)
  })
  arr(value, 'replays').forEach((r, i) => {
    if (!isObj(r) || typeof r.matchId !== 'string' || !isObj(r.replay)) throw invalid(`replays[${i}]`, '格式不對')
  })
  return value as unknown as ClubSaveV3
}

function validateRoster(roster: Obj, path: string): void {
  const lineup = arr(roster, 'lineup', path)
  if (lineup.length !== 9) throw invalid(`${path}.lineup`, '先發必須是 9 人')
  lineup.forEach((s, i) => {
    if (!isObj(s) || typeof s.position !== 'string') throw invalid(`${path}.lineup[${i}]`, '格式不對')
    player(s.player, 'batter', `${path}.lineup[${i}].player`)
  })
  arr(roster, 'bench', path).forEach((p, i) => player(p, 'batter', `${path}.bench[${i}]`))
  player(roster.starter, 'pitcher', `${path}.starter`)
  arr(roster, 'relievers', path).forEach((p, i) => player(p, 'pitcher', `${path}.relievers[${i}]`))
}

function player(p: unknown, role: 'batter' | 'pitcher', path: string): void {
  if (!isObj(p) || p.role !== role || typeof p.id !== 'string' || typeof p.name !== 'string' || !isObj(p.ratings) || !Array.isArray(p.traits)) {
    throw invalid(path, `不是合法的${role === 'batter' ? '打者' : '投手'}`)
  }
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const invalid = (path: string, why: string) => new ClubValidationError('invalid-schema', `存檔格式錯誤：${path} ${why}`)
const at = (parent: string | undefined, key: string) => (parent ? `${parent}.${key}` : key)

function obj(o: Obj, key: string, parent?: string): Obj {
  const v = o[key]
  if (!isObj(v)) throw invalid(at(parent, key), '必須是物件')
  return v
}
function arr(o: Obj, key: string, parent?: string): unknown[] {
  const v = o[key]
  if (!Array.isArray(v)) throw invalid(at(parent, key), '必須是陣列')
  return v
}
function str(o: Obj, key: string, parent?: string): void {
  if (typeof o[key] !== 'string' || o[key] === '') throw invalid(at(parent, key), '必須是非空字串')
}
function num(o: Obj, key: string, parent?: string): void {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(at(parent, key), '必須是 0 以上的數字')
}
function int(o: Obj, key: string, parent?: string): void {
  const v = o[key]
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid(at(parent, key), '必須是 0 以上的整數')
}
