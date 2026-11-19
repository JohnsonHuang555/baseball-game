// 正式記分（Phase 8）：從比賽的打席、盜壘、換人記下完整的個人原始數據，包含跑者責任與自責分。
// 規格見 docs/phase8-statistics-spec.md。
//
// 只讀比賽狀態、不呼叫亂數、不改變比賽：同一個種子與指令，比賽結果跟沒有記分時完全一樣。
// PlayerLine（game.ts）維持原樣給錦標賽成長與 MVP 用，這裡是另外一份。
import type { PlayKind, RunnerMove } from './game'

/** 打者的原始數據（全部是計數，比率由 v2/domain/stats.ts 從累積值算） */
export interface BattingCounts {
  pa: number
  ab: number
  r: number
  h: number
  /** 二壘安打 */
  d: number
  /** 三壘安打 */
  t: number
  hr: number
  rbi: number
  /** 四壞（含故意四壞） */
  bb: number
  ibb: number
  /** 觸身球：引擎沒有這種結果，永遠是 0 */
  hbp: number
  sf: number
  sh: number
  so: number
  gidp: number
  /** 因失誤上壘 */
  roe: number
}

/** 投手的原始數據 */
export interface PitchingCounts {
  /** 面對打者數 */
  bf: number
  /** 投球期間製造的出局數（含盜壘刺殺） */
  outs: number
  h: number
  hr: number
  r: number
  er: number
  bb: number
  ibb: number
  hbp: number
  k: number
}

export const BATTING_KEYS = ['pa', 'ab', 'r', 'h', 'd', 't', 'hr', 'rbi', 'bb', 'ibb', 'hbp', 'sf', 'sh', 'so', 'gidp', 'roe'] as const
export const PITCHING_KEYS = ['bf', 'outs', 'h', 'hr', 'r', 'er', 'bb', 'ibb', 'hbp', 'k'] as const

/** 一位球員一場比賽的記錄：有出場的那一邊才有（打者出場＝先發打線或替補上場；投手出場＝登板） */
export interface ScoreLine {
  batting: BattingCounts | null
  pitching: PitchingCounts | null
}

export const emptyBatting = (): BattingCounts => ({ pa: 0, ab: 0, r: 0, h: 0, d: 0, t: 0, hr: 0, rbi: 0, bb: 0, ibb: 0, hbp: 0, sf: 0, sh: 0, so: 0, gidp: 0, roe: 0 })
export const emptyPitching = (): PitchingCounts => ({ bf: 0, outs: 0, h: 0, hr: 0, r: 0, er: 0, bb: 0, ibb: 0, hbp: 0, k: 0 })

const HITS: ReadonlySet<PlayKind> = new Set(['single', 'double', 'triple', 'homeRun'])
/** 算打數的打席結果（保送、高飛犧牲打、犧牲觸擊不算） */
const AT_BAT: ReadonlySet<PlayKind> = new Set(['single', 'double', 'triple', 'homeRun', 'groundOut', 'flyOut', 'lineOut', 'strikeout', 'buntPopOut', 'doublePlay', 'error'])
/** 打席中途換投時，這些球數之下的保送記給前一位投手（OBR 9.16(h)） */
const PITCHER_BEHIND = new Set(['2-0', '2-1', '3-0', '3-1', '3-2'])

/** 跑者怎麼上壘的：安打／保送等（hit）、失誤上壘（error）、延長賽突破僵局放上二壘（tiebreak） */
export type ReachKind = 'batted' | 'error' | 'tiebreak'

interface RunnerInfo {
  /** 要為這位跑者負責的投手 */
  pitcherId: string
  /** 不是因為失誤（或延長賽規則）上壘 */
  earnedReach: boolean
  reach: ReachKind
  /** 在失誤上壘那一球多推進的壘包數（自責分的已知限制，見規格 §6） */
  errorBases: number
}

/**
 * 一分的記分明細（只在記憶體裡，給測試與分析用，不存檔）：哪個半局、哪一球、誰得分、算誰的、自責與否與判斷依據
 */
export interface RunRecord {
  /** 第幾個半局（從 0 數） */
  half: number
  kind: PlayKind | 'steal'
  runnerId: string
  /** 失分記給誰（放他上壘的投手） */
  pitcherId: string
  /** 得分當下在投的投手 */
  moundId: string
  reach: ReachKind
  errorBases: number
  outsBefore: number
  /** 這一球造成的出局數 */
  outsAdded: number
  /** 重建後這一球之前的出局數（實際出局＋該投手上場後的失誤機會） */
  reconstructedOuts: number
  earned: boolean
}

