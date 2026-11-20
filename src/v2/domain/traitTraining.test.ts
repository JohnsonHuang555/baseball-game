// Phase 9 PR 3：特性培養（domain）：潛能池、有效特性、訓練資格、進度、驗證
import { describe, expect, it } from 'vitest'
import { generateBatter, generatePitcher } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { TRAITS, conflicts, type TraitId } from '../../sim/traits'
import type { Batter, Pitcher, Player } from '../../sim/types'
import type { PlayerRecord } from './club'
import { leveled } from './progression'
import { effectivePlayer } from './roster'
import {
  MAX_POSITIVE_TRAITS,
  POTENTIAL_SIZE,
  TRAINING_CONFIG,
  TRAINING_RULES,
  positiveCeiling,
  TrainingInvariantError,
  advanceTraining,
  applyTraining,
  developmentIssues,
  effectiveTraits,
  matchesBeforePossibleTrainingCompletion,
  newTrainingState,
  potentialPool,
  positiveCount,
  staticTrainingBlock,
  trainingBlock,
  trainingOptions,
  type ActiveTraining,
} from './traitTraining'

const SEED = 4242
const rec = (player: Player, dev?: PlayerRecord['dev'], level = 1): PlayerRecord => ({ player, level, origin: 'recruit', joinedAtMatch: 0, ...(dev ? { dev } : {}) })
const batter = (i: number, over: Partial<Batter> = {}): Batter => ({ ...generateBatter(new Rng(1000 + i), 5), ...over })
const pitcher = (i: number, over: Partial<Pitcher> = {}): Pitcher => ({ ...generatePitcher(new Rng(2000 + i), 5), ...over })
const rich = { active: null, assets: { funds: 1e9, experience: 1e9 } }
const isPositive = (t: TraitId) => TRAITS[t].tier !== 'red'

describe('個人潛能池', () => {
  it('確定性：同一位球員、同一個球團永遠是同一池；不同球團或不同球員不一樣', () => {
    const p = batter(1)
    expect(potentialPool(SEED, p)).toEqual(potentialPool(SEED, structuredClone(p)))
    const pools = new Set(Array.from({ length: 40 }, (_, i) => potentialPool(SEED, batter(i)).join(',')))
    expect(pools.size).toBeGreaterThan(10)
    const across = new Set(Array.from({ length: 20 }, (_, s) => potentialPool(s, p).join(',')))
    expect(across.size).toBeGreaterThan(1)
  })

  it('只看原始資料：升級（能力變高）、換陣容都不會改變潛能池', () => {
    const p = batter(3)
    expect(potentialPool(SEED, leveled(p, 20))).not.toBe(undefined)
    // 潛能池用的是 record.player（Lv.1 原始資料），升級只改 record.level
    const r = rec(p, undefined, 1)
    const before = trainingOptions(SEED, r, rich).map((o) => o.trait)
    expect(trainingOptions(SEED, { ...r, level: 20 }, rich).map((o) => o.trait)).toEqual(before)
  })

  it('打者只會有打者特性、投手只會有投手特性；都是正面特性；不含已經有的；不含跟原生正面特性互斥的；最多 3 個', () => {
    for (let i = 0; i < 200; i++) {
      for (const p of [batter(i), pitcher(i)] as Player[]) {
        const pool = potentialPool(SEED, p)
        expect(pool.length).toBeLessThanOrEqual(POTENTIAL_SIZE)
        expect(pool.length).toBeGreaterThan(0)
        expect(new Set(pool).size).toBe(pool.length)
        for (const t of pool) {
          expect(TRAITS[t].role).toBe(p.role)
          expect(isPositive(t)).toBe(true)
          expect(p.traits).not.toContain(t)
          expect(p.traits.some((n) => isPositive(n) && conflicts(n, t))).toBe(false)
        }
      }
    }
  })

  it('依原始能力加權：長打高的打者常出現怪力、速度高的常出現盜壘／跑壘；球威高的投手常出現奪三振', () => {
    const count = (make: (i: number) => Player, traits: TraitId[]) => {
      let n = 0
      for (let i = 0; i < 300; i++) if (potentialPool(SEED, make(i)).some((t) => traits.includes(t))) n++
      return n
    }
    const withRatings = (i: number, r: Partial<Batter['ratings']>) => {
      const b = batter(i)
      return { ...b, traits: [], ratings: { ...b.ratings, ...r } } as Batter
    }
    const slow = (i: number) => withRatings(i, { power: 3, speed: 3, contact: 5, fielding: 5 })
    expect(count((i) => withRatings(i, { power: 9, speed: 3 }), ['slugger'])).toBeGreaterThan(count(slow, ['slugger']) * 2)
    expect(count((i) => withRatings(i, { speed: 9, power: 3 }), ['stealer', 'baserunner'])).toBeGreaterThan(count(slow, ['stealer', 'baserunner']) * 1.3)
    const pit = (i: number, stuff: number) => {
      const p = pitcher(i)
      return { ...p, traits: [], ratings: { ...p.ratings, stuff, control: 5, stamina: 5 } } as Pitcher
    }
    expect(count((i) => pit(i, 9), ['strikeoutArtist'])).toBeGreaterThan(count((i) => pit(i, 3), ['strikeoutArtist']) * 1.3)
  })

  it('原生有「守備不穩」的打者，池子裡可以有好手套，但要先改善守備不穩才能學', () => {
    let found: Batter | null = null
    for (let i = 0; i < 2000 && !found; i++) {
      const b = { ...batter(i), traits: ['errorProne'] as TraitId[] }
      if (potentialPool(SEED, b).includes('goodGlove')) found = b
    }
    expect(found).not.toBeNull()
    const r = rec(found!)
    expect(trainingBlock(SEED, r, 'goodGlove', 'learn', rich)).toBe('conflict')
    expect(trainingOptions(SEED, r, rich).find((o) => o.trait === 'goodGlove')!.conflictWith).toBe('errorProne')
    const fixed = applyTraining(r, 'errorProne', 'improve')
    expect(trainingBlock(SEED, fixed, 'goodGlove', 'learn', rich)).toBeNull()
  })
})

