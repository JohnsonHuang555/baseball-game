import {
  EXTRA_PITCH_CONTACT,
  PITCH_TRAIT_EFFECT,
  PITCH_WHIFF,
  aiPitch,
  coldZone,
  hotZone,
  isBreaking,
  isCorner,
  pitchTraitOf,
  repertoire,
  spotZones,
  stance,
  type PitchGuess,
  type PitchType,
} from './pitches'
import { Rng, clamp } from './rng'
import type { RelicId } from './items'
import { fieldingAtPosition } from './positions'
import { SYNERGY_KEYS, archetypeCounts, captainIn, positionSynergies, tierOf, type SynergyKey, type SynergyTier } from './synergy'
import { hasTrait } from './traits'
import type { Archetype, Batter, LineupSpot, Pitcher, Player, Team, Tendency } from './types'

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
  /**
   * 親自出棒：下一球一定揮棒，timing 是計量條停下的位置（0～1）。
   * 規則版本 5 起：停的位置偏早拉打、偏晚推打；guess 是先猜直球或變化球（只有早期的紀錄會有）
   */
  | { type: 'swing'; timing: number; guess?: PitchGuess }
  /** 決勝球：下一球由教練親自投，timing 是計量條停下的位置（0～1） */
  | { type: 'aimPitch'; timing: number }
  /**
   * 配球（規則版本 5 起取代決勝球）：選球種，accuracy 是手勢畫得多準（0～1）。
   * spot 是九宮格位置，現在的畫面不讓玩家選了，只有早期的紀錄會有
   */
  | { type: 'throw'; pitch: PitchType; spot?: number; accuracy: number }
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

/** 計量條的判定：完美、好、太早、太晚；手勢畫歪了是失投 */
export type MeterGrade = 'perfect' | 'good' | 'early' | 'late' | 'miss'

/** 親自出手的方式：出棒、決勝球（舊規則）、配球 */
export type TakeOverKind = 'swing' | 'aimPitch' | 'throw'

/** 關鍵打席的理由，依優先順序：英雄時刻、我方守備滿壘、差一步就覺醒、後段一分差二三壘有人 */
export type KeyAtBatReason = 'hero' | 'basesLoaded' | 'milestone' | 'crunch'

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
  /** 親自出棒時瞄準的平均擊球角度 */
  aim?: number
  /** 這一球的球種（只有親自出手時記下來給畫面看） */
  pitch?: PitchType
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
  /** pitch：這一球的球種（規則版本 5 起每一球都有，給投球動畫用） */
  | { type: 'pitch'; result: PitchResult; balls: number; strikes: number; meter?: MeterGrade; pitch?: PitchType }
  | {
      type: 'play'
      kind: PlayKind
      batterId: string
      ball: BattedBall | null
      moves: RunnerMove[]
      runs: number
      /** 雙殺的守備記號，例如 6-4-3 */
      notation: string | null
      /** 這個結果是羈絆促成的（沒有羈絆加成就不會發生） */
      assist?: Assist
    }
  | { type: 'steal'; runnerId: string; from: 1 | 2; success: boolean; moves: RunnerMove[]; assist?: Assist }
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

/** 羈絆促成的結果種類 */
export type AssistKind =
  | 'homeRun'
  | 'extraBase'
  | 'hit'
  | 'steal'
  | 'advance'
  | 'avoidK'
  | 'walk'
  | 'errorSaved'
  | 'hitSaved'
  | 'doublePlay'
  | 'caughtStealing'

/** 一次羈絆促成：哪一隊的哪個羈絆、促成了什麼 */
export interface Assist {
  side: Side
  key: SynergyKey
  kind: AssistKind
}

/** 一場比賽裡某隊某個羈絆的紀錄，賽後顯示 */
export interface SynergyRecord {
  key: SynergyKey
  /** 這場最高到幾階（守位羈絆成立就是 1） */
  peak: SynergyTier
  /** 中途失效的局數；最後還有效就是 null */
  lostInning: number | null
  assists: Partial<Record<AssistKind, number>>
}

/** 賽後羈絆區塊用的相關數據（各隊） */
export interface SynergyStats {
  /** 力量型打者的全壘打、三振 */
  powerHR: number
  powerK: number
  /** 速度型球員的盜壘成功 */
  speedSB: number
  /** 技巧型打者的三振、保送 */
  skillK: number
  skillBB: number
  /** 守備方完成的雙殺、投出的保送、阻殺盜壘 */
  doublePlays: number
  walksAllowed: number
  caughtStealing: number
}

export interface GameSetup {
  home: Team
  away: Team
  seed: number
  userSide: Side
  /** 規則版本：沒給就是最新版。舊存檔標成 1，照舊規則重播（AI 不佈陣） */
  rules?: number
}

/**
 * 目前的規則版本。2：AI 守備時會佈陣；3：左右投打相剋；4：AI 依左右相剋換投、派代打；
 * 5：配球對決（出棒決定擊球方向、猜球，投球改成選球種、位置並畫手勢）；6：守本職以外的守位時守備打折；
 * 7：流派羈絆與隊長；8：守位羈絆（黃金二遊、投捕搭檔）
 */
export const RULES_VERSION = 8

/**
 * 流派羈絆的效果，依階級（0 未啟動、1 是 3 人階、2 是 5 人階）取值；只作用在該流派的球員身上，鐵壁球隊作用在整個守備。
 * 重砲：全壘打、長打變多，揮空也變多；快腿：盜壘、跑壘推進、內野安打；
 * 精準：揮空變少、比較不追打壞球、兩好球後安打率提高；鐵壁：失誤變少、守備範圍變大。
 * 3 人階只有三個人吃得到，所以每人的效果接近 5 人階的八成（校準目標：3 人階約等於一張銀卡秘寶，5 人階約等於金卡）
 */
export const SYNERGY_EFFECT = {
  slugPower: [0, 1.5, 2],
  homer: [1, 1.3, 1.45],
  extraBase: [1, 1.15, 1.25],
  powerWhiff: [0, 0.01, 0.015],
  steal: [0, 0.18, 0.22],
  running: [0, 3, 3.5],
  infieldHit: [0, 0.02, 0.03],
  skillContact: [0, 0.05, 0.06],
  skillChase: [0, 0.07, 0.08],
  twoStrikeHit: [0, 0.025, 0.035],
  ironError: [1, 0.75, 0.6],
  /** 黃金二遊：雙殺成功率、二游的失誤；投捕搭檔：投手控球、對方盜壘成功率 */
  middleDoublePlay: 0.15,
  middleError: 0.8,
  batteryControl: 0.5,
  batterySteal: 0.05,
  ironRange: [0, 0.006, 0.015],
} as const

/** AI 換上的投手至少要面對幾位打者，才會再被 AI 換掉（避免一直換） */
const MIN_BATTERS_FACED = 3

