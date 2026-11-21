// 批次模擬：把球團的第 i 場比賽變成一份「比賽計畫」（快照好的陣容、戰術、種子），再用 Phase 1 的 runMatch 打完。
// 計畫與結果都是純資料、可以序列化，之後要搬進 Web Worker 只要把 runBatch 的迴圈搬過去。
// 這裡不碰時間、儲存或 DOM；讓出主執行緒的方式由呼叫端注入，測試可以完全控制
import { generateTeam } from '../../sim/generate'
import { equippedTeam } from '../../sim/items'
import { Rng } from '../../sim/rng'
import type { Team } from '../../sim/types'
import { RULES_VERSION, type GameSetup, type Side } from '../../sim/game'
import { SEED_SALT, deriveSeed, matchIdFor, userSideFor, type ClubSave } from '../domain/club'
import { BATCH_CONFIG } from '../domain/config'
import { leagueOf } from '../domain/league'
import { resolveRoster } from '../domain/roster'
import { stableJson } from '../domain/fingerprint'
import { runMatch, type MatchAi, type MatchResult } from './matchRunner'

/** 一場比賽的計畫：開打前就把球團的陣容與戰術複製一份，之後球團再怎麼改都不影響這一場 */
export interface MatchPlan {
  matchId: string
  matchIndex: number
  seed: number
  userSide: Side
  opponentName: string
  /** 這場所屬的聯盟階級：決定對手強度與收益倍率。結算時要跟球團目前的聯盟一致 */
  leagueTier: number
  /** 規則版本寫明在 setup 裡，接續舊結果時要比對 */
  setup: GameSetup & { rules: number }
  ai: MatchAi
}

export interface MatchOutcome {
  plan: MatchPlan
  result: MatchResult
}

/**
 * 第 matchIndex 場的計畫：種子、對手、主客場只由球團種子與場次序號決定，對手強度由球團「目前」的聯盟決定。
 * 聯盟只會在晉級挑戰時改變，而挑戰一定先把到期的比賽結算完，所以到期的比賽一定用晉級前的聯盟
 */
export function planMatch(club: ClubSave, matchIndex: number): MatchPlan {
  if (!Number.isSafeInteger(matchIndex) || matchIndex < 0) throw new RangeError(`場次序號不合法：${matchIndex}`)
  const seed = deriveSeed(club.clubSeed, matchIndex, SEED_SALT.match)
  const userSide = userSideFor(matchIndex)
  const leagueTier = club.league.tier
  return buildPlan(club, {
    matchId: matchIdFor(club, matchIndex),
    matchIndex,
    seed,
    userSide,
    leagueTier,
    opponentSeed: deriveSeed(club.clubSeed, matchIndex, SEED_SALT.opponent),
    opponentMean: leagueOf(leagueTier).opponentMean,
  })
}

/** 比賽計畫的共用部分（一般比賽與晉級挑戰賽）：對手由給定的種子與強度產生，我方快照目前的陣容與戰術 */
export function buildPlan(
  club: ClubSave,
  p: { matchId: string; matchIndex: number; seed: number; userSide: Side; leagueTier: number; opponentSeed: number; opponentMean: number; opponent?: Team },
): MatchPlan {
  const { userSide, seed } = p
  // 冠軍賽：對手在系列賽開始時就固定（整支存在存檔裡），不再由種子重新產生
  const opponent = p.opponent ? structuredClone(p.opponent) : generateTeam(new Rng(p.opponentSeed), p.opponentMean)
  // 快照：把配置換算成「這一刻」養成後能力的完整陣容（深拷貝），之後升級、換人都不影響這一場
  const ours = equippedTeam({ name: club.clubName, roster: structuredClone(resolveRoster(club)) })
  const coach = structuredClone(club.strategy.coach)
  const otherSide: Side = userSide === 'home' ? 'away' : 'home'
  return {
    matchId: p.matchId,
    matchIndex: p.matchIndex,
    seed,
    userSide,
    opponentName: opponent.name,
    leagueTier: p.leagueTier,
    setup: { home: userSide === 'home' ? ours : opponent, away: userSide === 'away' ? ours : opponent, seed, userSide, rules: RULES_VERSION },
    ai: { [userSide]: { kind: 'autoCoach', style: coach.style, params: coach.params }, [otherSide]: { kind: 'builtin' } } as MatchAi,
  }
}

/** 從第 from 場開始的 count 場計畫 */
export function planMatches(club: ClubSave, from: number, count: number): MatchPlan[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => planMatch(club, from + i))
}

export interface BatchSummary {
  planned: number
  completed: number
  wins: number
  losses: number
  runsFor: number
  runsAgainst: number
}

export interface BatchRun {
  /** completed：全部打完；aborted：被中斷；failed：某一場模擬失敗（outcomes 只有失敗之前的場次） */
  status: 'completed' | 'aborted' | 'failed'
  /** 依序打完的場次，一定是 plans 的前綴 */
  outcomes: MatchOutcome[]
  summary: BatchSummary
  failedMatchId?: string
  error?: unknown
}

