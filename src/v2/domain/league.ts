// 聯盟進度：目前階級、本聯盟戰績、最近 N 場、晉級資格、挑戰紀錄。都是純函式，不改輸入。
// 晉級挑戰賽有自己的序號（nextChallengeSeq），跟一般比賽的結算游標（idle.nextMatchIndex）完全分開
import type { Resources } from './club'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from './leagueConfig'

export interface ChallengeRecord {
  seq: number
  fromTier: number
  toTier: number
  won: boolean
  runsFor: number
  runsAgainst: number
  opponentName: string
  innings: number
  /** 挑戰時的時間 */
  at: number
  /** 挑戰時一般比賽的結算游標（只做紀錄） */
  matchIndexAt: number
  /** 這次發出的晉級獎勵（失敗或已經發過就是 0） */
  reward: Resources
  /** 請求內容（序號以外）：重送時比對 */
  requestKey: string
}

export interface LeagueState {
  tier: number
  /** 本聯盟（晉級後重新計算）的一般比賽場次與勝敗 */
  matches: number
  wins: number
  losses: number
  /** 最近的一般比賽結果，'W' 或 'L'，舊的在前，最多 PROMOTION_CONFIG.window 個 */
  recent: string
  promotions: number
  highestTier: number
  /** 下一次挑戰的序號：請求帶上這個號碼，用法跟領取、支出序號一樣 */
  nextChallengeSeq: number
  /** 一般比賽的結算游標要到這個數字，才能（再）挑戰：挑戰失敗後要再打幾場 */
  challengeReadyAt: number
  /** 最近幾次挑戰（最多 historyLimit 筆；最後一筆一定是 nextChallengeSeq − 1） */
  challenges: ChallengeRecord[]
  /** 已經發過晉級獎勵的階級：每個階級只發一次 */
  rewardedTiers: number[]
}

export function newLeagueState(): LeagueState {
  return {
    tier: 0,
    matches: 0,
    wins: 0,
    losses: 0,
    recent: '',
    promotions: 0,
    highestTier: 0,
    nextChallengeSeq: 0,
    challengeReadyAt: 0,
    challenges: [],
    rewardedTiers: [],
  }
}

export function leagueOf(tier: number) {
  const def = LEAGUES[tier]
  if (!def) throw new RangeError(`聯盟階級不合法：${tier}`)
  return def
}

/** 記一場一般比賽的勝敗（不改輸入） */
export function recordLeagueResult(state: LeagueState, won: boolean): LeagueState {
  return {
    ...state,
    matches: state.matches + 1,
    wins: state.wins + (won ? 1 : 0),
    losses: state.losses + (won ? 0 : 1),
    recent: (state.recent + (won ? 'W' : 'L')).slice(-PROMOTION_CONFIG.window),
  }
}

/** 最近 window 場（不足就用已經打的）的勝率；還沒打過是 0 */
export function recentWinRate(state: Pick<LeagueState, 'recent'>): number {
  if (!state.recent.length) return 0
  return [...state.recent].filter((c) => c === 'W').length / state.recent.length
}

export interface Eligibility {
  ok: boolean
  atMaxTier: boolean
  matches: { have: number; need: number }
  /** 最近 window 場的勝率：場數不足 window 時不算達標 */
  winRate: { have: number; need: number; games: number; window: number }
  /** 挑戰失敗後還要再打幾場 */
  retryRemaining: number
}

/** 能不能挑戰下一級聯盟，以及每個條件目前的進度 */
export function eligibility(state: LeagueState, nextMatchIndex: number): Eligibility {
  const atMaxTier = state.tier >= MAX_TIER
  const matches = { have: state.matches, need: PROMOTION_CONFIG.minMatches }
  const winRate = { have: recentWinRate(state), need: PROMOTION_CONFIG.winRate, games: state.recent.length, window: PROMOTION_CONFIG.window }
  const retryRemaining = Math.max(0, state.challengeReadyAt - nextMatchIndex)
  const ok = !atMaxTier && matches.have >= matches.need && winRate.games >= winRate.window && winRate.have >= winRate.need && retryRemaining === 0
  return { ok, atMaxTier, matches, winRate, retryRemaining }
}

/** 違反的不變量（空陣列代表正常） */
export function leagueViolations(s: LeagueState): string[] {
  const out: string[] = []
  if (!Number.isInteger(s.tier) || s.tier < 0 || s.tier > MAX_TIER) out.push('聯盟階級不合法')
  if (s.highestTier < s.tier || s.highestTier > MAX_TIER) out.push('最高階級不合法')
  if (s.wins + s.losses !== s.matches) out.push('本聯盟勝敗加總不等於場次')
  if (s.recent.length > PROMOTION_CONFIG.window || /[^WL]/.test(s.recent)) out.push('最近戰績格式不對')
  if (s.recent.length > s.matches) out.push('最近戰績比場次還多')
  // 挑戰紀錄只留最近幾筆，但只要挑戰過，最後一筆一定在，而且就是上一個序號
  const last = s.challenges.at(-1)
  if (last === undefined ? s.nextChallengeSeq !== 0 : last.seq !== s.nextChallengeSeq - 1) out.push('挑戰序號與最近一筆挑戰對不起來')
  if (s.challenges.some((c, i) => i > 0 && c.seq <= s.challenges[i - 1].seq)) out.push('挑戰紀錄的序號沒有遞增')
  if (s.challenges.length > PROMOTION_CONFIG.historyLimit) out.push('挑戰紀錄超過保留上限')
  // Phase 5 沒有降級：晉級次數 = 最高階級 = 目前階級
  if (s.promotions !== s.highestTier || s.highestTier !== s.tier) out.push('晉級次數、最高階級與目前階級對不起來')
  if (new Set(s.rewardedTiers).size !== s.rewardedTiers.length || s.rewardedTiers.some((t) => t < 1 || t > s.highestTier)) out.push('晉級獎勵紀錄不合法')
  return out
}
