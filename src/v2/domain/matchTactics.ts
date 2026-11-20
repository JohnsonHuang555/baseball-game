// 單場戰術摘要（Phase 9 PR 2）：我方這場實際用的戰術風格與執行結果。
// 全部從比賽事件與已執行的指令累加（application/matchRunner.ts），不推估、不歸因得分。
// 存檔裡用精簡的陣列（跟 Box Score 一樣），每場約 40 bytes；畫面用 unpackTactics 展開
import { COACH_STYLES, type CoachStyle } from '../application/autoCoach'

export interface MatchTactics {
  /** 這場用的戰術風格 */
  style: CoachStyle
  /** 進階設定跟風格預設不同（玩家自訂） */
  custom: boolean
  /** 盜壘：[嘗試, 成功]（steal 事件；打帶跑揮空、跑者被阻殺也算一次嘗試） */
  steals: [number, number]
  /** 犧牲觸擊：[嘗試, 成功]（觸擊指令；成功＝犧牲觸擊推進跑者） */
  bunts: [number, number]
  /** 打帶跑指令 */
  hitAndRuns: number
  /** 換投（我方投手被換下的次數） */
  pitchingChanges: number
  /** 先發投手被換下時是第幾局；沒有換投是 null */
  starterOutInning: number | null
  /** 守備替補 */
  defensiveSubs: number
  pinchHits: number
  pinchRuns: number
}

/**
 * 存檔格式：[風格, 自訂(1/0), 盜壘嘗試, 盜壘成功, 觸擊嘗試, 觸擊成功, 打帶跑, 換投, 先發下場的局數(0 = 沒換投), 守備替補, 代打, 代跑]
 */
export type TacticsRecord = [CoachStyle, 0 | 1, number, number, number, number, number, number, number, number, number, number]

export function emptyTactics(style: CoachStyle, custom: boolean): MatchTactics {
  return { style, custom, steals: [0, 0], bunts: [0, 0], hitAndRuns: 0, pitchingChanges: 0, starterOutInning: null, defensiveSubs: 0, pinchHits: 0, pinchRuns: 0 }
}

export function packTactics(t: MatchTactics): TacticsRecord {
  return [t.style, t.custom ? 1 : 0, t.steals[0], t.steals[1], t.bunts[0], t.bunts[1], t.hitAndRuns, t.pitchingChanges, t.starterOutInning ?? 0, t.defensiveSubs, t.pinchHits, t.pinchRuns]
}

export function unpackTactics(r: TacticsRecord): MatchTactics {
  const [style, custom, sa, ss, ba, bs, hr, pc, so, ds, ph, pr] = r
  return { style, custom: custom === 1, steals: [sa, ss], bunts: [ba, bs], hitAndRuns: hr, pitchingChanges: pc, starterOutInning: so === 0 ? null : so, defensiveSubs: ds, pinchHits: ph, pinchRuns: pr }
}

/** 存檔裡的戰術摘要合法嗎：回傳問題，合法是 null */
export function tacticsRecordIssue(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 12) return '必須是 12 個欄位的陣列'
  if (!(COACH_STYLES as readonly unknown[]).includes(value[0])) return '不支援的戰術風格'
  if (value[1] !== 0 && value[1] !== 1) return '自訂旗標必須是 0 或 1'
  if (!value.slice(2).every((n) => Number.isInteger(n) && n >= 0)) return '次數必須是 0 以上的整數'
  if (value[3] > value[2] || value[5] > value[4]) return '成功次數不能超過嘗試次數'
  if ((value[7] > 0) !== (value[8] > 0)) return '先發下場的局數跟換投次數對不起來'
  return null
}
