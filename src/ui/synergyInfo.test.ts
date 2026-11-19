// 羈絆說明的資料：條件、隊長加權、換隊長的變化、防守型當指定打擊、守位羈絆的本職與守備門檻、加成文字都來自正式設定；
// 而且跟比賽引擎實際用的階級一致
import { describe, expect, it } from 'vitest'
import { Game, SYNERGY_EFFECT } from '../sim/game'
import { generateTeam } from '../sim/generate'
import { Rng } from '../sim/rng'
import { POSITION_SYNERGY_FIELDING, captainWeight, thresholds } from '../sim/synergy'
import type { Archetype, Batter, LineupSpot, Position } from '../sim/types'
import { captainOptions, captainRules, conditionText, synergyChanges, synergyDetails, synergyEffects } from './synergyInfo'
import { synergyRows } from './synergyUi'

const base = () => generateTeam(new Rng(42)).roster
/** 依序把守備位置上的人改成指定流派（指定打擊一律是 rest，避開「防守型當指定打擊不算」），其餘改成 rest */
function lineupWith(counts: Partial<Record<Archetype, number>>, rest: Archetype = 'skill'): LineupSpot[] {
  const order = Object.entries(counts).flatMap(([a, n]) => Array.from({ length: n! }, () => a as Archetype))
  let k = 0
  return base().lineup.map((s) => ({ ...s, player: { ...s.player, archetype: s.position === 'DH' ? rest : (order[k++] ?? rest) } }))
}
const detail = (lineup: LineupSpot[], key: string, captain?: string, pool: Batter[] = []) => synergyDetails(lineup, captain, [], pool).find((d) => d.key === key)!
const [LOW, HIGH] = thresholds('power', [])
const W = captainWeight([])

describe('六種羈絆的啟動條件', () => {
  it.each(['power', 'speed', 'skill', 'defense'] as const)('%s：門檻來自 thresholds()，未滿／第一階／第二階', (a) => {
    const rest: Archetype = a === 'skill' ? 'power' : 'skill'
    const d0 = detail(lineupWith({}, rest), a)
    expect(d0).toMatchObject({ tier: 0, count: 0, low: LOW, high: HIGH, current: [] })
    expect(d0.reason).toContain('先發沒有')
    expect(d0.next!.missing).toBe(LOW)
    const below = detail(lineupWith({ [a]: LOW - 1 }, rest), a)
    expect(below).toMatchObject({ tier: 0, count: LOW - 1 })
    expect(below.reason).toContain(`差 1 人`)
    const d1 = detail(lineupWith({ [a]: LOW }, rest), a)
    expect(d1).toMatchObject({ tier: 1, count: LOW, current: synergyEffects(a, 1), next: { missing: HIGH - LOW, effects: synergyEffects(a, 2) } })
    expect(d1.members).toHaveLength(LOW)
    const d2 = detail(lineupWith({ [a]: HIGH }, rest), a)
    expect(d2).toMatchObject({ tier: 2, count: HIGH, next: null, reason: '已達最高階', tips: [], current: synergyEffects(a, 2) })
    expect(conditionText(d1)).toContain(`${LOW} 人啟動、${HIGH} 人升級`)
  })

  it('跟比賽引擎實際用的階級一致（200 支隨機隊伍）', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const home = generateTeam(new Rng(seed * 2 + 1))
      const away = generateTeam(new Rng(seed * 2 + 2))
      const game = new Game({ home, away, seed, userSide: 'home' })
      const details = synergyDetails(home.roster.lineup, home.roster.captain, [])
      for (const d of details) {
        const engine = d.position ? (game.positionSynergy(game.teams.home, d.key as 'middle' | 'battery') ? 1 : 0) : game.synergyTier(game.teams.home, d.key as Archetype)
        expect(d.tier, `${seed} ${d.key}`).toBe(engine)
      }
    }
  })

  it('加成文字的數字全部來自 SYNERGY_EFFECT', () => {
    const E = SYNERGY_EFFECT
    expect(synergyEffects('power', 2).join()).toContain(`×${E.homer[2]}`)
    expect(synergyEffects('power', 1).join()).toContain(`+${E.slugPower[1]}`)
    expect(synergyEffects('speed', 1).join()).toContain(`+${Math.round(E.steal[1] * 100)} 個百分點`)
    expect(synergyEffects('skill', 2).join()).toContain(`−${Math.round(E.skillChase[2] * 100)} 個百分點`)
    expect(synergyEffects('defense', 2).join()).toContain(`−${Math.round((1 - E.ironError[2]) * 100)}%`)
    expect(synergyEffects('middle', 1).join()).toContain(`+${Math.round(E.middleDoublePlay * 100)} 個百分點`)
    expect(synergyEffects('battery', 1).join()).toContain(`+${E.batteryControl}`)
    // 第二階一定比第一階強（同一組數字）
    for (const k of ['power', 'speed', 'skill', 'defense'] as const) expect(synergyEffects(k, 2)).not.toEqual(synergyEffects(k, 1))
  })
})

