// V2 自動教練：替 Game 的 userSide 那一方自動下指令（換投、代打、佈陣、盜壘、觸擊）。
// 只讀比賽狀態、透過 game.issue() 下指令，不碰 DOM、畫面或動畫；指令會照常記進 game.commands，
// 所以用引擎的 replay(setup, commands) 就能重現整場。另一方由引擎內建的 AI 負責（見 matchRunner）。
import { sameTactic, type Alignment, type Game, type GameEvent, type Tactic } from '../../sim/game'
import { fieldingAtPosition } from '../../sim/positions'
import { hasTrait } from '../../sim/traits'
import type { Batter, Pitcher } from '../../sim/types'

/**
 * 自動教練的邏輯版本。教練的判斷改了，同一個種子會打出不同的比賽，所以跟規則版本分開記。
 * 重播不靠這個版本：重播用的是記下來的指令紀錄。
 * 2（Phase 9 PR 2）：加上強攻、機動、守備三種風格；均衡型的判斷逐指令不變（coach-balanced-golden），
 * 所以版本 1 的比賽（全部是均衡型）用版本 2 的程式重新模擬，結果一樣
 */
export const AUTO_COACH_VERSION = 2

/** 戰術風格：四種風格共用同一個決策框架（StylePolicy），差別在 COACH_PRESETS 的參數與少數風格專用的判斷 */
export type CoachStyle = 'balanced' | 'power' | 'speed' | 'defense'
export const COACH_STYLES: readonly CoachStyle[] = ['balanced', 'power', 'speed', 'defense']

/** 自動教練的可調參數。前 7 項是 Phase 4 起的均衡型參數；後面幾項是 Phase 9 的風格專用判斷，均衡型全部關閉或維持原本的數值 */
export interface CoachParams {
  /**
   * 投球數超過疲勞門檻幾球就換投（0 = 一到門檻就換；負數 = 提早換，守備型）。
   * 負數時實際門檻不低於疲勞門檻的 60%（FATIGUE_FLOOR），先發不會在前幾局就被換下
   */
  fatigueMargin: number
  /** 左右相剋換投時，現任投手至少要面對幾位打者（避免一直換） */
  minBattersFaced: number
  /** 後段比分接近時，依左右投打相剋換投、派代打 */
  latePlatoon: boolean
  /** 守備佈陣（跟引擎內建 AI 同一套判斷） */
  align: boolean
  /** 盜壘一壘→二壘的最低成功率；二壘→三壘要再高 0.1 */
  stealMin: number
  /** 比分差超過這個數就不盜壘 */
  stealMaxRunDiff: number
  /** 平手或小比分差、無人出局時，讓弱打者犧牲觸擊 */
  sacBunt: boolean
  /** 犧牲觸擊從第幾局開始（含延長賽）；均衡 8 */
  buntFromInning: number
  /** 犧牲觸擊的比分範圍：落後 1 分到領先幾分；均衡 0（平手或落後 1 分） */
  buntMaxLead: number
  /** 只讓打擊不強的打者觸擊：打擊＋長打不超過這個數；均衡 10 */
  buntBatterMax: number
  /** 打帶跑（機動型）：一壘有人、跑者速度 6 以上、打者擊球能力 6 以上 */
  hitAndRun: boolean
  /** 代跑（機動型）：後段比分接近，用板凳上快很多的球員換下慢的跑者 */
  pinchRun: boolean
  /** 保護強打（強攻型）：長打 7 以上的打者打擊時不盜壘、不被代打，讓他自己打完打席 */
  protectSlugger: boolean
  /** 後段守成（守備型）：8 局後領先 1～3 分、投手已經用掉七成體力，換上最好的後援（9 局起優先終結者） */
  lateRelief: boolean
  /** 守備替補（守備型）：7 局後領先 1～3 分，板凳有守同一個守位明顯更好的人就換上 */
  defensiveSubs: boolean
}

/** 負數 fatigueMargin 的下限：實際換投門檻不低於疲勞門檻的這個比例（RFC §3） */
export const FATIGUE_FLOOR = 0.6

const BALANCED: CoachParams = {
  fatigueMargin: 0,
  minBattersFaced: 3,
  latePlatoon: true,
  align: true,
  stealMin: 0.75,
  stealMaxRunDiff: 3,
  sacBunt: true,
  buntFromInning: 8,
  buntMaxLead: 0,
  buntBatterMax: 10,
  hitAndRun: false,
  pinchRun: false,
  protectSlugger: false,
  lateRelief: false,
  defensiveSubs: false,
}

