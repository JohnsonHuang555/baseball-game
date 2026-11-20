// Phase 9 PR 4：單場 MVP（domain）：評分、同分規則、特殊比賽、永久成長、有效能力、分段上限、驗證、存檔格式
import { describe, expect, it } from 'vitest'
import { generateBatter, generatePitcher } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { emptyBatting, emptyPitching, type BattingCounts, type PitchingCounts } from '../../sim/scoring'
import type { Batter, Pitcher, Player } from '../../sim/types'
import type { PlayerRecord } from './club'
import {
  MVP_CONFIG,
  MVP_RULES,
  MvpError,
  awardMvp,
  batterScore,
  canGrowMore,
  compareCandidates,
  matchMvpIssue,
  matchesBeforePossibleMvpGrowth,
  mvpBonusUnits,
  mvpCursorIssues,
  mvpGrowthState,
  mvpCandidates,
  mvpIssues,
  mvpToNext,
  nextGrowthRating,
  packMvp,
  pitcherScore,
  selectMvp,
  unpackMvp,
  withMvpBonus,
  type MvpFacts,
  type MvpRecord,
} from './mvp'
import { leveled, MAX_LEVEL } from './progression'
import { effectivePlayer } from './roster'
import { batRow, pitRow, type MatchLines } from './stats'

const bat = (o: Partial<BattingCounts>): BattingCounts => ({ ...emptyBatting(), ...o })
const pit = (o: Partial<PitchingCounts>): PitchingCounts => ({ ...emptyPitching(), ...o })
const lines = (b: [string, Partial<BattingCounts>][], p: [string, Partial<PitchingCounts>][] = []): MatchLines => ({ bat: b.map(([id, c]) => batRow(id, bat(c))), pit: p.map(([id, c]) => pitRow(id, pit(c))) })
const noFacts: MvpFacts = { steals: {}, winningRbi: null }
const rec = (player: Player, mvp?: MvpRecord, level = 1): PlayerRecord => ({ player, level, origin: 'recruit', joinedAtMatch: 0, ...(mvp ? { mvp } : {}) })
const batter = (i: number, over: Partial<Batter> = {}): Batter => ({ ...generateBatter(new Rng(5000 + i), 5), ...over })
const pitcher = (i: number, over: Partial<Pitcher> = {}): Pitcher => ({ ...generatePitcher(new Rng(6000 + i), 5), ...over })
/** 一般的 4 打數：1 安打、3 出局 */
const filler = (n: number): [string, Partial<BattingCounts>][] => Array.from({ length: n }, (_, i) => [`f${i}`, { pa: 4, ab: 4, h: 1 }])

