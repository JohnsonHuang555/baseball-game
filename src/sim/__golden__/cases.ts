// Golden Test 的比賽清單：固定種子、隨機產生的雙方陣容、不同規則版本、兩種 AI 配置。
// 加入統計記錄（Phase 8）前後，同一組輸入的事件流、比分、PlayerLine 必須完全一樣。
import { Game, type GameEvent, type GameSetup, type Side } from '../game'
import { generateTeam } from '../generate'
import { Rng } from '../rng'
import type { Pitcher, Team } from '../types'
import { AutoCoach, createPolicy } from '../../v2/application/autoCoach'
import { resolveSetup, type MatchAi } from '../../v2/application/matchRunner'

export interface GoldenCase {
  id: string
  setup: GameSetup
  ai: MatchAi
}

const tired = (team: Team): Team => {
  const weak = (p: Pitcher): Pitcher => ({ ...p, ratings: { ...p.ratings, stamina: 0 } })
  return { ...team, roster: { ...team.roster, starter: weak(team.roster.starter), relievers: team.roster.relievers.map(weak) } }
}

export function goldenCases(): GoldenCase[] {
  const out: GoldenCase[] = []
  for (let seed = 1; seed <= 160; seed++) {
    const rules = [9, 9, 9, 8, 7, 6, 5, 4, 3, 1][seed % 10]
    const userSide: Side = seed % 2 ? 'home' : 'away'
    let home = generateTeam(new Rng(seed * 2 + 1))
    let away = generateTeam(new Rng(seed * 2 + 2))
    if (seed % 7 === 0) {
      home = tired(home)
      away = tired(away)
    }
    const other: Side = userSide === 'home' ? 'away' : 'home'
    const ai = { [userSide]: { kind: 'autoCoach', style: 'balanced' }, [other]: { kind: 'builtin' } } as MatchAi
    out.push({ id: `s${seed}-r${rules}`, setup: { home, away, seed: seed * 7919, userSide, rules }, ai })
  }
  return out
}

/** 跟 runMatchWithGame 一樣打完一整場，另外收集完整的事件流 */
export function playGolden(c: GoldenCase): { game: Game; events: GameEvent[] } {
  const resolved = resolveSetup(c.setup, c.ai)
  const game = new Game(resolved)
  const coach = new AutoCoach(createPolicy('balanced'))
  const events: GameEvent[] = []
  while (!game.over) {
    events.push(...coach.act(game))
    events.push(...game.step())
  }
  return { game, events }
}

export function fnv(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/** 一場比賽的指紋：比分、局數、步數、記分板、事件流、教練指令、舊的 PlayerLine */
export function goldenPrint(c: GoldenCase): Record<string, unknown> {
  const { game, events } = playGolden(c)
  return {
    score: `${game.score.away}:${game.score.home}`,
    innings: game.inning,
    steps: game.stepIndex,
    he: `${game.hits.away}/${game.hits.home} ${game.errors.away}/${game.errors.home}`,
    events: fnv(JSON.stringify(events)),
    commands: fnv(JSON.stringify(game.commands)),
    box: fnv(JSON.stringify(Object.entries(game.box).sort(([a], [b]) => (a < b ? -1 : 1)))),
  }
}
