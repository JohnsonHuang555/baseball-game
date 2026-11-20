// V2 戰術設定（Phase 9 PR 2）：玩家先選一種球隊風格（均衡、強攻、機動、守備），進階設定只有三項：
// 跑壘積極度（盜壘門檻）、後段調度、犧牲觸擊。跟 AutoCoach 的 CoachParams 之間的對應都集中在這裡。
//
// 規則（避免「畫面說強攻、實際用機動的參數」）：
// - 選一張風格卡片 → 進階設定整組換成那個風格的預設值
// - 改了進階設定 → 標記為「自訂」（跟目前風格的預設不同）；「恢復預設」把進階設定換回目前風格的預設
// - 存檔只存 { style, params: { stealMin, latePlatoon, sacBunt } }；其他參數（換投、打帶跑、代跑…）一律跟著風格的預設，不給玩家調
import { COACH_PRESETS, COACH_STYLES, type CoachParams, type CoachStyle } from '../application/autoCoach'

/** CoachParams 的所有欄位（驗證時不認識的欄位一律拒絕） */
export const COACH_PARAM_KEYS = Object.keys(COACH_PRESETS.balanced) as (keyof CoachParams)[]

export type Baserunning = 'aggressive' | 'balanced' | 'conservative'

export interface TacticSettings {
  style: CoachStyle
  /**
   * 盜壘門檻的原始值：玩家點了跑壘分段才改成那一段的數值；
   * 舊存檔（V10）的「積極」是 0.65，沒動跑壘就原樣保留，不會因為改了別的設定就被換掉
   */
  stealMin: number
  /** 後段比分接近時，依左右投打相剋換投、派代打 */
  latePlatoon: boolean
  /** 犧牲觸擊 */
  sacBunt: boolean
}

/**
 * 跑壘積極度對應的盜壘門檻。Phase 9 起「積極」是 0.70（原本 0.65）：平衡模擬裡 0.65 的盜壘成功率不到 8 成，
 * 白白送出局數（見 docs/balance/v2-phase9-tactics.md）
 */
export const BASERUNNING_STEAL_MIN: Record<Baserunning, number> = {
  aggressive: 0.7,
  balanced: 0.75,
  conservative: 0.85,
}

export const BASERUNNING_OPTIONS: readonly Baserunning[] = ['aggressive', 'balanced', 'conservative']

/** 盜壘門檻 → 最接近的跑壘分段（畫面顯示用） */
export function baserunningOf(stealMin: number): Baserunning {
  return BASERUNNING_OPTIONS.reduce((best, b) => (Math.abs(BASERUNNING_STEAL_MIN[b] - stealMin) < Math.abs(BASERUNNING_STEAL_MIN[best] - stealMin) ? b : best))
}

/** 某個風格的預設設定 */
export function presetSettings(style: CoachStyle): TacticSettings {
  const p = COACH_PRESETS[style]
  return { style, stealMin: p.stealMin, latePlatoon: p.latePlatoon, sacBunt: p.sacBunt }
}

export const DEFAULT_TACTICS: TacticSettings = presetSettings('balanced')

/** 進階設定跟目前風格的預設不同嗎 */
export function isCustom(s: TacticSettings): boolean {
  const p = presetSettings(s.style)
  return s.stealMin !== p.stealMin || s.latePlatoon !== p.latePlatoon || s.sacBunt !== p.sacBunt
}

/** 玩家的設定 → 存進球團的戰術（風格＋三項進階參數）；不合法就丟 RangeError */
export function toCoachSettings(s: TacticSettings): { style: CoachStyle; params: Partial<CoachParams> } {
  if (!COACH_STYLES.includes(s.style)) throw new RangeError(`不支援的戰術風格：${String(s.style)}`)
  if (typeof s.latePlatoon !== 'boolean' || typeof s.sacBunt !== 'boolean') throw new RangeError('後段調度、犧牲觸擊必須是開或關')
  const params: Partial<CoachParams> = { stealMin: s.stealMin, latePlatoon: s.latePlatoon, sacBunt: s.sacBunt }
  const issues = coachParamIssues(params)
  if (issues.length) throw new RangeError(issues.join('；'))
  return { style: s.style, params }
}

/** 存檔裡的戰術 → 畫面上的設定；沒設過的用風格的預設 */
export function fromCoachSettings(coach: { style: CoachStyle; params?: Partial<CoachParams> } | undefined): TacticSettings {
  const style = coach && COACH_STYLES.includes(coach.style) ? coach.style : 'balanced'
  const preset = presetSettings(style)
  const p = coach?.params
  return {
    style,
    stealMin: p?.stealMin ?? preset.stealMin,
    latePlatoon: p?.latePlatoon ?? preset.latePlatoon,
    sacBunt: p?.sacBunt ?? preset.sacBunt,
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
  // 負數 = 提早換投（守備型）；實際門檻另有下限 FATIGUE_FLOOR（autoCoach.pitchingChangeAt）
  num('fatigueMargin', -30, 30, true)
  num('minBattersFaced', 1, 9, true)
  num('buntFromInning', 1, 12, true)
  num('buntMaxLead', -1, 3, true)
  num('buntBatterMax', 2, 20, true)
  bool('latePlatoon')
  bool('align')
  bool('sacBunt')
  bool('hitAndRun')
  bool('pinchRun')
  bool('protectSlugger')
  bool('lateRelief')
  bool('defensiveSubs')
  const known = new Set<string>(COACH_PARAM_KEYS)
  for (const key of Object.keys(params)) if (!known.has(key)) issues.push(`不認識的設定：${key}`)
  return issues
}