describe('評分公式', () => {
  it('打者：各種安打互斥（一壘安打 = 安打 − 二壘 − 三壘 − 全壘打），不重複計分；出局 = 打數 − 安打 ＋ 高飛犧牲打 ＋ 雙殺多一個', () => {
    const w = MVP_CONFIG.batter
    // 4 打數 3 安打（1 一壘、1 二壘、1 全壘打）、3 打點、1 得分、1 三振
    expect(batterScore(bat({ ab: 4, h: 3, d: 1, hr: 1, rbi: 3, r: 1, so: 1 }))).toBe(w.single + w.double + w.homeRun + 1 * w.out + 3 * w.rbi + w.run)
    // 只有全壘打：不會再算成一壘安打
    expect(batterScore(bat({ ab: 1, h: 1, hr: 1, rbi: 1 }))).toBe(w.homeRun + w.rbi)
    // 三壘安打
    expect(batterScore(bat({ ab: 1, h: 1, t: 1 }))).toBe(w.triple)
    // 雙殺打：一個打數、兩個出局
    expect(batterScore(bat({ ab: 1, gidp: 1 }))).toBe(2 * w.out)
    // 高飛犧牲打：不算打數，但是一個出局；打點照算
    expect(batterScore(bat({ sf: 1, rbi: 1 }))).toBe(w.out + w.rbi)
    // 犧牲觸擊：不扣分（教練的戰術決定）
    expect(batterScore(bat({ sh: 1 }))).toBe(0)
    // 失誤上壘：算打數、不算安打 → 一個出局
    expect(batterScore(bat({ ab: 1, roe: 1 }))).toBe(w.out)
    // 保送（含故意四壞）、觸身
    expect(batterScore(bat({ bb: 2, ibb: 1, hbp: 1 }))).toBe(3 * w.walk)
    // 盜壘（從事件流）
    expect(batterScore(bat({}), [2, 1])).toBe(2 * w.steal + w.caughtStealing)
  })

  it('投手：(出局 × 聯盟每出局自責分 − 自責分) × 尺度，整數運算；被安打、保送透過自責分反映', () => {
    const p = MVP_CONFIG.pitcher
    // 完投完封：27 出局、0 自責
    expect(pitcherScore(pit({ outs: 27, k: 9 }))).toBe(Math.round((27 * p.runsPerOut * p.scale) / 1000) + 9 * p.strikeout)
    // 6 局 2 自責（聯盟平均是每 9 局 2.92 分 → 6 局約 1.94 分）：接近 0；6 局 3 自責是負分
    expect(Math.abs(pitcherScore(pit({ outs: 18, er: 2 })))).toBeLessThan(200)
    expect(pitcherScore(pit({ outs: 18, er: 3 }))).toBeLessThan(0)
    // 非自責分不扣（失誤造成的失分不是投手的責任）
    expect(pitcherScore(pit({ outs: 18, r: 3, er: 0 }))).toBe(pitcherScore(pit({ outs: 18 })))
    for (const o of [0, 1, 7, 27, 36]) for (const er of [0, 1, 5]) expect(Number.isSafeInteger(pitcherScore(pit({ outs: o, er })))).toBe(true)
  })

  it('打者與投手同一個尺度：多得一分與少失一分大約等值（尺度由平衡腳本量測）', () => {
    // 投手少失一分 = scale；打者一支全壘打（含打點，得分權重 0）
    expect(pitcherScore(pit({ outs: 0, er: 0 })) - pitcherScore(pit({ outs: 0, er: 1 }))).toBe(MVP_CONFIG.pitcher.scale)
    expect(MVP_CONFIG.pitcher.scale).toBeGreaterThan(1000)
    expect(MVP_CONFIG.pitcher.scale).toBeLessThan(2000)
  })
})

