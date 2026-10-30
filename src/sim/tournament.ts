// 錦標賽：roguelike 的一輪。例行賽 8 場（5 勝晉級），季後賽八強、四強各一場，決賽三戰兩勝（ADR-0005）
import { RULES_VERSION, type Command, type GameSetup, type PlayerLine } from './game'
import { applyGrowth, type Growth } from './growth'
import { BASE_MEAN, allPlayers, cardTier, generateBatter, generatePitcher, generateRoster, overall, teamName, type CardTier } from './generate'
import { defaultCaptain } from './synergy'
import { EQUIPMENT, MAX_EQUIPMENT, OFFERED_RELICS, RELICS, equippedTeam, mapRoster, type EquipmentId, type RelicId } from './items'
import { PITCH_TRAIT_IDS, PITCH_TYPES, isBreaking, repertoire, type PitchTraitId, type PitchType } from './pitches'
import { advancePotential, statOf, withPotential } from './potential'
import { STARTING_FUNDS, gameFunds, releaseValue } from './prices'
import type { EventId } from './rest'
import { Rng } from './rng'
import { createSetup, getSlot, isPitcherSlot, setSlot, type PregameSetup, type Slot } from './setup'
import { TRAITS, conflicts, type TraitId } from './traits'
import type { Pitcher, Player, Roster, Team } from './types'

/** 錦標賽的階段；r16 只出現在舊版的冠軍紀錄 */
export type Round = 'season' | 'r16' | 'qf' | 'sf' | 'final'
export const PLAYOFF_ROUNDS = ['qf', 'sf', 'final'] as const
export type PlayoffRound = (typeof PLAYOFF_ROUNDS)[number]

export const SEASON_GAMES = 8
export const WINS_TO_ADVANCE = 5
/** 例行賽最多能輸幾場；再輸就不可能拿到晉級的勝場 */
export const MAX_SEASON_LOSSES = SEASON_GAMES - WINS_TO_ADVANCE
export const FINAL_WINS_NEEDED = 2
/** 聯盟隊數：玩家加 11 支 AI 隊伍 */
const LEAGUE_SIZE = 12

/** 難度等級 1～5：奪冠後開放下一級 */
export const TIERS = [1, 2, 3, 4, 5] as const
export type Tier = (typeof TIERS)[number]
/** 對手能力值中心的曲線：第一場的起點，以及每打一場往上加多少 */
export const TIER_START: Record<Tier, number> = { 1: -0.5, 2: -0.2, 3: 0.2, 4: 0.5, 5: 0.8 }
export const TIER_SLOPE: Record<Tier, number> = { 1: 0.08, 2: 0.09, 3: 0.1, 4: 0.11, 5: 0.12 }
/** 例行賽每多一勝（超過晉級門檻），季後賽對手就弱這麼多 */
const SEED_BONUS = 0.08
/** 一位球員最多幾個特性 */
const MAX_TRAITS = 3
const STARTING_RELICS = 3

/** rest 是休息站選地點，shop、training、event 是進去之後 */
export type TournamentPhase =
  | 'pregame'
  | 'relic'
  | 'ready'
  | 'playing'
  | 'reward'
  | 'rest'
  | 'shop'
  | 'training'
  | 'event'
  | 'champion'
  | 'eliminated'

export interface GameRecord {
  round: Round
  userRuns: number
  opponentRuns: number
  won: boolean
  /** 對手隊名；舊版的冠軍紀錄沒有 */
  opponent?: string
  /** 這場我方的 MVP 名字（沒有人達標就沒有） */
  mvp?: string
}

/** 一輪中覺醒過的球員，給奪冠回顧用 */
export interface AwakenLog {
  name: string
  trait: TraitId
  /** 第幾場之後覺醒（1 起算） */
  game: number
}

/** 進行中的比賽：種子加指令紀錄就能重播回來（ADR-0001） */
export interface SavedGame {
  setup: GameSetup
  commands: Command[]
  stepIndex: number
}