describe('有效特性', () => {
  it('=（原生 − 已改善）∪ 已習得；原始資料不改；沒有養成就是同一個物件', () => {
    const p = { ...batter(5), traits: ['clutch', 'freeSwinger'] as TraitId[] }
    const r = rec(p, { learned: ['eye'], removed: ['freeSwinger'] })
    expect(effectiveTraits(r)).toEqual(['clutch', 'eye'])
    expect(r.player.traits).toEqual(['clutch', 'freeSwinger'])
    expect(effectivePlayer(r).traits).toEqual(['clutch', 'eye'])
    // 能力照等級成長，特性另外套用
    expect(effectivePlayer({ ...r, level: 10 }).ratings).toEqual(leveled(p, 10).ratings)
    const plain = rec(p)
    expect(effectivePlayer(plain).traits).toEqual(['clutch', 'freeSwinger'])
    expect(effectivePlayer(rec(p, { learned: [], removed: [] }))).toBe(p)
  })
})

describe('訓練資格', () => {
  it('每一項都有成本與所需出場數（平衡後的定案：一般 6,000／1,000／200、稀有 15,000／2,500／500、改善 8,000／1,200／300）', () => {
    expect(TRAINING_CONFIG).toEqual({
      common: { cost: { funds: 6000, experience: 1000 }, appearances: 200 },
      rare: { cost: { funds: 15000, experience: 2500 }, appearances: 500 },
      improve: { cost: { funds: 8000, experience: 1200 }, appearances: 300 },
    })
    const p = { ...batter(7), traits: ['freeSwinger'] as TraitId[] }
    const opts = trainingOptions(SEED, rec(p), rich)
    const improve = opts.find((o) => o.kind === 'improve')!
    expect(improve).toMatchObject({ trait: 'freeSwinger', cls: 'improve', need: TRAINING_CONFIG.improve.appearances, block: null })
    for (const o of opts.filter((x) => x.kind === 'learn')) expect(o.cls).toBe(TRAITS[o.trait].tier === 'gold' ? 'rare' : 'common')
  })

  it('正面特性上限（原生的也算，3 個）；負面特性不占名額', () => {
    expect(MAX_POSITIVE_TRAITS).toBe(3)
    expect(TRAINING_RULES.maxPositive).toBe(3)
    const p = { ...batter(9), traits: ['clutch', 'eye', 'freeSwinger'] as TraitId[] }
    const pool = potentialPool(SEED, p)
    const first = pool.find((t) => trainingBlock(SEED, rec(p), t, 'learn', rich) === null)!
    const r = rec(p, { learned: [first], removed: [] })
    expect(effectiveTraits(r).filter(isPositive)).toHaveLength(MAX_POSITIVE_TRAITS)
    for (const t of pool.filter((x) => x !== first)) expect(['cap', 'conflict']).toContain(trainingBlock(SEED, r, t, 'learn', rich))
    // 負面特性的改善不受上限影響
    expect(trainingBlock(SEED, r, 'freeSwinger', 'improve', rich)).toBeNull()
    // 原生就已經 3 個正面：一個都不能學，但不算存檔錯誤
    const full = rec({ ...batter(9), traits: ['clutch', 'eye', 'stealer'] as TraitId[] })
    expect(trainingOptions(SEED, full, rich).filter((o) => o.kind === 'learn').every((o) => o.block === 'cap' || o.block === 'conflict')).toBe(true)
    expect(developmentIssues(full)).toEqual([])
  })

  it('已擁有、已改善、不在潛能池、訓練槽占用、資源不足都會擋下', () => {
    const p = { ...batter(11), traits: ['clutchBad'] as TraitId[] }
    const pool = potentialPool(SEED, p)
    const learned = applyTraining(rec(p), pool[0], 'learn')
    expect(trainingBlock(SEED, learned, pool[0], 'learn', rich)).toBe('owned')
    const improved = applyTraining(rec(p), 'clutchBad', 'improve')
    expect(trainingBlock(SEED, improved, 'clutchBad', 'improve', rich)).toBe('improved')
    const notInPool = (Object.keys(TRAITS) as TraitId[]).find((t) => TRAITS[t].role === 'batter' && isPositive(t) && !pool.includes(t) && !conflicts(t, 'clutchBad'))!
    expect(trainingBlock(SEED, rec(p), notInPool, 'learn', rich)).toBe('not-eligible')
    expect(trainingBlock(SEED, rec(p), 'ironArm', 'learn', rich)).toBe('not-eligible')
    expect(trainingBlock(SEED, rec(p), 'wild', 'improve', rich)).toBe('not-eligible')
    const busy: ActiveTraining = { playerId: 'x', trait: 'eye', kind: 'learn', progress: 0, need: 40, startedAtMatch: 0, lastCountedMatch: null }
    expect(trainingBlock(SEED, rec(p), pool[0], 'learn', { ...rich, active: busy })).toBe('slot-busy')
    expect(trainingBlock(SEED, rec(p), pool[0], 'learn', { active: null, assets: { funds: 100, experience: 1e6 } })).toBe('insufficient')
  })

  it('六個負面特性都可以改善（投手的四死球、被全壘打、體力差；打者的得點圈×、扇風機、守備不穩）', () => {
    const negatives: TraitId[] = ['clutchBad', 'freeSwinger', 'errorProne', 'wild', 'homerProne', 'lowStamina']
    expect((Object.keys(TRAITS) as TraitId[]).filter((t) => TRAITS[t].tier === 'red').sort()).toEqual([...negatives].sort())
    for (const t of negatives) {
      const p = TRAITS[t].role === 'batter' ? { ...batter(13), traits: [t] } : { ...pitcher(13), traits: [t] }
      expect(trainingBlock(SEED, rec(p as Player), t, 'improve', rich)).toBeNull()
      const after = applyTraining(rec(p as Player), t, 'improve')
      expect(effectiveTraits(after)).not.toContain(t)
      expect(after.player.traits).toContain(t)
    }
  })
})