export interface PlayInput {
  kind: PlayKind
  batterId: string
  pitcherId: string
  /** 擊球種類（沒擊到球是 null）：用來分辨滾地雙殺 */
  ballType: 'ground' | 'fly' | 'line' | null
  moves: readonly RunnerMove[]
  /** 這一球之前的出局數 */
  outsBefore: number
}

export class Scorekeeper {
  readonly lines: Record<string, ScoreLine> = {}
  /** 每一分的記分明細（只在記憶體裡） */
  readonly runLog: RunRecord[] = []
  private halfIndex = 0
  private readonly runners = new Map<string, RunnerInfo>()
  /** 本半局的失誤上壘次數（重建半局時每一次都當作本來該有的出局） */
  private chances = 0
  /** 半局中途上場的投手：上場時的 chances */
  private readonly entryChances = new Map<string, number>()
  /** 這個打席中途被換下的投手與當時的球數 */
  private pitcherCarry: { pitcherId: string; count: string } | null = null
  /** 這個打席中途被兩好球換下的打者 */
  private strikeoutCarry: string | null = null

  private line(id: string): ScoreLine {
    return (this.lines[id] ??= { batting: null, pitching: null })
  }

  private bat(id: string): BattingCounts {
    const l = this.line(id)
    return (l.batting ??= emptyBatting())
  }

  private pit(id: string): PitchingCounts {
    const l = this.line(id)
    return (l.pitching ??= emptyPitching())
  }

  /** 打者出場（先發打線、代打、代跑、守備替補） */
  appearBatter(id: string): void {
    this.bat(id)
  }

  /** 投手登板 */
  appearPitcher(id: string): void {
    this.pit(id)
  }

  /** 換投；balls、strikes 是當時這個打席的球數 */
  pitcherIn(outId: string, inId: string, balls: number, strikes: number): void {
    this.appearPitcher(inId)
    this.entryChances.set(inId, this.chances)
    if (balls + strikes > 0 && !this.pitcherCarry) this.pitcherCarry = { pitcherId: outId, count: `${balls}-${strikes}` }
  }

  /** 代打；strikes 是當時的好球數 */
  pinchHit(outId: string, inId: string, strikes: number): void {
    this.appearBatter(inId)
    if (strikes === 2 && !this.strikeoutCarry) this.strikeoutCarry = outId
  }

  /** 代跑：跑者的責任與自責與否原樣轉給代跑者 */
  pinchRun(outId: string, inId: string): void {
    this.appearBatter(inId)
    const info = this.runners.get(outId)
    this.runners.delete(outId)
    if (info) this.runners.set(inId, info)
  }

  /** 守備替補 */
  defensiveSub(inId: string): void {
    this.appearBatter(inId)
  }

  /** 延長賽放在二壘的跑者：視同因失誤上壘，屬於當時在場的投手 */
  placeRunner(runnerId: string, pitcherId: string): void {
    this.runners.set(runnerId, { pitcherId, earnedReach: false, reach: 'tiebreak', errorBases: 0 })
  }

