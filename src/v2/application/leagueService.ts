// 晉級挑戰：達到晉級條件後，打一場自動模擬的挑戰賽，贏了晉級到下一級聯盟。
//
// 跟一般比賽完全分開：挑戰賽用自己的序號（league.nextChallengeSeq）、自己的種子 salt、自己的比賽編號（<球團>#c<序號>），
// 不動一般比賽的結算游標（idle.nextMatchIndex）與時間錨點，也不記進總戰績、近期比賽與一般比賽的 replay（挑戰賽的 Replay 另外存在 challengeReplay，只留最近一場）。
//
// 冪等：請求帶上「畫面顯示時」的 nextChallengeSeq 與聯盟（不是送出當下重新讀到的值），以及這次操作的 requestId。
// - 序號與聯盟都等於存檔目前的值：檢查資格、模擬、晉級（或記下失敗），序號加 1
// - 序號是上一個、而且請求內容（聯盟 + requestId）跟最近一筆挑戰相同：同一個請求重送，回傳原本的結果，不再模擬、不再發獎
// - 其他（別的分頁已經挑戰過或晉級、畫面過期）：拒絕，請重新讀取。不會因為畫面過期而開始另一個聯盟的挑戰
// 所以重複點擊、重送、多分頁同時按都只會挑戰一次，不會連跳兩級。
//
// 一致性：在 ClubLock 裡「讀最新存檔 → 用目前的聯盟結算到期的比賽 → 驗證資格 → 模擬 → 更新聯盟與獎勵 → 一次存檔」。
// 到期的比賽一定先用晉級前的聯盟結算，晉級後從下一場還沒打的比賽開始才是新聯盟。
// - 結算失敗：打完的場次照樣存檔，不挑戰
// - 資格不符、請求過期：到期的比賽照樣存檔，丟 LeagueError（帶上存好的球團）
// - 挑戰賽模擬失敗：到期的比賽照樣存檔，不晉級、序號不變（可以重試，同一個序號的挑戰賽一定是同一場）
// - 存檔寫入失敗：丟 ClubSaveError，什麼都沒變，不會回報成功
import type { Side } from '../../sim/game'
import { SEED_SALT, deriveSeed, userSideFor, type ClubSave, type Resources } from '../domain/club'
import { promotedRanked, eligibility, leagueOf, type ChallengeRecord } from '../domain/league'
import { MAX_TIER, PROMOTION_CONFIG } from '../domain/leagueConfig'
import { buildPlan, runBatch, type MatchOutcome, type MatchPlan } from './batchRunner'
import { SettlementError, settleDueUnsaved, type SettlementDeps } from './settlementService'
import { freezeLiveMatch } from './liveMatch'

export type LeagueErrorCode = 'bad-request' | 'stale-request' | 'not-eligible' | 'max-tier'

