// 休息站：例行賽每兩場一站，教練從商店、訓練、事件中選一個
import { allPlayers, type CardTier } from './generate'
import { EQUIPMENT, RELICS, type EquipmentId, type RelicId } from './items'
import { advancePotential, trainingBoost } from './potential'
import { SHOP_REROLL_COST, priceOf, upgradeCost } from './prices'
import { Rng } from './rng'
import type { Slot } from './setup'
import {
  canLearnTrait,
  equipFromBag,
  findPlayer,
  relicsOf,
  replacePlayer,
  rewardOf,
  teachPitch,
  teachPitchTrait,
  teachTrait,
  toNextGame,
  updatePlayer,
  withRelic,
  type Awakening,
  type RewardCard,
  type ShopItem,
  type Tournament,
  type TournamentPhase,
} from './tournament'
import { TRAITS, type TraitId } from './traits'
import type { BatterRatings, Player, PitcherRatings } from './types'

export type RestChoice = 'shop' | 'training' | 'event'

type Rating = keyof BatterRatings | keyof PitcherRatings

const MIN_RATING = 1
const MAX_RATING = 10

function expectPhase(t: Tournament, phase: TournamentPhase): void {
  if (t.phase !== phase) throw new Error(`錦標賽目前是 ${t.phase}，不能這樣做`)
}

/** 某位球員的某項能力加減（1～10 之間） */
function bump(t: Tournament, playerId: string, changes: Partial<Record<Rating, number>>): Tournament {
  const roster = updatePlayer(t.setup.team.roster, playerId, (p) => {
    const ratings = { ...p.ratings } as Record<string, number>
    for (const [k, v] of Object.entries(changes)) {
      if (ratings[k] === undefined) throw new Error('這位球員沒有這項能力')
      ratings[k] = Math.min(MAX_RATING, Math.max(MIN_RATING, ratings[k] + (v as number)))
    }
    return { ...p, ratings } as unknown as Player
  })
  return { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster } } }
}

/** 進入休息站的其中一個地點 */
export function enterRest(t: Tournament, choice: RestChoice): Tournament {
  expectPhase(t, 'rest')
  if (choice === 'shop') return stockShop({ ...t, phase: 'shop', upgrades: 0 })
  if (choice === 'training') return { ...t, phase: 'training' }
  const rng = new Rng(t.rngState)
  const event = rng.pick(Object.keys(EVENTS) as EventId[])
  return { ...t, phase: 'event', event, rngState: rng.state }
}

// ---- 商店 ----

const SHOP_TIERS: [CardTier, number][] = [['bronze', 40], ['silver', 35], ['gold', 20], ['rainbow', 5]]
/** 商店的貨架：2 名球員、2 件裝備、1 個秘寶、1 張特性 */
const SHOP_SHELF: RewardCard['kind'][] = ['player', 'player', 'equipment', 'equipment', 'relic', 'trait']

function stockShop(t: Tournament): Tournament {
  const rng = new Rng(t.rngState)
  const shop: ShopItem[] = []
  for (const shelf of SHOP_SHELF) {
    // 特性那一格有時改賣球種特性或新球種
    const kind = shelf === 'trait' ? rng.weighted<RewardCard['kind']>([['trait', 3], ['pitchTrait', 2], ['newPitch', 1]]) : shelf
    const card = rewardOf(rng, kind, rng.weighted(SHOP_TIERS), t)
    // 秘寶全部擁有了（或沒有投手用得到球種卡）就改賣裝備
    const item = card ?? rewardOf(rng, 'equipment', 'silver', t)!
    shop.push({ card: item, price: priceOf(item), sold: false })
  }
  return { ...t, shop, rngState: rng.state }
}

/** 花錢換一批新商品 */
export function rerollShop(t: Tournament): Tournament {
  expectPhase(t, 'shop')
  if (t.funds < SHOP_REROLL_COST) throw new Error('資金不夠')
  return stockShop({ ...t, funds: t.funds - SHOP_REROLL_COST })
}

/**
 * 買一格商品。球員要指定換掉誰（交易）；裝備指定誰帶（null 放進背包，裝滿要指定換下哪一件）；
 * 特性指定誰學；秘寶直接加進全隊
 */