describe('隊長加權', () => {
  it(`隊長在自己流派算 ${W} 人；不在先發就不算；對別的流派沒有影響`, () => {
    const lineup = lineupWith({ power: LOW - 1 }, 'skill')
    const powerGuy = lineup.find((s) => s.player.archetype === 'power')!.player.id
    const noCap = detail(lineup, 'power')
    const withCap = detail(lineup, 'power', powerGuy)
    expect(withCap.count).toBe(noCap.count + W - 1)
    expect(withCap.tier).toBe(withCap.count >= LOW ? 1 : 0)
    expect(withCap.members.find((m) => m.id === powerGuy)).toMatchObject({ captain: true, weight: W })
    expect(detail(lineup, 'skill', powerGuy).count).toBe(detail(lineup, 'skill').count)
    // 隊長是板凳的人 → 當作沒有隊長
    expect(detail(lineup, 'power', 'not-in-lineup').count).toBe(noCap.count)
  })

  it('換隊長後的進度變化：人數與階級都列出來', () => {
    const lineup = lineupWith({ power: LOW - 1, speed: LOW }, 'skill')
    const speedCap = lineup.find((s) => s.player.archetype === 'speed')!.player.id
    const powerGuy = lineup.find((s) => s.player.archetype === 'power')!.player.id
    const opts = captainOptions(lineup, speedCap, [])
    expect(opts.find((o) => o.id === speedCap)!.current).toBe(true)
    const toPower = opts.find((o) => o.id === powerGuy)!
    // 速度型隊長換成力量型：快腿少 1、重砲多 1 → 重砲啟動
    expect(toPower.counts).toEqual(
      expect.arrayContaining([
        { key: 'speed', name: '快腿球隊', from: LOW + W - 1, to: LOW },
        { key: 'power', name: '重砲打線', from: LOW - 1, to: LOW - 1 + W - 1 },
      ]),
    )
    expect(toPower.changes).toContainEqual(expect.objectContaining({ key: 'power', kind: 'gained', before: 0, after: 1 }))
    // 建議：有力量型球員、隊長不是力量型 → 建議指定隊長
    expect(detail(lineup, 'power', speedCap).tips.join()).toContain('設為隊長')
  })

  it('規則說明的數字來自 captainWeight 與秘技設定', () => {
    const rules = captainRules().join('\n')
    expect(rules).toContain('Captain')
    expect(rules).toContain(`算 ${W} 人`)
    expect(rules).toContain(`算 ${captainWeight(['captainBand'])} 人`)
    expect(rules).toContain('先發')
  })
})

