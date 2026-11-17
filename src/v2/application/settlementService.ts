// 結算服務：把「時間到了的比賽」變成戰績與收益，而且可以重複呼叫、不會重複發獎（Idempotent Settlement）。
//
// 冪等的依據是結算游標 idle.nextMatchIndex：比它小的場次都已結算，再送一次會被略過；跳號直接報錯。
// 收益分三筆記（見 domain/club.ts 的 EconomyState）：結算只加到 unclaimed，領取才搬進 assets。
// 狀態轉換全部是純函式（不改輸入）；服務層在鎖內「讀最新存檔 → 計算 → 存檔」，存檔成功才算結算完成。
import type { Side } from '../../sim/game'
import {
  SEED_SALT,
  deriveSeed,
  matchIdFor,
  type ClubSave,
  type MatchSummary,
  type RosterAssignment,
  type Resources,
  type SettledMatch,
  type SummaryHighlight,
  type TeamStrategies,
} from '../domain/club'
import { RETENTION_CONFIG } from '../domain/config'
import { settingsVersions, type SettingsVersions } from '../domain/fingerprint'
import { LineupError, lineupIssues } from '../domain/lineup'
import { assignmentIssues, resolveRoster } from '../domain/roster'
import { leagueOf, recordLeagueResult } from '../domain/league'
import { rewardFor } from '../domain/rewards'
import { coachParamIssues } from '../domain/tactics'
import { planMatches, runBatch, type BatchOptions, type BatchRun, type BatchSummary, type MatchOutcome } from './batchRunner'
import { advanceAnchor, dueMatches, type Clock, type DueMatches } from './idleEngine'

// ---- 對外依賴（由 infrastructure 實作，測試換成記憶體版） ----

/** 存檔的讀寫。saveClub 要確認存檔目前的 revision 還是 expectedRevision，存進去的 revision 加 1 */
export interface ClubStore {
  loadClub(): ClubSave | null
  saveClub(club: ClubSave, expectedRevision: number): ClubSave
}

/** 結算互斥。crossTab 是 false 代表只能保證同一個分頁內不會同時結算 */
export interface ClubLock {
  readonly crossTab: boolean
  run<T>(fn: () => Promise<T>): Promise<T>
}

export type SettlementErrorCode = 'no-club' | 'out-of-order' | 'mismatch' | 'simulation-failed' | 'settings-conflict'

