// Phase 9 PR 2：戰術風格與進階設定（domain）
import { describe, expect, it } from 'vitest'
import { generateRoster, generateTeam } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { COACH_PRESETS, COACH_STYLES, FATIGUE_FLOOR, pitchingChangeAt } from '../application/autoCoach'
import {
  BASERUNNING_OPTIONS,
  BASERUNNING_STEAL_MIN,
  DEFAULT_TACTICS,
  baserunningOf,
  coachParamIssues,
  fromCoachSettings,
  isCustom,
  presetSettings,
  toCoachSettings,
} from './tactics'
import { ADVICE_THRESHOLD, recommendStyle } from './tacticsAdvice'

describe('四種戰術風格', () => {
  it('四種風格都有預設參數，而且全部合法', () => {
    expect(COACH_STYLES).toEqual(['balanced', 'power', 'speed', 'defense'])
    for (const style of COACH_STYLES) expect(coachParamIssues(COACH_PRESETS[style])).toEqual([])
  })

  it('均衡型的預設跟 Phase 4 以來的參數一樣，風格專用的判斷全部關閉', () => {
    expect(COACH_PRESETS.balanced).toEqual({
      fatigueMargin: 0,
      minBattersFaced: 3,
      latePlatoon: true,
      align: true,
      stealMin: 0.75,
      stealMaxRunDiff: 3,
      sacBunt: true,
      buntFromInning: 8,
      buntMaxLead: 0,
      buntBatterMax: 10,
      hitAndRun: false,
      pinchRun: false,
      protectSlugger: false,
      lateRelief: false,
      defensiveSubs: false,
    })
  })

  it('每一種風格的參數都跟其他風格不同（不是同一組換名字）', () => {
    const seen = new Set(COACH_STYLES.map((s) => JSON.stringify(COACH_PRESETS[s])))
    expect(seen.size).toBe(4)
    expect(COACH_PRESETS.power).toMatchObject({ sacBunt: false, protectSlugger: true })
    expect(COACH_PRESETS.power.stealMin).toBeGreaterThan(COACH_PRESETS.balanced.stealMin)
    expect(COACH_PRESETS.speed).toMatchObject({ hitAndRun: true, pinchRun: true })
    expect(COACH_PRESETS.speed.stealMin).toBeLessThan(COACH_PRESETS.balanced.stealMin)
    expect(COACH_PRESETS.speed.buntFromInning).toBeLessThan(COACH_PRESETS.balanced.buntFromInning)
    expect(COACH_PRESETS.defense).toMatchObject({ fatigueMargin: -15, lateRelief: true, defensiveSubs: true })
  })
})

describe('CoachParams 的合法範圍', () => {
  it('fatigueMargin 可以是 −30～30 的整數（負數＝提早換投）', () => {
    for (const ok of [-30, -15, 0, 30]) expect(coachParamIssues({ fatigueMargin: ok })).toEqual([])
    for (const bad of [-31, 31, 2.5, NaN, Infinity]) expect(coachParamIssues({ fatigueMargin: bad })).not.toEqual([])
  })

  it('負數疲勞參數有下限：實際換投門檻不低於疲勞門檻的 60%；0 以上跟原本一樣是「門檻＋餘裕」', () => {
    expect(FATIGUE_FLOOR).toBe(0.6)
    expect(pitchingChangeAt(100, 0)).toBe(100)
    expect(pitchingChangeAt(100, 10)).toBe(110)
    expect(pitchingChangeAt(100, -15)).toBe(85)
    expect(pitchingChangeAt(100, -30)).toBe(70)
    // 體力很差的投手（門檻 50）：−30 會變成 20 球，下限把它拉回 30 球
    expect(pitchingChangeAt(50, -30)).toBe(30)
    expect(pitchingChangeAt(51, -30)).toBe(Math.ceil(51 * 0.6))
  })

  it('新的參數各有範圍；不認識的欄位、不合法的型別都擋下', () => {
    expect(coachParamIssues({ buntFromInning: 6, buntMaxLead: 1, buntBatterMax: 11, hitAndRun: true, pinchRun: true, protectSlugger: true, lateRelief: true, defensiveSubs: true })).toEqual([])
    for (const bad of [
      { stealMin: 0.1 },
      { stealMin: 1.2 },
      { stealMin: NaN },
      { minBattersFaced: 0 },
      { latePlatoon: 'yes' },
      { buntFromInning: 0 },
      { buntMaxLead: 4 },
      { buntBatterMax: 1 },
      { hitAndRun: 1 },
      { unknown: 1 },
    ]) {
      expect(coachParamIssues(bad as never).length).toBeGreaterThan(0)
    }
  })
})

