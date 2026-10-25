import type { Command, GameSetup } from './game'
import { BASE_MEAN, generateBatter, generatePitcher, generateRoster, teamName } from './generate'
import { Rng } from './rng'
import { createSetup, isPitcherSlot, setSlot, type PregameSetup, type Slot } from './setup'
import type { Player, Roster, Team } from './types'

export const ROUNDS = ['r16', 'qf', 'sf', 'final'] as const
export type Round = (typeof ROUNDS)[number]

/** 每一輪 AI 對手的能力值中心比玩家高多少 */
export const ROUND_DIFFICULTY: Record<Round, number> = { r16: 0, qf: 0.25, sf: 0.5, final: 0.75 }
export const FINAL_WINS_NEEDED = 2
export const DRAFT_SIZE = 3
const TEAM_COUNT = 16

export type TournamentPhase = 'pregame' | 'ready' | 'playing' | 'draft' | 'champion' | 'eliminated'

export interface GameRecord {
  round: Round
  userRuns: number
  opponentRuns: number
  won: boolean
}

/** AI 之間的比賽結果，開賽時就決定好 */
export interface AiMatch {
  round: number
  a: number
  b: number
  winner: number
}

/** 進行中的比賽：種子加指令紀錄就能重播回來（ADR-0001） */
export interface SavedGame {
  setup: GameSetup
  commands: Command[]
  stepIndex: number
}

/** 整個錦標賽的狀態，只含純資料，可以直接存成 JSON */
export interface Tournament {
  phase: TournamentPhase
  rngState: number
  /** 玩家的隊伍與剩餘重骰次數；開打後重骰次數不再使用 */
  setup: PregameSetup
  /** 賽程樹上的 16 隊，第 0 隊是玩家 */
  teamNames: string[]
  /** opponents[r]：第 r 輪的對手在 teamNames 的索引 */
  opponents: number[]
  aiMatches: AiMatch[]
  roundIndex: number
  opponent: Team
  series: { user: number; opponent: number }
  history: GameRecord[]
  draftOptions: Player[]
  currentGame: SavedGame | null
}

export function createTournament(seed: number): Tournament {
  const rng = new Rng(seed)
  const setup = createSetup(rng.int(0, 2 ** 32 - 1))
  const teamNames = [setup.team.name]
  while (teamNames.length < TEAM_COUNT) {
    const name = teamName(rng)
    if (!teamNames.includes(name)) teamNames.push(name)
  }

  // 玩家以外的半區，勝負事先決定。第 r 輪的對手來自 [2^r, 2^(r+1)) 這個半區
  const aiMatches: AiMatch[] = []
  const blockWinner = (lo: number, hi: number, round: number): number => {
    if (hi - lo === 1) return lo
    const mid = (lo + hi) / 2
    const a = blockWinner(lo, mid, round - 1)
    const b = blockWinner(mid, hi, round - 1)
    const winner = rng.chance(0.5) ? a : b
    aiMatches.push({ round, a, b, winner })
    return winner
  }
  const opponents = ROUNDS.map((_, r) => blockWinner(2 ** r, 2 ** (r + 1), r - 1))

  const t: Tournament = {
    phase: 'pregame',
    rngState: rng.state,
    setup,
    teamNames,
    opponents,
    aiMatches,
    roundIndex: 0,
    opponent: { name: '', roster: setup.team.roster },
    series: { user: 0, opponent: 0 },
    history: [],
    draftOptions: [],
    currentGame: null,
  }
  return withOpponent(t)
}

export function currentRound(t: Tournament): Round {
  return ROUNDS[t.roundIndex]
}

function withOpponent(t: Tournament): Tournament {
  const rng = new Rng(t.rngState)
  const round = ROUNDS[t.roundIndex]
  const roster = generateRoster(rng, BASE_MEAN + ROUND_DIFFICULTY[round])
  const opponent = { name: t.teamNames[t.opponents[t.roundIndex]], roster }
  return { ...t, opponent, rngState: rng.state }
}

function expectPhase(t: Tournament, ...phases: TournamentPhase[]): void {
  if (!phases.includes(t.phase)) throw new Error(`錦標賽目前是 ${t.phase}，不能這樣做`)
}

/** 開打前的重骰；開打後就不能再重骰 */
export function updateSetup(t: Tournament, setup: PregameSetup): Tournament {
  expectPhase(t, 'pregame')
  const name = setup.team.name
  if (name === t.teamNames[0]) return { ...t, setup }
  // 玩家自訂的隊名撞到 AI 隊伍時，AI 隊伍換名字
  const rng = new Rng(t.rngState)
  const teamNames = [name, ...t.teamNames.slice(1)]
  for (let i = 1; i < teamNames.length; i++) {
    while (teamNames.indexOf(teamNames[i]) !== i) teamNames[i] = teamName(rng)
  }
  const opponent = { ...t.opponent, name: teamNames[t.opponents[t.roundIndex]] }
  return { ...t, setup, teamNames, opponent, rngState: rng.state }
}

