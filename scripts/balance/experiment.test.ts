import { afterEach, describe, expect, it } from 'vitest'
import { CLUB_SCHEMA_VERSION } from '../../src/v2/domain/club'
import { LEAGUES } from '../../src/v2/domain/leagueConfig'
import { assertSingleExperiment, completedJobs, configFingerprint, currentExperiment, jobKey, MATRIX_FORMAT } from './experiment'

const line = (strategy: string, f: number, seed: number, experiment?: object) => JSON.stringify({ strategy, sessionsPerDay: f, seed, experiment })

describe('平衡矩陣的接續：實驗設定檢查', () => {
  const original = LEAGUES.map((l) => l.opponentMean)
  afterEach(() => LEAGUES.forEach((l, i) => ((l as { opponentMean: number }).opponentMean = original[i])))

  it('實驗設定包含候選方案、天數、格式、存檔版本與數值指紋', () => {
    const e = currentExperiment('S', 30)
    expect(e).toMatchObject({ format: MATRIX_FORMAT, candidate: 'S', days: 30, schema: CLUB_SCHEMA_VERSION })
    expect(e.config).toMatch(/^[0-9a-f]{8}$/)
  })

  it('同樣的設定可以接續，只跳過已完成的工作', () => {
    const e = currentExperiment('S', 30)
    const done = completedJobs([line('B', 1, 1001, e), line('E', 6, 1002, e), ''].join('\n'), e)
    expect([...done]).toEqual([jobKey('B', 1, 1001), jobKey('E', 6, 1002)])
    expect(done.has(jobKey('B', 1, 1002))).toBe(false)
  })

  it('候選方案不同就拒絕接續', () => {
    expect(() => completedJobs(line('B', 1, 1001, currentExperiment('S', 30)), currentExperiment('S45', 30))).toThrow(/實驗設定不同/)
  })

  it('天數不同就拒絕接續', () => {
    expect(() => completedJobs(line('B', 1, 1001, currentExperiment('S', 14)), currentExperiment('S', 30))).toThrow(/14 天/)
  })

  it('沒有實驗設定的舊格式結果不能接續', () => {
    expect(() => completedJobs(line('B', 1, 1001), currentExperiment('main', 30))).toThrow(/舊格式/)
  })

  it('名稱相同但數值不同（例如 main 在調整前後）也會被發現', () => {
    const before = currentExperiment('main', 30)
    ;(LEAGUES[1] as { opponentMean: number }).opponentMean = 5.5
    const after = currentExperiment('main', 30)
    expect(after.config).not.toBe(before.config)
    expect(() => completedJobs(line('B', 1, 1001, before), after)).toThrow(/設定/)
  })

  it('檔案中間混入不同設定的一筆也會被發現', () => {
    const e = currentExperiment('S', 30)
    const text = [line('B', 1, 1001, e), line('B', 1, 1002, { ...e, days: 7 }), line('B', 1, 1003, e)].join('\n')
    expect(() => completedJobs(text, e)).toThrow(/第 2 筆/)
  })

  it('指紋只跟數值有關：同樣的數值得到同樣的指紋', () => {
    expect(configFingerprint()).toBe(configFingerprint())
  })

  it('報告不能混用不同實驗設定的結果；舊格式（沒有設定）不檢查', () => {
    const s = currentExperiment('S', 30)
    expect(() => assertSingleExperiment([{ experiment: s }, { experiment: s }, {}])).not.toThrow()
    expect(() => assertSingleExperiment([{ experiment: s }, { experiment: currentExperiment('S45', 30) }])).toThrow(/2 種不同的實驗設定/)
  })
})
