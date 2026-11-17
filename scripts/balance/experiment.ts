// 平衡矩陣的實驗設定：每一筆結果都記錄「用什麼設定跑的」，接續執行時設定不同就拒絕，避免不同實驗的結果混在同一個檔案。
import * as gameConfig from '../../src/v2/domain/config'
import * as leagueConfig from '../../src/v2/domain/leagueConfig'
import * as progressionConfig from '../../src/v2/domain/progressionConfig'
import { CLUB_SCHEMA_VERSION } from '../../src/v2/domain/club'

/** 結果檔的格式版本：模擬邏輯或輸出欄位改變時 +1 */
export const MATRIX_FORMAT = 2

export interface Experiment {
  format: number
  /** 候選方案名稱（CANDIDATE） */
  candidate: string
  days: number
  /** 球團存檔版本 */
  schema: number
  /** 套用候選方案「之後」的所有平衡設定（聯盟、獎勵、成長、成本、晉級）的指紋：同一個名稱、不同數值也會被發現 */
  config: string
}

/** 平衡設定的指紋（FNV-1a）。函式不列入，只看資料 */
export function configFingerprint(): string {
  const text = JSON.stringify([gameConfig, leagueConfig, progressionConfig], (_, v) => (typeof v === 'function' ? undefined : v))
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

export function currentExperiment(candidate: string, days: number): Experiment {
  return { format: MATRIX_FORMAT, candidate, days, schema: CLUB_SCHEMA_VERSION, config: configFingerprint() }
}

const describe = (e: Partial<Experiment> | undefined) =>
  e ? `候選方案 ${e.candidate}、${e.days} 天、格式 ${e.format}、存檔 v${e.schema}、設定 ${e.config}` : '沒有實驗設定（舊格式）'

export function sameExperiment(a: Partial<Experiment> | undefined, b: Experiment): boolean {
  return !!a && a.format === b.format && a.candidate === b.candidate && a.days === b.days && a.schema === b.schema && a.config === b.config
}

export const jobKey = (strategy: string, sessionsPerDay: number, seed: number) => `${strategy}:${sessionsPerDay}:${seed}`

/**
 * 讀出既有結果檔裡已經完成的工作。只要有一筆的實驗設定跟這次不同（或沒有設定），就丟出錯誤，
 * 不會把不同設定的結果接在一起。
 */
export function completedJobs(fileText: string, experiment: Experiment): Set<string> {
  const done = new Set<string>()
  fileText.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    const r = JSON.parse(line) as { strategy: string; sessionsPerDay: number; seed: number; experiment?: Experiment }
    if (!sameExperiment(r.experiment, experiment))
      throw new Error(
        `輸出檔第 ${i + 1} 筆的實驗設定不同，不能接續：\n  檔案：${describe(r.experiment)}\n  這次：${describe(experiment)}\n請換一個 OUT 檔名。`,
      )
    done.add(jobKey(r.strategy, r.sessionsPerDay, r.seed))
  })
  return done
}

/**
 * 整理報告時：同一份報告的結果必須來自同一個實驗設定（舊格式沒有設定的結果不檢查）。
 * 不同設定混在一起時丟出錯誤，列出各自的設定。
 */
export function assertSingleExperiment(runs: readonly { experiment?: Experiment }[]): void {
  const seen = new Map<string, Experiment>()
  for (const r of runs) if (r.experiment) seen.set(JSON.stringify(r.experiment), r.experiment)
  if (seen.size > 1) throw new Error(`結果來自 ${seen.size} 種不同的實驗設定，不能放在同一份報告：\n${[...seen.values()].map((e) => `  ${describe(e)}`).join('\n')}`)
}