/** 陣容調整：打序、先發投手、板凳互換，不增減球員 */
export function updateRoster(t: Tournament, roster: Roster): Tournament {
  expectPhase(t, 'pregame', 'ready')
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

export function startTournament(t: Tournament): Tournament {
  expectPhase(t, 'pregame')
  return { ...t, phase: 'ready' }
}

export function beginGame(t: Tournament): Tournament {
  expectPhase(t, 'ready')
  const rng = new Rng(t.rngState)
  const setup: GameSetup = {
    home: t.setup.team,
    away: t.opponent,
    seed: rng.int(0, 2 ** 32 - 1),
    userSide: 'home',
  }
  return { ...t, phase: 'playing', rngState: rng.state, currentGame: { setup, commands: [], stepIndex: 0 } }
}

export function saveProgress(t: Tournament, commands: readonly Command[], stepIndex: number): Tournament {
  expectPhase(t, 'playing')
  return { ...t, currentGame: { ...t.currentGame!, commands: [...commands], stepIndex } }
}

export function finishGame(t: Tournament, score: { home: number; away: number }): Tournament {
  expectPhase(t, 'playing')
  const round = currentRound(t)
  const won = score.home > score.away
  const history = [...t.history, { round, userRuns: score.home, opponentRuns: score.away, won }]
  const base = { ...t, history, currentGame: null }
  if (round === 'final') {
    const series = { user: t.series.user + (won ? 1 : 0), opponent: t.series.opponent + (won ? 0 : 1) }
    if (series.user >= FINAL_WINS_NEEDED) return { ...base, series, phase: 'champion' }
    if (series.opponent >= FINAL_WINS_NEEDED) return { ...base, series, phase: 'eliminated' }
    return { ...base, series, phase: 'ready' }
  }
  if (!won) return { ...base, phase: 'eliminated' }
  return withDraftOptions({ ...base, phase: 'draft' })
}

function withDraftOptions(t: Tournament): Tournament {
  const rng = new Rng(t.rngState)
  const nextRound = ROUNDS[t.roundIndex + 1]
  // 選秀球員略強於基準，讓補強有意義，但不追上當輪對手
  const mean = BASE_MEAN + ROUND_DIFFICULTY[nextRound] * 0.5
  const draftOptions = Array.from({ length: DRAFT_SIZE }, () =>
    rng.chance(0.3) ? generatePitcher(rng, mean) : generateBatter(rng, mean),
  )
  return { ...t, draftOptions, rngState: rng.state }
}

/** 選秀：選中的球員取代同角色的一格，原本的球員釋出 */
export function draftPick(t: Tournament, optionIndex: number, release: Slot): Tournament {
  expectPhase(t, 'draft')
  const pick = t.draftOptions[optionIndex]
  if (!pick) throw new Error('沒有這個選秀選項')
  if ((pick.role === 'pitcher') !== isPitcherSlot(release)) throw new Error('只能替換同角色的球員')
  const roster = setSlot(t.setup.team.roster, release, pick)
  return advanceRound({ ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } })
}

export function skipDraft(t: Tournament): Tournament {
  expectPhase(t, 'draft')
  return advanceRound(t)
}

function advanceRound(t: Tournament): Tournament {
  return withOpponent({ ...t, phase: 'ready', draftOptions: [], roundIndex: t.roundIndex + 1 })
}

export interface BracketMatch {
  a: number
  b: number
  /** 還沒打完是 null */
  winner: number | null
}

/** 每一輪的對戰組合，給畫面顯示賽程樹用 */
export function bracket(t: Tournament): BracketMatch[][] {
  return ROUNDS.map((round, r) => {
    const userMatch: BracketMatch = { a: 0, b: t.opponents[r], winner: null }
    const reached = r <= t.roundIndex
    const games = t.history.filter((h) => h.round === round)
    if (round === 'final') {
      const wins = games.filter((g) => g.won).length
      const losses = games.length - wins
      if (wins >= FINAL_WINS_NEEDED) userMatch.winner = 0
      else if (losses >= FINAL_WINS_NEEDED) userMatch.winner = t.opponents[r]
    } else if (games.length > 0) {
      userMatch.winner = games[0].won ? 0 : t.opponents[r]
    }
    // 玩家出局後，對手繼續晉級；更後面的輪次就不再顯示玩家
    const ai = t.aiMatches.filter((m) => m.round === r).map(({ a, b, winner }) => ({ a, b, winner }))
    return reached ? [userMatch, ...ai] : ai
  })
}