/**
 * 四種風格的預設參數。風格之間的差別只在決策（什麼時候跑、觸擊、換投、換人），沒有任何能力加成。
 * - 強攻：不觸擊、只在把握很高時盜壘、強打者不被代打也不在他打擊時冒險跑壘
 * - 機動：盜壘門檻較低（0.70；0.65 在模擬裡會白白送出局數）、比分差較大也跑、7 局起觸擊（含領先 1 分）、打帶跑、後段代跑
 * - 守備：提早 15 球換投、相剋換投較積極、後段領先換上最好的後援、守備替補
 */
export const COACH_PRESETS: Record<CoachStyle, CoachParams> = {
  balanced: BALANCED,
  power: { ...BALANCED, stealMin: 0.85, sacBunt: false, protectSlugger: true },
  speed: { ...BALANCED, stealMin: 0.7, stealMaxRunDiff: 4, buntFromInning: 7, buntMaxLead: 1, buntBatterMax: 11, hitAndRun: true, pinchRun: true },
  defense: { ...BALANCED, fatigueMargin: -15, minBattersFaced: 2, lateRelief: true, defensiveSubs: true },
}

/**
 * 決策策略（Strategy）：看目前的比賽狀態，回傳下一個要下的指令，沒有就回傳 null。
 * 不能改 game、不能用亂數，同樣的狀態一定給同樣的答案，比賽才可以重現
 */
export interface CoachPolicy {
  readonly style: CoachStyle
  next(game: Game): Tactic | null
}

/** 一個打席最多下幾個指令（保險：策略寫錯也不會卡在同一個打席） */
const MAX_ACTIONS_PER_PA = 4

/** 會排到下一步才執行的戰術：同一時間只能有一個 */
const QUEUED_TYPES: ReadonlySet<Tactic['type']> = new Set(['steal', 'bunt', 'hitAndRun', 'swing', 'aimPitch', 'throw'])

/**
 * 自動教練：負責「什麼時候問策略、問到的指令能不能下」，判斷本身交給 CoachPolicy。
 * 每個打席開始時（還沒投球）只決策一次（打席以局數、上下半局、打席序號識別）；每個指令先確認在 availableTactics() 裡、
 * 同一打席不重複、同時最多排一個戰術，才交給 game.issue()
 */
export class AutoCoach {
  /** 上一次決策的打席：局數、上下半局加上打席序號 */
  private decided: string | null = null

  constructor(readonly policy: CoachPolicy) {}

  /** 每次 game.step() 之前呼叫；回傳這次下的指令產生的事件（換人等） */
  act(game: Game): GameEvent[] {
    // 不能只看 paIndex：盜壘被阻殺成第三個出局時半局換了，paIndex 卻沒變，新半局的第一個打席會被跳過
    const atBat = `${game.inning}-${game.half}-${game.paIndex}`
    if (game.over || game.balls + game.strikes > 0 || atBat === this.decided) return []
    this.decided = atBat
    const events: GameEvent[] = []
    const issued: Tactic[] = []
    for (let i = 0; i < MAX_ACTIONS_PER_PA && !game.over; i++) {
      const tactic = this.policy.next(game)
      if (!tactic) break
      if (issued.some((t) => sameTactic(t, tactic))) break
      if (QUEUED_TYPES.has(tactic.type) && game.queued) break
      if (!game.availableTactics().some((t) => sameTactic(t, tactic))) break
      issued.push(tactic)
      events.push(...game.issue(tactic))
      // 排了戰術（盜壘、觸擊）之後這個打席就不再下別的指令
      if (QUEUED_TYPES.has(tactic.type)) break
    }
    return events
  }
}

const batterValue = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3
const pitcherValue = (p: Pitcher) => p.ratings.stuff + p.ratings.control

/** 換投的球數門檻：疲勞門檻＋fatigueMargin；負數時不低於疲勞門檻的 60%（0 以上跟原本的條件逐字相同） */
export function pitchingChangeAt(limit: number, fatigueMargin: number): number {
  return fatigueMargin < 0 ? Math.max(limit + fatigueMargin, Math.ceil(limit * FATIGUE_FLOOR)) : limit + fatigueMargin
}

/**
 * 四種風格共用的決策框架：照顧好投手體力、後段比分接近時才做左右相剋的調度、只在成功率夠高時跑壘或觸擊；
 * 風格專用的判斷（打帶跑、代跑、保護強打、後段守成、守備替補）由參數開關，均衡型全部關閉。
 * 判斷順序就是優先順序，每次只回傳一個指令，AutoCoach 會在下完之後再問一次。
 * 只讀比賽狀態、不抽亂數，同樣的狀態一定給同樣的答案
 */
export class StylePolicy implements CoachPolicy {
  constructor(
    readonly style: CoachStyle,
    readonly params: CoachParams,
  ) {}

  next(game: Game): Tactic | null {
    if (game.over || game.balls + game.strikes > 0) return null
    return game.fieldingSide === game.userSide ? this.defense(game) : this.offense(game)
  }