/** 獎勵選擇裡的一張卡 */
export type RewardCard =
  | { kind: 'player'; player: Player }
  | { kind: 'equipment'; id: EquipmentId }
  | { kind: 'relic'; id: RelicId }
  | { kind: 'trait'; id: TraitId }
  | { kind: 'pitchTrait'; pitch: PitchType; id: PitchTraitId }
  | { kind: 'newPitch'; pitch: PitchType }

/** 上一場（或上一次訓練）覺醒的球員，畫面用來提示 */
export interface Awakening {
  playerId: string
  trait: TraitId
}

/** 整個錦標賽的狀態，只含純資料，可以直接存成 JSON */
export interface Tournament {
  version: 2
  phase: TournamentPhase
  rngState: number
  tier: Tier
  /** 玩家的隊伍（含秘技）；球員身上的能力不含裝備加成 */
  setup: PregameSetup
  /** 聯盟各隊，第 0 隊是玩家 */
  teamNames: string[]
  /** 例行賽 8 場的對手，teamNames 的索引 */
  schedule: number[]
  /** 季後賽八強、四強、決賽的對手 */
  playoff: number[]
  /** 下一場（或正在打的這場）屬於哪個階段 */
  round: Round
  opponent: Team
  series: { user: number; opponent: number }
  history: GameRecord[]
  relicOptions: RelicId[]
  rewards: RewardCard[]
  /** 背包：沒有裝在任何人身上的裝備 */
  bag: EquipmentId[]
  /** 球團資金 */
  funds: number
  /** 這次商店的商品；不在商店時是空的 */
  shop: ShopItem[]
  /** 這次商店已經付費強化幾次（越來越貴） */
  upgrades: number
  /** 這次休息站遇到的事件 */
  event: EventId | null
  currentGame: SavedGame | null
  /** 最近一場比賽（或訓練）覺醒的球員；之前的存檔沒有 */
  awakened?: Awakening[]
  /** 每位球員開打時（或加入時）的總評，奪冠回顧畫成長用 */
  startOverall?: Record<string, number>
  /** 這一輪覺醒過的球員 */
  awakenLog?: AwakenLog[]
}

/** 商店的一格商品 */
export interface ShopItem {
  card: RewardCard
  price: number
  sold: boolean
}

export function createTournament(seed: number, tier: Tier = 1): Tournament {
  const rng = new Rng(seed)
  const setup: PregameSetup = { ...createSetup(rng.int(0, 2 ** 32 - 1)), playerRerollsLeft: 0 }
  // 開局就有幾位球員帶著潛能，讓玩家一開始就有養成目標；整隊重骰時重新分配
  setup.team = { ...setup.team, roster: seedPotentials(rng, setup.team.roster) }
  const teamNames = [setup.team.name]
  while (teamNames.length < LEAGUE_SIZE) {
    const name = teamName(rng)
    if (!teamNames.includes(name)) teamNames.push(name)
  }
  const others = rng.shuffle(Array.from({ length: LEAGUE_SIZE - 1 }, (_, i) => i + 1))
  const t: Tournament = {
    version: 2,
    phase: 'pregame',
    rngState: rng.state,
    tier,
    setup,
    teamNames,
    schedule: others.slice(0, SEASON_GAMES),
    playoff: rng.shuffle(others).slice(0, PLAYOFF_ROUNDS.length),
    round: 'season',
    opponent: { name: '', roster: setup.team.roster },
    series: { user: 0, opponent: 0 },
    history: [],
    relicOptions: [],
    rewards: [],
    bag: [],
    funds: STARTING_FUNDS,
    shop: [],
    upgrades: 0,
    event: null,
    currentGame: null,
  }
  return withOpponent(t)
}

export function seasonRecord(t: Tournament): { wins: number; losses: number } {
  const games = t.history.filter((g) => g.round === 'season')
  const wins = games.filter((g) => g.won).length
  return { wins, losses: games.length - wins }
}