describe('驗證', () => {
  it('不合法的養成資料：別的角色、負面當習得、改善不是原生的、重複、互斥、超過上限', () => {
    const p = { ...batter(15), traits: ['clutch', 'errorProne'] as TraitId[] }
    const bad = (dev: PlayerRecord['dev']) => developmentIssues(rec(p, dev))
    expect(bad({ learned: ['eye'], removed: ['errorProne'] })).toEqual([])
    expect(bad({ learned: ['eye', 'stealer'], removed: [] })).toEqual([])
    expect(bad({ learned: ['eye', 'stealer', 'bunter'], removed: [] }).join()).toMatch(/超過/)
    expect(bad({ learned: ['ironArm'], removed: [] }).length).toBeGreaterThan(0)
    expect(bad({ learned: ['freeSwinger'], removed: [] }).length).toBeGreaterThan(0)
    expect(bad({ learned: ['clutch'], removed: [] }).length).toBeGreaterThan(0)
    expect(bad({ learned: [], removed: ['wild'] }).length).toBeGreaterThan(0)
    expect(bad({ learned: ['eye', 'eye'], removed: [] }).length).toBeGreaterThan(0)
    expect(bad({ learned: ['goodGlove'], removed: [] }).join()).toMatch(/互斥/)
  })
})

