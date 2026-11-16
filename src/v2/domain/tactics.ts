// V2 初版戰術設定：玩家看得懂的三個選項，和 AutoCoach 的 CoachParams 之間的對應都集中在這裡。
// 目前只有均衡策略（balanced）；之後的平衡型、強攻型、機動型、守備型會是新的策略，不是更多開關
import type { CoachParams } from '../application/autoCoach'

export type Baserunning = 'aggressive' | 'balanced' | 'conservative'

export interface TacticSettings {
  /** 跑壘積極度：盜壘要多有把握才跑 */
  baserunning: Baserunning
  /** 後段比分接近時，依左右投打相剋換投、派代打 */
  latePlatoon: boolean
  /** 後段平手或落後 1 分、無人出局時犧牲觸擊 */
  sacBunt: boolean
}

export const DEFAULT_TACTICS: TacticSettings = { baserunning: 'balanced', latePlatoon: true, sacBunt: true }

/** 跑壘積極度對應的最低盜壘成功率（均衡就是 AutoCoach 的預設 0.75） */
export const BASERUNNING_STEAL_MIN: Record<Baserunning, number> = {
  aggressive: 0.65,
  balanced: 0.75,
  conservative: 0.85,
}

export const BASERUNNING_OPTIONS: readonly Baserunning[] = ['aggressive', 'balanced', 'conservative']

/** 玩家的設定 → 存進球團的 CoachParams（只放跟預設不同的那幾項也行，這裡全部寫明比較好讀） */
export function toCoachParams(s: TacticSettings): Partial<CoachParams> {
  if (!BASERUNNING_OPTIONS.includes(s.baserunning)) throw new RangeError(`不認識的跑壘設定：${String(s.baserunning)}`)
  if (typeof s.latePlatoon !== 'boolean' || typeof s.sacBunt !== 'boolean') throw new RangeError('後段調度、犧牲觸擊必須是開或關')
  const params: Partial<CoachParams> = { stealMin: BASERUNNING_STEAL_MIN[s.baserunning], latePlatoon: s.latePlatoon, sacBunt: s.sacBunt }
  const issues = coachParamIssues(params)
  if (issues.length) throw new RangeError(issues.join('；'))
  return params
}

/** 存檔裡的 CoachParams → 畫面上的設定；沒設過的用預設，盜壘門檻取最接近的那一檔 */
export function fromCoachParams(params: Partial<CoachParams> | undefined): TacticSettings {
  const stealMin = params?.stealMin ?? BASERUNNING_STEAL_MIN.balanced
  const baserunning = BASERUNNING_OPTIONS.reduce((best, b) =>
    Math.abs(BASERUNNING_STEAL_MIN[b] - stealMin) < Math.abs(BASERUNNING_STEAL_MIN[best] - stealMin) ? b : best,
  )
  return {
    baserunning,
    latePlatoon: params?.latePlatoon ?? DEFAULT_TACTICS.latePlatoon,
    sacBunt: params?.sacBunt ?? DEFAULT_TACTICS.sacBunt,
  }
}

/** 合理範圍：讓存檔或程式寫錯的數值不會讓自動教練做出荒謬的決定。回傳問題清單 */
export function coachParamIssues(params: Partial<CoachParams>): string[] {
  const issues: string[] = []
  const num = (key: keyof CoachParams, min: number, max: number, integer = false) => {
    const v = params[key]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
      issues.push(`${key} 必須是 ${min}～${max} 的${integer ? '整數' : '數字'}`)
    }
  }
  const bool = (key: keyof CoachParams) => {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') issues.push(`${key} 必須是開或關`)
  }
  num('stealMin', 0.5, 0.95)
  num('stealMaxRunDiff', 0, 10, true)
  num('fatigueMargin', 0, 30, true)
  num('minBattersFaced', 1, 9, true)
  bool('latePlatoon')
  bool('align')
  bool('sacBunt')
  const known = new Set(['stealMin', 'stealMaxRunDiff', 'fatigueMargin', 'minBattersFaced', 'latePlatoon', 'align', 'sacBunt'])
  for (const key of Object.keys(params)) if (!known.has(key)) issues.push(`不認識的設定：${key}`)
  return issues
}