describe('選出 MVP 與同分規則', () => {
  it('確定性：同樣的數據一定選出同一位；不改輸入', () => {
    const l = lines([['a', { ab: 4, h: 2, hr: 1, rbi: 2 }], ...filler(8)], [['sp', { outs: 18, er: 2 }]])
    const copy = structuredClone(l)
    expect(selectMvp(l, noFacts).id).toBe('a')
    expect(selectMvp(l, noFacts)).toEqual(selectMvp(copy, noFacts))
    expect(l).toEqual(copy)
  })

  it('兩名打者同分：有勝利打點的優先 → 總壘打多的 → 打序前面的 → 球員編號', () => {
    // 同分：x 是 2 支一壘安打＋1 保送，y 是 1 支二壘安打＋... 用完全相同的數據保證同分
    const same = { ab: 4, h: 2, rbi: 1 }
    expect(selectMvp(lines([['x', same], ['y', same]]), { steals: {}, winningRbi: 'y' }).id).toBe('y')
    expect(selectMvp(lines([['x', same], ['y', same]]), noFacts).id).toBe('x') // 打序
    expect(selectMvp(lines([['y', same], ['x', same]]), noFacts).id).toBe('y') // 打序（y 在前）
    // 總壘打：分數做成一樣，總壘打不同（一壘＋保送 vs 只有二壘：0.9+0.7=1.6 ≠ 1.25，所以直接用比較函式測）
    const a = { id: 'a', role: 'batter' as const, score: 1000, key: false, volume: 2, order: 5 }
    const b = { id: 'b', role: 'batter' as const, score: 1000, key: false, volume: 4, order: 6 }
    expect([a, b].sort(compareCandidates)[0].id).toBe('b')
    // 全部相同（不可能在同一場出現，但規則要分得出來）：球員編號字典序
    expect([{ ...a, id: 'z', volume: 4, order: 6 }, { ...b }].sort(compareCandidates)[0].id).toBe('b')
  })

  it('打者與投手同分：勝利打點優先；都沒有時打者優先（固定規則）；投手同分比出局數', () => {
    const batterC = { id: 'b', role: 'batter' as const, score: 2000, key: false, volume: 4, order: 0 }
    const pitcherC = { id: 'p', role: 'pitcher' as const, score: 2000, key: false, volume: 27, order: 0 }
    expect([pitcherC, batterC].sort(compareCandidates)[0].id).toBe('b')
    expect([pitcherC, { ...batterC, key: false }, { ...pitcherC, id: 'q', volume: 21 }].sort(compareCandidates).map((c) => c.id)).toEqual(['b', 'p', 'q'])
    expect([{ ...batterC, key: true }, pitcherC].sort(compareCandidates)[0].id).toBe('b')
  })

  it('沒有明顯突出的表現：照樣選出評分最高的（評分很低也一樣）', () => {
    const l = lines([...filler(9).map(([id]) => [id, { pa: 4, ab: 4 }] as [string, Partial<BattingCounts>]), ['w', { pa: 4, ab: 4, h: 1 }]], [['sp', { outs: 15, er: 5 }]])
    const m = selectMvp(l, noFacts)
    expect(m.id).toBe('w')
    expect(m.score).toBeLessThan(500)
    // 全部都是負分：照樣選出最不差的
    const worse = lines([['a', { pa: 4, ab: 4 }], ['b', { pa: 4, ab: 3, bb: 1 }]], [['sp', { outs: 12, er: 7 }]])
    expect(selectMvp(worse, noFacts)).toMatchObject({ id: 'b' })
    expect(selectMvp(worse, noFacts).score).toBeLessThan(0)
  })

  it('低比分投手戰：完投 1 失分的先發得獎；高比分打擊戰：打者得獎', () => {
    expect(selectMvp(lines(filler(9), [['sp', { outs: 27, er: 1, k: 8 }]]), noFacts)).toMatchObject({ id: 'sp', role: 'pitcher' })
    expect(selectMvp(lines([['slug', { ab: 5, h: 4, hr: 2, d: 1, rbi: 6, r: 3 }], ...filler(8)], [['sp', { outs: 15, er: 6 }], ['rp', { outs: 12, er: 2 }]]), noFacts)).toMatchObject({ id: 'slug', role: 'batter' })
  })

  it('我方被完封：仍然選出一位（例如好投的先發，或唯一上壘的打者）', () => {
    const shutout = lines(Array.from({ length: 9 }, (_, i) => [`b${i}`, { pa: 3, ab: 3 }] as [string, Partial<BattingCounts>]), [['sp', { outs: 24, er: 1 }]])
    expect(selectMvp(shutout, noFacts).id).toBe('sp')
    const shutout2 = lines([...Array.from({ length: 8 }, (_, i) => [`b${i}`, { pa: 4, ab: 4 }] as [string, Partial<BattingCounts>]), ['walker', { pa: 4, ab: 2, bb: 2 }]], [['sp', { outs: 12, er: 6 }]])
    expect(selectMvp(shutout2, noFacts).id).toBe('walker')
  })

  it('替補（代打、代跑）、後援投手都能得獎：不要求先發', () => {
    expect(selectMvp(lines([...filler(9), ['ph', { pa: 1, ab: 1, h: 1, hr: 1, rbi: 3 }]], [['sp', { outs: 15, er: 4 }]]), noFacts).id).toBe('ph')
    // 代跑：沒有打席，只有盜壘（事件流）
    const pr = lines([...filler(9).map(([id]) => [id, { pa: 4, ab: 4 }] as [string, Partial<BattingCounts>]), ['pr', {}]], [['sp', { outs: 6, er: 7 }]])
    expect(selectMvp(pr, { steals: { pr: [2, 0] }, winningRbi: null }).id).toBe('pr')
    expect(selectMvp(lines(filler(9), [['sp', { outs: 9, er: 5 }], ['long', { outs: 18, er: 0, k: 7 }]]), noFacts).id).toBe('long')
  })

  it('延長賽：多打的局數照實計算（投手出局數超過 27、打者打數較多）', () => {
    const l = lines([['a', { ab: 6, h: 3, hr: 1, rbi: 2 }], ...filler(8)], [['sp', { outs: 21, er: 2 }], ['rp', { outs: 15, er: 0 }]])
    const all = mvpCandidates(l, noFacts)
    expect(all.find((c) => c.id === 'rp')!.volume).toBe(15)
    expect(selectMvp(l, noFacts).id).toBeDefined()
  })

  it('沒有有效的球員數據（正式新比賽不該發生）：丟錯，不默默指定第一位球員；舊比賽沒有 lines 也一樣不能選', () => {
    expect(() => selectMvp({ bat: [], pit: [] }, noFacts)).toThrow(MvpError)
    expect(() => selectMvp(undefined, noFacts)).toThrow(MvpError)
  })

  it('一位球員同時有打擊與投球列（二刀流）：取較高的一個，不重複列出', () => {
    const l = lines([['two', { ab: 3, h: 2, hr: 1 }]], [['two', { outs: 27, er: 0 }]])
    const all = mvpCandidates(l, noFacts)
    expect(all).toHaveLength(1)
    expect(all[0].role).toBe('pitcher')
  })
})