describe('結算時的進度', () => {
  const club = () => {
    const p = batter(17)
    const state = newTrainingState()
    const trait = potentialPool(SEED, p).find((t) => staticTrainingBlock(SEED, rec(p), t, 'learn') === null)!
    state.active = { playerId: p.id, trait, kind: 'learn', progress: 38, need: 40, startedAtMatch: 10, lastCountedMatch: 30 }
    return { clubSeed: SEED, training: state, players: [rec(p)], id: p.id }
  }
  const lines = (ids: string[], pit: string[] = []) => ({ bat: ids.map((id) => [id, 1] as [string, number]), pit: pit.map((id) => [id, 1] as [string, number]) })

  it('有出場才 +1；沒出場、開始之前、已經算過的場次都不算', () => {
    const c = club()
    expect(advanceTraining(c, 31, lines(['other']))).toBeNull()
    expect(c.training.active!.progress).toBe(38)
    expect(advanceTraining(c, 30, lines([c.id]))).toBeNull()
    expect(advanceTraining(c, 5, lines([c.id]))).toBeNull()
    expect(c.training.active!.progress).toBe(38)
    expect(advanceTraining(c, 31, lines([c.id]))).toBeNull()
    expect(c.training.active).toMatchObject({ progress: 39, lastCountedMatch: 31 })
    // 同一場再送一次不會再加
    expect(advanceTraining(c, 31, lines([c.id]))).toBeNull()
    expect(c.training.active!.progress).toBe(39)
  })

  it('投手名單（後援）也算出場；達到所需場數就寫進球員、清空訓練槽、記完成（下一場起生效）', () => {
    const c = club()
    advanceTraining(c, 31, lines([], [c.id]))
    const done = advanceTraining(c, 32, lines([c.id]))
    expect(done).toMatchObject({ playerId: c.id, completedAtMatch: 32, effectiveFromMatch: 33, kind: 'learn' })
    expect(c.training.active).toBeNull()
    expect(c.training.recent).toEqual([done])
    expect(c.players[0].dev!.learned).toEqual([done!.trait])
  })

  it('分段的上限：還差幾場就最多切幾場；球員不可能出場時不切', () => {
    const c = club()
    expect(matchesBeforePossibleTrainingCompletion(c, () => true)).toBe(2)
    expect(matchesBeforePossibleTrainingCompletion(c, () => false)).toBe(Infinity)
    expect(matchesBeforePossibleTrainingCompletion({ training: newTrainingState() }, () => true)).toBe(Infinity)
  })
})

