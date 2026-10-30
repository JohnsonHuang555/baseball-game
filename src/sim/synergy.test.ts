import { describe, expect, it } from 'vitest'
import { Game, type GameEvent } from './game'
import { ARCHETYPE_STAT, generateBatter, generateRoster, generateTeam } from './generate'
import { Rng } from './rng'
import { setSlot } from './setup'
import { archetypeCounts, defaultCaptain, positionSynergies, synergyTiers, thresholds } from './synergy'
import type { Archetype, LineupSpot, Team } from './types'

/** 把先發陣容前 n 人改成某個流派，其餘改成另一個流派 */
function withArchetypes(lineup: LineupSpot[], archetype: Archetype, n: number, rest: Archetype = 'skill'): LineupSpot[] {
  return lineup.map((s, i) => ({ ...s, player: { ...s.player, archetype: i < n ? archetype : rest } }))
}

describe('流派', () => {
  it('流派對應的能力一定是四項裡最高的', () => {
    const rng = new Rng(5)
    for (let i = 0; i < 500; i++) {
      const b = generateBatter(rng)
      expect(b.ratings[ARCHETYPE_STAT[b.archetype]]).toBe(Math.max(...Object.values(b.ratings)))
    }
  })

  it('本職中外野多半是速度型、本職一壘多半是力量型', () => {
    const share = (pos: 'CF' | '1B', a: Archetype) => {
      const rng = new Rng(9)
      const list = Array.from({ length: 1000 }, () => generateBatter(rng, 5, pos))
      return list.filter((b) => b.archetype === a).length / list.length
    }
    expect(share('CF', 'speed')).toBeGreaterThan(0.55)
    expect(share('1B', 'power')).toBeGreaterThan(0.55)
  })
})

describe('開局隊伍', () => {
  it('先發每種流派最多 3 人，所以開局不會有 5 人階；流派那一項還是最突出的', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = generateRoster(new Rng(seed))
      for (const a of ['power', 'speed', 'skill', 'defense'] as const) expect(r.lineup.filter((x) => x.player.archetype === a).length).toBeLessThanOrEqual(3)
      expect(Object.values(synergyTiers(r.lineup, r.captain, []))).not.toContain(2)
      for (const { player } of r.lineup) expect(player.ratings[ARCHETYPE_STAT[player.archetype]]).toBe(Math.max(...Object.values(player.ratings)))
    }
  })
})

describe('流派羈絆', () => {
  const base = generateRoster(new Rng(1)).lineup

  it('3 人啟動、5 人升級；隊長算兩人', () => {
    const lineup = withArchetypes(base, 'power', 4)
    expect(synergyTiers(lineup, null, []).power).toBe(1)
    expect(synergyTiers(lineup, lineup[0].player.id, []).power).toBe(2)
    // 隊長是別的流派就幫不到力量型
    expect(synergyTiers(lineup, lineup[8].player.id, []).power).toBe(1)
    expect(synergyTiers(withArchetypes(base, 'power', 2), null, []).power).toBe(0)
  })

  it('門檻秘技讓 2 人啟動、4 人升級；隊長臂章讓隊長算三人', () => {
    expect(thresholds('speed', ['runSchool'])).toEqual([2, 4])
    expect(thresholds('power', ['runSchool'])).toEqual([3, 5])
    const lineup = withArchetypes(base, 'speed', 3)
    expect(archetypeCounts(lineup, lineup[0].player.id, ['captainBand']).speed).toBe(5)
  })

  it('防守型當指定打擊不算鐵壁球隊；舊規則照算', () => {
    const lineup = withArchetypes(base, 'defense', 3).map((x, i) => (i === 0 ? { ...x, position: 'DH' as const } : i === 8 ? { ...x, position: base[0].position } : x))
    expect(archetypeCounts(lineup, null, []).defense).toBe(2)
    expect(archetypeCounts(lineup, null, [], false).defense).toBe(3)
  })

  it('板凳和不在先發的隊長都不算', () => {
    const lineup = withArchetypes(base, 'defense', 2)
    expect(archetypeCounts(lineup, 'not-in-lineup', []).defense).toBe(2)
  })

  it('系統挑的隊長能讓最多羈絆啟動或升級', () => {
    const lineup = withArchetypes(base, 'power', 4)
    const captain = lineup.find((s) => s.player.id === defaultCaptain(lineup, []))!
    expect(captain.player.archetype).toBe('power')
  })

  it('隊長被換掉或換到板凳就沒有隊長', () => {
    const roster = generateRoster(new Rng(2))
    const index = roster.lineup.findIndex((s) => s.player.id === roster.captain)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(setSlot(roster, { kind: 'lineup', index }, roster.bench[0]).captain).toBeUndefined()
    const other = (index + 1) % 9
    expect(setSlot(roster, { kind: 'lineup', index: other }, roster.bench[0]).captain).toBe(roster.captain)
  })
})

