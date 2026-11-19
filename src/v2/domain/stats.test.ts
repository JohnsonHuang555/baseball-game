// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { emptyBatting, emptyPitching, type BattingCounts, type PitchingCounts } from '../../sim/scoring'
import {
  BAT_STORE,
  PIT_STORE,
  addMatchToCareer,
  batOf,
  batRow,
  battingRates,
  careerTotals,
  fmtEra,
  fmtIp,
  fmtRate,
  markReleased,
  newClubStats,
  pitOf,
  pitRow,
  pitchingRates,
  totalsByPlayer,
  type MatchLines,
} from './stats'

const bat = (b: Partial<BattingCounts>): BattingCounts => ({ ...emptyBatting(), ...b })
const pit = (p: Partial<PitchingCounts>): PitchingCounts => ({ ...emptyPitching(), ...p })

describe('打擊公式', () => {
  it('AVG、OBP、SLG、OPS、TB：一般情況', () => {
    // 10 打數 3 安打（1 一安、1 二安、1 全壘打）、2 保送、1 高飛犧牲打
    const r = battingRates(bat({ pa: 13, ab: 10, h: 3, d: 1, hr: 1, bb: 2, sf: 1 }))
    expect(r.singles).toBe(1)
    expect(r.tb).toBe(1 + 2 + 4)
    expect(r.avg).toBeCloseTo(0.3)
    expect(r.obp).toBeCloseTo(5 / 13)
    expect(r.slg).toBeCloseTo(0.7)
    expect(r.ops).toBeCloseTo(5 / 13 + 0.7)
  })

  it('TB：一壘、二壘、三壘安打與全壘打各自的壘打數', () => {
    expect(battingRates(bat({ ab: 4, h: 4, d: 1, t: 1, hr: 1 })).tb).toBe(1 + 2 + 3 + 4)
    expect(battingRates(bat({ ab: 1, h: 1, t: 1 })).slg).toBe(3)
  })

  it('零分母：沒有打數 → AVG、SLG、OPS 是 null（不是 0 或 NaN）', () => {
    const none = battingRates(emptyBatting())
    expect(none).toMatchObject({ avg: null, obp: null, slg: null, ops: null, tb: 0 })
    // 只有保送：OBP 1.000，AVG、SLG 不存在
    const walks = battingRates(bat({ pa: 2, bb: 2 }))
    expect(walks).toMatchObject({ avg: null, slg: null, ops: null })
    expect(walks.obp).toBe(1)
    // 只有犧牲觸擊：連 OBP 的分母都是 0
    expect(battingRates(bat({ pa: 1, sh: 1 })).obp).toBeNull()
  })

  it('高飛犧牲打算進 OBP 分母、不算打數；觸身球算上壘', () => {
    expect(battingRates(bat({ pa: 2, ab: 1, h: 1, sf: 1 })).obp).toBeCloseTo(0.5)
    expect(battingRates(bat({ pa: 2, ab: 1, hbp: 1 })).obp).toBeCloseTo(0.5)
    expect(battingRates(bat({ pa: 2, ab: 1, hbp: 1 })).avg).toBe(0)
  })

  it('比率從累積值重算，不是平均每場的比率', () => {
    // 第一場 1 打數 1 安打（1.000），第二場 4 打數 0 安打（.000）：平均是 .500，正確是 .200
    const lines: MatchLines[] = [
      { bat: [batRow('a', bat({ pa: 1, ab: 1, h: 1 }))], pit: [] },
      { bat: [batRow('a', bat({ pa: 4, ab: 4 }))], pit: [] },
    ]
    const t = totalsByPlayer(lines.map((l) => ({ lines: l }))).get('a')!
    expect(t.g).toBe(2)
    expect(battingRates(t.bat).avg).toBeCloseTo(0.2)
  })
})

describe('投球公式', () => {
  it('IP 來自出局數；ERA = ER×27/Outs；WHIP = (BB+H)×3/Outs', () => {
    const r = pitchingRates(pit({ outs: 20, er: 3, bb: 2, h: 5 }))
    expect(r.ip).toBeCloseTo(20 / 3)
    expect(r.era).toBeCloseTo((3 * 27) / 20)
    expect(r.whip).toBeCloseTo((7 * 3) / 20)
    expect(fmtIp(20)).toBe('6.2')
    expect(fmtIp(1)).toBe('0.1')
    expect(fmtIp(3)).toBe('1.0')
  })

  it('一個出局都沒抓到：ERA、WHIP 是 null（不是 ∞）', () => {
    expect(pitchingRates(pit({ bf: 3, r: 2, er: 2, h: 2, bb: 1 }))).toMatchObject({ era: null, whip: null, ip: 0 })
  })

  it('非自責分不算進 ERA', () => {
    expect(pitchingRates(pit({ outs: 27, r: 4, er: 1 })).era).toBeCloseTo(1)
  })
})