describe('永久能力成長', () => {
  it('每 10 次 MVP 成長一次（+0.1）；最多 3 次（+0.3）；第 40、50 次照樣累計但不再成長', () => {
    expect(MVP_CONFIG.maxUnits).toBe(3)
    expect(MVP_CONFIG.perGrowth).toBe(10)
    let r = rec(batter(1, { archetype: 'power' }))
    const growths: string[] = []
    for (let i = 1; i <= 63; i++) {
      const out = awardMvp(r, 100 + i)
      r = out.record
      expect(out.award.count).toBe(i)
      if (out.award.growth) growths.push(`${i}:${out.award.growth}`)
    }
    expect(growths).toEqual(['10:power', '20:power', '30:power'])
    expect(r.mvp!.count).toBe(63)
    expect(r.mvp!.grants.map((g) => g.atMatch)).toEqual([110, 120, 130])
    expect(mvpBonusUnits(r)).toEqual({ power: 3 })
    expect(mvpToNext(r)).toBeNull()
    expect(canGrowMore(r)).toBe(false)
    expect(mvpIssues(r)).toEqual([])
  })

  it('不改輸入；進度 = 距離下一次還差幾次', () => {
    const r0 = rec(batter(2), { count: 7, grants: [] })
    const copy = structuredClone(r0)
    const { record } = awardMvp(r0, 5)
    expect(r0).toEqual(copy)
    expect(mvpToNext(record)).toBe(2)
    expect(mvpToNext(rec(batter(2)))).toBe(10)
  })

  it('加成以整數單位存，套用時一次換算：+0.3 是 0.3，不是 0.30000000000000004；最終能力不超過 10', () => {
    const b = batter(3, { ratings: { contact: 5.1, power: 6.2, speed: 4, fielding: 9.85 } })
    const grants = [{ rating: 'contact' as const, atMatch: 1 }, { rating: 'contact' as const, atMatch: 2 }, { rating: 'fielding' as const, atMatch: 4 }]
    const p = withMvpBonus(b, { mvp: { count: 30, grants } })
    expect(p.ratings.contact).toBe(5.3)
    expect(p.ratings.fielding).toBe(9.95)
    expect(p.ratings.power).toBe(6.2)
    expect(b.ratings.contact).toBe(5.1)
    expect(mvpBonusUnits({ mvp: { count: 30, grants } })).toEqual({ contact: 2, fielding: 1 })
    // +0.3 剛好是 0.3（整數單位一次換算），能力上限 10
    expect(withMvpBonus(b, { mvp: { count: 30, grants: [0, 1, 2].map((i) => ({ rating: 'contact' as const, atMatch: i })) } }).ratings.contact).toBe(5.4)
    expect(withMvpBonus({ ...b, ratings: { ...b.ratings, fielding: 9.9 } }, { mvp: { count: 30, grants: [0, 1, 2].map((i) => ({ rating: 'fielding' as const, atMatch: i })) } }).ratings.fielding).toBe(10)
  })

  it('有效能力的層次：原生 → 等級 → MVP 加成 → 特性；原生 Lv.1 資料不改', () => {
    const b = batter(4, { archetype: 'speed', traits: ['freeSwinger'] })
    const r: PlayerRecord = { ...rec(b, { count: 20, grants: [{ rating: 'speed', atMatch: 9 }, { rating: 'speed', atMatch: 19 }] }, 12), dev: { learned: ['eye'], removed: ['freeSwinger'] } }
    const eff = effectivePlayer(r) as Batter
    const lv = leveled(b, 12)
    expect(eff.ratings.speed).toBe(Math.min(10, Math.round((lv.ratings.speed + 0.2) * 100) / 100))
    expect(eff.ratings.power).toBe(lv.ratings.power)
    expect(eff.traits).toEqual(['eye'])
    expect(r.player).toEqual(b)
  })

  it('成長能力的選擇：打者給流派的主要能力；主要能力在 Lv.20 已滿就給其他最高的', () => {
    expect(nextGrowthRating(rec(batter(5, { archetype: 'skill' })))).toBe('contact')
    expect(nextGrowthRating(rec(batter(5, { archetype: 'defense' })))).toBe('fielding')
    // 力量型、長打在 Lv.20 已經 10：換成其他三項裡 Lv.20 最高的
    const full = batter(6, { archetype: 'power', ratings: { contact: 6, power: 9.5, speed: 7, fielding: 5 } })
    expect(leveled(full, MAX_LEVEL).ratings.power).toBe(10)
    const top = leveled(full, MAX_LEVEL).ratings
    const expected = (['contact', 'speed', 'fielding'] as const).slice().sort((a, b) => top[b] - top[a])[0]
    expect(nextGrowthRating(rec(full))).toBe(expected)
  })

  it('投手給球威、控球之中較低的一項（補短板）；兩項都滿才給體力；全部都滿就不成長（不浪費）', () => {
    const p = pitcher(1, { ratings: { stuff: 6, control: 4, stamina: 5 } })
    expect(nextGrowthRating(rec(p))).toBe('control')
    expect(nextGrowthRating(rec(pitcher(2, { ratings: { stuff: 3, control: 6, stamina: 5 } })))).toBe('stuff')
    const strong = pitcher(3, { ratings: { stuff: 9.9, control: 9.9, stamina: 5 } })
    expect(nextGrowthRating(rec(strong))).toBe('stamina')
    const maxed = pitcher(4, { ratings: { stuff: 10, control: 10, stamina: 10 } })
    expect(nextGrowthRating(rec(maxed))).toBeNull()
    expect(canGrowMore(rec(maxed))).toBe(false)
    // 第 10 次照樣累計，但沒有成長
    const out = awardMvp(rec(maxed, { count: 9, grants: [] }), 50)
    expect(out.award).toMatchObject({ count: 10, growth: null })
    expect(out.record.mvp!.grants).toEqual([])
  })

  it('成長規則依 Lv.20 判斷，之後升級也不會被上限 10 吃掉', () => {
    for (let i = 0; i < 300; i++) {
      for (const pl of [batter(100 + i), pitcher(100 + i)]) {
        let r = rec(pl)
        for (let n = 1; n <= 60; n++) r = awardMvp(r, n).record
        const top = withMvpBonus(leveled(pl, MAX_LEVEL), r).ratings as unknown as Record<string, number>
        const base = leveled(pl, MAX_LEVEL).ratings as unknown as Record<string, number>
        for (const [k, units] of Object.entries(mvpBonusUnits(r))) expect(top[k]).toBeCloseTo(Math.min(10, base[k] + units! / 10), 6)
        for (const [k, units] of Object.entries(mvpBonusUnits(r))) expect(base[k] + units! / 10).toBeLessThanOrEqual(10 + 1e-9)
        expect(mvpIssues(r)).toEqual([])
      }
    }
  })

  it('關掉成長（平衡、Golden 比較用）：照樣累計次數，不給能力', () => {
    MVP_RULES.growth = false
    try {
      const out = awardMvp(rec(batter(7), { count: 9, grants: [] }), 1)
      expect(out.award).toMatchObject({ count: 10, growth: null })
      expect(matchesBeforePossibleMvpGrowth([rec(batter(7), { count: 9, grants: [] })], () => true)).toBe(Infinity)
    } finally {
      MVP_RULES.growth = true
    }
  })
})