export function buy(t: Tournament, index: number, target: { release?: Slot; playerId?: string | null; replace?: number } = {}): Tournament {
  expectPhase(t, 'shop')
  const item = t.shop[index]
  if (!item || item.sold) throw new Error('沒有這個商品')
  if (t.funds < item.price) throw new Error('資金不夠')
  const shop = t.shop.map((x, i) => (i === index ? { ...x, sold: true } : x))
  let next: Tournament = { ...t, shop, funds: t.funds - item.price }
  const { card } = item
  switch (card.kind) {
    case 'player':
      if (!target.release) throw new Error('要指定換掉哪一位')
      return replacePlayer(next, card.player, target.release)
    case 'relic':
      return withRelic(next, card.id)
    case 'trait':
      if (!target.playerId) throw new Error('要指定誰學')
      return teachTrait(next, target.playerId, card.id)
    case 'equipment':
      next = { ...next, bag: [...next.bag, card.id] }
      return target.playerId ? equipFromBag(next, next.bag.length - 1, target.playerId, target.replace) : next
    case 'pitchTrait':
      if (!target.playerId) throw new Error('要指定哪一位投手')
      return teachPitchTrait(next, target.playerId, card.pitch, card.id)
    case 'newPitch':
      if (!target.playerId) throw new Error('要指定哪一位投手')
      return teachPitch(next, target.playerId, card.pitch)
  }
}

/** 付費強化：一位球員的一項能力 +1，同一次商店越強化越貴 */
export function upgrade(t: Tournament, playerId: string, rating: Rating): Tournament {
  expectPhase(t, 'shop')
  const cost = upgradeCost(t.upgrades)
  if (t.funds < cost) throw new Error('資金不夠')
  return { ...bump(t, playerId, { [rating]: 1 }), funds: t.funds - cost, upgrades: t.upgrades + 1 }
}

export function leaveShop(t: Tournament): Tournament {
  expectPhase(t, 'shop')
  return toNextGame(t)
}

// ---- 訓練 ----

/** 免費讓一位球員的一項能力 +1；有潛能的話順便推進四分之一，可能因此覺醒 */
export function train(t: Tournament, playerId: string, rating: Rating): Tournament {
  expectPhase(t, 'training')
  const next = bump(t, playerId, { [rating]: 1 })
  const awakened: Awakening[] = []
  const roster = updatePlayer(next.setup.team.roster, playerId, (p) => {
    if (!p.potential) return p
    const result = advancePotential(p, trainingBoost(p.potential))
    if (result.awakened) awakened.push({ playerId, trait: result.awakened })
    return result.player
  })
  return toNextGame({ ...next, awakened, setup: { ...next.setup, team: { ...next.setup.team, roster } } })
}

// ---- 事件 ----

export type EventId = 'fanMeet' | 'undergroundTraining' | 'visitingCoach' | 'lateNight' | 'sponsor' | 'fleaMarket' | 'mysteriousElder' | 'rehab'

export interface EventOption {
  /** 要付的資金 */
  cost?: number
  /** 要教練指定的球員 */
  target?: Player['role'] | 'any'
}

/** 每個事件的兩個選項；效果寫在 resolveEvent */
export const EVENTS: Record<EventId, [EventOption, EventOption]> = {
  fanMeet: [{}, { target: 'batter' }],
  undergroundTraining: [{ target: 'batter' }, {}],
  visitingCoach: [{ cost: 40, target: 'pitcher' }, {}],
  lateNight: [{}, { target: 'pitcher' }],
  sponsor: [{}, {}],
  fleaMarket: [{ cost: 30 }, {}],
  mysteriousElder: [{ cost: 60 }, {}],
  rehab: [{ target: 'any' }, {}],
}

/** 名教練能教的投手藍特 */
const COACH_TRAITS = (Object.keys(TRAITS) as TraitId[]).filter((id) => TRAITS[id].role === 'pitcher' && TRAITS[id].tier === 'blue')

/** 這個選項能選哪些球員；不需要指定球員就是 null */
export function eventTargets(t: Tournament, event: EventId, option: number): Player[] | null {
  const want = EVENTS[event][option].target
  if (!want) return null
  const players = allPlayers(t.setup.team.roster).filter((p) => want === 'any' || p.role === want)
  if (event === 'visitingCoach') return players.filter((p) => COACH_TRAITS.some((id) => canLearnTrait(p, id)))
  return players
}