export class SettlementError extends Error {
  override name = 'SettlementError'
  constructor(
    readonly code: SettlementErrorCode,
    message: string,
    /** 模擬失敗時，失敗之前的場次已經結算並存檔，這是存好的結果 */
    readonly report?: SettlementReport,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

// ---- 純函式 ----

/** 一場比賽要留在存檔裡的摘要 */
export function summarize(outcome: MatchOutcome): MatchSummary {
  const { plan, result } = outcome
  const other: Side = plan.userSide === 'home' ? 'away' : 'home'
  const names = new Map(result.players.map((p) => [p.playerId, p.name]))
  // 重要的精彩事件：再見 > 全壘打 > 關鍵安打，同類比得分；留下的照發生順序排
  const rank = { walkOff: 3, homeRun: 2, clutchHit: 1 } as const
  const picked = result.highlights
    .map((h, order) => ({ h, order }))
    .filter(({ h }) => h.kind !== 'pitchingChange')
    .sort((a, b) => rank[b.h.kind as keyof typeof rank] - rank[a.h.kind as keyof typeof rank] || b.h.runs - a.h.runs || a.order - b.order)
    .slice(0, RETENTION_CONFIG.highlightsPerMatch)
    .sort((a, b) => a.order - b.order)
  const highlights: SummaryHighlight[] = picked.map(({ h }) => ({
    kind: h.kind as SummaryHighlight['kind'],
    inning: h.inning,
    half: h.half,
    playerId: h.playerId,
    playerName: names.get(h.playerId) ?? '',
    runs: h.runs,
    ours: h.side === plan.userSide,
  }))
  return {
    userSide: plan.userSide,
    opponentName: plan.opponentName,
    runsFor: result.score[plan.userSide],
    runsAgainst: result.score[other],
    won: result.winner === plan.userSide,
    innings: result.innings,
    highlights,
    rulesVersion: result.replay.rulesVersion,
    coachVersion: result.replay.coachVersion,
    leagueTier: plan.leagueTier,
  }
}

export interface SettleOutcome {
  club: ClubSave
  /** 這次新結算的場次 */
  settled: SettledMatch[]
  /** 之前已經結算過、這次略過的場次數 */
  duplicates: number
}

/**
 * 把打完的比賽記進球團：戰績、未領取收益、近期比賽、replay，游標往前推。
 * 已結算的場次略過（重送 10 次也只算一次）；跳號或跟球團的種子對不起來就報錯，整批都不算
 */
export function settleOutcomes(club: ClubSave, outcomes: readonly MatchOutcome[], now: number): SettleOutcome {
  const next = structuredClone(club)
  const settled: SettledMatch[] = []
  let duplicates = 0
  const sorted = [...outcomes].sort((a, b) => a.plan.matchIndex - b.plan.matchIndex)
  const replays = [...next.replays]
  for (const outcome of sorted) {
    const { plan, result } = outcome
    if (plan.matchIndex < next.idle.nextMatchIndex) {
      duplicates++
      continue
    }
    if (plan.matchIndex !== next.idle.nextMatchIndex) {
      throw new SettlementError('out-of-order', `應該結算第 ${next.idle.nextMatchIndex} 場，收到第 ${plan.matchIndex} 場`)
    }
    if (plan.matchId !== matchIdFor(club, plan.matchIndex) || plan.seed !== deriveSeed(club.clubSeed, plan.matchIndex, SEED_SALT.match)) {
      throw new SettlementError('mismatch', `比賽 ${plan.matchId} 不屬於這個球團或種子不符`)
    }
    // 不同聯盟的結果（例如晉級前算好、晉級後才送來）不能記進來：對手強度與收益倍率都不對
    if (plan.leagueTier !== next.league.tier) {
      throw new SettlementError('mismatch', `比賽 ${plan.matchId} 是${leagueOf(plan.leagueTier).name}的比賽，球團目前在${leagueOf(next.league.tier).name}`)
    }
    const summary = summarize(outcome)
    const reward = rewardFor(summary.won, summary.runsFor, leagueOf(plan.leagueTier).rewardMultiplier)
    const match: SettledMatch = {
      matchId: plan.matchId,
      matchIndex: plan.matchIndex,
      seed: plan.seed,
      result: summary,
      earnedFunds: reward.funds,
      earnedExperience: reward.experience,
      settledAt: now,
    }
    settled.push(match)
    const r = next.record
    if (summary.won) r.wins++
    else r.losses++
    r.runsFor += summary.runsFor
    r.runsAgainst += summary.runsAgainst
    next.league = recordLeagueResult(next.league, summary.won)
    addTo(next.economy.unclaimed, reward)
    addTo(next.economy.earned, reward)
    next.idle.nextMatchIndex++
    replays.push({ matchId: plan.matchId, replay: structuredClone(result.replay) })
  }
  if (settled.length > 0) {
    next.idle.lastSettledAt = now
    next.recentMatches = [...next.recentMatches, ...settled].slice(-RETENTION_CONFIG.recentMatches)
    next.replays = replays.slice(-RETENTION_CONFIG.replays)
  }
  return { club: next, settled, duplicates }
}

/** 放置結算：記進比賽之後，時間錨點依實際新結算的場數推進（規則見 idleEngine.ts） */
export function settleIdle(club: ClubSave, outcomes: readonly MatchOutcome[], now: number): SettleOutcome {
  const applied = settleOutcomes(club, outcomes, now)
  applied.club.idle.anchorMs = advanceAnchor(club.idle.anchorMs, now, applied.settled.length)
  return applied
}

export interface ClaimOutcome {
  club: ClubSave
  /** 這次（或重送時，原本那次）領到的數量 */
  claimed: Resources
  /** 這個序號之前已經處理過，這次沒有入帳 */
  duplicate: boolean
}

/**
 * 領取：把未領取的收益全部搬進球團資產。
 * 請求帶上讀到的 economy.nextClaimSeq：等於目前序號才入帳，序號加 1；比目前小代表已經處理過（重送、別的分頁先領了），
 * 不入帳；比目前大代表請求來自不存在的未來狀態，直接拒絕
 */
export function claimRewards(club: ClubSave, claimSeq: number): ClaimOutcome {
  if (!Number.isSafeInteger(claimSeq) || claimSeq < 0) throw new RangeError(`領取序號不合法：${claimSeq}`)
  const { economy } = club
  if (claimSeq < economy.nextClaimSeq) {
    const original = economy.lastClaim?.seq === claimSeq ? { ...economy.lastClaim.claimed } : { funds: 0, experience: 0 }
    return { club, claimed: original, duplicate: true }
  }
  if (claimSeq > economy.nextClaimSeq) {
    throw new SettlementError('mismatch', `領取序號 ${claimSeq} 比目前的 ${economy.nextClaimSeq} 還大，請重新讀取存檔`)
  }
  const next = structuredClone(club)
  const claimed = { ...next.economy.unclaimed }
  addTo(next.economy.assets, claimed)
  next.economy.unclaimed = { funds: 0, experience: 0 }
  next.economy.lastClaim = { seq: claimSeq, claimed: { ...claimed } }
  next.economy.nextClaimSeq = claimSeq + 1
  return { club: next, claimed, duplicate: false }
}

export interface SettingsChange {
  /** 新的陣容配置（只有球員編號）；球員一定要在永久名單裡 */
  roster?: RosterAssignment
  coach?: TeamStrategies['coach']
}

/**
 * 換陣容、戰術：從下一場還沒結算的比賽開始生效。
 * 呼叫前應該先把已經到時間的比賽結算掉（服務層的 updateSettings 會做），否則那些場次也會用新設定
 */
export function applySettingsChange(club: ClubSave, change: SettingsChange): ClubSave {
  // 先驗證再動手：不合法的陣容、戰術參數不會進到存檔
  if (change.roster) {
    const candidate = { players: club.players, roster: change.roster }
    const issues = assignmentIssues(candidate)
    if (issues.length) throw new LineupError(issues)
    const lineup = lineupIssues(resolveRoster(candidate))
    if (lineup.length) throw new LineupError(lineup)
  }
  if (change.coach) {
    if (change.coach.style !== 'balanced') throw new RangeError(`不支援的戰術風格：${change.coach.style}`)
    const issues = coachParamIssues(change.coach.params ?? {})
    if (issues.length) throw new RangeError(`戰術設定不合法：${issues.join('；')}`)
  }
  const next = structuredClone(club)
  if (change.roster) next.roster = structuredClone(change.roster)
  if (change.coach) next.strategy.coach = structuredClone(change.coach)
  next.strategy.effectiveFromMatch = next.idle.nextMatchIndex
  return next
}

function addTo(target: Resources, add: Resources): void {
  target.funds += add.funds
  target.experience += add.experience
}

// ---- 服務 ----

export interface SettlementDeps {
  store: ClubStore
  lock: ClubLock
  clock: Clock
  /** 批次設定：讓出主執行緒的方式、每批幾場、注入的模擬函式 */
  batch?: Omit<BatchOptions, 'completed' | 'signal'>
}

export interface SettlementReport {
  /** settled：有新結算；nothing-due：時間還沒到；aborted：被中斷，只存了打完的部分 */
  status: 'settled' | 'nothing-due' | 'aborted' | 'failed'
  due: DueMatches
  settled: SettledMatch[]
  summary: BatchSummary
  /** 存好的球團（沒有新結算時是讀到的那一份） */
  club: ClubSave
  /** 這次的互斥有沒有跨分頁保證 */
  crossTab: boolean
}

function loadOrThrow(store: ClubStore): ClubSave {
  const club = store.loadClub()
  if (!club) throw new SettlementError('no-club', '還沒有球團存檔')
  return club
}

/** 打完到期的比賽，不存檔，只回傳新的球團與批次結果（升級、招募、換設定在同一次存檔前先呼叫） */
export async function settleDueUnsaved(club: ClubSave, now: number, deps: SettlementDeps, signal?: AbortSignal): Promise<{ next: SettleOutcome; due: DueMatches; batch: BatchRun }> {
  const due = dueMatches(club.idle, now)
  const plans = planMatches(club, club.idle.nextMatchIndex, due.matches)
  const batch = await runBatch(plans, { ...deps.batch, signal })
  // 只記打完的前綴；錨點也只推進這幾場，剩下的下次接著打
  return { next: settleIdle(club, batch.outcomes, now), due, batch }
}

/**
 * 結算到期的比賽。在鎖內重新讀取最新存檔，打完、記帳、存檔；存檔失敗就丟錯（不回報成功）。
 * 中斷：已經打完的場次照樣存檔；模擬失敗：失敗之前的場次存檔，然後丟 SettlementError（失敗的那一場沒有任何紀錄）
 */
export function settleDue(deps: SettlementDeps, options: { signal?: AbortSignal } = {}): Promise<SettlementReport> {
  return deps.lock.run(async () => {
    const club = loadOrThrow(deps.store)
    const now = deps.clock.now()
    const { next, due, batch } = await settleDueUnsaved(club, now, deps, options.signal)
    const saved = next.settled.length > 0 ? deps.store.saveClub(next.club, club.revision) : club
    const status: SettlementReport['status'] =
      batch.status === 'failed' ? 'failed' : batch.status === 'aborted' ? 'aborted' : next.settled.length > 0 ? 'settled' : 'nothing-due'
    const report: SettlementReport = { status, due, settled: next.settled, summary: batch.summary, club: saved, crossTab: deps.lock.crossTab }
    if (batch.status === 'failed') {
      throw new SettlementError('simulation-failed', `比賽 ${batch.failedMatchId} 模擬失敗`, report, { cause: batch.error })
    }
    return report
  })
}

/** 領取收益：冪等，同一個領取序號只入帳一次（序號用 club.economy.nextClaimSeq） */
export function claim(deps: Pick<SettlementDeps, 'store' | 'lock'>, claimSeq: number): Promise<ClaimOutcome> {
  return deps.lock.run(async () => {
    const club = loadOrThrow(deps.store)
    const out = claimRewards(club, claimSeq)
    if (out.duplicate) return out
    return { ...out, club: deps.store.saveClub(out.club, club.revision) }
  })
}

/**
 * 換陣容、戰術：先用舊設定把到期的比賽打完，再套用新設定，兩件事一起存檔。
 * 到期的比賽沒全部打完（失敗）就整個不改，丟錯。
 * expected 是草稿建立時的設定版本：在鎖內跟存檔目前的版本比，不一致（別的分頁已經改過）就丟 settings-conflict，
 * 不會用舊草稿覆蓋別人的修改。只比這次要改的那一項（改陣容時不管戰術有沒有被改）
 */
export function updateSettings(deps: SettlementDeps, change: SettingsChange, expected: Partial<SettingsVersions> = {}): Promise<ClubSave> {
  return deps.lock.run(async () => {
    const club = loadOrThrow(deps.store)
    const current = settingsVersions(club)
    const stale = (['roster', 'coach'] as const).filter((k) => (k === 'roster' ? change.roster : change.coach) && expected[k] !== undefined && expected[k] !== current[k])
    if (stale.length) {
      throw new SettlementError('settings-conflict', `${stale.map((k) => (k === 'roster' ? '陣容' : '戰術')).join('、')}已經在其他地方被修改，請重新載入後再編輯`)
    }
    const now = deps.clock.now()
    const { next, batch } = await settleDueUnsaved(club, now, deps)
    if (batch.status !== 'completed') {
      throw new SettlementError('simulation-failed', `換設定前的結算沒有完成：${batch.failedMatchId ?? batch.status}`, undefined, { cause: batch.error })
    }
    return deps.store.saveClub(applySettingsChange(next.club, change), club.revision)
  })
}
