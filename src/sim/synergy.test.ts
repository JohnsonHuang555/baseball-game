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

  it('門檻秘寶讓 2 人啟動、4 人升級；隊長臂章讓隊長算三人', () => {
    expect(thresholds('speed', ['runSchool'])).toEqual([2, 4])
    expect(thresholds('power', ['runSchool'])).toEqual([3, 5])
    const lineup = withArchetypes(base, 'speed', 3)
    expect(archetypeCounts(lineup, lineup[0].player.id, ['captainBand']).speed).toBe(5)
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

describe('守位羈絆', () => {
  it('二壘、游擊都守本職才有黃金二遊；捕手守本職就有投捕搭檔', () => {
    const lineup = generateRoster(new Rng(4)).lineup
    expect(positionSynergies(lineup)).toEqual({ middle: true, battery: true })
    const swapped = lineup.map((s) => (s.position === '2B' ? { ...s, position: 'SS' as const } : s.position === 'SS' ? { ...s, position: '2B' as const } : s))
    expect(positionSynergies(swapped).middle).toBe(false)
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
    expect(rate((t) => t)).toBeGreaterThan(rate(breakMiddle) + 0.08)
    expect(new Game(setupWith(1, (t) => t, 7)).synergyLevel(new Game(setupWith(1, (t) => t, 7)).teams.home, 'middle')).toBe(0)
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