describe('分段結算的上限（證明，不是預測）', () => {
  it('每場只有一位 MVP：球員最快要 (10 − 進度) 場才會成長；取可能出場、還能成長的人裡最小的', () => {
    const a = rec(batter(10), { count: 3, grants: [] })
    const b = rec(batter(11), { count: 18, grants: [{ rating: 'contact', atMatch: 1 }] })
    const capped = rec(batter(12), { count: 59, grants: Array.from({ length: MVP_CONFIG.maxUnits }, (_, i) => ({ rating: 'power' as const, atMatch: i })) })
    const benchless = rec(batter(13), { count: 9, grants: [] })
    const appear = (id: string) => id !== benchless.player.id
    expect(matchesBeforePossibleMvpGrowth([a, b, capped, benchless], appear)).toBe(2)
    expect(matchesBeforePossibleMvpGrowth([a, capped, benchless], appear)).toBe(7)
    // 已達上限、不會出場的人不影響
    expect(matchesBeforePossibleMvpGrowth([capped, benchless], appear)).toBe(Infinity)
    // 新球團（大家都是 0）：10 場
    expect(matchesBeforePossibleMvpGrowth([rec(batter(14)), rec(pitcher(14))], () => true)).toBe(10)
  })
})

describe('驗證與存檔格式', () => {
  it('次數不合法、格式不對：拒絕', () => {
    const b = batter(20)
    expect(mvpIssues(rec(b, { count: -1, grants: [] })).join()).toMatch(/次數/)
    expect(mvpIssues(rec(b, { count: 1.5, grants: [] })).join()).toMatch(/次數/)
    expect(mvpIssues(rec(b, { count: 10, grants: 'x' as never })).join()).toMatch(/陣列/)
    expect(mvpIssues(rec(b, { count: 10, grants: [null as never] })).join()).toMatch(/格式/)
  })

  it('單場 MVP 精簡格式：可以來回轉換；格式錯誤會被抓到', () => {
    const m = { playerId: 'p1', role: 'pitcher' as const, score: 3120, count: 10, sb: 0, cs: 0, key: false, growth: 'control' as const }
    expect(unpackMvp(packMvp(m))).toEqual(m)
    expect(packMvp({ ...m, role: 'batter', growth: null, key: true, sb: 2 })).toEqual(['p1', 0, 3120, 10, 2, 0, 1])
    expect(matchMvpIssue(packMvp(m))).toBeNull()
    expect(matchMvpIssue(['p1', 2, 1, 1, 0, 0, 0])).toMatch(/角色/)
    expect(matchMvpIssue(['p1', 0, 1.5, 1, 0, 0, 0])).toMatch(/評分/)
    expect(matchMvpIssue(['p1', 0, 1, 0, 0, 0, 0])).toMatch(/次數/)
    expect(matchMvpIssue(['p1', 0, 1, 1, 0, 0, 0, 'stuff'])).toMatch(/能力/)
    expect(matchMvpIssue({})).toMatch(/格式/)
  })
})