  private close(game: Game, runs = 2): boolean {
    return game.inning >= 7 && Math.abs(game.score.home - game.score.away) <= runs
  }

  private defense(game: Game): Tactic | null {
    const p = this.params
    const team = game.fielding
    const relievers = team.relievers
    const faced = game.paIndex - team.pitcherSincePa
    const limit = game.fatigueLimit(team.pitcher, team)
    const lead = game.score[game.fieldingSide] - game.score[game.battingSide]

    // 1. 體力：到換投門檻就換上最好的後援；8 局前盡量留著終結者
    if (relievers.length > 0 && team.pitchCount >= pitchingChangeAt(limit, p.fatigueMargin)) {
      return { type: 'changePitcher', relieverIndex: this.bestReliever(game, relievers) }
    }

    // 1b. 後段守成（守備型）：8 局後領先 1～3 分、投手已用掉七成體力，換上最好的後援；9 局起有終結者就用終結者
    if (p.lateRelief && relievers.length > 0 && game.inning >= 8 && lead >= 1 && lead <= 3 && team.pitchCount >= Math.ceil(limit * 0.7)) {
      const closer = game.inning >= 9 ? relievers.findIndex((r) => hasTrait(r, 'closer')) : -1
      return { type: 'changePitcher', relieverIndex: closer >= 0 ? closer : this.bestReliever(game, relievers) }
    }

    // 2. 左右相剋：後段比分接近、打者佔對側優勢，換上同手、能力不差的後援（留一位後援）
    const batter = game.batter
    if (
      p.latePlatoon &&
      game.platoonOn &&
      this.close(game) &&
      batter.bats !== 'S' &&
      game.matchup() === 'opposite' &&
      relievers.length >= 2 &&
      faced >= p.minBattersFaced
    ) {
      const now = pitcherValue(team.pitcher)
      const pick = relievers
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.throws === batter.bats && pitcherValue(r) >= now - 1)
        .sort((a, b) => pitcherValue(b.r) - pitcherValue(a.r) || a.i - b.i)[0]
      if (pick) return { type: 'changePitcher', relieverIndex: pick.i }
    }

    // 2b. 守備替補（守備型）：7 局後領先 1～3 分，板凳上守同一個守位明顯更好（至少 +2）的人換上
    if (p.defensiveSubs && game.inning >= 7 && lead >= 1 && lead <= 3) {
      const sub = defensiveUpgrade(game)
      if (sub) return sub
    }

    // 3. 佈陣
    if (p.align) {
      const alignment = alignmentFor(game)
      if (alignment !== game.alignment) return { type: 'alignment', alignment }
    }
    return null
  }

  /** 換誰上：能力最好的後援；8 局前有其他人可用就先不動終結者 */
  private bestReliever(game: Game, relievers: readonly Pitcher[]): number {
    const ranked = relievers.map((r, i) => ({ r, i })).sort((a, b) => pitcherValue(b.r) - pitcherValue(a.r) || a.i - b.i)
    const saveCloser = game.inning < 8 && ranked.some(({ r }) => !hasTrait(r, 'closer'))
    return (saveCloser ? ranked.find(({ r }) => !hasTrait(r, 'closer'))! : ranked[0]).i
  }

  private offense(game: Game): Tactic | null {
    const p = this.params
    const team = game.batting
    const spot = team.lineup[team.battingIndex]
    const lead = game.score[game.battingSide] - game.score[game.fieldingSide]
    const [b1, b2, b3] = game.bases
    // 強攻型：長打 7 以上的打者打擊時，讓他自己打完（不代打、不在他打擊時盜壘或打帶跑）
    const slugger = p.protectSlugger && spot.player.ratings.power >= 7

    // 1. 代打：後段比分接近、打者同側不利，派對側、打擊不差的板凳
    if (p.latePlatoon && game.platoonOn && !slugger && this.close(game) && game.matchup(spot.player) === 'same') {
      const pick = team.bench
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => game.matchup(b) === 'opposite' && batterValue(b) >= batterValue(spot.player) - 0.5)
        .sort((a, b) => batterValue(b.b) - batterValue(a.b) || a.i - b.i)[0]
      if (pick) return { type: 'pinchHit', benchIndex: pick.i }
    }

    // 1b. 代跑（機動型）：7 局後比分差 1 分內，一或二壘上的慢跑者（速度 4 以下）換成板凳上快很多（+3）的人
    if (p.pinchRun && game.inning >= 7 && Math.abs(lead) <= 1) {
      const run = pinchRunner(game)
      if (run) return run
    }

    // 2. 犧牲觸擊：buntFromInning 局起（含延長賽）、落後 1 分到領先 buntMaxLead 分、無人出局、跑者在一或二壘、打者不強
    const batter = game.batter
    if (
      p.sacBunt &&
      game.inning >= p.buntFromInning &&
      game.outs === 0 &&
      lead >= -1 &&
      lead <= p.buntMaxLead &&
      (b1 || b2) &&
      !b3 &&
      batter.ratings.contact + batter.ratings.power <= p.buntBatterMax &&
      game.buntChance() >= 0.6
    ) {
      return { type: 'bunt' }
    }

    // 3. 盜壘：比分沒拉開、成功率夠高才跑；二壘盜三壘要更有把握，而且兩出局不跑
    if (Math.abs(lead) <= p.stealMaxRunDiff && !slugger) {
      if (b1 && !b2 && game.stealChance(1) >= p.stealMin) return { type: 'steal', from: 1 }
      if (b2 && !b3 && game.outs < 2 && game.stealChance(2) >= p.stealMin + 0.1) return { type: 'steal', from: 2 }
    }

    // 4. 打帶跑（機動型）：一壘有人、二壘空、兩出局前，跑者速度 6 以上、打者擊球能力 6 以上、跑者成功率至少 0.55（不到盜壘門檻時改用打帶跑）
    if (
      p.hitAndRun &&
      !slugger &&
      Math.abs(lead) <= p.stealMaxRunDiff &&
      b1 &&
      !b2 &&
      game.outs < 2 &&
      b1.ratings.speed >= 6 &&
      batter.ratings.contact >= 6 &&
      game.stealChance(1) >= 0.55
    ) {
      return { type: 'hitAndRun' }
    }
    return null
  }
}