describe('進階設定（跑壘、後段調度、觸擊）', () => {
  it('三檔跑壘：積極 < 均衡 < 保守；盜壘門檻對到最接近的那一檔', () => {
    expect(BASERUNNING_STEAL_MIN.aggressive).toBeLessThan(BASERUNNING_STEAL_MIN.balanced)
    expect(BASERUNNING_STEAL_MIN.balanced).toBeLessThan(BASERUNNING_STEAL_MIN.conservative)
    for (const b of BASERUNNING_OPTIONS) expect(baserunningOf(BASERUNNING_STEAL_MIN[b])).toBe(b)
    // 舊存檔（V10）的「積極」是 0.65：顯示成積極
    expect(baserunningOf(0.65)).toBe('aggressive')
  })

  it('每種風格的預設正好對到一檔跑壘；選風格就套用那個風格的預設', () => {
    expect(baserunningOf(presetSettings('power').stealMin)).toBe('conservative')
    expect(baserunningOf(presetSettings('speed').stealMin)).toBe('aggressive')
    expect(baserunningOf(presetSettings('balanced').stealMin)).toBe('balanced')
    expect(presetSettings('power')).toEqual({ style: 'power', stealMin: 0.85, latePlatoon: true, sacBunt: false })
    for (const style of COACH_STYLES) expect(isCustom(presetSettings(style))).toBe(false)
  })

  it('改了任何一項進階設定就是自訂；改回預設就不是', () => {
    const s = presetSettings('speed')
    expect(isCustom({ ...s, sacBunt: false })).toBe(true)
    expect(isCustom({ ...s, latePlatoon: false })).toBe(true)
    expect(isCustom({ ...s, stealMin: 0.85 })).toBe(true)
    expect(isCustom({ ...s })).toBe(false)
  })

  it('設定 ↔ 存檔來回轉換不變；舊存檔的 0.65 原樣保留', () => {
    for (const style of COACH_STYLES) {
      for (const stealMin of [0.65, 0.7, 0.75, 0.85]) {
        for (const latePlatoon of [true, false]) {
          const s = { style, stealMin, latePlatoon, sacBunt: !latePlatoon }
          const coach = toCoachSettings(s)
          expect(coach).toEqual({ style, params: { stealMin, latePlatoon, sacBunt: !latePlatoon } })
          expect(coachParamIssues(coach.params)).toEqual([])
          expect(fromCoachSettings(coach)).toEqual(s)
        }
      }
    }
  })

  it('沒設定過就是均衡型的預設；只存了部分參數時其他用風格的預設', () => {
    expect(fromCoachSettings(undefined)).toEqual(DEFAULT_TACTICS)
    expect(fromCoachSettings({ style: 'balanced' })).toEqual(DEFAULT_TACTICS)
    expect(fromCoachSettings({ style: 'power', params: { latePlatoon: false } })).toEqual({ style: 'power', stealMin: 0.85, latePlatoon: false, sacBunt: false })
  })

  it('不合法的風格或參數丟 RangeError', () => {
    expect(() => toCoachSettings({ style: 'reckless' as never, stealMin: 0.75, latePlatoon: true, sacBunt: true })).toThrow(RangeError)
    expect(() => toCoachSettings({ style: 'power', stealMin: 0.3, latePlatoon: true, sacBunt: true })).toThrow(RangeError)
    expect(() => toCoachSettings({ style: 'power', stealMin: 0.75, latePlatoon: 'yes' as never, sacBunt: true })).toThrow(RangeError)
  })
})

describe('推薦戰術', () => {
  it('確定性：同一份陣容永遠是同一個建議，也不改輸入', () => {
    const r = generateRoster(new Rng(5))
    const before = JSON.stringify(r)
    expect(recommendStyle(r)).toEqual(recommendStyle(structuredClone(r)))
    expect(JSON.stringify(r)).toBe(before)
  })

  it('沒有明顯優勢就推薦均衡型：1,000 支隨機球隊大約四分之三是均衡型', () => {
    const counts: Record<string, number> = {}
    for (let i = 0; i < 1000; i++) {
      const s = recommendStyle(generateTeam(new Rng(i * 13 + 5), 5.8).roster).style
      counts[s] = (counts[s] ?? 0) + 1
    }
    expect(counts.balanced).toBeGreaterThan(650)
    for (const style of ['power', 'speed', 'defense']) expect(counts[style]).toBeGreaterThan(30)
  })

  it('長打、速度、投手特別突出的陣容分別推薦強攻、機動、守備，並說明理由', () => {
    const base = generateRoster(new Rng(11))
    const bats = (r: typeof base) => r.lineup.map((s) => s.player)
    const power = structuredClone(base)
    for (const b of bats(power)) b.ratings.power = Math.min(10, b.ratings.power + 3)
    expect(recommendStyle(power)).toMatchObject({ style: 'power', reason: 'power' })
    const speed = structuredClone(base)
    for (const b of bats(speed)) b.ratings.speed = Math.min(10, b.ratings.speed + 3)
    expect(recommendStyle(speed)).toMatchObject({ style: 'speed', reason: 'speed' })
    const pitch = structuredClone(base)
    for (const p of [pitch.starter, ...pitch.relievers]) {
      p.ratings.stuff = Math.min(10, p.ratings.stuff + 3)
      p.ratings.control = Math.min(10, p.ratings.control + 3)
    }
    const a = recommendStyle(pitch)
    expect(a).toMatchObject({ style: 'defense', reason: 'pitching' })
    expect(a.z.pitching).toBeGreaterThanOrEqual(ADVICE_THRESHOLD)
  })

  it('只看上場的陣容：板凳球員再強也不影響建議', () => {
    const r = generateRoster(new Rng(21))
    const a = recommendStyle(r)
    const withBench = structuredClone(r)
    for (const b of withBench.bench) {
      b.ratings.power = 10
      b.ratings.speed = 10
    }
    expect(recommendStyle(withBench)).toEqual(a)
  })
})
