// 球團資金的價格：商店售價、釋出球員換回的錢、每場比賽賺的錢
import { cardTier, type CardTier } from './generate'
import { EQUIPMENT, RELICS } from './items'
import { TRAITS } from './traits'
import type { RewardCard } from './tournament'
import type { Player } from './types'

export const STARTING_FUNDS = 50
/** 商店重骰一次的費用 */
export const SHOP_REROLL_COST = 20
/** 付費強化：第一次的費用，之後每次再貴一點（同一次商店內） */
export const UPGRADE_BASE_COST = 40
export const UPGRADE_STEP_COST = 20

const PLAYER_PRICE: Record<CardTier, number> = { bronze: 40, silver: 70, gold: 110, rainbow: 160 }
const EQUIPMENT_PRICE: Record<CardTier, number> = { bronze: 30, silver: 55, gold: 90, rainbow: 140 }
const RELIC_PRICE: Record<CardTier, number> = { bronze: 50, silver: 80, gold: 120, rainbow: 180 }

export function priceOf(card: RewardCard): number {
  switch (card.kind) {
    case 'player':
      return PLAYER_PRICE[cardTier(card.player)]
    case 'equipment':
      return EQUIPMENT_PRICE[EQUIPMENT[card.id].tier]
    case 'relic':
      return RELIC_PRICE[RELICS[card.id].tier]
    case 'trait':
      return TRAITS[card.id].tier === 'gold' ? 90 : 45
  }
}

/** 釋出球員換回的錢：身價的一半 */
export function releaseValue(p: Player): number {
  return Math.floor(PLAYER_PRICE[cardTier(p)] / 2)
}

/** 每場比賽賺的錢：贏 50、輸 25，每得一分再加 5（最多加 30） */
export function gameFunds(won: boolean, runs: number): number {
  return (won ? 50 : 25) + Math.min(30, runs * 5)
}

export function upgradeCost(upgradesSoFar: number): number {
  return UPGRADE_BASE_COST + UPGRADE_STEP_COST * upgradesSoFar
}