  /** 一個打席結束。回傳不影響比賽，只是記錄 */
  play(input: PlayInput): void {
    const { kind, batterId, pitcherId, moves, outsBefore } = input
    const outsAdded = moves.filter((m) => m.to === 'out').length
    const runsCount = outsBefore + outsAdded < 3
    const walk = kind === 'walk' || kind === 'intentionalWalk'
    // 這個打者算誰的：打席中途換投、而且當時投手落後球數時被保送，算前一位投手
    const carry = this.pitcherCarry
    const chargedId = walk && carry && PITCHER_BEHIND.has(carry.count) ? carry.pitcherId : pitcherId
    // 三振算誰的：代打者接手兩好球後被三振，三振與打數記給原打者
    const strikeoutBatter = kind === 'strikeout' && this.strikeoutCarry ? this.strikeoutCarry : batterId
    const runs = runsCount ? moves.filter((m) => m.to === 4).length : 0

    const b = this.bat(kind === 'strikeout' ? strikeoutBatter : batterId)
    b.pa++
    if (AT_BAT.has(kind)) b.ab++
    if (HITS.has(kind)) b.h++
    if (kind === 'double') b.d++
    if (kind === 'triple') b.t++
    if (kind === 'homeRun') b.hr++
    if (walk) b.bb++
    if (kind === 'intentionalWalk') b.ibb++
    if (kind === 'sacrificeFly') b.sf++
    if (kind === 'sacrificeBunt') b.sh++
    if (kind === 'strikeout') b.so++
    if (kind === 'doublePlay' && input.ballType === 'ground') b.gidp++
    if (kind === 'error') b.roe++
    // 打點沿用引擎的規則：失誤、雙殺不給打點
    if (kind !== 'error' && kind !== 'doublePlay') b.rbi += runs

    const p = this.pit(chargedId)
    p.bf++
    if (HITS.has(kind)) p.h++
    if (kind === 'homeRun') p.hr++
    if (walk) p.bb++
    if (kind === 'intentionalWalk') p.ibb++
    if (kind === 'strikeout') p.k++
    // 出局數記給場上的投手
    this.pit(pitcherId).outs += Math.min(3, outsBefore + outsAdded) - outsBefore

    const next = new Map(this.runners)
    for (const m of moves) {
      const info: RunnerInfo =
        m.from === 0
          ? { pitcherId: chargedId, earnedReach: kind !== 'error', reach: kind === 'error' ? 'error' : 'batted', errorBases: 0 }
          : (this.runners.get(m.runnerId) ?? { pitcherId, earnedReach: true, reach: 'batted', errorBases: 0 })
      next.delete(m.runnerId)
      if (m.to === 'out') continue
      if (m.to === 4) {
        if (!runsCount) continue
        this.bat(m.runnerId).r++
        const charged = this.pit(info.pitcherId)
        charged.r++
        const reconstructedOuts = outsBefore + this.chances - (this.entryChances.get(info.pitcherId) ?? 0)
        // 重建後，這一球本身造成的出局也要算：例如重建已經 2 出局時的高飛犧牲打，接殺就是第三出局，跑者不會回來
        const earned = info.earnedReach && kind !== 'error' && reconstructedOuts + outsAdded < 3
        if (earned) charged.er++
        this.runLog.push({ half: this.halfIndex, kind, runnerId: m.runnerId, pitcherId: info.pitcherId, moundId: pitcherId, reach: info.reach, errorBases: info.errorBases, outsBefore, outsAdded, reconstructedOuts, earned })
        continue
      }
      next.set(m.runnerId, kind === 'error' && m.from > 0 ? { ...info, errorBases: info.errorBases + (m.to - m.from) } : info)
    }
    this.runners.clear()
    for (const [id, info] of next) this.runners.set(id, info)
    if (kind === 'error') this.chances++
    this.pitcherCarry = null
    this.strikeoutCarry = null
  }

  /** 盜壘：刺殺的出局記給場上的投手 */
  steal(moves: readonly RunnerMove[], pitcherId: string, outsBefore: number): void {
    for (const m of moves) {
      if (m.to === 'out') {
        this.runners.delete(m.runnerId)
        if (outsBefore < 3) this.pit(pitcherId).outs++
      } else if (m.to === 4) {
        // 引擎的盜壘不會得分；真的發生就照一般得分處理，避免漏記
        const info = this.runners.get(m.runnerId)
        this.runners.delete(m.runnerId)
        this.bat(m.runnerId).r++
        if (info) {
          const charged = this.pit(info.pitcherId)
          charged.r++
          const reconstructedOuts = outsBefore + this.chances - (this.entryChances.get(info.pitcherId) ?? 0)
          const earned = info.earnedReach && reconstructedOuts < 3
          if (earned) charged.er++
          this.runLog.push({ half: this.halfIndex, kind: 'steal', runnerId: m.runnerId, pitcherId: info.pitcherId, moundId: pitcherId, reach: info.reach, errorBases: info.errorBases, outsBefore, outsAdded: 0, reconstructedOuts, earned })
        }
      }
    }
  }

  /** 半局結束：壘包、失誤機會、打席中的換人都清掉 */
  halfEnd(): void {
    this.halfIndex++
    this.runners.clear()
    this.chances = 0
    this.entryChances.clear()
    this.pitcherCarry = null
    this.strikeoutCarry = null
  }
}
