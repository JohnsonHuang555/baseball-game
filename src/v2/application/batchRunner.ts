// 批次模擬：把球團的第 i 場比賽變成一份「比賽計畫」（快照好的陣容、戰術、種子），再用 Phase 1 的 runMatch 打完。
// 計畫與結果都是純資料、可以序列化，之後要搬進 Web Worker 只要把 runBatch 的迴圈搬過去。
// 這裡不碰時間、儲存或 DOM；讓出主執行緒的方式由呼叫端注入，測試可以完全控制
import { generateTeam } from '../../sim/generate'
import { equippedTeam } from '../../sim/items'
import { Rng } from '../../sim/rng'
import type { GameSetup, Side } from '../../sim/game'
import { SEED_SALT, deriveSeed, matchIdFor, userSideFor, type ClubSaveV3 } from '../domain/club'
import { BATCH_CONFIG } from '../domain/config'
import { runMatch, type MatchAi, type MatchResult } from './matchRunner'

/** 一場比賽的計畫：開打前就把球團的陣容與戰術複製一份，之後球團再怎麼改都不影響這一場 */
export interface MatchPlan {
  matchId: string
  matchIndex: number
  seed: number
  userSide: Side
  opponentName: string
  setup: GameSetup
  ai: MatchAi
}

export interface MatchOutcome {
  plan: MatchPlan
  result: MatchResult
}

/** 第 matchIndex 場的計畫：種子、對手、主客場都只由球團種子與場次序號決定 */
export function planMatch(club: ClubSaveV3, matchIndex: number): MatchPlan {
  if (!Number.isSafeInteger(matchIndex) || matchIndex < 0) throw new RangeError(`場次序號不合法：${matchIndex}`)
  const seed = deriveSeed(club.clubSeed, matchIndex, SEED_SALT.match)
  const userSide = userSideFor(matchIndex)
  const opponent = generateTeam(new Rng(deriveSeed(club.clubSeed, matchIndex, SEED_SALT.opponent)))
  // 快照：深拷貝陣容與戰術
  const ours = equippedTeam({ name: club.clubName, roster: structuredClone(club.roster) })
  const coach = structuredClone(club.strategy.coach)
  const otherSide: Side = userSide === 'home' ? 'away' : 'home'
  return {
    matchId: matchIdFor(club, matchIndex),
    matchIndex,
    seed,
    userSide,
    opponentName: opponent.name,
    setup: { home: userSide === 'home' ? ours : opponent, away: userSide === 'away' ? ours : opponent, seed, userSide },
    ai: { [userSide]: { kind: 'autoCoach', style: coach.style, params: coach.params }, [otherSide]: { kind: 'builtin' } } as MatchAi,
  }
}

/** 從第 from 場開始的 count 場計畫 */
export function planMatches(club: ClubSaveV3, from: number, count: number): MatchPlan[] {
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
  /** 讓出主執行緒；不給就不讓出（測試、Worker 裡用） */
  yieldControl?: () => Promise<void>
  /** 中斷：每場開打前檢查 */
  signal?: AbortSignal
  /** 上次中斷時已經打完的場次：不會重打，直接沿用 */
  completed?: readonly MatchOutcome[]
  /** 單場的模擬函式（測試用來注入失敗） */
  simulate?: (plan: MatchPlan) => MatchResult
  onProgress?: (done: number, total: number) => void
}

const defaultSimulate = (plan: MatchPlan) => runMatch(plan.setup, plan.ai)

/** 依序打完所有計畫；每 chunkSize 場讓出一次主執行緒，可中斷、可接續 */
export async function runBatch(plans: readonly MatchPlan[], options: BatchOptions = {}): Promise<BatchRun> {
  const chunkSize = options.chunkSize ?? BATCH_CONFIG.chunkSize
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError(`chunkSize 必須是大於 0 的整數：${chunkSize}`)
  const simulate = options.simulate ?? defaultSimulate
  const done = new Map((options.completed ?? []).map((o) => [o.plan.matchId, o]))
  const outcomes: MatchOutcome[] = []
  let sinceYield = 0
  for (const plan of plans) {
    const previous = done.get(plan.matchId)
    if (previous) {
      // 接續：同一場的計畫必須完全一樣，否則代表陣容或種子變了，不能沿用
      if (previous.plan.seed !== plan.seed || previous.plan.matchIndex !== plan.matchIndex) {
        throw new Error(`接續的場次跟計畫對不起來：${plan.matchId}`)
      }
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
    if (++sinceYield >= chunkSize && options.yieldControl) {
      sinceYield = 0
      await options.yieldControl()
    }
  }
  return finish('completed', plans, outcomes)
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
        resolve()
      }
      channel.port2.postMessage(null)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}