describe('防守型擔任指定打擊', () => {
  it('不算進鐵壁球隊，列在「不算進來」並建議改守野手位置', () => {
    const l = base().lineup.map((s) => ({ ...s, player: { ...s.player, archetype: 'skill' as Archetype } }))
    const dhIndex = l.findIndex((s) => s.position === 'DH')
    const picks = [dhIndex, ...l.map((_, i) => i).filter((i) => i !== dhIndex).slice(0, LOW - 1)]
    const lineup = l.map((s, i) => (picks.includes(i) ? { ...s, player: { ...s.player, archetype: 'defense' as Archetype } } : s))
    const d = detail(lineup, 'defense')
    expect(d.count).toBe(LOW - 1)
    expect(d.tier).toBe(0)
    expect(d.excluded).toEqual([{ name: lineup[dhIndex].player.name, why: expect.stringContaining('指定打擊') }])
    expect(d.members.map((m) => m.id)).not.toContain(lineup[dhIndex].player.id)
    expect(d.tips.join()).toContain('不要當指定打擊')
  })
})

describe('守位羈絆：本職與守備門檻', () => {
  const set = (lineup: LineupSpot[], position: Position, patch: Partial<Batter> & { fielding?: number }) =>
    lineup.map((s) => (s.position === position ? { ...s, player: { ...s.player, ...patch, ratings: { ...s.player.ratings, ...(patch.fielding !== undefined ? { fielding: patch.fielding } : {}) } } } : s))
  const strong = (l: LineupSpot[]) => set(set(set(l, '2B', { primary: '2B', fielding: POSITION_SYNERGY_FIELDING + 1, traits: [] }), 'SS', { primary: 'SS', fielding: POSITION_SYNERGY_FIELDING + 1, traits: [] }), 'C', { primary: 'C', fielding: POSITION_SYNERGY_FIELDING + 1, traits: [] })

  it('二壘、游擊、捕手都本職且守備 B 以上 → 黃金二遊、投捕搭檔成立', () => {
    const lineup = strong(base().lineup)
    expect(detail(lineup, 'middle')).toMatchObject({ tier: 1, next: null, tips: [] })
    expect(detail(lineup, 'battery').tier).toBe(1)
    expect(detail(lineup, 'middle').current).toEqual(synergyEffects('middle', 1))
  })

  it('游擊手非本職 → 未成立，原因寫非本職，建議找本職游擊', () => {
    const lineup = set(strong(base().lineup), 'SS', { primary: '3B' })
    const d = detail(lineup, 'middle')
    expect(d.tier).toBe(0)
    expect(d.reason).toContain('非本職')
    expect(d.tips.join()).toContain('游擊')
  })

  it('捕手守備不到門檻 → 未成立，原因寫守備；板凳有本職捕手守備夠的人就推薦他', () => {
    const lineup = set(strong(base().lineup), 'C', { fielding: POSITION_SYNERGY_FIELDING - 0.5 })
    const backup = { ...base().bench[0], primary: 'C' as const, traits: [], ratings: { ...base().bench[0].ratings, fielding: POSITION_SYNERGY_FIELDING + 0.5 } }
    const d = detail(lineup, 'battery', undefined, [backup])
    expect(d.tier).toBe(0)
    expect(d.reason).toContain('要 B 以上')
    expect(d.tips.join()).toContain(backup.name)
    expect(conditionText(d)).toContain('B 以上')
  })
})

describe('草稿與存檔的差異', () => {
  it('只列有變化的羈絆：成立、失效、升級、降級', () => {
    const before = synergyRows(lineupWith({ power: LOW, speed: HIGH }, 'skill'), undefined, [])
    const after = synergyRows(lineupWith({ power: 0, speed: LOW, defense: LOW }, 'skill'), undefined, [])
    const kinds = Object.fromEntries(synergyChanges(before, after).map((c) => [c.key, c.kind]))
    expect(kinds.power).toBe('lost')
    expect(kinds.speed).toBe('down')
    expect(synergyChanges(before, before)).toEqual([])
  })
})