describe('羈絆在比賽中的效果', () => {
  function setupWith(seed: number, f: (t: Team) => Team, rules?: number) {
    return { home: f(generateTeam(new Rng(seed * 2 + 1))), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide: 'home' as const, rules }
  }
  const all = (a: Archetype) => (t: Team): Team => ({ ...t, roster: { ...t.roster, lineup: withArchetypes(t.roster.lineup, a, 9) } })

  /** 主隊打擊時每個打席的結果比例 */
  function batting(f: (t: Team) => Team, rules?: number) {
    let pa = 0, hr = 0, so = 0
    for (let seed = 1; seed <= 300; seed++) {
      const g = new Game(setupWith(seed, f, rules))
      while (!g.over) {
        const home = g.half === 'bottom'
        for (const e of g.step()) {
          if (!home || e.type !== 'play') continue
          pa++
          if (e.kind === 'homeRun') hr++
          if (e.kind === 'strikeout') so++
        }
      }
    }
    return { hr: hr / pa, so: so / pa }
  }

  it('重砲打線 5 人階：全壘打變多，三振也變多；舊規則沒有效果', () => {
    const on = batting(all('power'))
    const off = batting(all('power'), 6)
    expect(on.hr).toBeGreaterThan(off.hr * 1.15)
    expect(on.so).toBeGreaterThan(off.so)
  })

  it('精準打線 5 人階：三振變少', () => {
    expect(batting(all('skill')).so).toBeLessThan(batting(all('skill'), 6).so * 0.9)
  })

  it('鐵壁球隊 5 人階：失誤變少', () => {
    const errors = (rules?: number) => {
      let n = 0, inPlay = 0
      for (let seed = 1; seed <= 300; seed++) {
        const g = new Game(setupWith(seed, all('defense'), rules))
        while (!g.over) {
          for (const e of g.step()) {
            if (e.type !== 'play' || g.half !== 'top' || !e.ball) continue
            inPlay++
            if (e.kind === 'error') n++
          }
        }
      }
      return n / inPlay
    }
    expect(errors()).toBeLessThan(errors(6) * 0.75)
  })

  it('隊長被換下場，這場就沒有隊長，羈絆跟著重算', () => {
    const team = (t: Team): Team => {
      const lineup = withArchetypes(t.roster.lineup, 'power', 4)
      return { ...t, roster: { ...t.roster, lineup, captain: lineup[0].player.id } }
    }
    const g = new Game(setupWith(3, team))
    const home = g.teams.home
    expect(g.synergyTier(home, 'power')).toBe(2)
    // 主隊守備時用守備替補換下隊長（第 1 棒）
    const events: GameEvent[] = g.issue({ type: 'defensiveSub', benchIndex: 0, lineupIndex: 0 })
    expect(events[0].type).toBe('substitution')
    expect(home.captainId).toBeNull()
    expect(g.synergyTier(home, 'power')).toBe(home.lineup[0].player.archetype === 'power' ? 1 : 0)
  })
})

/** 二壘、游擊、捕手的守備設成某個值 */
function keyFielding(lineup: LineupSpot[], fielding: number): LineupSpot[] {
  return lineup.map((s) => (['C', '2B', 'SS'].includes(s.position) ? { ...s, player: { ...s.player, ratings: { ...s.player.ratings, fielding } } } : s))
}
const goodKeys = (t: Team): Team => ({ ...t, roster: { ...t.roster, lineup: keyFielding(t.roster.lineup, 7) } })

