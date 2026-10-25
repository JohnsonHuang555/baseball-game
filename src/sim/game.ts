import { Rng, clamp } from './rng'
import { hasTrait } from './traits'
import type { Batter, LineupSpot, Pitcher, Player, Team } from './types'

export type Side = 'home' | 'away'
export type Half = 'top' | 'bottom'
/** 1 = 一壘、2 = 二壘、3 = 三壘 */
export type BaseNumber = 1 | 2 | 3

export type Tactic =
  | { type: 'steal'; from: 1 | 2 }
  | { type: 'bunt' }
  | { type: 'hitAndRun' }
  | { type: 'pinchHit'; benchIndex: number }
  | { type: 'pinchRun'; base: BaseNumber; benchIndex: number }
  | { type: 'changePitcher'; relieverIndex: number }
  | { type: 'intentionalWalk' }

export type PitchResult = 'ball' | 'calledStrike' | 'swingingStrike' | 'foul' | 'inPlay'

export type PlayKind =
  | 'single'
  | 'double'
  | 'triple'
  | 'homeRun'
  | 'groundOut'
  | 'doublePlay'
  | 'flyOut'
  | 'sacrificeFly'
  | 'lineOut'
  | 'strikeout'
  | 'walk'
  | 'intentionalWalk'
  | 'sacrificeBunt'
  | 'buntPopOut'

/** from：0 = 打者；to：4 = 回本壘得分 */
export interface RunnerMove {
  runnerId: string
  from: 0 | BaseNumber
  to: BaseNumber | 4 | 'out'
}

export interface BattedBall {
  type: 'ground' | 'fly' | 'line'
  /** 角度：0 為中外野方向，負數偏左外野，正數偏右外野，界內為 ±45 度 */
  angle: number
  /** 落點距離本壘的英呎數 */
  distance: number
}

export type GameEvent =
  | { type: 'pitch'; result: PitchResult; balls: number; strikes: number }
  | { type: 'play'; kind: PlayKind; batterId: string; ball: BattedBall | null; moves: RunnerMove[]; runs: number }
  | { type: 'steal'; runnerId: string; from: 1 | 2; success: boolean; moves: RunnerMove[] }
  | { type: 'substitution'; side: Side; kind: 'pinchHit' | 'pinchRun' | 'pitcher'; inId: string; outId: string }
  | { type: 'halfInningEnd'; inning: number; half: Half }
  | { type: 'gameOver'; winner: Side }

export type DecisionReason = 'leverage' | 'fatigue'

export interface GameSetup {
  home: Team
  away: Team
  seed: number
  userSide: Side
}

/** 教練指令紀錄：在第 stepIndex 步之前下達。種子加上這份紀錄就能重現整場比賽。 */
export interface Command {
  stepIndex: number
  tactic: Tactic
}

export interface TeamState {
  name: string
  lineup: LineupSpot[]
  bench: Batter[]
  pitcher: Pitcher
  relievers: Pitcher[]
  pitchCount: number
  battingIndex: number
}

type Bases = [Batter | null, Batter | null, Batter | null]

export const LEVERAGE_THRESHOLD = 3.2

export class Game {
  readonly userSide: Side
  inning = 1
  half: Half = 'top'
  outs = 0
  balls = 0
  strikes = 0
  bases: Bases = [null, null, null]
  score: Record<Side, number> = { home: 0, away: 0 }
  linescore: Record<Side, number[]> = { home: [], away: [0] }
  teams: Record<Side, TeamState>
  over = false
  winner: Side | null = null
  /** step() 被呼叫的次數 */
  stepIndex = 0
  /** 第幾個打席，從 0 開始 */
  paIndex = 0
  queued: Tactic | null = null
  readonly commands: Command[] = []
  private readonly rng: Rng
  private readonly players = new Map<string, Player>()

  constructor(setup: GameSetup) {
    this.userSide = setup.userSide
    this.rng = new Rng(setup.seed)
    this.teams = { home: this.teamState(setup.home), away: this.teamState(setup.away) }
  }

  private teamState(team: Team): TeamState {
    const { roster } = team
    for (const p of [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]) {
      this.players.set(p.id, p)
    }
    return {
      name: team.name,
      lineup: roster.lineup.map((s) => ({ ...s })),
      bench: [...roster.bench],
      pitcher: roster.starter,
      relievers: [...roster.relievers],
      pitchCount: 0,
      battingIndex: 0,
    }
  }