/** 季後賽種子：8 勝是第 1 種子，5 勝是第 4 種子 */
export function playoffSeed(t: Tournament): number {
  return Math.min(4, Math.max(1, SEASON_GAMES + 1 - seasonRecord(t).wins))
}

/** 下一場對手的隊伍索引 */
export function opponentIndex(t: Tournament): number {
  if (t.round === 'season') return t.schedule[seasonRecord(t).wins + seasonRecord(t).losses]
  return t.playoff[PLAYOFF_ROUNDS.indexOf(t.round as PlayoffRound)]
}

/** 對手的能力值中心：隨場次提高，難度決定起點與斜率；季後賽依例行賽勝場給種子優勢 */
export function opponentMean(t: Tournament): number {
  const base = BASE_MEAN + TIER_START[t.tier] + TIER_SLOPE[t.tier] * t.history.length
  if (t.round === 'season') return base
  return base - (seasonRecord(t).wins - WINS_TO_ADVANCE) * SEED_BONUS
}

function withOpponent(t: Tournament): Tournament {
  const rng = new Rng(t.rngState)
  const roster = generateRoster(rng, opponentMean(t))
  return { ...t, opponent: { name: t.teamNames[opponentIndex(t)], roster }, rngState: rng.state }
}

function expectPhase(t: Tournament, ...phases: TournamentPhase[]): void {
  if (!phases.includes(t.phase)) throw new Error(`錦標賽目前是 ${t.phase}，不能這樣做`)
}

/** 開打前的重骰與改隊名；開打後就不能再重骰 */
export function updateSetup(t: Tournament, setup: PregameSetup): Tournament {
  expectPhase(t, 'pregame')
  // 整隊重骰後的新球員沒有潛能，重新分配
  if (!allPlayers(setup.team.roster).some((p) => p.potential)) {
    const rng = new Rng(setup.rngState)
    setup = { ...setup, team: { ...setup.team, roster: seedPotentials(rng, setup.team.roster) }, rngState: rng.state }
  }
  const name = setup.team.name
  if (name === t.teamNames[0]) return { ...t, setup }
  // 玩家自訂的隊名撞到 AI 隊伍時，AI 隊伍換名字
  const rng = new Rng(t.rngState)
  const teamNames = [name, ...t.teamNames.slice(1)]
  for (let i = 1; i < teamNames.length; i++) {
    while (teamNames.indexOf(teamNames[i]) !== i) teamNames[i] = teamName(rng)
  }
  const opponent = { ...t.opponent, name: teamNames[opponentIndex(t)] }
  return { ...t, setup, teamNames, opponent, rngState: rng.state }
}

/** 陣容調整：打序、先發投手、板凳互換，不增減球員 */
export function updateRoster(t: Tournament, roster: Roster): Tournament {
  expectPhase(t, 'pregame', 'ready')
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

/** 兩場之間的陣容調整：隊名、秘技、重骰都不能改，只接受陣容 */
export function updateLineup(t: Tournament, setup: PregameSetup): Tournament {
  expectPhase(t, 'ready')
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster: setup.team.roster } } }
}

/** 開打：沒用完的重骰作廢，接著選起始秘技 */
export function startTournament(t: Tournament): Tournament {
  expectPhase(t, 'pregame')
  const rng = new Rng(t.rngState)
  // 起始秘技不出彩虹，免得開局就定生死
  const pool = OFFERED_RELICS.filter((id) => RELICS[id].tier !== 'rainbow')
  const relicOptions = rng.shuffle(pool).slice(0, STARTING_RELICS)
  const startOverall = Object.fromEntries(allPlayers(t.setup.team.roster).map((p) => [p.id, overall(p)]))
  return {
    ...t,
    phase: 'relic',
    relicOptions,
    startOverall,
    awakenLog: [],
    rngState: rng.state,
    setup: { ...t.setup, playerRerollsLeft: 0 },
  }
}