describe('顯示格式', () => {
  it('打擊率 .312、1.000、null 是「—」；ERA 兩位小數', () => {
    expect(fmtRate(0.3125)).toBe('.313')
    expect(fmtRate(1)).toBe('1.000')
    expect(fmtRate(0)).toBe('.000')
    expect(fmtRate(1.4567)).toBe('1.457')
    expect(fmtRate(null)).toBe('—')
    expect(fmtEra(2.456)).toBe('2.46')
    expect(fmtEra(null)).toBe('—')
  })
})

describe('存檔編碼', () => {
  it('結尾連續的 0 不存，讀回來一模一樣', () => {
    const b = bat({ pa: 4, ab: 4, h: 1 })
    expect(batRow('x', b)).toEqual(['x', 4, 4, 1])
    expect(batOf(batRow('x', b).slice(1) as number[])).toEqual(b)
    const p = pit({ bf: 5, outs: 3, k: 2, hbp: 0 })
    expect(pitOf(pitRow('y', p).slice(1) as number[])).toEqual(p)
    expect(batRow('z', emptyBatting())).toEqual(['z'])
  })

  it('欄位順序固定（改了等於改存檔格式）', () => {
    expect(BAT_STORE).toEqual(['pa', 'ab', 'h', 'd', 't', 'hr', 'r', 'rbi', 'bb', 'so', 'ibb', 'sf', 'sh', 'gidp', 'roe', 'hbp'])
    expect(PIT_STORE).toEqual(['bf', 'outs', 'h', 'hr', 'r', 'er', 'bb', 'k', 'ibb', 'hbp'])
  })
})

describe('生涯累計', () => {
  const info = (id: string) => ({ name: `名字${id}`, role: id.startsWith('p') ? ('pitcher' as const) : ('batter' as const) })
  const one: MatchLines = { bat: [batRow('a', bat({ pa: 4, ab: 3, h: 1, bb: 1 })), batRow('b', emptyBatting())], pit: [pitRow('p1', pit({ bf: 30, outs: 27, er: 2, r: 3 }))] }

  it('同一場只能記一次：場次跟 throughMatch 對不上就報錯', () => {
    const s1 = addMatchToCareer(newClubStats(0), 0, one, info)
    expect(s1.throughMatch).toBe(1)
    expect(() => addMatchToCareer(s1, 0, one, info)).toThrow(RangeError)
    expect(() => addMatchToCareer(s1, 2, one, info)).toThrow(RangeError)
  })

  it('出場就算 G（代跑、守備替補沒有打席也算），數據累加', () => {
    let s = newClubStats(5)
    s = addMatchToCareer(s, 5, one, info)
    s = addMatchToCareer(s, 6, one, info)
    expect(careerTotals(s.players.a)).toMatchObject({ g: 2, bat: { pa: 8, ab: 6, h: 2, bb: 2 } })
    expect(careerTotals(s.players.b)).toMatchObject({ g: 2, bat: { pa: 0 } })
    expect(careerTotals(s.players.p1)).toMatchObject({ gp: 2, pit: { outs: 54, er: 4, r: 6 } })
    expect(s.players.a).toMatchObject({ name: '名字a', first: 5, last: 6 })
  })

  it('改名、升級不影響：名字跟著最新的，數據不重置', () => {
    let s = addMatchToCareer(newClubStats(0), 0, one, info)
    s = addMatchToCareer(s, 1, one, (id) => ({ name: id === 'a' ? '新名字' : `名字${id}`, role: 'batter' }))
    expect(s.players.a.name).toBe('新名字')
    expect(s.players.a.bg).toBe(2)
  })

  it('釋出：保留紀錄並標記（只標一次）；釋出超過 60 位、之後又打了很多場，紀錄一筆都不少', () => {
    let s = newClubStats(0)
    for (let i = 0; i < 75; i++) s = addMatchToCareer(s, i, { bat: [batRow(`r${i}`, bat({ pa: 4, ab: 4, h: 1 }))], pit: [] }, info)
    for (let i = 0; i < 75; i++) s = markReleased(s, `r${i}`, i + 1)
    expect(markReleased(s, 'r0', 99)).toBe(s)
    const before = structuredClone(s.players)
    // 之後 200 場都沒有他們
    for (let i = 75; i < 275; i++) s = addMatchToCareer(s, i, { bat: [batRow('new', bat({ pa: 4, ab: 3, bb: 1 }))], pit: [] }, info)
    for (let i = 0; i < 75; i++) expect(s.players[`r${i}`]).toEqual(before[`r${i}`])
    expect(Object.keys(s.players)).toHaveLength(76)
    expect(s.players.r0).toMatchObject({ releasedAt: 1, first: 0, last: 0, bg: 1 })
  })
})