  // ---- 查詢 ----

  player(id: string): Player | undefined {
    return this.players.get(id)
  }

  get battingSide(): Side {
    return this.half === 'top' ? 'away' : 'home'
  }

  get fieldingSide(): Side {
    return this.half === 'top' ? 'home' : 'away'
  }

  get batting(): TeamState {
    return this.teams[this.battingSide]
  }

  get fielding(): TeamState {
    return this.teams[this.fieldingSide]
  }

  get batter(): Batter {
    return this.batting.lineup[this.batting.battingIndex].player
  }

  get pitcher(): Pitcher {
    return this.fielding.pitcher
  }

  fatigueLimit(p: Pitcher): number {
    return 50 + p.ratings.stamina * 8 + (hasTrait(p, 'ironArm') ? 40 : 0)
  }

  isFatigued(team: TeamState): boolean {
    return team.pitchCount >= this.fatigueLimit(team.pitcher)
  }

  /** 槓桿指數：越高代表這個時刻越能左右勝負 */
  leverage(): number {
    const diff = Math.abs(this.score.home - this.score.away)
    let li = 1
    if (this.inning >= 7) li += 0.6
    if (this.inning >= 9) li += 0.6
    if (diff === 0) li += 1
    else if (diff === 1) li += 0.8
    else if (diff === 2) li += 0.4
    else if (diff >= 5) li -= 1.5
    const runners = this.bases.filter(Boolean).length
    li += runners * 0.35
    if (this.bases[1] || this.bases[2]) li += 0.3
    return li
  }

  /** 打席開始時，是否該暫停讓教練下指令（只看狀態，不影響模擬） */
  decisionReasons(): DecisionReason[] {
    if (this.over || this.balls + this.strikes > 0) return []
    const reasons: DecisionReason[] = []
    const userFielding = this.fieldingSide === this.userSide
    if (userFielding && this.isFatigued(this.fielding) && this.fielding.relievers.length > 0) reasons.push('fatigue')
    if (this.leverage() >= LEVERAGE_THRESHOLD && this.availableTactics().length > 0) reasons.push('leverage')
    return reasons
  }

  /** 教練現在可以下的指令 */
  availableTactics(): Tactic[] {
    if (this.over) return []
    const tactics: Tactic[] = []
    const [b1, b2, b3] = this.bases
    if (this.battingSide === this.userSide) {
      const bench = this.batting.bench
      if (b1 && !b2) tactics.push({ type: 'steal', from: 1 })
      if (b2 && !b3) tactics.push({ type: 'steal', from: 2 })
      if (this.outs < 2 && (b1 || b2 || b3)) tactics.push({ type: 'bunt' })
      if (b1 && !b2 && this.outs < 2) tactics.push({ type: 'hitAndRun' })
      bench.forEach((_, benchIndex) => tactics.push({ type: 'pinchHit', benchIndex }))
      ;([1, 2, 3] as const).forEach((base) => {
        if (this.bases[base - 1]) bench.forEach((_, benchIndex) => tactics.push({ type: 'pinchRun', base, benchIndex }))
      })
    } else {
      this.fielding.relievers.forEach((_, relieverIndex) => tactics.push({ type: 'changePitcher', relieverIndex }))
      if (this.balls + this.strikes === 0) tactics.push({ type: 'intentionalWalk' })
    }
    return tactics
  }

  // ---- 教練指令 ----

  /** 下達指令。換人類立即生效；盜壘、觸擊、打帶跑在下一步執行。 */
  issue(tactic: Tactic): GameEvent[] {
    if (!this.availableTactics().some((t) => sameTactic(t, tactic))) throw new Error(`現在不能下這個指令：${tactic.type}`)
    this.commands.push({ stepIndex: this.stepIndex, tactic })
    switch (tactic.type) {
      case 'steal':
      case 'bunt':
      case 'hitAndRun':
        this.queued = tactic
        return []
      case 'pinchHit': {
        const team = this.batting
        const spot = team.lineup[team.battingIndex]
        const out = spot.player
        spot.player = team.bench.splice(tactic.benchIndex, 1)[0]
        return [{ type: 'substitution', side: this.battingSide, kind: 'pinchHit', inId: spot.player.id, outId: out.id }]
      }
      case 'pinchRun': {
        const team = this.batting
        const runner = this.bases[tactic.base - 1]!
        const spot = team.lineup.find((s) => s.player.id === runner.id)!
        spot.player = team.bench.splice(tactic.benchIndex, 1)[0]
        this.bases[tactic.base - 1] = spot.player
        return [{ type: 'substitution', side: this.battingSide, kind: 'pinchRun', inId: spot.player.id, outId: runner.id }]
      }
      case 'changePitcher':
        return this.changePitcher(this.fielding, this.fieldingSide, tactic.relieverIndex)
      case 'intentionalWalk':
        this.fielding.pitchCount += 4
        return this.walk('intentionalWalk')
    }
  }