export interface BatchOptions {
  /** 每打幾場讓出一次主執行緒 */
  chunkSize?: number
  /**
   * 讓出主執行緒。不給就用 yieldToMain（正式環境的預設，忘了注入也不會卡住畫面）；
   * 測試可以注入可控制的函式；在 Web Worker 裡不需要讓出時給 null
   */
  yieldControl?: (() => Promise<void>) | null
  /** 中斷：每場開打前檢查 */
  signal?: AbortSignal
  /** 上次中斷時已經打完的場次：不會重打，直接沿用 */
  completed?: readonly MatchOutcome[]
  /** 單場的模擬函式（測試用來注入失敗） */
  simulate?: (plan: MatchPlan) => MatchResult
  onProgress?: (done: number, total: number) => void
  /**
   * 跨批次共用的「距離上次讓出打了幾場」：分段結算把一批拆成好幾段時傳同一個物件，
   * 很短的段落（例如 MVP 成長的上限只有 1～2 場）也會照總場數每 chunkSize 場讓出一次，不會整批都不讓出
   */
  yieldCounter?: { sinceYield: number }
}

const defaultSimulate = (plan: MatchPlan) => runMatch(plan.setup, plan.ai)

/** 依序打完所有計畫；每 chunkSize 場讓出一次主執行緒，可中斷、可接續 */
export async function runBatch(plans: readonly MatchPlan[], options: BatchOptions = {}): Promise<BatchRun> {
  const chunkSize = options.chunkSize ?? BATCH_CONFIG.chunkSize
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`chunkSize 必須是大於 0 的整數：${chunkSize}`)
  const simulate = options.simulate ?? defaultSimulate
  const yieldControl = options.yieldControl === undefined ? yieldToMain : options.yieldControl
  const done = new Map((options.completed ?? []).map((o) => [o.plan.matchId, o]))
  const outcomes: MatchOutcome[] = []
  const counter = options.yieldCounter ?? { sinceYield: 0 }
  for (const plan of plans) {
    const previous = done.get(plan.matchId)
    if (previous) {
      // 接續：舊結果必須是用完全一樣的計畫打出來的（陣容、戰術、對手、種子、規則版本），否則拒絕
      const why = resumeMismatch(previous, plan)
      if (why) throw new BatchResumeError(plan.matchId, why)
      outcomes.push(previous)
      continue
    }
    if (options.signal?.aborted) return finish('aborted', plans, outcomes)
    try {
      outcomes.push({ plan, result: simulate(plan) })
    } catch (error) {
      return { ...finish('failed', plans, outcomes), failedMatchId: plan.matchId, error }
    }
    options.onProgress?.(outcomes.length, plans.length)
    if (++counter.sinceYield >= chunkSize && yieldControl) {
      counter.sinceYield = 0
      await yieldControl()
    }
  }
  return finish('completed', plans, outcomes)
}

/** 舊結果不能沿用：計畫或結果跟現在的計畫不一致 */
export class BatchResumeError extends Error {
  override name = 'BatchResumeError'
  constructor(
    readonly matchId: string,
    readonly reason: string,
  ) {
    super(`接續的比賽 ${matchId} 跟目前的計畫不一致（${reason}），不能沿用舊結果`)
  }
}

/** 比對舊結果與現在的計畫，回傳不一致的原因；一致就是 null */
function resumeMismatch(previous: MatchOutcome, plan: MatchPlan): string | null {
  const replay = previous.result.replay
  if (stableJson(previous.plan) !== stableJson(plan)) return '計畫內容不同（陣容、戰術、對手或種子）'
  // 結果本身也要是這份計畫打出來的：重播設定（含規則版本）與 AI 設定都要相同
  if (replay.rulesVersion !== plan.setup.rules) return `規則版本不同（${replay.rulesVersion} ≠ ${plan.setup.rules}）`
  if (stableJson(replay.setup) !== stableJson(plan.setup)) return '結果的比賽設定與計畫不同'
  if (stableJson(replay.ai) !== stableJson(plan.ai)) return '結果的 AI 設定與計畫不同'
  return null
}

function finish(status: BatchRun['status'], plans: readonly MatchPlan[], outcomes: MatchOutcome[]): BatchRun {
  const summary: BatchSummary = { planned: plans.length, completed: outcomes.length, wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 }
  for (const { plan, result } of outcomes) {
    const other: Side = plan.userSide === 'home' ? 'away' : 'home'
    if (result.winner === plan.userSide) summary.wins++
    else summary.losses++
    summary.runsFor += result.score[plan.userSide]
    summary.runsAgainst += result.score[other]
  }
  return { status, outcomes, summary }
}

/** 瀏覽器裡讓出主執行緒：有 scheduler.yield 就用，否則用 MessageChannel（不受背景分頁的 setTimeout 節流影響） */
export function yieldToMain(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (s?.yield) return s.yield()
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}