export function chooseStartingRelic(t: Tournament, index: number): Tournament {
  expectPhase(t, 'relic')
  const id = t.relicOptions[index]
  if (!id) throw new Error('沒有這個秘技')
  return { ...withRelic(t, id), phase: 'ready', relicOptions: [] }
}

export function relicsOf(t: Tournament): readonly RelicId[] {
  return t.setup.team.relics ?? []
}

export function withRelic(t: Tournament, id: RelicId): Tournament {
  const team = { ...t.setup.team, relics: [...relicsOf(t), id] }
  return { ...t, setup: { ...t.setup, team } }
}

export function beginGame(t: Tournament): Tournament {
  expectPhase(t, 'ready')
  const rng = new Rng(t.rngState)
  const setup: GameSetup = {
    // 上場的隊伍把裝備加成算進能力值，比賽本身不用知道裝備
    home: equippedTeam(t.setup.team),
    away: t.opponent,
    seed: rng.int(0, 2 ** 32 - 1),
    userSide: 'home',
    // 記下規則版本，之後改版時存檔才知道要用哪套規則重播
    rules: RULES_VERSION,
  }
  return { ...t, phase: 'playing', rngState: rng.state, currentGame: { setup, commands: [], stepIndex: 0 } }
}

export function saveProgress(t: Tournament, commands: readonly Command[], stepIndex: number): Tournament {
  expectPhase(t, 'playing')
  return { ...t, currentGame: { ...t.currentGame!, commands: [...commands], stepIndex } }
}

/** 比賽結束：記戰績、套用成長，決定下一個階段；沒結束就進入獎勵選擇 */
export function finishGame(
  t: Tournament,
  score: { home: number; away: number },
  growth: readonly Growth[] = [],
  lines: Readonly<Record<string, PlayerLine>> = {},
): Tournament {
  expectPhase(t, 'playing')
  const won = score.home > score.away
  const mvpId = growth.find((g) => g.mvp)?.playerId
  const mvp = mvpId ? allPlayers(t.setup.team.roster).find((p) => p.id === mvpId)?.name : undefined
  const history = [...t.history, { round: t.round, userRuns: score.home, opponentRuns: score.away, won, opponent: t.opponent.name, mvp }]
  // 成長之後累積潛能：這場的數字加進進度，達成就覺醒
  const awakened: Awakening[] = []
  const roster = mapRoster(applyGrowth(t.setup.team.roster, growth), <P extends Player>(p: P) => {
    if (!p.potential) return p
    const { player, awakened: trait } = advancePotential(p, statOf(lines[p.id], p.potential.stat))
    if (trait) awakened.push({ playerId: p.id, trait })
    return player
  })
  const team = { ...t.setup.team, roster }
  const funds = t.funds + gameFunds(won, score.home)
  const awakenLog = [...(t.awakenLog ?? []), ...logAwakenings(roster, awakened, history.length)]
  const base: Tournament = { ...t, setup: { ...t.setup, team }, history, funds, awakened, awakenLog, currentGame: null }
  let round: Round = t.round
  let series = t.series
  if (t.round === 'season') {
    const { wins, losses } = seasonRecord(base)
    if (losses > MAX_SEASON_LOSSES) return { ...base, phase: 'eliminated' }
    if (wins + losses >= SEASON_GAMES) round = 'qf'
  } else if (t.round === 'final') {
    series = { user: t.series.user + (won ? 1 : 0), opponent: t.series.opponent + (won ? 0 : 1) }
    if (series.user >= FINAL_WINS_NEEDED) return { ...base, series, phase: 'champion' }
    if (series.opponent >= FINAL_WINS_NEEDED) return { ...base, series, phase: 'eliminated' }
  } else {
    if (!won) return { ...base, phase: 'eliminated' }
    round = t.round === 'qf' ? 'sf' : 'final'
  }
  return withRewards({ ...base, round, series, phase: 'reward' }, won)
}

