import { Rng, clamp } from './rng'
import { hasTrait } from './traits'
import type { Batter, LineupSpot, Pitcher, Player, Team, Tendency } from './types'

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
  /** 守備替補：板凳球員接手某一棒的守位與棒次 */
  | { type: 'defensiveSub'; benchIndex: number; lineupIndex: number }
  /** 親自出棒：下一球一定揮棒，timing 是計量條停下的位置（0～1） */
  | { type: 'swing'; timing: number }
  /** 決勝球：下一球由教練親自投，timing 是計量條停下的位置（0～1） */
  | { type: 'aimPitch'; timing: number }
  /** 守備佈陣：只對目前這位打者有效，打席結束恢復標準 */
  | { type: 'alignment'; alignment: Alignment }

/** 守備佈陣：標準、偏左、偏右、內野前進、外野後退 */
export type Alignment = 'normal' | 'shiftLeft' | 'shiftRight' | 'infieldIn' | 'outfieldBack'
export const ALIGNMENTS: readonly Alignment[] = ['normal', 'shiftLeft', 'shiftRight', 'infieldIn', 'outfieldBack']

/** 野手站位 [角度, 距離英呎]：角度 0 為中外野方向，負數偏左外野 */
export type Spots = Record<'1B' | '2B' | 'SS' | '3B' | 'LF' | 'CF' | 'RF', [number, number]>
const NORMAL_SPOTS: Spots = {
  '1B': [38, 105],
  '2B': [14, 145],
  SS: [-14, 145],
  '3B': [-38, 105],
  LF: [-28, 285],
  CF: [0, 315],
  RF: [28, 285],
}
const SHIFT_LEFT_SPOTS: Spots = {
  '1B': [30, 110],
  '2B': [-6, 140],
  SS: [-26, 140],
  '3B': [-40, 105],
  LF: [-34, 280],
  CF: [-10, 315],
  RF: [18, 290],
}
const mirror = (spots: Spots): Spots => ({
  '1B': [-spots['3B'][0], spots['3B'][1]],
  '2B': [-spots.SS[0], spots.SS[1]],
  SS: [-spots['2B'][0], spots['2B'][1]],
  '3B': [-spots['1B'][0], spots['1B'][1]],
  LF: [-spots.RF[0], spots.RF[1]],
  CF: [-spots.CF[0], spots.CF[1]],
  RF: [-spots.LF[0], spots.LF[1]],
})
/** 各種佈陣的野手站位（畫面也照這份畫） */
export const ALIGNMENT_SPOTS: Record<Alignment, Spots> = {
  normal: NORMAL_SPOTS,
  shiftLeft: SHIFT_LEFT_SPOTS,
  shiftRight: mirror(SHIFT_LEFT_SPOTS),
  infieldIn: { ...NORMAL_SPOTS, '1B': [38, 85], '3B': [-38, 85], '2B': [14, 115], SS: [-14, 115] },
  outfieldBack: { ...NORMAL_SPOTS, LF: [-28, 315], CF: [0, 345], RF: [28, 315] },
}

/** 擊球方向傾向造成的平均角度偏移 */
const TENDENCY_MEAN: Record<Tendency, number> = { left: -12, even: 0, right: 12 }

/** 計量條的判定：完美、好、太早、太晚 */
export type MeterGrade = 'perfect' | 'good' | 'early' | 'late'

/** 計量條上的目標區：center 是中心位置，good、perfect 是往兩側的半寬 */
export interface MeterZone {
  center: number
  good: number
  perfect: number
}

/** 計量條的目標中心：靠近上緣，跟 2K 的投籃條一樣要等到快滿才放 */
export const METER_CENTER = 0.8

export function gradeTiming(zone: MeterZone, timing: number): MeterGrade {
  const d = timing - zone.center
  if (Math.abs(d) <= zone.perfect) return 'perfect'
  if (Math.abs(d) <= zone.good) return 'good'
  return d < 0 ? 'early' : 'late'
}

/** 一球的修正：強制好壞球、揮棒、結果，以及擊球品質的加減 */
interface PitchMod {
  inZone?: boolean
  swing?: boolean
  result?: PitchResult
  contact?: number
  hit?: number
  power?: number
  meter?: MeterGrade
}

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
  | 'error'

/** from：0 = 打者；to：4 = 回本壘得分 */
export interface RunnerMove {
  runnerId: string
  from: 0 | BaseNumber
  to: BaseNumber | 4 | 'out'
}

/** 守備位置，數字是記錄用的守備代號（6-4-3 的那個數字） */
export type Fielder = 'P' | 'C' | '1B' | '2B' | '3B' | 'SS' | 'LF' | 'CF' | 'RF'
export const FIELDER_NUMBERS: Record<Fielder, number> = {
  P: 1,
  C: 2,
  '1B': 3,
  '2B': 4,
  '3B': 5,
  SS: 6,
  LF: 7,
  CF: 8,
  RF: 9,
}