describe('MVP 成長紀錄驗證（PR #23 review P2）', () => {
  const b = batter(40)
  const p = pitcher(40)
  const g = (rating: string, atMatch: number) => ({ rating: rating as never, atMatch })
  const joinedAt = (r: PlayerRecord, n: number): PlayerRecord => ({ ...r, joinedAtMatch: n })

  it('兩筆相同場次：拒絕（每場只有一位 MVP，同一場不可能成長兩次）', () => {
    expect(mvpIssues(rec(b, { count: 20, grants: [g('power', 100), g('contact', 100)] })).join()).toMatch(/嚴格遞增/)
  })

  it('場次倒退：拒絕', () => {
    expect(mvpIssues(rec(b, { count: 20, grants: [g('power', 120), g('power', 100)] })).join()).toMatch(/嚴格遞增/)
  })

  it('早於加入球團的場次：拒絕；剛好等於加入的場次：通過', () => {
    expect(mvpIssues(joinedAt(rec(b, { count: 10, grants: [g('power', 49)] }), 50)).join()).toMatch(/早於加入/)
    expect(mvpIssues(joinedAt(rec(b, { count: 10, grants: [g('power', 50)] }), 50))).toEqual([])
  })

  it('等於或大於結算游標（還沒結算的比賽）：拒絕；小於游標：通過', () => {
    const r = rec(b, { count: 20, grants: [g('power', 10), g('power', 30)] })
    expect(mvpCursorIssues(r, 31)).toEqual([])
    expect(mvpCursorIssues(r, 30).join()).toMatch(/還沒結算/)
    expect(mvpCursorIssues(r, 12).join()).toMatch(/還沒結算/)
  })

  it('成長次數超過 MVP 門檻能換到的：拒絕', () => {
    expect(mvpIssues(rec(b, { count: 9, grants: [g('power', 3)] })).join()).toMatch(/超過 MVP 次數/)
    expect(mvpIssues(rec(b, { count: 19, grants: [g('power', 3), g('power', 9)] })).join()).toMatch(/超過 MVP 次數/)
  })

  it('成長超過總上限（+0.3）：拒絕', () => {
    expect(mvpIssues(rec(b, { count: 99, grants: [1, 2, 3, 4].map((i) => g('power', i)) })).join()).toMatch(/上限 3/)
  })

  it('投手拿到打者專用能力、打者拿到投手專用能力：拒絕', () => {
    expect(mvpIssues(rec(p, { count: 10, grants: [g('power', 3)] })).join()).toMatch(/能力不合法/)
    expect(mvpIssues(rec(p, { count: 10, grants: [g('contact', 3)] })).join()).toMatch(/能力不合法/)
    expect(mvpIssues(rec(b, { count: 10, grants: [g('stuff', 3)] })).join()).toMatch(/能力不合法/)
    expect(mvpIssues(rec(b, { count: 10, grants: [g('stamina', 3)] })).join()).toMatch(/能力不合法/)
  })

  it('正常連續成長：通過（不同能力也可以）', () => {
    expect(mvpIssues(rec(b, { count: 31, grants: [g('power', 10), g('power', 20), g('contact', 33)] }))).toEqual([])
    expect(mvpIssues(rec(p, { count: 20, grants: [g('control', 5), g('stuff', 6)] }))).toEqual([])
  })

  it('已達上限但 MVP 次數繼續增加：通過', () => {
    expect(mvpIssues(rec(b, { count: 87, grants: [g('power', 10), g('power', 20), g('power', 30)] }))).toEqual([])
  })

  it('沒有 MVP 紀錄的舊球員：通過；有次數但缺少成長（能力全滿那幾次沒成長）：通過', () => {
    expect(mvpIssues(rec(b))).toEqual([])
    expect(mvpCursorIssues(rec(b), 0)).toEqual([])
    expect(mvpIssues(rec(b, { count: 25, grants: [] }))).toEqual([])
    expect(mvpIssues(rec(b, { count: 25, grants: [g('power', 7)] }))).toEqual([])
  })

  it('awardMvp 產生的紀錄一定通過驗證（含能力全滿不成長的情況）', () => {
    for (let i = 0; i < 40; i++) {
      for (const pl of [batter(200 + i), pitcher(200 + i), pitcher(300 + i, { ratings: { stuff: 10, control: 10, stamina: 9.95 } })]) {
        let r: PlayerRecord = { ...rec(pl), joinedAtMatch: 30 }
        for (let n = 0; n < 45; n++) r = awardMvp(r, 30 + n * 2).record
        expect(mvpIssues(r)).toEqual([])
        expect(mvpCursorIssues(r, 30 + 45 * 2)).toEqual([])
      }
    }
  })
})

describe('成長狀態（介面用）', () => {
  it('還在成長：還差幾次；到上限：capped；還沒到上限但能力都滿了：no-room（都仍可得獎）', () => {
    expect(mvpGrowthState(rec(batter(50), { count: 13, grants: [{ rating: 'power', atMatch: 1 }] }))).toEqual({ kind: 'growing', toNext: 7 })
    expect(mvpGrowthState(rec(batter(50)))).toEqual({ kind: 'growing', toNext: 10 })
    const three = [1, 2, 3].map((i) => ({ rating: 'power' as const, atMatch: i }))
    expect(mvpGrowthState(rec(batter(50), { count: 41, grants: three }))).toEqual({ kind: 'capped' })
    expect(mvpToNext(rec(batter(50), { count: 41, grants: three }))).toBeNull()
    const full = pitcher(51, { ratings: { stuff: 10, control: 10, stamina: 10 } })
    expect(mvpGrowthState(rec(full, { count: 12, grants: [] }))).toEqual({ kind: 'no-room' })
  })
})