describe('守位羈絆', () => {
  it('二游都守本職而且守備 B 以上才有黃金二遊；捕手守本職而且守備 B 以上才有投捕搭檔', () => {
    const lineup = keyFielding(generateRoster(new Rng(4)).lineup, 7)
    expect(positionSynergies(lineup)).toEqual({ middle: true, battery: true })
    const swapped = lineup.map((s) => (s.position === '2B' ? { ...s, position: 'SS' as const } : s.position === 'SS' ? { ...s, position: '2B' as const } : s))
    expect(positionSynergies(swapped).middle).toBe(false)
    // 守本職但守備 C：不成立；舊規則（strict = false）只看本職
    const weak = keyFielding(lineup, 6)
    expect(positionSynergies(weak)).toEqual({ middle: false, battery: false })
    expect(positionSynergies(weak, false)).toEqual({ middle: true, battery: true })
  })

  it('裝備的守備加成也算：守備 C 的捕手戴上皮手套就成立', () => {
    const weak = keyFielding(generateRoster(new Rng(4)).lineup, 6)
    const gloved = weak.map((s) => (s.position === 'C' ? { ...s, player: { ...s.player, equipment: ['leatherGlove' as const] } } : s))
    expect(positionSynergies(gloved).battery).toBe(true)
  })

  function setupWith(seed: number, f: (t: Team) => Team, rules?: number) {
    return { home: f(generateTeam(new Rng(seed * 2 + 1))), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide: 'home' as const, rules }
  }
  /** 主隊的二游互換，黃金二遊就不成立 */
  const breakMiddle = (t: Team): Team => ({
    ...t,
    roster: { ...t.roster, lineup: t.roster.lineup.map((s) => ({ ...s, player: { ...s.player, primary: s.position === '2B' ? ('SS' as const) : s.position === 'SS' ? ('2B' as const) : s.player.primary } })) },
  })

  it('黃金二遊讓主隊的雙殺變多；舊規則（版本 7）沒有守位羈絆', () => {
    const rate = (f: (t: Team) => Team, rules?: number) => {
      let dp = 0
      let chances = 0
      for (let seed = 1; seed <= 300; seed++) {
        const g = new Game(setupWith(seed, f, rules))
        while (!g.over) {
          const ready = g.half === 'top' && !!g.bases[0] && g.outs < 2
          for (const e of g.step()) if (ready && e.type === 'play' && (e.kind === 'groundOut' || e.kind === 'doublePlay')) {
            chances++
            if (e.kind === 'doublePlay') dp++
          }
        }
      }
      return dp / chances
    }
    expect(rate(goodKeys)).toBeGreaterThan(rate((t) => breakMiddle(goodKeys(t))) + 0.08)
    const old = new Game(setupWith(1, goodKeys, 7))
    expect(old.synergyLevel(old.teams.home, 'middle')).toBe(0)
    // 規則版本 8 的舊比賽只看本職，守備不到 B 也成立
    const weak = (t: Team): Team => ({ ...t, roster: { ...t.roster, lineup: keyFielding(t.roster.lineup, 5) } })
    const v8 = new Game(setupWith(1, weak, 8))
    expect(v8.synergyLevel(v8.teams.home, 'middle')).toBe(1)
    const v9 = new Game(setupWith(1, weak))
    expect(v9.synergyLevel(v9.teams.home, 'middle')).toBe(0)
  })
})

describe('羈絆促成', () => {
  const all = (a: Archetype) => (t: Team): Team => ({ ...t, roster: { ...t.roster, lineup: withArchetypes(t.roster.lineup, a, 9) } })
  const games = (f: (t: Team) => Team) =>
    Array.from({ length: 200 }, (_, i) => {
      const g = new Game({ home: f(generateTeam(new Rng(i * 2 + 3))), away: generateTeam(new Rng(i * 2 + 4)), seed: i + 1, userSide: 'home' })
      const tagged: GameEvent[] = []
      while (!g.over) for (const e of g.step()) if ((e.type === 'play' || e.type === 'steal') && e.assist) tagged.push(e)
      return { g, tagged }
    })

  it('重砲打線促成的全壘打有記下來，而且不超過力量型的全壘打', () => {
    let credited = 0
    let homers = 0
    for (const { g, tagged } of games(all('power'))) {
      credited += g.synergyLog.home.power?.assists.homeRun ?? 0
      homers += g.synergyStats.home.powerHR
      for (const e of tagged) if (e.type === 'play' && e.assist?.kind === 'homeRun') expect(e.kind).toBe('homeRun')
    }
    expect(credited).toBeGreaterThan(0)
    expect(credited).toBeLessThan(homers)
  })

  it('沒有啟動的羈絆不會有紀錄（9 人分四種流派，一定有一種至少 3 人，這裡讓力量、技巧各 2 人）', () => {
    const neutral = (t: Team): Team => ({ ...t, roster: { ...t.roster, captain: undefined, lineup: t.roster.lineup.map((s, i) => ({ ...s, player: { ...s.player, archetype: (['power', 'power', 'speed', 'speed', 'skill', 'skill', 'defense', 'defense', 'defense'] as const)[i] } })) } })
    for (const { g } of games(neutral).slice(0, 50)) {
      expect(g.synergyLog.home.power).toBeUndefined()
      expect(g.synergyLog.home.skill).toBeUndefined()
    }
  })

  it('換人讓羈絆失效時記下局數', () => {
    const team = (t: Team): Team => ({ ...t, roster: { ...t.roster, captain: undefined, lineup: withArchetypes(t.roster.lineup, 'power', 3), bench: t.roster.bench.map((b) => ({ ...b, archetype: 'skill' as const })) } })
    const g = new Game({ home: team(generateTeam(new Rng(11))), away: generateTeam(new Rng(12)), seed: 5, userSide: 'home' })
    expect(g.synergyLog.home.power?.lostInning).toBeNull()
    g.issue({ type: 'defensiveSub', benchIndex: 0, lineupIndex: 0 })
    expect(g.synergyLog.home.power?.lostInning).toBe(1)
    expect(g.synergyLog.home.power?.peak).toBe(1)
  })
})