/** 這個選項現在能不能選：錢夠、需要的對象存在 */
export function canChoose(t: Tournament, event: EventId, option: number): boolean {
  const opt = EVENTS[event][option]
  if ((opt.cost ?? 0) > t.funds) return false
  const targets = eventTargets(t, event, option)
  if (targets && !targets.length) return false
  if (event === 'mysteriousElder' && option === 0) return unownedRelics(t).length > 0
  return true
}

function unownedRelics(t: Tournament): RelicId[] {
  const owned = new Set(relicsOf(t))
  return (Object.keys(RELICS) as RelicId[]).filter((id) => !owned.has(id))
}

export interface EventResult {
  t: Tournament
  /** 隨機得到（或被加上）的東西，畫面用來提示 */
  got?: RewardCard
  /** 受影響的球員 */
  playerId?: string
}

/** 選一個選項，結算後前往下一場 */
export function resolveEvent(t: Tournament, option: number, playerId?: string): EventResult {
  expectPhase(t, 'event')
  const event = t.event!
  if (!canChoose(t, event, option)) throw new Error('這個選項現在不能選')
  const targets = eventTargets(t, event, option)
  if (targets && !targets.some((p) => p.id === playerId)) throw new Error('要指定一位符合的球員')
  const rng = new Rng(t.rngState)
  let next: Tournament = { ...t, funds: t.funds - (EVENTS[event][option].cost ?? 0) }
  let got: RewardCard | undefined
  const id = playerId!
  switch (`${event}:${option}`) {
    case 'fanMeet:0':
      next = { ...next, funds: next.funds + 40 }
      break
    case 'fanMeet:1':
      next = bump(next, id, { contact: 1 })
      break
    case 'undergroundTraining:0':
      next = bump(next, id, { power: 2, fielding: -1 })
      break
    case 'visitingCoach:0': {
      const p = findPlayer(next.setup.team.roster, id)
      const trait = rng.pick(COACH_TRAITS.filter((x) => canLearnTrait(p, x)))
      next = teachTrait(next, id, trait)
      got = { kind: 'trait', id: trait }
      break
    }
    case 'lateNight:0':
      for (const s of next.setup.team.roster.lineup) next = bump(next, s.player.id, { speed: 0.5 })
      break
    case 'lateNight:1':
      next = bump(next, id, { stamina: 1 })
      break
    case 'sponsor:0': {
      // 贊助商要求的代言行程：拿 80 資金，但隨機一位球員染上一個紅特
      next = { ...next, funds: next.funds + 80 }
      const options = allPlayers(next.setup.team.roster).flatMap((p) =>
        (Object.keys(TRAITS) as TraitId[]).filter((x) => TRAITS[x].tier === 'red' && canLearnTrait(p, x)).map((x) => [p.id, x] as const),
      )
      if (options.length) {
        const [who, trait] = rng.pick(options)
        next = teachTrait(next, who, trait)
        got = { kind: 'trait', id: trait }
        return { t: toNextGame({ ...next, rngState: rng.state }), got, playerId: who }
      }
      break
    }
    case 'fleaMarket:0': {
      const pool = (Object.keys(EQUIPMENT) as EquipmentId[]).filter((x) => EQUIPMENT[x].tier === 'bronze' || EQUIPMENT[x].tier === 'silver')
      const item = rng.pick(pool)
      next = { ...next, bag: [...next.bag, item] }
      got = { kind: 'equipment', id: item }
      break
    }
    case 'mysteriousElder:0': {
      const relic = rng.pick(unownedRelics(next))
      next = withRelic(next, relic)
      got = { kind: 'relic', id: relic }
      break
    }
    case 'rehab:0': {
      const p = findPlayer(next.setup.team.roster, id)
      next = bump(next, id, Object.fromEntries(Object.keys(p.ratings).map((k) => [k, 0.5])))
      break
    }
    case 'rehab:1':
      next = { ...next, funds: next.funds + 30 }
      break
  }
  return { t: toNextGame({ ...next, rngState: rng.state }), got, playerId }
}