// ---- 獎勵選擇 ----

/** 獎勵卡的卡色：球員看總評，道具看定義，金特是金卡、藍特是銀卡 */
export function rewardTier(card: RewardCard): CardTier {
  switch (card.kind) {
    case 'player':
      return cardTier(card.player)
    case 'equipment':
      return EQUIPMENT[card.id].tier
    case 'relic':
      return RELICS[card.id].tier
    case 'trait':
      return TRAITS[card.id].tier === 'gold' ? 'gold' : 'silver'
    case 'pitchTrait':
      return 'silver'
    case 'newPitch':
      return 'gold'
  }
}

/** 開局有潛能的球員數 */
const STARTING_POTENTIALS = 3
/** 獎勵、商店的球員卡帶潛能的機率 */
const CARD_POTENTIAL_CHANCE = 0.3

/** 隨機挑幾位球員給潛能 */
export function seedPotentials(rng: Rng, roster: Roster): Roster {
  const ids = new Set(rng.shuffle(allPlayers(roster).map((p) => p.id)).slice(0, STARTING_POTENTIALS))
  return mapRoster(roster, <P extends Player>(p: P) => (ids.has(p.id) ? withPotential(rng, p) : p))
}

/** 贏球的卡色機率；輸球只有比較差的分布 */
const WIN_TIERS: [CardTier, number][] = [['bronze', 45], ['silver', 35], ['gold', 16], ['rainbow', 4]]
const LOSS_TIERS: [CardTier, number][] = [['bronze', 70], ['silver', 27], ['gold', 3]]
/** 球員卡依卡色調整能力值中心 */
const PLAYER_MEAN: Record<CardTier, number> = { bronze: 0, silver: 0.8, gold: 1.6, rainbow: 2.4 }
const TIER_ORDER: readonly CardTier[] = ['bronze', 'silver', 'gold', 'rainbow']

function withRewards(t: Tournament, won: boolean): Tournament {
  const rng = new Rng(t.rngState)
  const cards: RewardCard[] = []
  const taken = new Set<string>()
  const key = (c: RewardCard) => (c.kind === 'player' ? c.player.id : JSON.stringify(c))
  for (let guard = 0; cards.length < (won ? 3 : 2) && guard < 50; guard++) {
    const tier = rng.weighted(won ? WIN_TIERS : LOSS_TIERS)
    const kind = rng.weighted<RewardCard['kind']>([
      ['player', 28],
      ['equipment', 30],
      ['trait', 16],
      ['relic', 12],
      ['pitchTrait', 8],
      ['newPitch', 6],
    ])
    const card = rewardOf(rng, kind, tier, t)
    if (!card || taken.has(key(card))) continue
    taken.add(key(card))
    cards.push(card)
  }
  return { ...t, rewards: cards, rngState: rng.state }
}

/**
 * 指定種類與卡色的一張卡；沒有符合的道具時往低一級找。
 * 球種卡只出隊上有投手用得到的：球種特性挑某位投手會、還沒有特性的球種，新球種挑某位投手還不會的
 */
