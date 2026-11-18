// V2 自動教練：替 Game 的 userSide 那一方自動下指令（換投、代打、佈陣、盜壘、觸擊）。
// 只讀比賽狀態、透過 game.issue() 下指令，不碰 DOM、畫面或動畫；指令會照常記進 game.commands，
// 所以用引擎的 replay(setup, commands) 就能重現整場。另一方由引擎內建的 AI 負責（見 matchRunner）。
import { sameTactic, type Alignment, type Game, type GameEvent, type Tactic } from '../../sim/game'
import { hasTrait } from '../../sim/traits'
import type { Batter, Pitcher } from '../../sim/types'

/**
 * 自動教練的邏輯版本。教練的判斷改了，同一個種子會打出不同的比賽，所以跟規則版本分開記。
 * 重播不靠這個版本：重播用的是記下來的指令紀錄
 */
export const AUTO_COACH_VERSION = 1

/** 戰術風格。第一版只有均衡；之後的四種風格加在這裡，並在 COACH_PRESETS 給一組參數或自己的 policy */
export type CoachStyle = 'balanced'
export const COACH_STYLES: readonly CoachStyle[] = ['balanced']

/** 均衡策略的可調參數：四種戰術風格可以先從不同的參數組開始 */
export interface CoachParams {
  /** 投球數超過疲勞門檻幾球就換投（0 = 一到門檻就換） */
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
  /** 後段平手或落後 1 分、無人出局時，讓弱打者犧牲觸擊 */
  sacBunt: boolean
}

export const COACH_PRESETS: Record<CoachStyle, CoachParams> = {
  balanced: {
    fatigueMargin: 0,
    minBattersFaced: 3,
    latePlatoon: true,
    align: true,
    stealMin: 0.75,
    stealMaxRunDiff: 3,
    sacBunt: true,
  },
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

/**
 * 均衡策略：照顧好投手體力、後段比分接近時才做左右相剋的調度、只在成功率夠高時跑壘或觸擊。
 * 判斷順序就是優先順序，每次只回傳一個指令，AutoCoach 會在下完之後再問一次
 */
export class BalancedPolicy implements CoachPolicy {
  readonly style: CoachStyle = 'balanced'

  constructor(readonly params: CoachParams = COACH_PRESETS.balanced) {}

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

    // 1. 體力：到疲勞門檻就換上最好的後援；8 局前盡量留著終結者
    if (relievers.length > 0 && team.pitchCount >= game.fatigueLimit(team.pitcher, team) + p.fatigueMargin) {
      return { type: 'changePitcher', relieverIndex: this.bestReliever(game, relievers) }
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

    // 1. 代打：後段比分接近、打者同側不利，派對側、打擊不差的板凳
    if (p.latePlatoon && game.platoonOn && this.close(game) && game.matchup(spot.player) === 'same') {
      const pick = team.bench
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => game.matchup(b) === 'opposite' && batterValue(b) >= batterValue(spot.player) - 0.5)
        .sort((a, b) => batterValue(b.b) - batterValue(a.b) || a.i - b.i)[0]
      if (pick) return { type: 'pinchHit', benchIndex: pick.i }
    }

    // 2. 犧牲觸擊：後段（含延長賽）平手或落後 1 分、無人出局、跑者在一或二壘、打者不強
    const batter = game.batter
    if (
      p.sacBunt &&
      game.inning >= 8 &&
      game.outs === 0 &&
      (lead === 0 || lead === -1) &&
      (b1 || b2) &&
      !b3 &&
      batter.ratings.contact + batter.ratings.power <= 10 &&
      game.buntChance() >= 0.6
    ) {
      return { type: 'bunt' }
    }

    // 3. 盜壘：比分沒拉開、成功率夠高才跑；二壘盜三壘要更有把握，而且兩出局不跑
    if (Math.abs(lead) <= p.stealMaxRunDiff) {
      if (b1 && !b2 && game.stealChance(1) >= p.stealMin) return { type: 'steal', from: 1 }
      if (b2 && !b3 && game.outs < 2 && game.stealChance(2) >= p.stealMin + 0.1) return { type: 'steal', from: 2 }
    }
    return null
  }
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

/** 依風格建立策略 */
export function createPolicy(style: CoachStyle = 'balanced', params?: Partial<CoachParams>): CoachPolicy {
  switch (style) {
    case 'balanced':
      return new BalancedPolicy({ ...COACH_PRESETS.balanced, ...params })
  }
}
