// 聯盟進度：目前階級、本聯盟戰績、最近 N 場、晉級資格、挑戰紀錄。都是純函式，不改輸入。
// 晉級挑戰賽有自己的序號（nextChallengeSeq），跟一般比賽的結算游標（idle.nextMatchIndex）完全分開
import type { Resources } from './club'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG, RANKED_CONFIG } from './leagueConfig'

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
  /** 已經發過晉級獎勵的階級：每個階級只發一次（降級不會移除） */
  rewardedTiers: number[]
  /** 競技積分（Phase 7B）：挑戰者以上才有，新秀、業餘是 null */
  points: number | null
  /** 晉級後還剩幾場「計入本聯盟的一般比賽」有保護（積分最低停在 1） */
  protectionRemaining: number
  /** 降級次數（累計）。tier = promotions − relegations */
  relegations: number
  /** 最近一次降級：matchIndex 是造成降級的那一場，畫面用它（與 relegations）辨識同一個事件，不會重複通知 */
  lastRelegation: RelegationRecord | null
}

export interface RelegationRecord {
  fromTier: number
  toTier: number
  /** 造成降級的那一場一般比賽 */
  matchIndex: number
  /** 那一場的預定結束時間 */
  at: number
}

/** 一場一般比賽造成的積分變化，跟比賽一起存進 SettledMatch.ranked（戰報顯示用，不在畫面上重算） */
export interface RankedMatchRecord {
  /** 這場計分時的聯盟 */
  tier: number
  before: number
  after: number
  /** 實際變化（保護期或上下限會讓它跟規則上的 +3／−2 不同） */
  delta: number
  /** 這場的失分被保護擋下（積分停在 1） */
  protected: boolean
  /** 這場之後還剩幾場保護 */
  protectionRemaining: number
  /** 這場造成降級：降到哪一級 */
  relegatedTo: number | null
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
    points: null,
    protectionRemaining: 0,
    relegations: 0,
    lastRelegation: null,
  }
}

/**
 * 直接把聯盟設成某一級（沒有降級過、每一級都晉級過一次）：給測試、效能測試與平衡腳本建立情境用，正式流程不用它
 */
export function leagueAtTier(state: LeagueState, tier: number, extra: Partial<LeagueState> = {}): LeagueState {
  return {
    ...state,
    tier,
    highestTier: tier,
    promotions: tier,
    relegations: 0,
    lastRelegation: null,
    rewardedTiers: Array.from({ length: tier }, (_, i) => i + 1),
    points: initialPointsFor(tier),
    protectionRemaining: 0,
    ...extra,
  }
}

// ---- 競技積分（純函式，不改輸入） ----

export const rankedEnabled = (tier: number) => tier >= RANKED_CONFIG.enabledFromTier
export const canRelegate = (tier: number) => RANKED_CONFIG.relegationTiers.includes(tier)
/** 這一級的起始積分：挑戰者以上是 initialPoints，以下沒有積分 */
export const initialPointsFor = (tier: number): number | null => (rankedEnabled(tier) ? RANKED_CONFIG.initialPoints : null)
export const inDanger = (points: number | null) => points !== null && points <= RANKED_CONFIG.dangerThreshold

/**
 * 記一場一般比賽的積分（呼叫端保證這場是目前聯盟的比賽）：勝 +3、敗 −2，範圍 0～100；
 * 保護期間積分最低停在 1，並扣一場保護；職業、傳奇歸零就降一級（降級後積分重設、保護歸零）。
 * 沒有積分的聯盟回傳原狀態與 null
 */
export function applyRankedResult(state: LeagueState, won: boolean, matchIndex: number, at: number): { state: LeagueState; record: RankedMatchRecord | null } {
  if (state.points === null || !rankedEnabled(state.tier)) return { state, record: null }
  const before = state.points
  let after = Math.min(RANKED_CONFIG.maxPoints, Math.max(RANKED_CONFIG.minPoints, before + (won ? RANKED_CONFIG.winPoints : RANKED_CONFIG.lossPoints)))
  let protectionRemaining = state.protectionRemaining
  let guarded = false
  if (protectionRemaining > 0) {
    if (after < 1) {
      after = 1
      guarded = true
    }
    protectionRemaining--
  }
  const next: LeagueState = { ...state, points: after, protectionRemaining }
  if (after <= RANKED_CONFIG.minPoints && canRelegate(state.tier)) {
    const relegated = relegate(next, matchIndex, at)
    return { state: relegated, record: { tier: state.tier, before, after, delta: after - before, protected: guarded, protectionRemaining: 0, relegatedTo: relegated.tier } }
  }
  return { state: next, record: { tier: state.tier, before, after, delta: after - before, protected: guarded, protectionRemaining, relegatedTo: null } }
}

/**
 * 降一級：本聯盟場次、勝敗、最近戰績重算，挑戰冷卻清掉；積分重設為起始值、沒有保護。
 * 最高階級、晉級次數、已發獎勵、挑戰紀錄都保留
 */