/** 均衡型（Phase 4 起的策略）：保留類別名稱，等同 StylePolicy('balanced') */
export class BalancedPolicy extends StylePolicy {
  constructor(params: CoachParams = COACH_PRESETS.balanced) {
    super('balanced', params)
  }
}

/** 守備替補：板凳上守同一個守位比現在的人至少好 2 的球員（差最多的那位；同分取守位、板凳序號較前的） */
function defensiveUpgrade(game: Game): Tactic | null {
  const team = game.fielding
  let best: { gain: number; benchIndex: number; lineupIndex: number } | null = null
  team.lineup.forEach((spot, lineupIndex) => {
    if (spot.position === 'DH') return
    const now = game.spotFielding(spot)
    team.bench.forEach((b, benchIndex) => {
      const gain = (game.positionsOn ? fieldingAtPosition(b, spot.position) : b.ratings.fielding) - now
      if (gain >= 2 && (!best || gain > best.gain)) best = { gain, benchIndex, lineupIndex }
    })
  })
  const pick = best as { gain: number; benchIndex: number; lineupIndex: number } | null
  return pick ? { type: 'defensiveSub', benchIndex: pick.benchIndex, lineupIndex: pick.lineupIndex } : null
}

/** 代跑：二壘優先（離本壘近），速度 4 以下的跑者換成板凳上快至少 3 的人（最快的那位） */
function pinchRunner(game: Game): Tactic | null {
  const bench = game.batting.bench
  for (const base of [2, 1] as const) {
    const runner = game.bases[base - 1]
    if (!runner || runner.ratings.speed > 4) continue
    const pick = bench
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.ratings.speed >= runner.ratings.speed + 3)
      .sort((a, b) => b.b.ratings.speed - a.b.ratings.speed || a.i - b.i)[0]
    if (pick) return { type: 'pinchRun', base, benchIndex: pick.i }
  }
  return null
}

/**
 * 佈陣：跟引擎內建 AI（Game.aiAlignment）同一套判斷，不抽亂數。
 * 後段一分都不能給、三壘有人就內野前進；後段小幅領先、面對強力打者就外野後退；打者有明顯方向又夠強就往那邊移
 */
export function alignmentFor(game: Game): Alignment {
  const b = game.batter
  const lead = game.score[game.fieldingSide] - game.score[game.battingSide]
  if (game.bases[2] && game.outs < 2 && game.inning >= 7 && lead >= 0 && lead <= 1) return 'infieldIn'
  if (game.inning >= 8 && lead >= 1 && lead <= 2 && !game.bases[1] && !game.bases[2] && b.ratings.power >= 7) return 'outfieldBack'
  const threat = b.ratings.contact + b.ratings.power >= 11
  if (threat && b.tendency === 'left') return 'shiftLeft'
  if (threat && b.tendency === 'right') return 'shiftRight'
  return 'normal'
}

/** 依風格建立策略：風格的預設參數，再蓋上玩家的進階設定 */
export function createPolicy(style: CoachStyle = 'balanced', params?: Partial<CoachParams>): CoachPolicy {
  if (!COACH_STYLES.includes(style)) throw new RangeError(`不支援的戰術風格：${String(style)}`)
  const merged = { ...COACH_PRESETS[style], ...params }
  return style === 'balanced' ? new BalancedPolicy(merged) : new StylePolicy(style, merged)
}