  private changePitcher(team: TeamState, side: Side, relieverIndex: number): GameEvent[] {
    const out = team.pitcher
    team.pitcher = team.relievers.splice(relieverIndex, 1)[0]
    team.pitchCount = 0
    return [{ type: 'substitution', side, kind: 'pitcher', inId: team.pitcher.id, outId: out.id }]
  }

  // ---- 推進 ----

  /** 推進一步：通常是一球，或是一次盜壘 */
  step(): GameEvent[] {
    if (this.over) return []
    const events: GameEvent[] = []
    // AI 在打席開始時換下累過頭的投手
    if (this.fieldingSide !== this.userSide && this.balls + this.strikes === 0) {
      const team = this.fielding
      if (team.relievers.length > 0 && team.pitchCount >= this.fatigueLimit(team.pitcher) + 10) {
        events.push(...this.changePitcher(team, this.fieldingSide, 0))
      }
    }
    const tactic = this.queued
    this.queued = null
    if (tactic?.type === 'steal') events.push(...this.steal(tactic.from, 0))
    else if (tactic?.type === 'bunt') events.push(...this.bunt())
    else events.push(...this.pitch(tactic?.type === 'hitAndRun'))
    this.stepIndex++
    return events
  }

  private pitch(hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const pitcher = this.pitcher
    const { stuff, control } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const twoStrikes = this.strikes === 2
    this.fielding.pitchCount++

    const zoneP = clamp(0.5 + (control - 5) * 0.035 - (hasTrait(pitcher, 'wild') ? 0.08 : 0), 0.3, 0.72)
    const inZone = rng.chance(zoneP)
    const swingP = inZone
      ? 0.65 + (twoStrikes ? 0.15 : 0)
      : 0.32 + (twoStrikes ? 0.12 : 0) - (hasTrait(batter, 'eye') ? 0.12 : 0) - (this.balls === 3 ? 0.05 : 0)
    const swing = hitAndRun || rng.chance(swingP)

    let result: PitchResult
    if (!swing) {
      result = inZone ? 'calledStrike' : 'ball'
    } else {
      const contactP = clamp(
        (inZone ? 0.8 : 0.55) +
          (contact - stuff) * 0.03 -
          (hasTrait(batter, 'freeSwinger') ? 0.08 : 0) -
          (hasTrait(pitcher, 'strikeoutArtist') ? 0.06 : 0),
        0.3,
        0.95,
      )
      if (!rng.chance(contactP)) result = 'swingingStrike'
      else if (rng.chance(0.42)) result = 'foul'
      else result = 'inPlay'
    }

    if (result === 'inPlay') {
      return [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes }, ...this.ballInPlay(hitAndRun)]
    }
    if (result === 'ball') this.balls++
    else if (result === 'foul') this.strikes = Math.min(2, this.strikes + 1)
    else this.strikes++
    const events: GameEvent[] = [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes }]

    if (this.balls === 4) return [...events, ...this.walk('walk')]
    if (this.strikes === 3) {
      events.push(...this.finishPlay('strikeout', null, [{ runnerId: batter.id, from: 0, to: 'out' }]))
    }
    // 打帶跑沒打到球：跑者照樣起跑，成功率較低
    if (hitAndRun && result !== 'foul' && !this.over && this.outs < 3 && this.bases[0] && !this.bases[1]) {
      events.push(...this.steal(1, 0.08))
    }
    return events
  }

  private effectivePitcher(): { stuff: number; control: number } {
    const team = this.fielding
    const p = team.pitcher
    const over = Math.max(0, team.pitchCount - this.fatigueLimit(p))
    const penalty = (over / 15) * (hasTrait(p, 'ironArm') ? 0.5 : 1)
    return { stuff: p.ratings.stuff - penalty, control: p.ratings.control - penalty }
  }

  private effectiveContact(b: Batter): number {
    let k = b.ratings.contact
    if (this.bases[1] || this.bases[2]) {
      if (hasTrait(b, 'clutch')) k += 2
      if (hasTrait(b, 'clutchBad')) k -= 2
    }
    return k
  }

  private ballInPlay(hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const { stuff } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const { power, speed } = batter.ratings
    const hitP = clamp(0.33 + (contact - 5) * 0.018 - (stuff - 5) * 0.012 + (speed - 5) * 0.005, 0.15, 0.5)

    if (rng.chance(hitP)) {
      const kind = rng.weighted<PlayKind>([
        ['homeRun', Math.max(0.02, 0.1 + (power - 5) * 0.035 + (hasTrait(batter, 'slugger') ? 0.08 : 0))],
        ['triple', Math.max(0.005, 0.025 + (speed - 5) * 0.006)],
        ['double', Math.max(0.08, 0.2 + (power - 5) * 0.02)],
        ['single', 0.65],
      ])
      return this.hit(kind, hitAndRun)
    }
    const type = rng.weighted<BattedBall['type']>([
      ['ground', 0.45],
      ['fly', 0.4 + (power - 5) * 0.02],
      ['line', 0.15],
    ])
    if (type === 'ground') return this.groundOut(hitAndRun)
    if (type === 'fly') return this.flyOut()
    return this.lineOut(hitAndRun)
  }

  private hit(kind: PlayKind, hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const [b1, b2, b3] = this.bases
    const moves: RunnerMove[] = []
    const taken = new Set<number>()
    const move = (runner: Batter, from: 0 | BaseNumber, to: BaseNumber | 4) => {
      moves.push({ runnerId: runner.id, from, to })
      if (to !== 4) taken.add(to)
    }
    const spd = (b: Batter) => b.ratings.speed - 5
    let ball: BattedBall
    switch (kind) {
      case 'homeRun':
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 4)
        ball = { type: 'fly', angle: clamp(rng.normal(0, 25), -43, 43), distance: rng.range(380, 450) }
        break
      case 'triple':
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 3)
        ball = { type: 'line', angle: rng.pick([-1, 1]) * rng.range(25, 42), distance: rng.range(330, 390) }
        break
      case 'double':
        if (b3) move(b3, 3, 4)
        if (b2) move(b2, 2, 4)
        if (b1) move(b1, 1, rng.chance(0.35 + spd(b1) * 0.05 + (hitAndRun ? 0.3 : 0)) ? 4 : 3)
        move(batter, 0, 2)
        ball = { type: 'line', angle: rng.pick([-1, 1]) * rng.range(12, 40), distance: rng.range(260, 360) }
        break
      default: {
        if (b3) move(b3, 3, 4)
        if (b2) move(b2, 2, rng.chance(0.55 + spd(b2) * 0.06) ? 4 : 3)
        if (b1) {
          const extra = !taken.has(3) && (hitAndRun || rng.chance(0.25 + spd(b1) * 0.04))
          move(b1, 1, extra ? 3 : 2)
        }
        move(batter, 0, 1)
        const ground = rng.chance(0.5)
        ball = ground
          ? { type: 'ground', angle: clamp(rng.normal(0, 25), -40, 40), distance: rng.range(130, 170) }
          : { type: 'line', angle: clamp(rng.normal(0, 25), -40, 40), distance: rng.range(160, 240) }
      }
    }
    return this.finishPlay(kind, ball, moves)
  }

  private groundOut(hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const [b1, b2, b3] = this.bases
    const ball: BattedBall = { type: 'ground', angle: clamp(rng.normal(0, 22), -42, 42), distance: rng.range(60, 125) }
    const dpP = 0.45 - (batter.ratings.speed - 5) * 0.04
    if (b1 && this.outs < 2 && !hitAndRun && rng.chance(dpP)) {
      const moves: RunnerMove[] = [
        { runnerId: b1.id, from: 1, to: 'out' },
        { runnerId: batter.id, from: 0, to: 'out' },
      ]
      if (b2) moves.push({ runnerId: b2.id, from: 2, to: 3 })
      if (b3) moves.push({ runnerId: b3.id, from: 3, to: b2 ? 4 : rng.chance(0.5) ? 4 : 3 })
      return this.finishPlay('doublePlay', ball, moves)
    }
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    // 被迫進壘的跑者一定往前；沒被迫的看情況
    const forced2 = !!b1
    const forced3 = forced2 && !!b2
    const forcedHome = forced3 && !!b3
    if (b3) moves.push({ runnerId: b3.id, from: 3, to: forcedHome || (this.outs < 2 && rng.chance(0.45)) ? 4 : 3 })
    const thirdFree = !moves.some((m) => m.to === 3)
    if (b2) moves.push({ runnerId: b2.id, from: 2, to: forced3 || (thirdFree && rng.chance(0.5)) ? 3 : 2 })
    if (b1) moves.push({ runnerId: b1.id, from: 1, to: 2 })
    return this.finishPlay('groundOut', ball, moves)
  }

  private flyOut(): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const [, b2, b3] = this.bases
    const ball: BattedBall = { type: 'fly', angle: clamp(rng.normal(0, 25), -43, 43), distance: rng.range(180, 370) }
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    let kind: PlayKind = 'flyOut'
    if (this.outs < 2) {
      if (b3 && ball.distance > 230 && rng.chance(0.5 + (b3.ratings.speed - 5) * 0.05)) {
        moves.push({ runnerId: b3.id, from: 3, to: 4 })
        kind = 'sacrificeFly'
      }
      // 三壘有人沒跑，二壘跑者就不能推進
      if (b2 && (kind === 'sacrificeFly' || !b3) && rng.chance(0.3)) {
        moves.push({ runnerId: b2.id, from: 2, to: 3 })
      }
    }
    return this.finishPlay(kind, ball, moves)
  }

  private lineOut(hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const ball: BattedBall = { type: 'line', angle: clamp(rng.normal(0, 25), -42, 42), distance: rng.range(90, 260) }
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    // 打帶跑遇到平飛球，一壘跑者容易被雙殺
    const b1 = this.bases[0]
    if (hitAndRun && b1 && this.outs < 2 && rng.chance(0.5)) {
      moves.push({ runnerId: b1.id, from: 1, to: 'out' })
      return this.finishPlay('doublePlay', ball, moves)
    }
    return this.finishPlay('lineOut', ball, moves)
  }

  private walk(kind: 'walk' | 'intentionalWalk'): GameEvent[] {
    const [b1, b2, b3] = this.bases
    const moves: RunnerMove[] = [{ runnerId: this.batter.id, from: 0, to: 1 }]
    if (b1) {
      moves.push({ runnerId: b1.id, from: 1, to: 2 })
      if (b2) {
        moves.push({ runnerId: b2.id, from: 2, to: 3 })
        if (b3) moves.push({ runnerId: b3.id, from: 3, to: 4 })
      }
    }
    return this.finishPlay(kind, null, moves)
  }

  private bunt(): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    this.fielding.pitchCount++
    const successP = clamp(0.65 + (hasTrait(batter, 'bunter') ? 0.2 : 0) + (batter.ratings.contact - 5) * 0.02, 0.3, 0.95)
    const ball: BattedBall = { type: 'ground', angle: rng.range(-30, 30), distance: rng.range(20, 45) }
    if (rng.chance(successP)) {
      const [b1, b2, b3] = this.bases
      const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
      if (b3) moves.push({ runnerId: b3.id, from: 3, to: 4 })
      if (b2) moves.push({ runnerId: b2.id, from: 2, to: 3 })
      if (b1) moves.push({ runnerId: b1.id, from: 1, to: 2 })
      return this.finishPlay('sacrificeBunt', ball, moves)
    }
    if (rng.chance(0.5)) {
      // 觸擊成界外球，兩好球時觸擊界外算三振
      this.strikes++
      const events: GameEvent[] = [{ type: 'pitch', result: 'foul', balls: this.balls, strikes: this.strikes }]
      if (this.strikes === 3) {
        events.push(...this.finishPlay('strikeout', null, [{ runnerId: batter.id, from: 0, to: 'out' }]))
      }
      return events
    }
    return this.finishPlay('buntPopOut', { ...ball, type: 'fly' }, [{ runnerId: batter.id, from: 0, to: 'out' }])
  }

  /** 盜壘。penalty 用於打帶跑揮空時降低成功率 */
  private steal(from: 1 | 2, penalty: number): GameEvent[] {
    const runner = this.bases[from - 1]
    if (!runner || this.bases[from]) return []
    const successP = clamp(
      0.55 + (runner.ratings.speed - 5) * 0.06 + (hasTrait(runner, 'stealer') ? 0.15 : 0) - penalty,
      0.1,
      0.95,
    )
    const success = this.rng.chance(successP)
    const moves: RunnerMove[] = [{ runnerId: runner.id, from, to: success ? ((from + 1) as BaseNumber) : 'out' }]
    this.applyMoves(moves)
    const events: GameEvent[] = [{ type: 'steal', runnerId: runner.id, from, success, moves }]
    if (this.outs >= 3) events.push(...this.endHalfInning())
    return events
  }

  // ---- 結算 ----

  /** 回傳得分數。第三個出局發生的那一球，跑者的得分不算。 */
  private applyMoves(moves: RunnerMove[]): number {
    const outsAdded = moves.filter((m) => m.to === 'out').length
    const runsCount = this.outs + outsAdded < 3
    const next: Bases = [...this.bases]
    for (const m of moves) if (m.from > 0) next[m.from - 1] = null
    let runs = 0
    for (const m of moves) {
      const runner = m.from === 0 ? this.batter : this.bases[m.from - 1]!
      if (m.to === 4) runs += runsCount ? 1 : 0
      else if (m.to !== 'out') next[m.to - 1] = runner
    }
    this.bases = next
    this.outs += outsAdded
    if (runs > 0) {
      const side = this.battingSide
      this.score[side] += runs
      const line = this.linescore[side]
      line[line.length - 1] += runs
    }
    return runs
  }

  /** 打席結束：套用跑壘、換下一棒、檢查再見或半局結束 */
  private finishPlay(kind: PlayKind, ball: BattedBall | null, moves: RunnerMove[]): GameEvent[] {
    const batterId = this.batter.id
    const runs = this.applyMoves(moves)
    const events: GameEvent[] = [{ type: 'play', kind, batterId, ball, moves, runs }]
    const team = this.batting
    team.battingIndex = (team.battingIndex + 1) % 9
    this.balls = 0
    this.strikes = 0
    this.paIndex++
    if (this.half === 'bottom' && this.inning >= 9 && this.score.home > this.score.away) {
      return [...events, this.endGame('home')]
    }
    if (this.outs >= 3) events.push(...this.endHalfInning())
    return events
  }

  private endHalfInning(): GameEvent[] {
    const events: GameEvent[] = [{ type: 'halfInningEnd', inning: this.inning, half: this.half }]
    this.outs = 0
    this.balls = 0
    this.strikes = 0
    this.bases = [null, null, null]
    this.queued = null
    if (this.half === 'top') {
      if (this.inning >= 9 && this.score.home > this.score.away) return [...events, this.endGame('home')]
      this.half = 'bottom'
      this.linescore.home.push(0)
    } else {
      if (this.inning >= 9 && this.score.home !== this.score.away) {
        return [...events, this.endGame(this.score.home > this.score.away ? 'home' : 'away')]
      }
      this.half = 'top'
      this.inning++
      this.linescore.away.push(0)
    }
    // 延長賽突破僵局制：上一棒站上二壘
    if (this.inning >= 10) {
      const team = this.batting
      this.bases[1] = team.lineup[(team.battingIndex + 8) % 9].player
    }
    return events
  }

  private endGame(winner: Side): GameEvent {
    this.over = true
    this.winner = winner
    return { type: 'gameOver', winner }
  }
}

export function sameTactic(a: Tactic, b: Tactic): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 用同樣的設定和指令紀錄重播比賽。給 steps 就只推進到那一步。 */
export function replay(setup: GameSetup, commands: readonly Command[], steps = Infinity): Game {
  const game = new Game(setup)
  let c = 0
  while (!game.over && game.stepIndex < steps) {
    while (c < commands.length && commands[c].stepIndex === game.stepIndex) game.issue(commands[c++].tactic)
    game.step()
  }
  while (c < commands.length && commands[c].stepIndex === game.stepIndex && !game.over) game.issue(commands[c++].tactic)
  return game
}