export function relegate(state: LeagueState, matchIndex: number, at: number): LeagueState {
  if (!canRelegate(state.tier)) throw new RangeError(`${leagueOf(state.tier).name}不會降級`)
  const toTier = state.tier - 1
  return {
    ...state,
    tier: toTier,
    matches: 0,
    wins: 0,
    losses: 0,
    recent: '',
    challengeReadyAt: 0,
    points: initialPointsFor(toTier),
    protectionRemaining: 0,
    relegations: state.relegations + 1,
    lastRelegation: { fromTier: state.tier, toTier, matchIndex, at },
  }
}

/** 晉級後的積分：重設為起始值，開啟保護（挑戰者以下沒有積分也沒有保護） */
export function promotedRanked(toTier: number): Pick<LeagueState, 'points' | 'protectionRemaining'> {
  return rankedEnabled(toTier) ? { points: RANKED_CONFIG.initialPoints, protectionRemaining: RANKED_CONFIG.promotionProtectionMatches } : { points: null, protectionRemaining: 0 }
}

/**
 * 從現在起，最多再結算幾場「一定不會降級」：結算服務用它把一批離線比賽切段，降級之後的比賽才能用新聯盟重新規劃。
 * 不會降級的聯盟是 Infinity；保護期間是剩下的保護場數；之後是最快歸零需要的連敗場數
 */
export function matchesBeforePossibleRelegation(state: LeagueState): number {
  if (state.points === null || !canRelegate(state.tier)) return Number.POSITIVE_INFINITY
  if (state.protectionRemaining > 0) return state.protectionRemaining
  return Math.max(1, Math.ceil((state.points - RANKED_CONFIG.minPoints) / -RANKED_CONFIG.lossPoints))
}

export type RankedZone = 'off' | 'floor' | 'safe' | 'danger'

/** 畫面用的競技狀態（只讀存檔，不重算任何積分） */
export interface RankedView {
  enabled: boolean
  tier: number
  points: number | null
  max: number
  win: number
  loss: number
  dangerThreshold: number
  zone: RankedZone
  /** 這一級會不會降級（職業、傳奇） */
  canRelegate: boolean
  /** 降級會降到哪一級 */
  relegateTo: number | null
  /** 離危險區還有幾分（已經在危險區是 0） */
  aboveDanger: number | null
  /** 歸零還差幾分 */
  toZero: number | null
  protectionRemaining: number
  atMax: boolean
}

export function rankedView(state: LeagueState): RankedView {
  const enabled = state.points !== null && rankedEnabled(state.tier)
  const relegates = canRelegate(state.tier)
  const p = enabled ? state.points : null
  const zone: RankedZone = !enabled ? 'off' : !relegates ? 'floor' : inDanger(p) ? 'danger' : 'safe'
  return {
    enabled,
    tier: state.tier,
    points: p,
    max: RANKED_CONFIG.maxPoints,
    win: RANKED_CONFIG.winPoints,
    loss: -RANKED_CONFIG.lossPoints,
    dangerThreshold: RANKED_CONFIG.dangerThreshold,
    zone,
    canRelegate: relegates,
    relegateTo: relegates ? state.tier - 1 : null,
    aboveDanger: p === null ? null : Math.max(0, p - RANKED_CONFIG.dangerThreshold),
    toZero: p === null ? null : p - RANKED_CONFIG.minPoints,
    protectionRemaining: enabled ? state.protectionRemaining : 0,
    atMax: p !== null && p >= RANKED_CONFIG.maxPoints,
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
  // Phase 7B 起有降級：目前階級 = 晉級次數 − 降級次數，而且不高於最高階級；晉級次數至少是最高階級（重返也算一次晉級）
  if (!Number.isInteger(s.relegations) || s.relegations < 0) out.push('降級次數不合法')
  if (s.promotions < s.highestTier || s.tier !== s.promotions - s.relegations) out.push('晉級次數、降級次數與目前階級對不起來')
  if (new Set(s.rewardedTiers).size !== s.rewardedTiers.length || s.rewardedTiers.some((t) => t < 1 || t > s.highestTier)) out.push('晉級獎勵紀錄不合法')
  // 競技積分
  if (rankedEnabled(s.tier)) {
    if (!Number.isInteger(s.points) || (s.points as number) < RANKED_CONFIG.minPoints || (s.points as number) > RANKED_CONFIG.maxPoints) out.push('競技積分不合法')
  } else if (s.points !== null) out.push('這個聯盟不應該有競技積分')
  if (!Number.isInteger(s.protectionRemaining) || s.protectionRemaining < 0 || s.protectionRemaining > RANKED_CONFIG.promotionProtectionMatches) out.push('保護場次不合法')
  if (!rankedEnabled(s.tier) && s.protectionRemaining !== 0) out.push('這個聯盟不應該有保護場次')
  // 職業、傳奇的積分歸零當場就降級，所以存檔裡不會停在 0
  if (canRelegate(s.tier) && s.points === RANKED_CONFIG.minPoints) out.push('會降級的聯盟積分不會停在 0')
  const r = s.lastRelegation
  if (r === null) {
    if (s.relegations !== 0) out.push('有降級次數卻沒有降級紀錄')
  } else if (!canRelegate(r.fromTier) || r.toTier !== r.fromTier - 1 || r.fromTier > s.highestTier || !Number.isInteger(r.matchIndex) || r.matchIndex < 0 || s.relegations < 1) {
    out.push('降級紀錄不合法')
  }
  return out
}