export function rewardOf(rng: Rng, kind: RewardCard['kind'], tier: CardTier, t: Tournament): RewardCard | null {
  const owned = new Set(relicsOf(t))
  if (kind === 'player') {
    // 球員卡跟著賽程慢慢變強，才追得上對手
    const mean = BASE_MEAN + PLAYER_MEAN[tier] + t.history.length * 0.05
    const player = rng.chance(0.3) ? generatePitcher(rng, mean) : generateBatter(rng, mean)
    return { kind, player: rng.chance(CARD_POTENTIAL_CHANCE) ? withPotential(rng, player) : player }
  }
  // 球種卡不分卡色：球種特性固定銀卡，新球種固定金卡
  const pitchers = allPlayers(t.setup.team.roster).filter((p) => p.role === 'pitcher')
  if (kind === 'pitchTrait') {
    const pitches = PITCH_TYPES.filter((x) => pitchers.some((p) => canLearnPitchTrait(p, x)))
    return pitches.length ? { kind, pitch: rng.pick(pitches), id: rng.pick(PITCH_TRAIT_IDS) } : null
  }
  if (kind === 'newPitch') {
    const pitches = PITCH_TYPES.filter((x) => isBreaking(x) && pitchers.some((p) => canLearnPitch(p, x)))
    return pitches.length ? { kind, pitch: rng.pick(pitches) } : null
  }
  for (let i = TIER_ORDER.indexOf(tier); i >= 0; i--) {
    const want = TIER_ORDER[i]
    if (kind === 'equipment') {
      const pool = (Object.keys(EQUIPMENT) as EquipmentId[]).filter((id) => EQUIPMENT[id].tier === want)
      if (pool.length) return { kind, id: rng.pick(pool) }
    } else if (kind === 'relic') {
      const pool = OFFERED_RELICS.filter((id) => RELICS[id].tier === want && !owned.has(id))
      if (pool.length) return { kind, id: rng.pick(pool) }
    } else {
      const traitTier = want === 'gold' || want === 'rainbow' ? 'gold' : 'blue'
      const pool = (Object.keys(TRAITS) as TraitId[]).filter((id) => TRAITS[id].tier === traitTier)
      if (pool.length) return { kind, id: rng.pick(pool) }
    }
  }
  return null
}

/** 例行賽每打完兩場有一個休息站 */
export const REST_EVERY = 2

/** 選完獎勵（或放棄）：例行賽每兩場進休息站，否則換下一個對手 */
function afterReward(t: Tournament): Tournament {
  const cleared = { ...t, rewards: [] }
  const last = t.history[t.history.length - 1]
  const seasonGames = t.history.filter((g) => g.round === 'season').length
  if (last?.round === 'season' && seasonGames % REST_EVERY === 0) return { ...cleared, phase: 'rest' }
  return toNextGame(cleared)
}

/** 準備下一場：產生對手，回到兩場之間的主畫面 */
export function toNextGame(t: Tournament): Tournament {
  return withOpponent({ ...t, phase: 'ready', shop: [], upgrades: 0, event: null })
}

function rewardAt<K extends RewardCard['kind']>(t: Tournament, index: number, kind: K): Extract<RewardCard, { kind: K }> {
  expectPhase(t, 'reward')
  const card = t.rewards[index]
  if (!card || card.kind !== kind) throw new Error('沒有這張獎勵卡')
  return card as Extract<RewardCard, { kind: K }>
}

/** 球員卡：取代同角色的一格，被換下的人釋出，他的裝備回到背包 */
export function pickPlayer(t: Tournament, index: number, release: Slot): Tournament {
  const { player } = rewardAt(t, index, 'player')
  return afterReward(replacePlayer(t, player, release))
}

/** 把覺醒寫成回顧用的紀錄：誰、哪個特性、第幾場之後 */
export function logAwakenings(roster: Roster, awakened: readonly Awakening[], game: number): AwakenLog[] {
  const players = allPlayers(roster)
  return awakened.map((a) => ({ name: players.find((p) => p.id === a.playerId)?.name ?? '', trait: a.trait, game }))
}

/** 新球員取代同角色的一格；被換下的人釋出：裝備回到背包，換回一些資金 */
export function replacePlayer(t: Tournament, player: Player, release: Slot): Tournament {
  if ((player.role === 'pitcher') !== isPitcherSlot(release)) throw new Error('只能替換同角色的球員')
  const roster = t.setup.team.roster
  const out = getSlot(roster, release)
  const next = setSlot(roster, release, player)
  return {
    ...t,
    funds: t.funds + releaseValue(out),
    bag: [...t.bag, ...(out.equipment ?? [])],
    // 中途加入的球員從加入時的總評開始算成長
    startOverall: { ...t.startOverall, [player.id]: overall(player) },
    setup: { ...t.setup, team: { ...t.setup.team, roster: next } },
  }
}