export interface BattedBall {
  type: 'ground' | 'fly' | 'line'
  /** 角度：0 為中外野方向，負數偏左外野，正數偏右外野，界內為 ±45 度 */
  angle: number
  /** 落點距離本壘的英呎數 */
  distance: number
  /** 處理這顆球的守備員 */
  fielder: Fielder
}

export type GameEvent =
  | { type: 'pitch'; result: PitchResult; balls: number; strikes: number; meter?: MeterGrade }
  | {
      type: 'play'
      kind: PlayKind
      batterId: string
      ball: BattedBall | null
      moves: RunnerMove[]
      runs: number
      /** 雙殺的守備記號，例如 6-4-3 */
      notation: string | null
    }
  | { type: 'steal'; runnerId: string; from: 1 | 2; success: boolean; moves: RunnerMove[] }
  | {
      type: 'substitution'
      side: Side
      kind: 'pinchHit' | 'pinchRun' | 'pitcher' | 'defense'
      inId: string
      outId: string
    }
  | { type: 'halfInningEnd'; inning: number; half: Half }
  | { type: 'gameOver'; winner: Side }

export type DecisionReason = 'leverage' | 'fatigue'

export interface GameSetup {
  home: Team
  away: Team
  seed: number
  userSide: Side
  /** 規則版本：沒給就是最新版。舊存檔標成 1，照舊規則重播（AI 不佈陣） */
  rules?: number
}