describe('訓練資格：開始、存檔讀取、完成用同一套規則（PR #22 review P2）', () => {
  /** 一位原生「得點圈強打＋扇風機」的打者：池子裡第一個可以學的特性 */
  const base = () => {
    const p = { ...batter(31), traits: ['clutch', 'freeSwinger'] as TraitId[] }
    const pool = potentialPool(SEED, p)
    return { p, pool, ok: pool.find((t) => staticTrainingBlock(SEED, rec(p), t, 'learn') === null)! }
  }

  it('合法：池子裡可以學的、原生的負面特性可以改善', () => {
    const { p, ok } = base()
    expect(staticTrainingBlock(SEED, rec(p), ok, 'learn')).toBeNull()
    expect(staticTrainingBlock(SEED, rec(p), 'freeSwinger', 'improve')).toBeNull()
  })

  it('不在潛能池、別的角色、不存在的特性：not-eligible', () => {
    const { p, pool } = base()
    const outside = (Object.keys(TRAITS) as TraitId[]).find((t) => TRAITS[t].role === 'batter' && isPositive(t) && !pool.includes(t) && !p.traits.includes(t))!
    expect(staticTrainingBlock(SEED, rec(p), outside, 'learn')).toEqual({ block: 'not-eligible' })
    expect(staticTrainingBlock(SEED, rec(p), 'ironArm', 'learn')).toEqual({ block: 'not-eligible' })
    expect(staticTrainingBlock(SEED, rec(p), 'nope' as TraitId, 'learn')).toEqual({ block: 'not-eligible' })
  })

  it('已經擁有（原生或習得）不能再學', () => {
    const { p, ok } = base()
    expect(staticTrainingBlock(SEED, rec(p), 'clutch', 'learn')).toEqual({ block: 'owned' })
    expect(staticTrainingBlock(SEED, rec(p, { learned: [ok], removed: [] }), ok, 'learn')).toEqual({ block: 'owned' })
  })

  it('跟有效特性互斥：拒絕，並指出跟誰互斥；改善之後就可以', () => {
    let found: { p: Batter; t: TraitId } | null = null
    for (let i = 0; i < 3000 && !found; i++) {
      const b = { ...batter(i), traits: ['errorProne'] as TraitId[] }
      if (potentialPool(SEED, b).includes('goodGlove')) found = { p: b, t: 'goodGlove' }
    }
    expect(staticTrainingBlock(SEED, rec(found!.p), 'goodGlove', 'learn')).toEqual({ block: 'conflict', conflictWith: 'errorProne' })
    expect(staticTrainingBlock(SEED, rec(found!.p, { learned: [], removed: ['errorProne'] }), 'goodGlove', 'learn')).toBeNull()
  })

  it('正面特性已達上限：拒絕新的學習（改善不受影響）', () => {
    const p = { ...batter(33), traits: ['clutch', 'eye', 'freeSwinger'] as TraitId[] }
    const pool = potentialPool(SEED, p)
    const first = pool.find((t) => staticTrainingBlock(SEED, rec(p), t, 'learn') === null)!
    const full = rec(p, { learned: [first], removed: [] })
    expect(positiveCount(full)).toBe(3)
    for (const t of pool.filter((x) => x !== first)) expect(['cap', 'conflict']).toContain(staticTrainingBlock(SEED, full, t, 'learn')!.block)
    expect(staticTrainingBlock(SEED, full, 'freeSwinger', 'improve')).toBeNull()
  })

  it('種類不對：負面特性不能 learn、正面特性不能 improve', () => {
    const { p } = base()
    expect(staticTrainingBlock(SEED, rec(p), 'freeSwinger', 'learn')).toEqual({ block: 'wrong-kind' })
    expect(staticTrainingBlock(SEED, rec(p), 'clutch', 'improve')).toEqual({ block: 'wrong-kind' })
    expect(staticTrainingBlock(SEED, rec(p), 'clutch', 'other' as never)).toEqual({ block: 'wrong-kind' })
  })

  it('非原生的負面特性不能改善；已經改善過的不能再改善', () => {
    const { p } = base()
    expect(staticTrainingBlock(SEED, rec(p), 'errorProne', 'improve')).toEqual({ block: 'not-eligible' })
    expect(staticTrainingBlock(SEED, rec(p, { learned: [], removed: ['freeSwinger'] }), 'freeSwinger', 'improve')).toEqual({ block: 'improved' })
  })

  it('開始訓練（trainingBlock）先看靜態資格；合法的才看訓練槽與資源', () => {
    const { p, ok } = base()
    const busy: ActiveTraining = { playerId: 'x', trait: 'eye', kind: 'learn', progress: 0, need: 200, startedAtMatch: 0, lastCountedMatch: null }
    expect(trainingBlock(SEED, rec(p), 'freeSwinger', 'learn', { active: busy, assets: { funds: 0, experience: 0 } })).toBe('wrong-kind')
    expect(trainingBlock(SEED, rec(p), ok, 'learn', { active: busy, assets: rich.assets })).toBe('slot-busy')
    expect(trainingBlock(SEED, rec(p), ok, 'learn', { active: null, assets: { funds: 0, experience: 0 } })).toBe('insufficient')
  })

  it('完成時再檢查一次：資料不一致（例如期間別處已經學到同一個特性）就丟錯，不會重複解鎖', () => {
    const { p, ok } = base()
    const fresh = (): ActiveTraining => ({ playerId: p.id, trait: ok, kind: 'learn', progress: 0, need: 1, startedAtMatch: 0, lastCountedMatch: null })
    const state = { ...newTrainingState(), active: fresh() }
    const c = { clubSeed: SEED, training: state, players: [rec(p, { learned: [ok], removed: [] })] }
    expect(() => advanceTraining(c, 5, { bat: [[p.id, 1]], pit: [] })).toThrow(TrainingInvariantError)
    // 名單裡找不到人也一樣丟錯
    const gone = { clubSeed: SEED, training: { ...newTrainingState(), active: { ...fresh(), playerId: 'nobody' } }, players: [rec(p)] }
    expect(() => advanceTraining(gone, 5, { bat: [['nobody', 1]], pit: [] })).toThrow(TrainingInvariantError)
    // 合法的：完成一次，再送同一場不會再解鎖
    const fine = { clubSeed: SEED, training: { ...newTrainingState(), active: fresh() }, players: [rec(p)] }
    expect(advanceTraining(fine, 5, { bat: [[p.id, 1]], pit: [] })).not.toBeNull()
    expect(advanceTraining(fine, 5, { bat: [[p.id, 1]], pit: [] })).toBeNull()
    expect(fine.players[0].dev!.learned).toEqual([ok])
  })
})