// ---- 傳奇館 ----

/** 傳奇館球員回到新的一輪：能力值每項 −1，特性保留；裝備、潛能、球種特性、新球種都不帶 */
export function asLegend<P extends Player>(p: P): P {
  const ratings = Object.fromEntries(Object.entries(p.ratings).map(([k, v]) => [k, Math.max(1, v - 1)]))
  const { equipment: _e, potential: _p, ...rest } = p as Player
  const clean = rest.role === 'pitcher' ? (({ pitchTraits: _t, extraPitches: _x, ...r }) => r)(rest as Pitcher) : rest
  return { ...clean, ratings } as unknown as P
}

/** 開打前把一位傳奇館球員加進隊伍，取代同角色總評最低的一位 */
export function addLegend(t: Tournament, legend: Player): Tournament {
  expectPhase(t, 'pregame')
  const player = asLegend(legend)
  const roster = t.setup.team.roster
  const slots: Slot[] =
    player.role === 'pitcher'
      ? [{ kind: 'starter' }, ...roster.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i }))]
      : [...roster.lineup.map((_, i): Slot => ({ kind: 'lineup', index: i })), ...roster.bench.map((_, i): Slot => ({ kind: 'bench', index: i }))]
  const weakest = slots.reduce((a, b) => (overall(getSlot(roster, b)) < overall(getSlot(roster, a)) ? b : a))
  const replaced = setSlot(roster, weakest, player)
  // 開局一定有隊長：傳奇取代的剛好是隊長，就重新挑一位
  const next = replaced.captain ? replaced : { ...replaced, captain: defaultCaptain(replaced.lineup, []) }
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster: next } } }
}

/** 秘技卡：直接加進全隊 */
export function pickRelic(t: Tournament, index: number): Tournament {
  const { id } = rewardAt(t, index, 'relic')
  return afterReward(withRelic(t, id))
}

/** 裝備卡：裝在某位球員身上；playerId 是 null 就先放進背包。裝滿時 replace 指定換下哪一件（回到背包） */
export function pickEquipment(t: Tournament, index: number, playerId: string | null, replace?: number): Tournament {
  const { id } = rewardAt(t, index, 'equipment')
  const withItem = { ...t, bag: [...t.bag, id] }
  return afterReward(playerId ? equipFromBag(withItem, withItem.bag.length - 1, playerId, replace) : withItem)
}

/** 特性卡：加在一位同角色的球員身上，跟它互斥的舊特性會被取代 */
export function pickTrait(t: Tournament, index: number, playerId: string): Tournament {
  const { id } = rewardAt(t, index, 'trait')
  return afterReward(teachTrait(t, playerId, id))
}

/** 球種特性卡：加在一位投手的這個球種上 */
export function pickPitchTrait(t: Tournament, index: number, playerId: string): Tournament {
  const card = rewardAt(t, index, 'pitchTrait')
  return afterReward(teachPitchTrait(t, playerId, card.pitch, card.id))
}

/** 新球種卡：一位投手學會這個球種 */
export function pickNewPitch(t: Tournament, index: number, playerId: string): Tournament {
  const card = rewardAt(t, index, 'newPitch')
  return afterReward(teachPitch(t, playerId, card.pitch))
}

/** 能不能把球種特性加在這個球種上：要是投手、會這個球種，而且這個球種還沒有特性 */
export function canLearnPitchTrait(p: Player, pitch: PitchType): p is Pitcher {
  return p.role === 'pitcher' && repertoire(p).includes(pitch) && !p.pitchTraits?.[pitch]
}

/** 能不能學這個新球種：要是投手，而且還不會 */
export function canLearnPitch(p: Player, pitch: PitchType): p is Pitcher {
  return p.role === 'pitcher' && !repertoire(p).includes(pitch)
}