export class LeagueError extends Error {
  override name = 'LeagueError'
  /** 被拒絕之前，到期的比賽已經結算並存檔：這是存好的球團。沒有到期的比賽時是 undefined */
  settled?: { club: ClubSave; matches: number }
  constructor(
    readonly code: LeagueErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ChallengeRequest {
  /** 讀到的 league.nextChallengeSeq */
  challengeSeq: number
  /** 畫面上看到的目前聯盟：跟存檔不同（別的分頁剛晉級）就拒絕 */
  fromTier: number
  /**
   * 這次操作的識別碼（每次按下按鈕產生一個）：用來分辨「同一個請求重送」與「另一個分頁拿著同樣的序號送來的不同請求」。
   * 沒有給的話，只要序號與聯盟相同就視為重送
   */
  requestId?: string
}

export interface ChallengeOutcome {
  club: ClubSave
  challenge: ChallengeRecord
  /** 重送的請求：沒有再模擬、沒有再發獎，challenge 是原本那一筆 */
  duplicate: boolean
  /** 挑戰前先結算的一般比賽場數 */
  settledMatches: number
}

// ---- 純函式 ----

export function challengeMatchId(club: Pick<ClubSave, 'clubId'>, seq: number): string {
  return `${club.clubId}#c${seq}`
}

/** 第 seq 次挑戰的對手強度：下一級聯盟的一般對手再強一點 */
export function challengeOpponentMean(fromTier: number): number {
  return leagueOf(Math.min(fromTier + 1, MAX_TIER)).opponentMean + PROMOTION_CONFIG.challengeBonus
}

/**
 * 目前這次挑戰的比賽計畫：只由球團種子、挑戰序號與目前聯盟決定（確定性），陣容與戰術快照目前的設定。
 * leagueTier 記的是挑戰的目標聯盟
 */
export function planChallenge(club: ClubSave): MatchPlan {
  const seq = club.league.nextChallengeSeq
  const fromTier = club.league.tier
  return buildPlan(club, {
    matchId: challengeMatchId(club, seq),
    matchIndex: seq,
    seed: deriveSeed(club.clubSeed, seq, SEED_SALT.challenge),
    userSide: userSideFor(seq),
    leagueTier: Math.min(fromTier + 1, MAX_TIER),
    opponentSeed: deriveSeed(club.clubSeed, seq, SEED_SALT.challengeOpponent),
    opponentMean: challengeOpponentMean(fromTier),
  })
}

function requestKeyFor(req: ChallengeRequest): string {
  return req.requestId ? `challenge:${req.fromTier}:${req.requestId}` : `challenge:${req.fromTier}`
}

/** 檢查序號：可以挑戰回傳 null；重送回傳原本那一筆 */
export function checkChallenge(club: ClubSave, req: ChallengeRequest): ChallengeRecord | null {
  if (!Number.isSafeInteger(req.challengeSeq) || req.challengeSeq < 0 || !Number.isSafeInteger(req.fromTier) || (req.requestId !== undefined && (typeof req.requestId !== 'string' || !req.requestId))) {
    throw new LeagueError('bad-request', '挑戰請求不合法')
  }
  const { league } = club
  const last = league.challenges.at(-1)
  if (req.challengeSeq === league.nextChallengeSeq - 1 && last && last.seq === req.challengeSeq && last.requestKey === requestKeyFor(req)) return last
  if (req.challengeSeq !== league.nextChallengeSeq || req.fromTier !== league.tier) {
    throw new LeagueError('stale-request', '聯盟狀態已經改變（可能其他分頁剛挑戰過），請重新讀取後再試一次')
  }
  if (league.tier >= MAX_TIER) throw new LeagueError('max-tier', `已經在最高的${leagueOf(MAX_TIER).name}`)
  return null
}

/** 挑戰前的資格檢查（用結算完到期比賽之後的球團） */
export function assertEligible(club: ClubSave): void {
  const e = eligibility(club.league, club.idle.nextMatchIndex)
  if (e.ok) return
  if (e.atMaxTier) throw new LeagueError('max-tier', `已經在最高的${leagueOf(MAX_TIER).name}`)
  throw new LeagueError('not-eligible', '還沒有達到晉級條件')
}

/**
 * 把挑戰結果記進球團（不改輸入）：
 * - 贏：晉級、晉級次數 +1、更新最高階級、本聯盟戰績歸零；第一次到這個聯盟的獎勵加到未領取與累計收益（每個聯盟只發一次）
 * - 輸：記下失敗，要再打 retryAfterMatches 場一般比賽才能再挑戰
 * 不管輸贏，都把這場挑戰賽的完整 Replay 存進 challengeReplay（取代上一次的）。
 * 球員、等級、資產、總戰績、近期比賽、一般比賽的 replay 都不動
 */
export function applyChallenge(club: ClubSave, req: ChallengeRequest, outcome: MatchOutcome, now: number): { club: ClubSave; challenge: ChallengeRecord } {
  const { plan, result } = outcome
  if (plan.matchId !== challengeMatchId(club, club.league.nextChallengeSeq) || plan.seed !== deriveSeed(club.clubSeed, club.league.nextChallengeSeq, SEED_SALT.challenge)) {
    throw new SettlementError('mismatch', `挑戰賽 ${plan.matchId} 不是這次的挑戰`)
  }
  const other: Side = plan.userSide === 'home' ? 'away' : 'home'
  const won = result.winner === plan.userSide
  const next = structuredClone(club)
  const league = next.league
  const fromTier = league.tier
  const toTier = fromTier + 1
  let reward: Resources = { funds: 0, experience: 0 }
  if (won) {
    league.tier = toTier
    league.highestTier = Math.max(league.highestTier, toTier)
    league.promotions++
    league.matches = 0
    league.wins = 0
    league.losses = 0
    league.recent = ''
    league.challengeReadyAt = 0
    // 競技積分：重設為起始值、開啟晉級保護（挑戰賽本身不計分）
    Object.assign(league, promotedRanked(toTier))
    // 首次晉級獎勵看 rewardedTiers（不看目前或最高階級）：降級後重返不會再發
    if (!league.rewardedTiers.includes(toTier)) {
      reward = { ...leagueOf(toTier).promotionReward }
      league.rewardedTiers = [...league.rewardedTiers, toTier]
      const e = next.economy
      e.unclaimed = { funds: e.unclaimed.funds + reward.funds, experience: e.unclaimed.experience + reward.experience }
      e.earned = { funds: e.earned.funds + reward.funds, experience: e.earned.experience + reward.experience }
    }
  } else {
    league.challengeReadyAt = next.idle.nextMatchIndex + PROMOTION_CONFIG.retryAfterMatches
  }
  const challenge: ChallengeRecord = {
    seq: league.nextChallengeSeq,
    fromTier,
    toTier,
    won,
    runsFor: result.score[plan.userSide],
    runsAgainst: result.score[other],
    opponentName: plan.opponentName,
    innings: result.innings,
    at: now,
    matchIndexAt: next.idle.nextMatchIndex,
    reward,
    requestKey: requestKeyFor(req),
  }
  league.nextChallengeSeq++
  league.challenges = [...league.challenges, challenge].slice(-PROMOTION_CONFIG.historyLimit)
  next.challengeReplay = { seq: challenge.seq, matchId: plan.matchId, replay: structuredClone(result.replay) }
  return { club: next, challenge }
}

// ---- 服務 ----

/** 挑戰下一級聯盟（冪等）：先結算到期的比賽，再驗證資格、打挑戰賽、更新聯盟，一次存檔 */
export function challengeNextLeague(deps: SettlementDeps, req: ChallengeRequest): Promise<ChallengeOutcome> {
  return deps.lock.run(async () => {
    const club = deps.store.loadClub()
    if (!club) throw new SettlementError('no-club', '還沒有球團存檔')
    const now = deps.clock.now()
    const { next, batch } = await settleDueUnsaved(club, now, deps)
    const settledMatches = next.settled.length
    const saveSettled = () => (settledMatches > 0 ? deps.store.saveClub(next.club, club.revision) : club)
    if (batch.status !== 'completed') {
      saveSettled()
      throw new SettlementError('simulation-failed', `挑戰前的結算沒有完成：${batch.failedMatchId ?? batch.status}`, undefined, { cause: batch.error })
    }
    const settledClub = next.club
    let dup: ChallengeRecord | null
    try {
      dup = checkChallenge(settledClub, req)
      if (!dup) assertEligible(settledClub)
    } catch (e) {
      if (e instanceof LeagueError && settledMatches > 0) e.settled = { club: saveSettled(), matches: settledMatches }
      throw e
    }
    if (dup) return { club: saveSettled(), challenge: dup, duplicate: true, settledMatches }
    const run = await runBatch([planChallenge(settledClub)], { ...deps.batch })
    if (run.status !== 'completed' || run.outcomes.length !== 1) {
      saveSettled()
      throw new SettlementError('simulation-failed', '挑戰賽模擬失敗，沒有晉級，可以再試一次', undefined, { cause: run.error })
    }
    // 進行中那一場已經用晉級前的聯盟開打：先固定，新聯盟從下一場開始
    const applied = applyChallenge(freezeLiveMatch(settledClub), req, run.outcomes[0], now)
    return { club: deps.store.saveClub(applied.club, club.revision), challenge: applied.challenge, duplicate: false, settledMatches }
  })
}