/** 一位球員這場比賽的成績（打者看打擊欄，投手看投球欄） */
export interface PlayerLine {
  /** 打席、安打、全壘打、打點、被三振 */
  pa: number
  hits: number
  hr: number
  rbi: number
  so: number
  /** 投手：抓到的出局數、失分、三振 */
  outs: number
  runs: number
  k: number
}

/** 同側（右投對右打、左投對左打）打擊下修，對側小幅上修 */
export const PLATOON = { same: -1, opposite: 0.5 }

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
  /** 目前這位投手是從第幾個打席開始投的 */
  pitcherSincePa: number
  /** 先發投手，用來分辨後援 */
  starterId: string
  /** 錦標賽的秘寶；AI 隊伍和舊存檔沒有 */
  relics: readonly RelicId[]
  /** 隊長；比賽中被換下場就變成 null，這場不會遞補 */
  captainId: string | null
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
  /** 這個半局第一個打席的 paIndex */
  halfStartPa = 0
  queued: Tactic | null = null
  /** 目前的守備佈陣：教練守備時可以改，打席結束恢復標準 */
  alignment: Alignment = 'normal'
  readonly commands: Command[] = []
  private readonly rng: Rng
  /** AI 守備時會不會佈陣（規則版本 2 起） */
  private readonly aiAligns: boolean
  /** AI 會不會依左右相剋換投、派代打（規則版本 4 起） */
  private readonly aiPlatoon: boolean
  /** 有沒有左右投打相剋（規則版本 3 起） */
  readonly platoonOn: boolean
  /** 有沒有配球對決（規則版本 5 起） */
  readonly pitchMix: boolean
  /** 守本職以外的守位時守備會不會打折（規則版本 6 起） */
  readonly positionsOn: boolean
  /** 有沒有流派羈絆與隊長（規則版本 7 起） */
  readonly synergyOn: boolean
  /** 有沒有守位羈絆（規則版本 8 起） */
  readonly positionSynergyOn: boolean
  /** 這場比賽各隊羈絆的紀錄：最高階、中途失效、促成了什麼 */
  readonly synergyLog: Record<Side, Partial<Record<SynergyKey, SynergyRecord>>> = { home: {}, away: {} }
  readonly synergyStats: Record<Side, SynergyStats> = { home: emptySynergyStats(), away: emptySynergyStats() }
  /** 這一球目前為止的羈絆促成，結算時掛到事件上 */
  private pendingAssist: Assist | null = null
  private readonly seed: number
  /** 這個打席上一球親自投的球種：連投同一種會被打者看穿 */
  private lastThrow: PitchType | null = null
  /** 這顆擊球瞄準的平均角度（親自出棒才有） */
  private aimAngle: number | null = null
  /** 兩隊開賽時的全部球員編號（換下場的人也算） */
  private readonly rosters: Record<Side, Set<string>>
  /** 每位球員這場的成績，用來選 MVP 和錦標賽成長 */
  readonly box: Record<string, PlayerLine> = {}
  private readonly players = new Map<string, Player>()

  constructor(setup: GameSetup) {
    this.userSide = setup.userSide
    this.rng = new Rng(setup.seed)
    this.teams = { home: this.teamState(setup.home), away: this.teamState(setup.away) }
    const ids = (t: Team) => new Set([...t.roster.lineup.map((s) => s.player), ...t.roster.bench, t.roster.starter, ...t.roster.relievers].map((p) => p.id))
    this.rosters = { home: ids(setup.home), away: ids(setup.away) }
    this.aiAligns = (setup.rules ?? RULES_VERSION) >= 2
    this.platoonOn = (setup.rules ?? RULES_VERSION) >= 3
    this.aiPlatoon = (setup.rules ?? RULES_VERSION) >= 4
    this.pitchMix = (setup.rules ?? RULES_VERSION) >= 5
    this.positionsOn = (setup.rules ?? RULES_VERSION) >= 6
    this.synergyOn = (setup.rules ?? RULES_VERSION) >= 7
    this.positionSynergyOn = (setup.rules ?? RULES_VERSION) >= 8
    this.seed = setup.seed
    this.trackSynergies()
    this.prepareAtBat()
  }

  /** 打席開始：AI 守備時決定佈陣，讓玩家下指令前就看得到 */
  private prepareAtBat(): GameEvent[] {
    if (this.over || this.balls + this.strikes > 0) return []
    const events = this.aiPlatoonMoves()
    if (this.aiAligns && this.fieldingSide !== this.userSide) this.alignment = this.aiAlignment()
    return events
  }

  /**
   * AI 的左右相剋調度，只在後段比分接近時：
   * 守備時，玩家的打者佔對側優勢，就換上同手的後援（不用掉最後一位後援、新投手至少面對三位打者）；
   * 進攻時，自己的打者遇到同側投手，就派對側、打擊不差的代打
   */
  private aiPlatoonMoves(): GameEvent[] {
    if (!this.aiPlatoon || this.inning < 7 || Math.abs(this.score.home - this.score.away) > 2) return []
    const batterValue = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3
    if (this.fieldingSide !== this.userSide) {
      const team = this.fielding
      const batter = this.batter
      if (batter.bats === 'S' || this.matchup() !== 'opposite') return []
      if (team.relievers.length < 2 || this.paIndex - team.pitcherSincePa < MIN_BATTERS_FACED) return []
      const now = team.pitcher.ratings.stuff + team.pitcher.ratings.control
      const pick = team.relievers
        .map((p, i) => ({ p, i, value: p.ratings.stuff + p.ratings.control }))
        .filter(({ p, value }) => p.throws === batter.bats && value >= now - 1)
        .sort((a, b) => b.value - a.value)[0]
      return pick ? this.changePitcher(team, this.fieldingSide, pick.i) : []
    }
    const team = this.batting
    const spot = team.lineup[team.battingIndex]
    if (this.matchup(spot.player) !== 'same') return []
    const pick = team.bench
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => this.matchup(p) === 'opposite' && batterValue(p) >= batterValue(spot.player) - 0.5)
      .sort((a, b) => batterValue(b.p) - batterValue(a.p))[0]
    if (!pick) return []
    const out = this.benchIn(team, spot, pick.i)
    return [{ type: 'substitution', side: this.battingSide, kind: 'pinchHit', inId: spot.player.id, outId: out.id }]
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
      pitcherSincePa: 0,
      starterId: roster.starter.id,
      relics: team.relics ?? [],
      captainId: captainIn(roster.lineup, roster.captain),
    }
  }

  /** 板凳換上先發的某一格，回傳被換下的人；換下的是隊長，這場就沒有隊長 */
  private benchIn(team: TeamState, spot: LineupSpot, benchIndex: number): Batter {
    const out = spot.player
    spot.player = team.bench.splice(benchIndex, 1)[0]
    if (team.captainId === out.id) team.captainId = null
    this.trackSynergies()
    return out
  }

  /** 這一隊某個流派羈絆目前的階級；舊規則的比賽沒有羈絆 */
  synergyTier(team: TeamState, archetype: Archetype): SynergyTier {
    if (!this.synergyOn) return 0
    return tierOf(archetypeCounts(team.lineup, team.captainId, team.relics)[archetype], archetype, team.relics)
  }

  /** 守位羈絆成立沒有（規則版本 8 起） */
  positionSynergy(team: TeamState, key: 'middle' | 'battery'): boolean {
    return this.positionSynergyOn && positionSynergies(team.lineup)[key]
  }

  /** 任一個羈絆目前的階級：流派羈絆 0～2，守位羈絆成立就是 1 */
  synergyLevel(team: TeamState, key: SynergyKey): SynergyTier {
    return key === 'middle' || key === 'battery' ? (this.positionSynergy(team, key) ? 1 : 0) : this.synergyTier(team, key)
  }

  /** 換人之後重新檢查羈絆：記下這場啟動過的最高階，失效的記下局數 */
  private trackSynergies(): void {
    if (!this.synergyOn) return
    for (const side of ['home', 'away'] as const) {
      const log = this.synergyLog[side]
      for (const key of SYNERGY_KEYS) {
        const level = this.synergyLevel(this.teams[side], key)
        const entry = log[key]
        if (level > 0) {
          if (!entry) log[key] = { key, peak: level, lostInning: null, assists: {} }
          else {
            entry.peak = Math.max(entry.peak, level) as SynergyTier
            entry.lostInning = null
          }
        } else if (entry && entry.lostInning === null) entry.lostInning = this.inning
      }
    }
  }

  /** 記一次羈絆促成：算進賽後統計，並讓這一球的事件帶上標記（同一球只標第一個） */
  private credit(side: Side, key: SynergyKey, kind: AssistKind): void {
    const entry = (this.synergyLog[side][key] ??= { key, peak: 1, lostInning: null, assists: {} })
    entry.assists[kind] = (entry.assists[kind] ?? 0) + 1
    this.pendingAssist ??= { side, key, kind }
  }

  /** 這名球員吃得到的流派羈絆階級：不是這個流派就是 0 */
  private boost(team: TeamState, b: Batter, archetype: Archetype): SynergyTier {
    return b.archetype === archetype ? this.synergyTier(team, archetype) : 0
  }

  // ---- 查詢 ----

  rosterIds(side: Side): ReadonlySet<string> {
    return this.rosters[side]
  }

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

  /** 投手的疲勞門檻（球數）；給了所屬的隊伍才算秘寶「耐力訓練」 */
  fatigueLimit(p: Pitcher, team?: TeamState): number {
    const relic = team && hasRelic(team, 'stamina') ? 15 : 0
    return 50 + p.ratings.stamina * 8 + (hasTrait(p, 'ironArm') ? 40 : 0) - (hasTrait(p, 'lowStamina') ? 15 : 0) + relic
  }

  isFatigued(team: TeamState): boolean {
    return team.pitchCount >= this.fatigueLimit(team.pitcher, team)
  }

  /** 剩餘體力比例：1 是滿的，0 代表已經到疲勞門檻 */
  staminaLeft(team: TeamState): number {
    return clamp(1 - team.pitchCount / this.fatigueLimit(team.pitcher, team), 0, 1)
  }

  /** 得點圈（二、三壘）有沒有跑者 */
  private scoringPosition(): boolean {
    return !!(this.bases[1] || this.bases[2])
  }

  /** 某個守位上的球員（投手、捕手以外的守位才有） */
  private fielderPlayer(team: TeamState, fielder: Fielder): Batter | undefined {
    return team.lineup.find((s) => s.position === fielder)?.player
  }

  /** 先發陣容裡某一格實際的守備值：守本職以外的守位會打折（規則版本 6 起） */
  spotFielding(spot: LineupSpot): number {
    return this.positionsOn ? fieldingAtPosition(spot.player, spot.position) : spot.player.ratings.fielding
  }

  /** 某個守位的守備值；投手沒有守備能力，當作聯盟平均 */
  fieldingAt(team: TeamState, fielder: Fielder): number {
    if (fielder === 'P') return AVERAGE_FIELDING
    const wall = hasRelic(team, 'ironWall') ? 1 : 0
    const spot = team.lineup.find((s) => s.position === fielder)
    return (spot ? this.spotFielding(spot) : AVERAGE_FIELDING) + wall
  }

  /** 整隊的守備範圍：指定打擊不算 */
  teamDefense(team: TeamState): number {
    const fielders = team.lineup.filter((s) => s.position !== 'DH')
    const wall = hasRelic(team, 'ironWall') ? 1 : 0
    return fielders.reduce((sum, s) => sum + this.spotFielding(s), 0) / fielders.length + wall
  }

  /** 盜壘成功率：跑者速度對上捕手守備。penalty 用於打帶跑揮空時 */
  /** synergy 是 false 時算的是沒有羈絆加成的成功率（判斷羈絆促成用） */
  stealChance(from: 1 | 2, penalty = 0, synergy = true): number {
    const runner = this.bases[from - 1]
    if (!runner) return 0
    const catcher = this.fieldingAt(this.fielding, 'C')
    const bonus = synergy
      ? SYNERGY_EFFECT.steal[this.boost(this.batting, runner, 'speed')] - (this.positionSynergy(this.fielding, 'battery') ? SYNERGY_EFFECT.batterySteal : 0)
      : 0
    return clamp(
      0.55 +
        (runner.ratings.speed - 5) * 0.06 +
        (hasTrait(runner, 'stealer') ? 0.15 : 0) +
        (hasRelic(this.batting, 'speedster') ? 0.1 : 0) +
        bonus -
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

  /**
   * 這個打席是不是交給教練親自出手的關鍵打席（ADR-0002），不是就回傳 null。
   * 英雄時刻：第 8 局以後，打者這邊落後或平手，得點圈的跑者數夠這一支安打追平或超前（攻守兩邊都算）；
   * 延長賽每個半局都從二壘有人開始，所以英雄時刻只算半局的第一個打席，不然平手時每個打席都是；
   * 滿壘：我方守備時任何一局；後段：第 7 局以後、比分差 1 分內、二三壘都有人（攻守兩邊都算）
   */
  keyAtBat(): KeyAtBatReason | null {
    if (this.over) return null
    const [, second, third] = this.bases
    const risp = (second ? 1 : 0) + (third ? 1 : 0)
    const behind = this.score[this.fieldingSide] - this.score[this.battingSide]
    const heroAllowed = this.inning < 10 || this.paIndex === this.halfStartPa
    if (this.inning >= 8 && heroAllowed && behind >= 0 && risp >= Math.max(1, behind)) return 'hero'
    if (this.fieldingSide === this.userSide && this.bases.every(Boolean)) return 'basesLoaded'
    if (this.nearAwakening()) return 'milestone'
    if (this.inning >= 7 && Math.abs(behind) <= 1 && second && third) return 'crunch'
    return null
  }

  /**
   * 差一步：我方這位打者（或投手）這個打席有機會讓潛能覺醒。
   * 安打、全壘打差一支；打點差的數字壘上跑者加打者自己就夠；投手三振差一次。出局數一個打席湊不到，不算
   */
  private nearAwakening(): boolean {
    const batting = this.battingSide === this.userSide
    const p: Player = batting ? this.batter : this.pitcher
    const pot = p.potential
    if (!pot) return false
    const left = pot.need - pot.progress - (this.box[p.id]?.[pot.stat] ?? 0)
    if (left <= 0) return false
    if (!batting) return pot.stat === 'k' && left === 1
    if (pot.stat === 'hits' || pot.stat === 'hr') return left === 1
    return pot.stat === 'rbi' && left <= this.bases.filter(Boolean).length + 1
  }

  /** 第 7 局以後、比分差 1 分以內、得點圈有人：真正能左右勝負的時刻 */
  isCrunchTime(): boolean {
    return this.inning >= 7 && Math.abs(this.score.home - this.score.away) <= 1 && !!(this.bases[1] || this.bases[2])
  }

  /**
   * 守備佈陣對目前打者的安打率修正（負數代表比較不容易被打安打）。
   * 偏向打者習慣的方向能沒收安打，猜錯方向反而留下大洞；內野前進、外野後退都會讓一壘安打變多
   */
  alignmentEffect(alignment: Alignment = this.alignment, tendency: Tendency = this.hitDirection()): number {
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
   * 現在能不能親自出手：每一球都可以（「親自操作」模式就是每球都出手），
   * 只是不能跟其他排著的戰術同時。進攻時是親自出棒，守備時是決勝球
   */
  takeOver(): TakeOverKind | null {
    if (this.over || this.queued) return null
    if (this.battingSide === this.userSide) return 'swing'
    return this.pitchMix ? 'throw' : 'aimPitch'
  }

  /**
   * 計量條的目標區：出棒看打者的打擊，投球看投手的控球，體力越低越窄。
   * 早期的紀錄還有猜球：猜中變寬、猜錯變窄（現在的畫面不猜了）
   */
  meterZone(kind: 'swing' | 'aimPitch', guess?: PitchGuess): MeterZone {
    let good: number
    if (kind === 'swing') {
      good = 0.05 + clamp(this.effectiveContact(this.batter), 0, 10) * 0.008
      if (this.pitchMix && guess) good *= this.guessRight(guess) ? GUESS_ZONE.right : GUESS_ZONE.wrong
    } else {
      const control = clamp(this.effectivePitcher().control, 0, 10)
      good = (0.05 + control * 0.008) * (0.6 + 0.4 * this.staminaLeft(this.fielding))
    }
    return { center: METER_CENTER, good, perfect: good * 0.35 }
  }

  /** AI 投手這一球要投的球種（由種子和步數決定，出棒後寫進比賽紀錄） */
  nextPitch(): PitchType {
    return aiPitch(this.seed, this.stepIndex, this.pitcher, this.balls, this.strikes)
  }

  guessRight(guess: PitchGuess): boolean {
    return isBreaking(this.nextPitch()) === (guess === 'breaking')
  }

  /** 手勢的門檻：accuracy 到 good 算好球、到 perfect 算完美。控球越好越寬鬆，體力越低越嚴 */
  gestureZone(): { good: number; perfect: number } {
    const control = clamp(this.effectivePitcher().control, 0, 10)
    const slack = (0.2 + control * 0.03) * (0.6 + 0.4 * this.staminaLeft(this.fielding))
    const good = 1 - slack
    return { good, perfect: good + slack * 0.45 }
  }

  gradeGesture(accuracy: number): MeterGrade {
    const zone = this.gestureZone()
    return accuracy >= zone.perfect ? 'perfect' : accuracy >= zone.good ? 'good' : 'miss'
  }

  /** 出棒停的位置換算成擊球角度：偏早（偏下）拉打、偏晚（偏上）推打，正中打向中外野 */
  aimFor(timing: number, zone: MeterZone = this.meterZone('swing')): number {
    const offset = clamp((timing - zone.center) / zone.good, -1.5, 1.5)
    const pullSide = stance(this.batter, this.pitcher) === 'R' ? -1 : 1
    return -offset * pullSide * AIM_ANGLE
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
        ? this.takeOver() === tactic.type &&
          tactic.timing >= 0 &&
          tactic.timing <= 1 &&
          (tactic.type === 'aimPitch' || tactic.guess === undefined || (this.pitchMix && (tactic.guess === 'fastball' || tactic.guess === 'breaking')))
        : tactic.type === 'throw'
          ? this.takeOver() === 'throw' &&
            repertoire(this.pitcher).includes(tactic.pitch) &&
            (tactic.spot === undefined || (Number.isInteger(tactic.spot) && tactic.spot >= 0 && tactic.spot <= 8)) &&
            tactic.accuracy >= 0 &&
            tactic.accuracy <= 1
          : this.availableTactics().some((t) => sameTactic(t, tactic))
    if (!allowed) throw new Error(`現在不能下這個指令：${tactic.type}`)
    this.commands.push({ stepIndex: this.stepIndex, tactic })
    switch (tactic.type) {
      case 'alignment':
        this.alignment = tactic.alignment
        return []
      case 'swing':
      case 'aimPitch':
      case 'throw':
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
        const out = this.benchIn(team, spot, tactic.benchIndex)
        // 換了打者，AI 重新判斷佈陣，也可能換投回應
        const sub: GameEvent = { type: 'substitution', side: this.battingSide, kind: 'pinchHit', inId: spot.player.id, outId: out.id }
        return [sub, ...this.prepareAtBat()]
      }
      case 'pinchRun': {
        const team = this.batting
        const runner = this.bases[tactic.base - 1]!
        const spot = team.lineup.find((s) => s.player.id === runner.id)!
        this.benchIn(team, spot, tactic.benchIndex)
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
        const out = this.benchIn(team, spot, tactic.benchIndex)
        return [{ type: 'substitution', side: this.fieldingSide, kind: 'defense', inId: spot.player.id, outId: out.id }]
      }
    }
  }

  private changePitcher(team: TeamState, side: Side, relieverIndex: number): GameEvent[] {
    const out = team.pitcher
    team.pitcher = team.relievers.splice(relieverIndex, 1)[0]
    team.pitchCount = 0
    team.pitcherSincePa = this.paIndex
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
    else if (tactic?.type === 'throw') events.push(...this.pitch(false, this.throwPitch(tactic)))
    else events.push(...this.pitch(tactic?.type === 'hitAndRun'))
    this.stepIndex++
    return events
  }

  /**
   * 親自出手的這一球：完美不保證安打，只是大幅提高好結果的機率。
   * 出棒太早多半變界外或軟弱滾地，太晚多半揮空；決勝球失手不是壞球就是甜球
   */
  private takeOverPitch(t: { type: 'swing'; timing: number; guess?: PitchGuess } | { type: 'aimPitch'; timing: number }): PitchMod {
    const rng = this.rng
    const zone = t.type === 'swing' ? this.meterZone('swing', t.guess) : this.meterZone(t.type)
    const meter = gradeTiming(zone, t.timing)
    if (t.type === 'swing') {
      // 配球對決：擊球方向跟著停的位置走，畫面也標出對方投了什麼
      const mix: PitchMod = this.pitchMix ? { aim: this.aimFor(t.timing, zone), pitch: this.nextPitch() } : {}
      // 猜中球種，除了黃色區變寬，打出去的球也比較扎實
      const read = this.pitchMix && t.guess && this.guessRight(t.guess) ? GUESS_HIT : 0
      switch (meter) {
        case 'perfect':
          return { ...mix, meter, inZone: true, swing: true, result: 'inPlay', hit: 0.25 + read, power: 3 }
        case 'good':
          return { ...mix, meter, inZone: true, swing: true, result: rng.chance(0.75) ? 'inPlay' : 'foul', hit: 0.12 + read, power: 1 }
        case 'early':
          return { ...mix, meter, inZone: true, swing: true, result: rng.chance(0.45) ? 'foul' : 'inPlay', hit: -0.1 + read, power: -2 }
        default: {
          const r = rng.next()
          return { ...mix, meter, inZone: true, swing: true, result: r < 0.45 ? 'swingingStrike' : r < 0.7 ? 'foul' : 'inPlay', hit: -0.12 + read, power: -2 }
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

  /**
   * 配球：手勢畫得準、用看家球種、換著球種投，都讓打者更難打；同一個打席連投同一種球就容易被打。
   * 手勢畫歪是失投：一半變壞球、一半變甜球。
   * 早期的紀錄還有九宮格位置：投在角落、打者的弱點比較有利，投在正中間、打者的熱區比較不利
   */
  private throwPitch(t: { pitch: PitchType; spot?: number; accuracy: number }): PitchMod {
    const rng = this.rng
    const meter = this.gradeGesture(t.accuracy)
    const edge = this.pitchEdge(t.pitch, t.spot, meter === 'perfect')
    this.lastThrow = t.pitch
    const base: PitchMod = { meter, pitch: t.pitch, inZone: true, swing: true }
    const r = rng.next()
    if (meter === 'miss') {
      const ballP = t.spot === undefined ? 0.5 : t.spot === 4 ? 0.2 : isCorner(t.spot) ? 0.65 : 0.5
      return r < ballP ? { ...base, inZone: false, swing: false, result: 'ball' } : { ...base, result: 'inPlay', hit: 0.15, power: 2 }
    }
    const sharp = pitchTraitOf(this.pitcher, t.pitch) === 'sharp' ? PITCH_TRAIT_EFFECT.sharpWhiff : 0
    const whiff = clamp(0.12 + edge * 0.45 + PITCH_WHIFF[t.pitch] + sharp, 0.04, 0.6)
    if (r < whiff) return { ...base, result: 'swingingStrike' }
    if (r < whiff + 0.18) return { ...base, result: 'foul' }
    return { ...base, result: 'inPlay', hit: -edge * 0.35, power: Math.round(-edge * 4) }
  }

  /** 這一球對投手有多有利（約 -0.5～0.8）；沒有位置就不算位置的加減 */
  pitchEdge(pitch: PitchType, spot?: number, perfect = false): number {
    let edge = perfect ? 0.5 : 0.25
    if (spot !== undefined) {
      const zones = spotZones(spot, stance(this.batter, this.pitcher))
      if (spot === 4) edge -= 0.2
      else if (isCorner(spot)) edge += 0.1
      if (zones.includes(hotZone(this.batter))) edge -= 0.25
      if (zones.includes(coldZone(this.batter))) edge += 0.1
    }
    if (this.lastThrow === pitch) edge -= 0.2
    if (repertoire(this.pitcher)[1] === pitch) edge += 0.05
    // 精準：親自配球時這一球比較到位
    if (pitchTraitOf(this.pitcher, pitch) === 'command') edge += 0.1
    return edge
  }

  /** 這個打席上一球親自投的球種 */
  get previousThrow(): PitchType | null {
    return this.lastThrow
  }

  private pitch(hitAndRun: boolean, mod: PitchMod = {}): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const pitcher = this.pitcher
    const { stuff, control } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const twoStrikes = this.strikes === 2
    // 這一球的球種只給畫面用（投球動畫），不影響結果、不抽亂數；舊規則的比賽沒有球種
    const pitchType = mod.pitch ?? (this.pitchMix ? this.nextPitch() : undefined)
    this.fielding.pitchCount++
    this.pendingAssist = null
    // 錦標賽的球種特性與新球種：舊存檔的投手沒有這些欄位，結果不變
    const pitchTrait = pitchTraitOf(pitcher, pitchType)
    const command = pitchTrait === 'command' ? PITCH_TRAIT_EFFECT.commandZone : 0

    const zoneP = clamp(0.5 + (control - 5) * 0.035 - (hasTrait(pitcher, 'wild') ? 0.08 : 0) + command, 0.3, 0.72 + command)
    const inZone = mod.inZone ?? rng.chance(zoneP)
    const chase = inZone ? 0 : SYNERGY_EFFECT.skillChase[this.boost(this.batting, batter, 'skill')]
    const swingP = inZone
      ? 0.65 + (twoStrikes ? 0.15 : 0)
      : 0.32 + (twoStrikes ? 0.12 : 0) - (hasTrait(batter, 'eye') ? 0.12 : 0) - (this.balls === 3 ? 0.05 : 0) - (hasRelic(this.batting, 'patience') ? 0.06 : 0) - chase
    // 精準打線讓打者沒追打這顆壞球：剛好是第四壞球就算羈絆促成的保送
    let heldOff = false
    let swing: boolean
    if (mod.swing !== undefined) swing = mod.swing
    else if (hitAndRun) swing = true
    else {
      const u = rng.next()
      swing = u < swingP
      heldOff = !swing && u < swingP + chase
    }

    let result: PitchResult
    if (mod.result) {
      result = mod.result
    } else if (!swing) {
      result = inZone ? 'calledStrike' : 'ball'
    } else {
      const contactWith = (synergy: number) =>
        clamp(
          (inZone ? 0.8 : 0.55) +
            (contact - stuff) * 0.03 -
            (hasTrait(batter, 'freeSwinger') ? 0.08 : 0) -
            (hasTrait(pitcher, 'strikeoutArtist') ? 0.06 : 0) -
            (hasTrait(pitcher, 'escapeArtist') && this.scoringPosition() ? 0.05 : 0) -
            (pitchTrait === 'sharp' ? PITCH_TRAIT_EFFECT.sharpWhiff : 0) -
            (pitcher.extraPitches?.length ?? 0) * EXTRA_PITCH_CONTACT +
            synergy +
            (mod.contact ?? 0),
          0.2,
          0.95,
        )
      const skill = SYNERGY_EFFECT.skillContact[this.boost(this.batting, batter, 'skill')]
      const contactP = contactWith(skill - SYNERGY_EFFECT.powerWhiff[this.boost(this.batting, batter, 'power')])
      const u = rng.next()
      // 兩好球時因為精準打線才碰到球：算羈絆促成的「避開三振」
      if (u < contactP && u >= contactWith(0) && skill > 0 && twoStrikes) this.credit(this.battingSide, 'skill', 'avoidK')
      if (u >= contactP) result = 'swingingStrike'
      else if (rng.chance(0.42)) result = 'foul'
      else result = 'inPlay'
    }

    if (result === 'inPlay') {
      this.aimAngle = mod.aim ?? null
      // 尾勁：被打中也比較難形成安打
      const heavy = pitchTrait === 'heavy' ? { ...mod, hit: (mod.hit ?? 0) - PITCH_TRAIT_EFFECT.heavyHit } : mod
      const play = this.ballInPlay(hitAndRun, heavy)
      this.aimAngle = null
      return [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes, meter: mod.meter, pitch: pitchType }, ...play]
    }
    if (result === 'ball') this.balls++
    else if (result === 'foul') this.strikes = Math.min(2, this.strikes + 1)
    else this.strikes++
    const events: GameEvent[] = [{ type: 'pitch', result, balls: this.balls, strikes: this.strikes, meter: mod.meter, pitch: pitchType }]

    if (this.balls === 4) {
      if (heldOff) this.credit(this.battingSide, 'skill', 'walk')
      return [...events, ...this.walk('walk')]
    }
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
    const over = Math.max(0, team.pitchCount - this.fatigueLimit(p, team))
    const penalty = (over / 15) * (hasTrait(p, 'ironArm') ? 0.5 : 1)
    // 終結者：第 8 局起球威、控球都提升
    const closing = hasTrait(p, 'closer') && this.inning >= 8 ? 1.5 : 0
    // 秘寶：後援陣容（後援球威）、守護神（第 9 局起球威）、好球帶（控球）、王朝（都加）
    const dynasty = hasRelic(team, 'dynasty') ? 0.5 : 0
    const stuff =
      (hasRelic(team, 'deepRelief') && p.id !== team.starterId ? 1 : 0) + (hasRelic(team, 'guardian') && this.inning >= 9 ? 1.5 : 0) + dynasty
    const control = (hasRelic(team, 'strikeZone') ? 1 : 0) + dynasty + (this.positionSynergy(team, 'battery') ? SYNERGY_EFFECT.batteryControl : 0)
    return { stuff: p.ratings.stuff - penalty + closing + stuff, control: p.ratings.control - penalty + closing + control }
  }

  /** 打者對投手是同側還是對側；兩打永遠站對側 */
  matchup(batter: Batter = this.batter, pitcher: Pitcher = this.pitcher): 'same' | 'opposite' {
    return batter.bats !== 'S' && batter.bats === pitcher.throws ? 'same' : 'opposite'
  }

  /** 左右相剋對打擊的修正；舊規則的比賽沒有 */
  platoonEffect(batter: Batter = this.batter, pitcher: Pitcher = this.pitcher): number {
    return this.platoonOn ? PLATOON[this.matchup(batter, pitcher)] : 0
  }

  private effectiveContact(b: Batter): number {
    let k = b.ratings.contact + this.platoonEffect(b)
    if (this.bases[1] || this.bases[2]) {
      if (hasTrait(b, 'clutch')) k += 2
      if (hasTrait(b, 'clutchBad')) k -= 2
    }
    // 秘寶：開路先鋒（每半局第一棒）、得點圈之魂、逆轉魂（第 7 局起落後）、王朝
    const team = this.batting
    if (hasRelic(team, 'leadoff') && this.paIndex === this.halfStartPa) k += 2
    if (hasRelic(team, 'rispSoul') && this.scoringPosition()) k += 1
    if (hasRelic(team, 'comeback') && this.inning >= 7 && this.score[this.battingSide] < this.score[this.fieldingSide]) k += 1.5
    if (hasRelic(team, 'dynasty')) k += 0.5
    return k
  }

  private ballInPlay(hitAndRun: boolean, mod: PitchMod = {}): GameEvent[] {
    const rng = this.rng
    const batter = this.batter
    const { stuff } = this.effectivePitcher()
    const contact = this.effectiveContact(batter)
    const { speed } = batter.ratings
    // 重砲打線：擊球時力量提升（全壘打、長打、高飛球都跟著變多）
    const power =
      batter.ratings.power + (mod.power ?? 0) + (hasRelic(this.batting, 'dynasty') ? 0.5 : 0) + SYNERGY_EFFECT.slugPower[this.boost(this.batting, batter, 'power')]
    // 守備範圍好的隊伍，能把一部分安打變成出局
    const range = this.teamDefense(this.fielding) - AVERAGE_FIELDING
    // 羈絆：快腿 5 人階多內野安打、精準 5 人階兩好球後安打率提高、對方鐵壁 5 人階守備範圍變大
    const synergyHit =
      SYNERGY_EFFECT.infieldHit[this.boost(this.batting, batter, 'speed')] +
      (this.strikes === 2 ? SYNERGY_EFFECT.twoStrikeHit[this.boost(this.batting, batter, 'skill')] : 0) -
      SYNERGY_EFFECT.ironRange[this.synergyTier(this.fielding, 'defense')]
    const hitBase = 0.33 + (contact - 5) * 0.018 - (stuff - 5) * 0.012 + (speed - 5) * 0.005 - range * 0.015

    const pitcher = this.pitcher
    // 危機處理：得點圈有人時比較不容易被打安打
    const escape = hasTrait(pitcher, 'escapeArtist') && this.scoringPosition() ? 0.03 : 0
    const hitU = rng.next()
    const hitWith = (synergy: number) => clamp(clamp(hitBase + synergy, 0.15, 0.5) + (mod.hit ?? 0) + this.alignmentEffect() - escape, 0.05, 0.85)
    const isHit = hitU < hitWith(synergyHit)
    const plainHit = hitU < hitWith(0)
    if (isHit && !plainHit) {
      const fast = SYNERGY_EFFECT.infieldHit[this.boost(this.batting, batter, 'speed')] > 0
      this.credit(this.battingSide, fast ? 'speed' : 'skill', 'hit')
    }
    if (!isHit && plainHit) this.credit(this.fieldingSide, 'defense', 'hitSaved')
    if (isHit) {
      // 外野後退：長打大多被攔下來變成一壘安打
      const deep = this.alignment === 'outfieldBack' ? 0.4 : 1
      // 平飛打者多二、三壘安打；滾地球投手少被全壘打，被全壘打的投手反之
      const gaps = hasTrait(batter, 'lineDrive') ? 1.4 : 1
      const slug = this.boost(this.batting, batter, 'power')
      const homers =
        (hasTrait(pitcher, 'homerProne') ? 1.5 : hasTrait(pitcher, 'groundballer') ? 0.7 : 1) * (hasRelic(this.batting, 'powerHouse') ? 1.25 : 1)
      // 同一次亂數算有、沒有重砲打線時的安打種類，只差在羈絆就記功勞
      const kinds = (tier: SynergyTier): [PlayKind, number][] => {
        const pow = power - SYNERGY_EFFECT.slugPower[slug] + SYNERGY_EFFECT.slugPower[tier]
        const extra = SYNERGY_EFFECT.extraBase[tier]
        return [
          ['homeRun', Math.max(0.02, 0.1 + (pow - 5) * 0.035 + (hasTrait(batter, 'slugger') ? 0.08 : 0)) * homers * SYNERGY_EFFECT.homer[tier]],
          ['triple', Math.max(0.005, 0.025 + (speed - 5) * 0.006) * deep * gaps * extra],
          ['double', Math.max(0.08, 0.2 + (pow - 5) * 0.02) * deep * gaps * extra],
          ['single', 0.65],
        ]
      }
      const u = rng.next()
      const kind = weightedAt(kinds(slug), u)
      const plainKind = weightedAt(kinds(0), u)
      if (kind === 'homeRun' && plainKind !== 'homeRun') this.credit(this.battingSide, 'power', 'homeRun')
      else if ((kind === 'double' || kind === 'triple') && plainKind === 'single') this.credit(this.battingSide, 'power', 'extraBase')
      return this.hit(kind, hitAndRun)
    }
    // 滾地球投手讓打者多打成滾地球（也就多雙殺）
    const sinker = hasTrait(pitcher, 'groundballer') ? 0.15 : 0
    const type = rng.weighted<BattedBall['type']>([
      ['ground', 0.45 + sinker],
      ['fly', 0.4 + (power - 5) * 0.02 - sinker * 0.7],
      ['line', 0.15],
    ])
    const ball = this.outBall(type)
    const glove = this.fieldingAt(this.fielding, ball.fielder)
    // 好手套失誤減半、守備不穩失誤變多
    const handler = this.fielderPlayer(this.fielding, ball.fielder)
    const hands = handler && hasTrait(handler, 'goodGlove') ? 0.5 : handler && hasTrait(handler, 'errorProne') ? 1.8 : 1
    // 鐵壁球隊、黃金二遊（二游處理的球）讓失誤變少
    const iron = SYNERGY_EFFECT.ironError[this.synergyTier(this.fielding, 'defense')]
    const middle = (ball.fielder === '2B' || ball.fielder === 'SS') && this.positionSynergy(this.fielding, 'middle') ? SYNERGY_EFFECT.middleError : 1
    const errorBase = ERROR_RATE[type] * clamp(1 + (AVERAGE_FIELDING - glove) * 0.18, 0.25, 2.2) * hands
    const errorU = rng.next()
    if (errorU < errorBase * iron * middle) return this.reachOnError(ball)
    if (errorU < errorBase) this.credit(this.fieldingSide, iron < 1 ? 'defense' : 'middle', 'errorSaved')
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

  /** 打者傾向的平均擊球角度；親自出棒時改成瞄準的方向 */
  private get pull(): number {
    return this.aimAngle ?? TENDENCY_MEAN[this.batter.tendency]
  }

  /** 擊球角度：平均是 pull，親自瞄準時比較集中 */
  private direction(sd: number): number {
    return this.rng.normal(this.pull, this.aimAngle === null ? sd : sd * 0.6)
  }

  /** 這顆球往哪邊飛：親自瞄準就看瞄準的方向，否則看打者的傾向（佈陣的效果照這個算） */
  private hitDirection(): Tendency {
    if (this.aimAngle === null) return this.batter.tendency
    return this.aimAngle < -10 ? 'left' : this.aimAngle > 10 ? 'right' : 'even'
  }

  /** 長打往哪一邊：瞄準了就往那邊，否則隨機（一樣抽一次亂數） */
  private gapSide(): number {
    const side = this.rng.pick([-1, 1])
    return this.aimAngle !== null && Math.abs(this.aimAngle) > 10 ? Math.sign(this.aimAngle) : side
  }

  private outBall(type: BattedBall['type']): BattedBall {
    const rng = this.rng
    if (type === 'ground') return this.makeBall(type, clamp(this.direction(22), -42, 42), rng.range(60, 125))
    if (type === 'fly') return this.makeBall(type, clamp(this.direction(25), -43, 43), rng.range(180, 370))
    return this.makeBall(type, clamp(this.direction(25), -42, 42), rng.range(90, 260))
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
    // 跑壘○：多推進一個壘包的判斷比速度看起來更好
    const spd = (b: Batter, synergy = true) =>
      b.ratings.speed -
      5 +
      (hasTrait(b, 'baserunner') ? 2 : 0) +
      (hasRelic(this.batting, 'speedster') ? 1 : 0) +
      (synergy ? SYNERGY_EFFECT.running[this.boost(this.batting, b, 'speed')] : 0)
    // 多推進一個壘：同一次亂數算有、沒有快腿球隊時的結果
    const advance = (runner: Batter, chance: (s: number) => number) => {
      const u = rng.next()
      const made = u < chance(spd(runner))
      if (made && u >= chance(spd(runner, false))) this.credit(this.battingSide, 'speed', 'advance')
      return made
    }
    let ball: BattedBall
    switch (kind) {
      case 'homeRun': {
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 4)
        // 一定飛過該方向的全壘打牆；力量越大打得越遠。亂數用量跟以前一樣，舊存檔重播不受影響
        const angle = clamp(this.direction(25), -43, 43)
        const distance = fenceDistance(angle) + Math.max(5, 8 + rng.range(0, 60) + (batter.ratings.power - 5) * 5)
        ball = { type: 'fly', angle, distance, fielder: fielderFor('fly', angle, distance) }
        break
      }
      case 'triple':
        for (const [i, r] of [b3, b2, b1].entries()) if (r) move(r, (3 - i) as BaseNumber, 4)
        move(batter, 0, 3)
        // 三壘安打：打穿外野空檔或沿著邊線
        ball = this.makeBall('line', toGap(this.gapSide() * rng.range(25, 42), this.gaps('outfield')), rng.range(330, 390))
        break
      case 'double':
        if (b3) move(b3, 3, 4)
        if (b2) move(b2, 2, 4)
        if (b1) move(b1, 1, advance(b1, (s) => 0.35 + s * 0.05 + (hitAndRun ? 0.3 : 0)) ? 4 : 3)
        move(batter, 0, 2)
        ball = this.makeBall('line', toGap(this.gapSide() * rng.range(12, 40), this.gaps('outfield')), rng.range(260, 360))
        break
      default: {
        if (b3) move(b3, 3, 4)
        if (b2) move(b2, 2, advance(b2, (s) => 0.55 + s * 0.06) ? 4 : 3)
        if (b1) {
          const extra = !taken.has(3) && (hitAndRun || advance(b1, (s) => 0.25 + s * 0.04))
          move(b1, 1, extra ? 3 : 2)
        }
        move(batter, 0, 1)
        const ground = rng.chance(0.5)
        // 滾地安打穿過內野手之間的空檔；平飛安打落在外野手之間的前方
        ball = ground
          ? this.makeBall('ground', toGap(clamp(this.direction(25), -40, 40), this.gaps('infield')), rng.range(130, 170))
          : this.makeBall('line', toGap(clamp(this.direction(25), -40, 40), this.gaps('shallow')), rng.range(160, 240))
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
    const middle = this.positionSynergy(this.fielding, 'middle') ? SYNERGY_EFFECT.middleDoublePlay : 0
    let doublePlay = false
    if (b1 && this.outs < 2 && !hitAndRun) {
      const u = rng.next()
      doublePlay = u < dpP + middle
      if (doublePlay && u >= dpP) this.credit(this.fieldingSide, 'middle', 'doublePlay')
    }
    if (doublePlay && b1) {
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
    // 一次亂數同時判斷有、沒有羈絆時的結果，只差在羈絆就記功勞
    const u = this.rng.next()
    const success = u < this.stealChance(from, penalty)
    const plain = u < this.stealChance(from, penalty, false)
    this.pendingAssist = null
    if (success && !plain) this.credit(this.battingSide, 'speed', 'steal')
    if (!success && plain) this.credit(this.fieldingSide, 'battery', 'caughtStealing')
    if (success && runner.archetype === 'speed') this.synergyStats[this.battingSide].speedSB++
    if (!success) this.synergyStats[this.fieldingSide].caughtStealing++
    const moves: RunnerMove[] = [{ runnerId: runner.id, from, to: success ? ((from + 1) as BaseNumber) : 'out' }]
    this.applyMoves(moves)
    const assist = this.pendingAssist ?? undefined
    this.pendingAssist = null
    const events: GameEvent[] = [{ type: 'steal', runnerId: runner.id, from, success, moves, ...(assist ? { assist } : {}) }]
    if (this.outs >= 3) events.push(...this.endHalfInning())
    events.push(...this.prepareAtBat())
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
    const pitcherId = this.pitcher.id
    if (HIT_KINDS.includes(kind)) this.hits[this.battingSide]++
    if (kind === 'error') this.errors[this.fieldingSide]++
    const outsBefore = this.outs
    const runs = this.applyMoves(moves)
    this.record(batterId, pitcherId, kind, runs, Math.min(3, this.outs) - outsBefore)
    this.recordSynergyStats(kind)
    const assist = this.pendingAssist ?? undefined
    this.pendingAssist = null
    const events: GameEvent[] = [{ type: 'play', kind, batterId, ball, moves, runs, notation, ...(assist ? { assist } : {}) }]
    const team = this.batting
    team.battingIndex = (team.battingIndex + 1) % 9
    this.balls = 0
    this.strikes = 0
    this.paIndex++
    this.alignment = 'normal'
    this.lastThrow = null
    if (this.half === 'bottom' && this.inning >= 9 && this.score.home > this.score.away) {
      return [...events, this.endGame('home')]
    }
    if (this.outs >= 3) events.push(...this.endHalfInning())
    events.push(...this.prepareAtBat())
    return events
  }

  /** 賽後羈絆區塊的相關數據：依打者流派與守備方記下全壘打、三振、保送、雙殺 */
  private recordSynergyStats(kind: PlayKind): void {
    const bat = this.synergyStats[this.battingSide]
    const field = this.synergyStats[this.fieldingSide]
    const { archetype } = this.batter
    if (kind === 'homeRun' && archetype === 'power') bat.powerHR++
    if (kind === 'strikeout') {
      if (archetype === 'power') bat.powerK++
      if (archetype === 'skill') bat.skillK++
    }
    if (kind === 'walk' || kind === 'intentionalWalk') {
      if (archetype === 'skill') bat.skillBB++
      field.walksAllowed++
    }
    if (kind === 'doublePlay') field.doublePlays++
  }

  private line(id: string): PlayerLine {
    return (this.box[id] ??= { pa: 0, hits: 0, hr: 0, rbi: 0, so: 0, outs: 0, runs: 0, k: 0 })
  }

  /** 記下這個打席的個人成績：失誤和雙殺不算打點 */
  private record(batterId: string, pitcherId: string, kind: PlayKind, runs: number, outs: number): void {
    const b = this.line(batterId)
    b.pa++
    if (HIT_KINDS.includes(kind)) b.hits++
    if (kind === 'homeRun') b.hr++
    if (kind !== 'error' && kind !== 'doublePlay') b.rbi += runs
    if (kind === 'strikeout') b.so++
    const p = this.line(pitcherId)
    p.outs += Math.max(0, outs)
    p.runs += runs
    if (kind === 'strikeout') p.k++
  }

  private endHalfInning(): GameEvent[] {
    const events: GameEvent[] = [{ type: 'halfInningEnd', inning: this.inning, half: this.half }]
    this.outs = 0
    this.balls = 0
    this.strikes = 0
    this.bases = [null, null, null]
    this.queued = null
    this.halfStartPa = this.paIndex
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

function emptySynergyStats(): SynergyStats {
  return { powerHR: 0, powerK: 0, speedSB: 0, skillK: 0, skillBB: 0, doublePlays: 0, walksAllowed: 0, caughtStealing: 0 }
}

/** 跟 Rng.weighted 一樣的挑法，但用給定的亂數 u，才能拿同一個亂數比較兩組權重 */
function weightedAt<T>(entries: readonly (readonly [T, number])[], u: number): T {
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0)
  let roll = u * total
  for (const [value, w] of entries) {
    roll -= Math.max(0, w)
    if (roll < 0) return value
  }
  return entries[entries.length - 1][0]
}

function hasRelic(team: TeamState, id: RelicId): boolean {
  return team.relics.includes(id)
}

/** 猜球對計量條黃色區的影響：猜中變寬、猜錯變窄 */
export const GUESS_ZONE = { right: 1.5, wrong: 0.65 }
/** 猜中球種時的安打率加成 */
const GUESS_HIT = 0.05

/** 計量條停在黃色區邊緣時，瞄準的擊球角度（度） */
const AIM_ANGLE = 28

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
  // 規則改版後，舊紀錄裡的指令可能已經不合法（例如壘上沒人了還要盜壘）；略過它，不要讓整場比賽打不開
  const issue = (t: Tactic) => {
    try {
      game.issue(t)
    } catch {
      // 略過
    }
  }
  while (!game.over && game.stepIndex < steps) {
    while (c < commands.length && commands[c].stepIndex === game.stepIndex) issue(commands[c++].tactic)
    game.step()
  }
  while (c < commands.length && commands[c].stepIndex === game.stepIndex && !game.over) issue(commands[c++].tactic)
  return game
}