/** 目前的規則版本。2：AI 守備時會佈陣 */
export const RULES_VERSION = 2

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
/** 守備值的聯盟平均（能力值分布中心） */
const AVERAGE_FIELDING = 5

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
  /** 記分板的 H：各隊擊出的安打數 */
  hits: Record<Side, number> = { home: 0, away: 0 }
  /** 記分板的 E：各隊守備時犯的失誤數 */
  errors: Record<Side, number> = { home: 0, away: 0 }
  teams: Record<Side, TeamState>
  over = false
  winner: Side | null = null
  /** step() 被呼叫的次數 */
  stepIndex = 0
  /** 第幾個打席，從 0 開始 */
  paIndex = 0
  queued: Tactic | null = null
  /** 目前的守備佈陣：教練守備時可以改，打席結束恢復標準 */
  alignment: Alignment = 'normal'
  /** 教練最近一次親自出手的打席，每個打席只能一次 */
  private takeOverPa = -1
  readonly commands: Command[] = []
  private readonly rng: Rng
  /** AI 守備時會不會佈陣（規則版本 2 起） */
  private readonly aiAligns: boolean
  private readonly players = new Map<string, Player>()

  constructor(setup: GameSetup) {
    this.userSide = setup.userSide
    this.rng = new Rng(setup.seed)
    this.teams = { home: this.teamState(setup.home), away: this.teamState(setup.away) }
    this.aiAligns = (setup.rules ?? RULES_VERSION) >= 2
    this.prepareAtBat()
  }

  /** 打席開始：AI 守備時決定佈陣，讓玩家下指令前就看得到 */
  private prepareAtBat(): void {
    if (this.over || !this.aiAligns || this.fieldingSide === this.userSide) return
    this.alignment = this.aiAlignment()
  }

  /**
   * AI 的佈陣規則（不抽亂數）：
   * 後段一分都不能給、三壘有人就內野前進；後段小幅領先、面對強力打者就外野後退；
   * 打者有明顯擊球方向而且夠強，就往那邊移
   */
  private aiAlignment(): Alignment {
    const b = this.batter
    const lead = this.score[this.fieldingSide] - this.score[this.battingSide]
    if (this.bases[2] && this.outs < 2 && this.inning >= 7 && lead >= 0 && lead <= 1) return 'infieldIn'
    if (this.inning >= 8 && lead >= 1 && lead <= 2 && !this.bases[1] && !this.bases[2] && b.ratings.power >= 7) return 'outfieldBack'
    const threat = b.ratings.contact + b.ratings.power >= 11
    if (threat && b.tendency === 'left') return 'shiftLeft'
    if (threat && b.tendency === 'right') return 'shiftRight'
    return 'normal'
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

  /** 剩餘體力比例：1 是滿的，0 代表已經到疲勞門檻 */
  staminaLeft(team: TeamState): number {
    return clamp(1 - team.pitchCount / this.fatigueLimit(team.pitcher), 0, 1)
  }

  /** 某個守位的守備值；投手沒有守備能力，當作聯盟平均 */
  fieldingAt(team: TeamState, fielder: Fielder): number {
    if (fielder === 'P') return AVERAGE_FIELDING
    return team.lineup.find((s) => s.position === fielder)?.player.ratings.fielding ?? AVERAGE_FIELDING
  }

  /** 整隊的守備範圍：指定打擊不算 */
  teamDefense(team: TeamState): number {
    const fielders = team.lineup.filter((s) => s.position !== 'DH')
    return fielders.reduce((sum, s) => sum + s.player.ratings.fielding, 0) / fielders.length
  }

  /** 盜壘成功率：跑者速度對上捕手守備。penalty 用於打帶跑揮空時 */
  stealChance(from: 1 | 2, penalty = 0): number {
    const runner = this.bases[from - 1]
    if (!runner) return 0
    const catcher = this.fieldingAt(this.fielding, 'C')
    return clamp(
      0.55 +
        (runner.ratings.speed - 5) * 0.06 +
        (hasTrait(runner, 'stealer') ? 0.15 : 0) -
        (catcher - AVERAGE_FIELDING) * 0.03 -
        penalty,
      0.1,
      0.95,
    )
  }

  /** 犧牲觸擊成功率 */
  buntChance(): number {
    const b = this.batter
    // 偏移佈陣讓另一側空出來，觸擊比較容易成功；內野前進則正好相反
    const vsAlignment = this.alignment === 'shiftLeft' || this.alignment === 'shiftRight' ? 0.1 : this.alignment === 'infieldIn' ? -0.15 : 0
    return clamp(0.65 + (hasTrait(b, 'bunter') ? 0.2 : 0) + (b.ratings.contact - 5) * 0.02 + vsAlignment, 0.3, 0.95)
  }

  /** 第 7 局以後、比分差 1 分以內、得點圈有人：真正能左右勝負的時刻 */
  isCrunchTime(): boolean {
    return this.inning >= 7 && Math.abs(this.score.home - this.score.away) <= 1 && !!(this.bases[1] || this.bases[2])
  }

  /**
   * 守備佈陣對目前打者的安打率修正（負數代表比較不容易被打安打）。
   * 偏向打者習慣的方向能沒收安打，猜錯方向反而留下大洞；內野前進、外野後退都會讓一壘安打變多
   */
  alignmentEffect(alignment: Alignment = this.alignment): number {
    const tendency = this.batter.tendency
    switch (alignment) {
      case 'normal':
        return 0
      case 'shiftLeft':
        return tendency === 'left' ? -0.07 : tendency === 'right' ? 0.07 : 0.03
      case 'shiftRight':
        return tendency === 'right' ? -0.07 : tendency === 'left' ? 0.07 : 0.03
      case 'infieldIn':
        return 0.04
      case 'outfieldBack':
        return 0.02
    }
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

  /**
   * 打席開始時，是否該暫停讓教練下指令（只看狀態，不影響模擬）。
   * few：只在後段比分接近、得點圈有人時；many：槓桿指數夠高就暫停
   */
  decisionReasons(frequency: 'few' | 'many' = 'few'): DecisionReason[] {
    if (this.over || this.balls + this.strikes > 0) return []
    const reasons: DecisionReason[] = []
    const userFielding = this.fieldingSide === this.userSide
    if (userFielding && this.isFatigued(this.fielding) && this.fielding.relievers.length > 0) reasons.push('fatigue')
    const pivotal = frequency === 'few' ? this.isCrunchTime() : this.leverage() >= LEVERAGE_THRESHOLD
    if (pivotal && this.availableTactics().length > 0) reasons.push('leverage')
    return reasons
  }

  /**
   * 現在能不能親自出手：教練面板打開時都能用（關鍵時刻或主動暫停），
   * 但每個打席一次，而且不能跟其他排著的戰術同時。進攻時是親自出棒，守備時是決勝球
   */
  takeOver(): 'swing' | 'aimPitch' | null {
    if (this.over || this.queued || this.takeOverPa === this.paIndex) return null
    return this.battingSide === this.userSide ? 'swing' : 'aimPitch'
  }

  /** 計量條的目標區：出棒看打者的打擊，投球看投手的控球，體力越低越窄 */
  meterZone(kind: 'swing' | 'aimPitch'): MeterZone {
    let good: number
    if (kind === 'swing') good = 0.05 + clamp(this.effectiveContact(this.batter), 0, 10) * 0.008
    else {
      const control = clamp(this.effectivePitcher().control, 0, 10)
      good = (0.05 + control * 0.008) * (0.6 + 0.4 * this.staminaLeft(this.fielding))
    }
    return { center: METER_CENTER, good, perfect: good * 0.35 }
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
      const team = this.fielding
      for (const alignment of ALIGNMENTS) if (alignment !== this.alignment) tactics.push({ type: 'alignment', alignment })
      team.relievers.forEach((_, relieverIndex) => tactics.push({ type: 'changePitcher', relieverIndex }))
      if (this.balls + this.strikes === 0) tactics.push({ type: 'intentionalWalk' })
      team.bench.forEach((_, benchIndex) =>
        team.lineup.forEach((s, lineupIndex) => {
          if (s.position !== 'DH') tactics.push({ type: 'defensiveSub', benchIndex, lineupIndex })
        }),
      )
    }
    return tactics
  }

  // ---- 教練指令 ----

  /** 下達指令。換人類立即生效；盜壘、觸擊、打帶跑在下一步執行。 */
  issue(tactic: Tactic): GameEvent[] {
    const allowed =
      tactic.type === 'swing' || tactic.type === 'aimPitch'
        ? this.takeOver() === tactic.type && tactic.timing >= 0 && tactic.timing <= 1
        : this.availableTactics().some((t) => sameTactic(t, tactic))
    if (!allowed) throw new Error(`現在不能下這個指令：${tactic.type}`)
    this.commands.push({ stepIndex: this.stepIndex, tactic })
    switch (tactic.type) {
      case 'alignment':
        this.alignment = tactic.alignment
        return []
      case 'swing':
      case 'aimPitch':
        this.takeOverPa = this.paIndex
        this.queued = tactic
        return []
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
        // 換了打者，AI 重新判斷佈陣
        if (this.balls + this.strikes === 0) this.prepareAtBat()
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
      case 'defensiveSub': {
        const team = this.fielding
        const spot = team.lineup[tactic.lineupIndex]
        const out = spot.player
        spot.player = team.bench.splice(tactic.benchIndex, 1)[0]
        return [{ type: 'substitution', side: this.fieldingSide, kind: 'defense', inId: spot.player.id, outId: out.id }]
      }
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
    else if (tactic?.type === 'swing' || tactic?.type === 'aimPitch') events.push(...this.pitch(false, this.takeOverPitch(tactic)))
    else events.push(...this.pitch(tactic?.type === 'hitAndRun'))
    this.stepIndex++
    return events
  }

  /**
   * 親自出手的這一球：完美不保證安打，只是大幅提高好結果的機率。
   * 出棒太早多半變界外或軟弱滾地，太晚多半揮空；決勝球失手不是壞球就是甜球
   */
  private takeOverPitch(t: { type: 'swing' | 'aimPitch'; timing: number }): PitchMod {
    const rng = this.rng
    const meter = gradeTiming(this.meterZone(t.type), t.timing)
    if (t.type === 'swing') {
      switch (meter) {
        case 'perfect':
          return { meter, inZone: true, swing: true, result: 'inPlay', hit: 0.25, power: 3 }
        case 'good':
          return { meter, inZone: true, swing: true, result: rng.chance(0.75) ? 'inPlay' : 'foul', hit: 0.12, power: 1 }
        case 'early':
          return { meter, inZone: true, swing: true, result: rng.chance(0.45) ? 'foul' : 'inPlay', hit: -0.1, power: -2 }
        case 'late': {
          const r = rng.next()
          return { meter, inZone: true, swing: true, result: r < 0.45 ? 'swingingStrike' : r < 0.7 ? 'foul' : 'inPlay', hit: -0.12, power: -2 }
        }
      }
    }
    // 決勝球：投得好多半是揮空或軟弱擊球；失手一半是壞球、一半是被打的甜球
    const r = rng.next()
    switch (meter) {
      case 'perfect':
        return r < 0.45 ? { meter, inZone: true, swing: true, result: 'swingingStrike' } : { meter, inZone: true, swing: true, result: 'inPlay', hit: -0.2, power: -2 }
      case 'good':
        if (r < 0.3) return { meter, inZone: true, swing: true, result: 'swingingStrike' }
        return r < 0.8 ? { meter, inZone: true, swing: true, result: 'inPlay', hit: -0.1, power: -1 } : { meter, inZone: true, swing: true, result: 'foul' }
      default:
        return r < 0.5 ? { meter, inZone: false, swing: false, result: 'ball' } : { meter, inZone: true, swing: true, result: 'inPlay', hit: 0.15, power: 2 }
    }
  }

  private pitch(hitAndRun: boolean, mod: PitchMod = {}): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const pitcher = this.pitcher
    const { stuff, control } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const twoStrikes = this.strikes === 2
    this.fielding.pitchCount++

    const zoneP = clamp(0.5 + (control - 5) * 0.035 - (hasTrait(pitcher, 'wild') ? 0.08 : 0), 0.3, 0.72)
    const inZone = mod.inZone ?? rng.chance(zoneP)
    const swingP = inZone
      ? 0.65 + (twoStrikes ? 0.15 : 0)
      : 0.32 + (twoStrikes ? 0.12 : 0) - (hasTrait(batter, 'eye') ? 0.12 : 0) - (this.balls === 3 ? 0.05 : 0)
    const swing = mod.swing ?? (hitAndRun || rng.chance(swingP))

    let result: PitchResult
    if (mod.result) {
      result = mod.result
    } else if (!swing) {
      result = inZone ? 'calledStrike' : 'ball'
    } else {
      const contactP = clamp(
        (inZone ? 0.8 : 0.55) +
          (contact - stuff) * 0.03 -
          (hasTrait(batter, 'freeSwinger') ? 0.08 : 0) -
          (hasTrait(pitcher, 'strikeoutArtist') ? 0.06 : 0) +
          (mod.contact ?? 0),
        0.2,
        0.95,
      )
      if (!rng.chance(contactP)) result = 'swingingStrike'
      else if (rng.chance(0.42)) result = 'foul'
      else result = 'inPlay'
    }

    if (result === 'inPlay') {
      return [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes, meter: mod.meter }, ...this.ballInPlay(hitAndRun, mod)]
    }
    if (result === 'ball') this.balls++
    else if (result === 'foul') this.strikes = Math.min(2, this.strikes + 1)
    else this.strikes++
    const events: GameEvent[] = [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes, meter: mod.meter }]

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

  private ballInPlay(hitAndRun: boolean, mod: PitchMod = {}): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const { stuff } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const { speed } = batter.ratings
    const power = batter.ratings.power + (mod.power ?? 0)
    // 守備範圍好的隊伍，能把一部分安打變成出局
    const range = this.teamDefense(this.fielding) - AVERAGE_FIELDING
    const hitP = clamp(
      0.33 + (contact - 5) * 0.018 - (stuff - 5) * 0.012 + (speed - 5) * 0.005 - range * 0.015,
      0.15,
      0.5,
    )

    if (rng.chance(clamp(hitP + (mod.hit ?? 0) + this.alignmentEffect(), 0.05, 0.85))) {
      // 外野後退：長打大多被攔下來變成一壘安打
      const deep = this.alignment === 'outfieldBack' ? 0.4 : 1
      const kind = rng.weighted<PlayKind>([
        ['homeRun', Math.max(0.02, 0.1 + (power - 5) * 0.035 + (hasTrait(batter, 'slugger') ? 0.08 : 0))],
        ['triple', Math.max(0.005, 0.025 + (speed - 5) * 0.006) * deep],
        ['double', Math.max(0.08, 0.2 + (power - 5) * 0.02) * deep],
        ['single', 0.65],
      ])
      return this.hit(kind, hitAndRun)
    }
    const type = rng.weighted<BattedBall['type']>([
      ['ground', 0.45],
      ['fly', 0.4 + (power - 5) * 0.02],
      ['line', 0.15],
    ])
    const ball = this.outBall(type)
    const glove = this.fieldingAt(this.fielding, ball.fielder)
    const errorFactor = clamp(1 + (AVERAGE_FIELDING - glove) * 0.18, 0.25, 2.2)
    if (rng.chance(ERROR_RATE[type] * errorFactor)) return this.reachOnError(ball)
    if (type === 'ground') return this.groundOut(ball, hitAndRun)
    if (type === 'fly') return this.flyOut(ball)
    return this.lineOut(ball, hitAndRun)
  }

  /** 擊球：沒出牆的球一定落在全壘打牆前面 */
  private makeBall(type: BattedBall['type'], angle: number, distance: number): BattedBall {
    const d = Math.min(distance, fenceDistance(angle) - 10)
    const fielder =
      this.alignment === 'normal' ? fielderFor(type, angle, d) : nearestFielder(type, angle, d, ALIGNMENT_SPOTS[this.alignment])
    return { type, angle, distance: d, fielder }
  }

  /** 安打的空檔，依現在的佈陣算出來 */
  private gaps(kind: 'infield' | 'outfield' | 'shallow'): number[] {
    return hitGaps(ALIGNMENT_SPOTS[this.alignment], kind)
  }

  /** 打者傾向的平均擊球角度 */
  private get pull(): number {
    return TENDENCY_MEAN[this.batter.tendency]
  }

  private outBall(type: BattedBall['type']): BattedBall {
    const rng = this.rng
    if (type === 'ground') return this.makeBall(type, clamp(rng.normal(this.pull, 22), -42, 42), rng.range(60, 125))
    if (type === 'fly') return this.makeBall(type, clamp(rng.normal(this.pull, 25), -43, 43), rng.range(180, 370))
    return this.makeBall(type, clamp(rng.normal(this.pull, 25), -42, 42), rng.range(90, 260))
  }

  /** 守備失誤：打者上壘，跑者至少推進一個壘包；外野失誤推進更多 */
  private reachOnError(ball: BattedBall): GameEvent[] {
    const outfield = OUTFIELDERS.includes(ball.fielder)
    const advance = outfield ? 2 : 1
    const moves: RunnerMove[] = []
    for (const base of [3, 2, 1] as const) {
      const r = this.bases[base - 1]
      if (r) moves.push({ runnerId: r.id, from: base, to: Math.min(4, base + advance) as BaseNumber | 4 })
    }
    moves.push({ runnerId: this.batter.id, from: 0, to: outfield && this.rng.chance(0.4) ? 2 : 1 })
    return this.finishPlay('error', ball, moves)
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
      case 'homeRun': {
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 4)
        // 一定飛過該方向的全壘打牆；力量越大打得越遠。亂數用量跟以前一樣，舊存檔重播不受影響
        const angle = clamp(rng.normal(this.pull, 25), -43, 43)
        const distance = fenceDistance(angle) + Math.max(5, 8 + rng.range(0, 60) + (batter.ratings.power - 5) * 5)
        ball = { type: 'fly', angle, distance, fielder: fielderFor('fly', angle, distance) }
        break
      }
      case 'triple':
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 3)
        // 三壘安打：打穿外野空檔或沿著邊線
        ball = this.makeBall('line', toGap(rng.pick([-1, 1]) * rng.range(25, 42), this.gaps('outfield')), rng.range(330, 390))
        break
      case 'double':
        if (b3) move(b3, 3, 4)
        if (b2) move(b2, 2, 4)
        if (b1) move(b1, 1, rng.chance(0.35 + spd(b1) * 0.05 + (hitAndRun ? 0.3 : 0)) ? 4 : 3)
        move(batter, 0, 2)
        ball = this.makeBall('line', toGap(rng.pick([-1, 1]) * rng.range(12, 40), this.gaps('outfield')), rng.range(260, 360))
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
        // 滾地安打穿過內野手之間的空檔；平飛安打落在外野手之間的前方
        ball = ground
          ? this.makeBall('ground', toGap(clamp(rng.normal(this.pull, 25), -40, 40), this.gaps('infield')), rng.range(130, 170))
          : this.makeBall('line', toGap(clamp(rng.normal(this.pull, 25), -40, 40), this.gaps('shallow')), rng.range(160, 240))
      }
    }
    return this.finishPlay(kind, ball, moves)
  }

  private groundOut(ball: BattedBall, hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const [b1, b2, b3] = this.bases
    const glove = this.fieldingAt(this.fielding, ball.fielder) - AVERAGE_FIELDING
    const dpP = 0.45 - (batter.ratings.speed - 5) * 0.04 + glove * 0.03
    if (b1 && this.outs < 2 && !hitAndRun && rng.chance(dpP)) {
      const moves: RunnerMove[] = [
        { runnerId: b1.id, from: 1, to: 'out' },
        { runnerId: batter.id, from: 0, to: 'out' },
      ]
      if (b2) moves.push({ runnerId: b2.id, from: 2, to: 3 })
      if (b3) moves.push({ runnerId: b3.id, from: 3, to: b2 ? 4 : rng.chance(0.5) ? 4 : 3 })
      return this.finishPlay('doublePlay', ball, moves, groundDoublePlay(ball.fielder))
    }
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    // 被迫進壘的跑者一定往前；沒被迫的看情況
    const forced2 = !!b1
    const forced3 = forced2 && !!b2
    const forcedHome = forced3 && !!b3
    // 內野前進守備：三壘跑者沒被迫進壘就跑不回來
    const holdThird = this.alignment === 'infieldIn'
    if (b3) moves.push({ runnerId: b3.id, from: 3, to: forcedHome || (!holdThird && this.outs < 2 && rng.chance(0.45)) ? 4 : 3 })
    const thirdFree = !moves.some((m) => m.to === 3)
    if (b2) moves.push({ runnerId: b2.id, from: 2, to: forced3 || (thirdFree && rng.chance(0.5)) ? 3 : 2 })
    if (b1) moves.push({ runnerId: b1.id, from: 1, to: 2 })
    return this.finishPlay('groundOut', ball, moves)
  }

  private flyOut(ball: BattedBall): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const [, b2, b3] = this.bases
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    let kind: PlayKind = 'flyOut'
    const outfield = OUTFIELDERS.includes(ball.fielder)
    if (this.outs < 2) {
      // 外野高飛球，三壘跑者回壘觸壘後衝本壘；球太淺就不跑
      if (b3 && outfield && (ball.distance > 240 || rng.chance(0.35))) {
        // 外野手守備好，回傳本壘就準
        const arm = this.fieldingAt(this.fielding, ball.fielder) - AVERAGE_FIELDING
        const safeP = clamp(0.55 + (ball.distance - 250) / 200 + (b3.ratings.speed - 5) * 0.05 - arm * 0.04, 0.2, 0.97)
        if (rng.chance(safeP)) {
          moves.push({ runnerId: b3.id, from: 3, to: 4 })
          kind = 'sacrificeFly'
        } else {
          // 在本壘前被觸殺：接殺加觸殺的雙殺
          moves.push({ runnerId: b3.id, from: 3, to: 'out' })
          return this.finishPlay('doublePlay', ball, moves, `${FIELDER_NUMBERS[ball.fielder]}-2`)
        }
      }
      // 三壘有人沒跑，二壘跑者就不能推進
      if (b2 && outfield && (kind === 'sacrificeFly' || !b3) && rng.chance(0.3)) {
        moves.push({ runnerId: b2.id, from: 2, to: 3 })
      }
    }
    return this.finishPlay(kind, ball, moves)
  }

  private lineOut(ball: BattedBall, hitAndRun: boolean): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const moves: RunnerMove[] = [{ runnerId: batter.id, from: 0, to: 'out' }]
    // 平飛球被接殺，離壘的跑者來不及回壘；打帶跑時一壘跑者已經起跑，更容易被雙殺
    const [b1, b2] = this.bases
    if (this.outs < 2) {
      const base = b2 ? 2 : b1 ? 1 : null
      if (base && rng.chance(hitAndRun && b1 ? 0.5 : 0.08)) {
        const runner = (hitAndRun && b1 ? b1 : this.bases[base - 1])!
        const from = runner === b1 ? 1 : 2
        moves.push({ runnerId: runner.id, from, to: 'out' })
        return this.finishPlay('doublePlay', ball, moves, doubledOff(ball.fielder, from))
      }
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
    const successP = this.buntChance()
    const ball = this.makeBall('ground', rng.range(-30, 30), rng.range(20, 45))
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
    const success = this.rng.chance(this.stealChance(from, penalty))
    const moves: RunnerMove[] = [{ runnerId: runner.id, from, to: success ? ((from + 1) as BaseNumber) : 'out' }]
    this.applyMoves(moves)
    const events: GameEvent[] = [{ type: 'steal', runnerId: runner.id, from, success, moves }]
    if (this.outs >= 3) events.push(...this.endHalfInning())
    this.prepareAtBat()
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
  private finishPlay(kind: PlayKind, ball: BattedBall | null, moves: RunnerMove[], notation: string | null = null): GameEvent[] {
    const batterId = this.batter.id
    if (HIT_KINDS.includes(kind)) this.hits[this.battingSide]++
    if (kind === 'error') this.errors[this.fieldingSide]++
    const runs = this.applyMoves(moves)
    const events: GameEvent[] = [{ type: 'play', kind, batterId, ball, moves, runs, notation }]
    const team = this.batting
    team.battingIndex = (team.battingIndex + 1) % 9
    this.balls = 0
    this.strikes = 0
    this.paIndex++
    this.alignment = 'normal'
    if (this.half === 'bottom' && this.inning >= 9 && this.score.home > this.score.away) {
      return [...events, this.endGame('home')]
    }
    if (this.outs >= 3) events.push(...this.endHalfInning())
    this.prepareAtBat()
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

const HIT_KINDS: readonly PlayKind[] = ['single', 'double', 'triple', 'homeRun']

/** 原本會出局的球，被判失誤的機率（真實棒球每隊每場約 0.5 次失誤） */
const ERROR_RATE: Record<BattedBall['type'], number> = { ground: 0.045, fly: 0.015, line: 0.01 }

const OUTFIELDERS: readonly Fielder[] = ['LF', 'CF', 'RF']

/** 依擊球方向和距離，判斷由哪個守備員處理 */
/**
 * 全壘打牆的距離（英呎）：跟真實球場一樣兩邊淺、中間深，
 * 左右外野標竿約 330 英呎（101 公尺），中外野 400 英呎（122 公尺）
 */
/**
 * 安打的方向往最近的空檔靠：守備員站位之間，或沿著邊線。
 * 只改角度、不多抽亂數，所以舊存檔重播的結果不變
 */
function toGap(angle: number, gaps: readonly number[]): number {
  const gap = gaps.reduce((best, g) => (Math.abs(g - angle) < Math.abs(best - angle) ? g : best))
  return gap + clamp((angle - gap) * 0.2, -2, 2)
}
/**
 * 依野手站位算出安打的空檔。
 * infield：內野手之間與兩條邊線；outfield：外野手之間（偏到外野手和邊線中間就用邊線）；
 * shallow（平飛一壘安打）：內外野所有人之間夠寬的縫與邊線
 */
function hitGaps(spots: Spots, kind: 'infield' | 'outfield' | 'shallow'): number[] {
  const infield = (['3B', 'SS', '2B', '1B'] as const).map((p) => spots[p][0])
  const outfield = (['LF', 'CF', 'RF'] as const).map((p) => spots[p][0])
  const between = (angles: number[], minWidth: number) => {
    const sorted = [...angles].sort((a, b) => a - b)
    return sorted.slice(1).flatMap((a, i) => (a - sorted[i] >= minWidth ? [(a + sorted[i]) / 2] : []))
  }
  // 空檔離最近的相關野手至少 minGap 度才算數（偏移佈陣時，靠近野手那側的邊線就不是空檔）
  const clear = (fielders: number[], minGap: number) => (a: number) => Math.min(...fielders.map((o) => Math.abs(o - a))) >= minGap
  if (kind === 'infield') return [-44, ...between(infield, 0), 44].filter(clear(infield, 6))
  const everyone = [...infield, ...outfield]
  // 長打：所有人之間的縫，但離外野手至少 7 度，才看得出是打穿外野
  if (kind === 'outfield') return [-41, ...between(everyone, 0), 41].filter(clear(outfield, 7))
  return [-44.5, ...between(everyone, 12), 44.5].filter(clear(everyone, 6))
}

/** 偏移佈陣時，由站位最近的野手處理擊球 */
function nearestFielder(type: BattedBall['type'], angle: number, distance: number, spots: Spots): Fielder {
  const infield = type === 'ground' ? distance <= 125 : distance < 150
  if (infield && distance < 45) return fielderFor(type, angle, distance)
  const pool = infield ? (['3B', 'SS', '2B', '1B'] as const) : (['LF', 'CF', 'RF'] as const)
  return pool.reduce((best, p) => (Math.abs(spots[p][0] - angle) < Math.abs(spots[best][0] - angle) ? p : best))
}

export function fenceDistance(angle: number): number {
  const a = (clamp(angle, -45, 45) * Math.PI) / 180
  return 330 + 70 * Math.cos(2 * a)
}

export interface HomeRunStats {
  distanceFt: number
  /** 仰角（度） */
  launchAngle: number
  /** 擊球初速（英哩／時） */
  exitVelocityMph: number
}

/**
 * 全壘打的擊球數據：由飛行距離與方向推算仰角和初速。
 * 不另外抽亂數，同一顆球永遠算出一樣的數據，也不影響模擬
 */
export function homeRunStats(ball: BattedBall): HomeRunStats {
  // 用距離和方向做出穩定、看起來隨機的仰角：24～34 度
  const wobble = Math.abs(Math.sin(ball.distance * 12.9898 + ball.angle * 78.233))
  const launchAngle = Math.round(24 + wobble * 10)
  // 約 28 度最有效率，偏離越多需要越大的初速才打得一樣遠
  const efficiency = 1 - 0.3 * ((launchAngle - 28) / 14) ** 2
  const exitVelocityMph = Math.round(((ball.distance / efficiency + 230) / 6) * 10) / 10
  return { distanceFt: Math.round(ball.distance), launchAngle, exitVelocityMph }
}

export function fielderFor(type: BattedBall['type'], angle: number, distance: number): Fielder {
  const infield = type === 'ground' ? distance <= 125 : distance < 150
  if (!infield) return angle < -15 ? 'LF' : angle > 15 ? 'RF' : 'CF'
  if (distance < 45) return angle < -15 ? '3B' : angle > 15 ? '1B' : distance < 25 ? 'C' : 'P'
  if (angle < -28) return '3B'
  if (angle < -6) return 'SS'
  if (angle <= 6) return distance < 75 ? 'P' : angle < 0 ? 'SS' : '2B'
  if (angle <= 28) return '2B'
  return '1B'
}

/** 滾地球雙殺：接球的人傳二壘補位的人，再轉傳一壘 */
function groundDoublePlay(fielder: Fielder): string {
  const pivot = fielder === '2B' || fielder === '1B' || fielder === 'P' || fielder === 'C' ? 'SS' : '2B'
  return `${FIELDER_NUMBERS[fielder]}-${FIELDER_NUMBERS[pivot]}-3`
}

/** 平飛球接殺後，傳回跑者原本的壘包；自己就在壘包旁則是獨殺 */
function doubledOff(fielder: Fielder, base: 1 | 2): string {
  const cover: Fielder = base === 1 ? '1B' : fielder === '2B' ? '2B' : 'SS'
  return fielder === cover ? `${FIELDER_NUMBERS[fielder]}` : `${FIELDER_NUMBERS[fielder]}-${FIELDER_NUMBERS[cover]}`
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