export function teachPitchTrait(t: Tournament, playerId: string, pitch: PitchType, id: PitchTraitId): Tournament {
  if (!canLearnPitchTrait(findPlayer(t.setup.team.roster, playerId), pitch)) throw new Error('這位投手不能加這個球種特性')
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => ({ ...p, pitchTraits: { ...(p as Pitcher).pitchTraits, [pitch]: id } }) as Pitcher)
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

export function teachPitch(t: Tournament, playerId: string, pitch: PitchType): Tournament {
  if (!canLearnPitch(findPlayer(t.setup.team.roster, playerId), pitch)) throw new Error('這位投手不能學這個球種')
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => ({ ...p, extraPitches: [...((p as Pitcher).extraPitches ?? []), pitch] }) as Pitcher)
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

/** 讓一位球員學會特性，跟它互斥的舊特性會被取代 */
export function teachTrait(t: Tournament, playerId: string, id: TraitId): Tournament {
  const target = findPlayer(t.setup.team.roster, playerId)
  if (!canLearnTrait(target, id)) throw new Error('這位球員不能學這個特性')
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => ({ ...p, traits: [...p.traits.filter((x) => !conflicts(x, id)), id] }))
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

export function skipReward(t: Tournament): Tournament {
  expectPhase(t, 'reward')
  return afterReward(t)
}

/** 能不能學這個特性：角色要對、還沒有，而且扣掉會被取代的互斥特性後不超過上限 */
export function canLearnTrait(p: Player, id: TraitId): boolean {
  if (TRAITS[id].role !== p.role || p.traits.includes(id)) return false
  return p.traits.filter((x) => !conflicts(x, id)).length < MAX_TRAITS
}

// ---- 裝備與背包 ----

export function canEquip(p: Player, id: EquipmentId): boolean {
  return EQUIPMENT[id].role === p.role
}

/** 把背包裡的一件裝備裝到球員身上；已經裝滿時要指定換下哪一件 */
export function equipFromBag(t: Tournament, bagIndex: number, playerId: string, replace?: number): Tournament {
  expectPhase(t, 'ready', 'reward', 'shop')
  const id = t.bag[bagIndex]
  if (!id) throw new Error('背包裡沒有這件裝備')
  const target = findPlayer(t.setup.team.roster, playerId)
  if (!canEquip(target, id)) throw new Error('角色不符，不能裝這件裝備')
  const current = target.equipment ?? []
  const bag = t.bag.filter((_, i) => i !== bagIndex)
  let equipment: EquipmentId[]
  if (current.length < MAX_EQUIPMENT) equipment = [...current, id]
  else {
    if (replace === undefined || !current[replace]) throw new Error('裝備已滿，要指定換下哪一件')
    bag.push(current[replace])
    equipment = current.map((x, i) => (i === replace ? id : x))
  }
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => ({ ...p, equipment }))
  return { ...t, bag, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

/** 把球員身上的一件裝備卸下，放回背包 */
export function unequip(t: Tournament, playerId: string, itemIndex: number): Tournament {
  expectPhase(t, 'ready', 'reward')
  const target = findPlayer(t.setup.team.roster, playerId)
  const id = target.equipment?.[itemIndex]
  if (!id) throw new Error('這位球員沒有這件裝備')
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => ({ ...p, equipment: (p.equipment ?? []).filter((_, i) => i !== itemIndex) }))
  return { ...t, bag: [...t.bag, id], setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

export function findPlayer(roster: Roster, id: string): Player {
  const all = [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]
  const p = all.find((x) => x.id === id)
  if (!p) throw new Error('名單上沒有這位球員')
  return p
}

export function updatePlayer(roster: Roster, id: string, f: (p: Player) => Player): Roster {
  return mapRoster(roster, <P extends Player>(p: P) => (p.id === id ? (f(p) as P) : p))
}