describe('潛能池不會整個卡死；第三個名額的實際可達程度', () => {
  it('原生負面特性都改善後，還沒到上限的球員至少有一項可以學；潛能池跟等級無關（用 Lv.1 原始資料）', () => {
    let stuck = 0
    const ceilings: Record<number, number> = {}
    for (let i = 0; i < 400; i++) {
      for (const p of [batter(i), pitcher(i)]) {
        const healed = rec(p, { learned: [], removed: p.traits.filter((t) => !isPositive(t)) })
        const learnable = potentialPool(SEED, p).filter((t) => staticTrainingBlock(SEED, healed, t, 'learn') === null)
        if (positiveCount(healed) < TRAINING_RULES.maxPositive && learnable.length === 0) stuck++
        const c = positiveCeiling(SEED, rec(p))
        ceilings[c] = (ceilings[c] ?? 0) + 1
        // 升級不改潛能池（潛能池只看 player，等級在 record）
        expect(potentialPool(SEED, rec(p, undefined, 20).player)).toEqual(potentialPool(SEED, p))
      }
    }
    expect(stuck).toBe(0)
    // 大部分球員可以練到 3 個（記錄分布，平衡文件引用）
    expect((ceilings[3] ?? 0) / 800).toBeGreaterThan(0.9)
  })

  it('原生 2 個正面特性的球員：第 3 個名額大多可用', () => {
    let n = 0
    let ok = 0
    for (let i = 0; i < 3000 && n < 200; i++) {
      const p = batter(i)
      if (p.traits.filter(isPositive).length !== 2) continue
      n++
      if (positiveCeiling(SEED, rec(p)) === 3) ok++
    }
    expect(n).toBeGreaterThan(20)
    expect(ok / n).toBeGreaterThan(0.8)
  })
})
