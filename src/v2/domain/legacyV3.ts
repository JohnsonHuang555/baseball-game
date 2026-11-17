// schemaVersion 3（Phase 2、Phase 3）的存檔格式：只用來讀取舊存檔、遷移到目前的格式，不再寫入。
// 這裡的型別與驗證凍結在 Phase 3 結束時的樣子，之後不要跟著新格式改
import type { Roster } from '../../sim/types'
import type { CoachParams } from '../application/autoCoach'
import type { ClubRecord, IdleState, Resources, SettledMatch, TeamStrategies } from './club'
import type { MatchReplay } from '../application/matchRunner'
import { lineupIssues } from './lineup'
import { coachParamIssues } from './tactics'
import { ClubValidationError, arr, int, invalid, isObj, num, obj, player, str, validateMatches } from './validation'

export interface EconomyStateV3 {
  assets: Resources
  unclaimed: Resources
  lifetime: Resources
  nextClaimSeq: number
  lastClaim: { seq: number; claimed: Resources } | null
}

export interface ClubSaveV3 {
  schemaVersion: 3
  clubId: string
  clubName: string
  clubSeed: number
  createdAt: number
  /** V3 的陣容直接內嵌球員物件 */
  roster: Roster
  strategy: TeamStrategies
  economy: EconomyStateV3
  idle: IdleState
  record: ClubRecord
  recentMatches: SettledMatch[]
  replays: { matchId: string; replay: MatchReplay }[]
  revision: number
}

function economyViolationsV3(e: EconomyStateV3): string[] {
  const out: string[] = []
  for (const k of ['funds', 'experience'] as const) {
    if (e.assets[k] < 0 || e.unclaimed[k] < 0 || e.lifetime[k] < 0) out.push(`${k} 出現負數`)
    if (e.assets[k] + e.unclaimed[k] !== e.lifetime[k]) out.push(`${k}：資產 + 未領取 ≠ 總收益`)
  }
  if (e.lastClaim === null ? e.nextClaimSeq !== 0 : e.lastClaim.seq !== e.nextClaimSeq - 1) out.push('領取序號與上一次領取對不起來')
  return out
}

/** 驗證 V3 存檔（跟 Phase 3 的 validateClub 相同） */
export function validateClubV3(value: unknown): ClubSaveV3 {
  if (!isObj(value)) throw invalid('$', '不是物件')
  if (value.schemaVersion !== 3) throw new ClubValidationError('unsupported-version', `不是 V3 存檔：${String(value.schemaVersion)}`)
  str(value, 'clubId')
  str(value, 'clubName')
  int(value, 'clubSeed')
  num(value, 'createdAt')
  int(value, 'revision')
  const roster = obj(value, 'roster')
  const lineup = arr(roster, 'lineup', 'roster')
  if (lineup.length !== 9) throw invalid('roster.lineup', '先發必須是 9 人')
  lineup.forEach((s, i) => {
    if (!isObj(s) || typeof s.position !== 'string') throw invalid(`roster.lineup[${i}]`, '格式不對')
    player(s.player, 'batter', `roster.lineup[${i}].player`)
  })
  arr(roster, 'bench', 'roster').forEach((p, i) => player(p, 'batter', `roster.bench[${i}]`))
  player(roster.starter, 'pitcher', 'roster.starter')
  arr(roster, 'relievers', 'roster').forEach((p, i) => player(p, 'pitcher', `roster.relievers[${i}]`))
  const issues = lineupIssues(roster as unknown as Roster)
  if (issues.length) throw invalid('roster', issues.join('；'))
  const strategy = obj(value, 'strategy')
  const coach = obj(strategy, 'coach', 'strategy')
  if (coach.style !== 'balanced') throw invalid('strategy.coach.style', '不支援的戰術風格')
  if (coach.params !== undefined) {
    if (!isObj(coach.params)) throw invalid('strategy.coach.params', '必須是物件')
    const p = coachParamIssues(coach.params as Partial<CoachParams>)
    if (p.length) throw invalid('strategy.coach.params', p.join('；'))
  }
  int(strategy, 'effectiveFromMatch', 'strategy')
  const economy = obj(value, 'economy')
  for (const key of ['assets', 'unclaimed', 'lifetime']) {
    const r = obj(economy, key, 'economy')
    num(r, 'funds', `economy.${key}`)
    num(r, 'experience', `economy.${key}`)
  }
  int(economy, 'nextClaimSeq', 'economy')
  const v = economyViolationsV3(economy as unknown as EconomyStateV3)
  if (v.length) throw invalid('economy', v.join('；'))
  const idle = obj(value, 'idle')
  num(idle, 'anchorMs', 'idle')
  int(idle, 'nextMatchIndex', 'idle')
  const record = obj(value, 'record')
  for (const key of ['wins', 'losses', 'runsFor', 'runsAgainst']) int(record, key, 'record')
  validateMatches(value)
  return value as unknown as ClubSaveV3
}
