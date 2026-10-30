// 休息站的畫面：選地點、商店、訓練、事件
import { allPlayers } from '../sim/generate'
import { SHOP_REROLL_COST, releaseValue, upgradeCost } from '../sim/prices'
import { EVENTS, buy, canChoose, enterRest, eventTargets, leaveShop, rerollShop, resolveEvent, train, upgrade, type RestChoice } from '../sim/rest'
import { getSlot } from '../sim/setup'
import { repertoire } from '../sim/pitches'
import { canLearnPitch, canLearnPitchTrait, canLearnTrait, relicsOf, type RewardCard, type Tournament } from '../sim/tournament'
import { TRAITS } from '../sim/traits'
import type { BatterRatings, Pitcher, Player, PitcherRatings, Roster } from '../sim/types'
import { avatarSvg } from './avatar'
import { chooseWearer, itemCard, pickHeader, playerCard, rosterSlots } from './cards'
import { gradeOf } from './grades'
import { kbd, setKeys } from './keys'
import { choiceModal, infoModal } from './modal'
import { addGainLine, replaceList } from './replaceList'
import { relicPreview } from './synergyUi'
import { el } from './playerCard'
import { toast } from './visual'
import { EQUIPMENT_NAMES, EVENT_TEXT, PITCH_TRAIT_NAMES, RATING_FULL, RELIC_NAMES, T, TRAIT_NAMES } from './strings'

type Go = (t: Tournament) => void
type Rating = keyof BatterRatings | keyof PitcherRatings

const SVG_LINE = 'stroke="#141633" stroke-width="3" stroke-linejoin="round"'

/** 休息站三個地點的圖：商店的遮雨棚、訓練的啞鈴、事件的問號 */
const PLACE_ICONS: Record<RestChoice, string> = {
  shop: `<svg aria-hidden="true" viewBox="0 0 64 64"><rect x="12" y="28" width="40" height="28" fill="#FFFFFF" ${SVG_LINE}/><rect x="26" y="40" width="12" height="16" fill="#6FB6FF" ${SVG_LINE}/><path d="M8 28 L14 12 H50 L56 28 Q50 34 44 28 Q38 34 32 28 Q26 34 20 28 Q14 34 8 28 Z" fill="#FF4F7B" ${SVG_LINE}/></svg>`,
  training: `<svg aria-hidden="true" viewBox="0 0 64 64"><rect x="20" y="29" width="24" height="6" fill="#B4B9CC" ${SVG_LINE}/><rect x="10" y="18" width="10" height="28" rx="3" fill="#5FE3A1" ${SVG_LINE}/><rect x="44" y="18" width="10" height="28" rx="3" fill="#5FE3A1" ${SVG_LINE}/><rect x="4" y="24" width="6" height="16" rx="2" fill="#5FE3A1" ${SVG_LINE}/><rect x="54" y="24" width="6" height="16" rx="2" fill="#5FE3A1" ${SVG_LINE}/></svg>`,
  event: `<svg aria-hidden="true" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="#B57BFF" ${SVG_LINE}/><path d="M24 24 Q24 14 32 14 Q41 14 41 23 Q41 29 34 32 Q32 33 32 38" fill="none" stroke="#FFFFFF" stroke-width="6" stroke-linecap="round"/><circle cx="32" cy="47" r="3.5" fill="#FFFFFF"/></svg>`,
}

function fundsChip(t: Tournament): HTMLElement {
  return el('span', 'funds-chip', T.funds(t.funds))
}

/** 休息站的標題列：標題、說明、右邊是目前資金 */
function restHeader(title: string, hint: string, t: Tournament, toTitle: () => void): HTMLElement {
  const header = pickHeader(title, hint, toTitle, false)
  header.querySelector('.draft-header-row')?.append(fundsChip(t))
  return header
}

// ---- 選地點 ----

export function showRest(root: HTMLElement, t: Tournament, go: Go, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'draft-screen rest-screen')
  screen.append(restHeader(T.restTitle, T.restHint, t, toTitle))
  const cards = el('section', 'draft-cards')
  cards.setAttribute('aria-label', T.restTitle)
  const places: RestChoice[] = ['shop', 'training', 'event']
  places.forEach((place, i) => {
    const card = el('button', 'draft-pick item-pick place-pick reveal')
    card.type = 'button'
    card.style.setProperty('--delay', `${i * 120}ms`)
    const inner = el('span', 'draft-inner')
    const icon = el('span', 'item-icon')
    icon.innerHTML = PLACE_ICONS[place]
    inner.append(icon, el('span', 'draft-name', T.restPlaces[place].name), el('span', 'item-desc', T.restPlaces[place].desc))
    inner.append(kbd(String(i + 1)))
    card.append(inner)
    card.onclick = () => go(enterRest(t, place))
    cards.append(card)
  })
  screen.append(cards)
  root.append(screen)
  setKeys({ 1: () => go(enterRest(t, 'shop')), 2: () => go(enterRest(t, 'training')), 3: () => go(enterRest(t, 'event')) })
}

// ---- 共用的選人、選能力 ----

/** 從名單選一位球員；sub 決定每一列的第二行 */
function choosePlayer(roster: Roster, title: string, players: Player[], sub: (p: Player) => string): Promise<Player | null> {
  const labels = new Map(rosterSlots(roster).map(([slot, label]) => [getSlot(roster, slot).id, label]))
  return choiceModal<Player>({
    title,
    options: players.map((p) => ({ value: p, label: `${p.name}（${labels.get(p.id) ?? ''}）`, sub: sub(p), icon: avatarSvg(p.id, 'user') })),
  })
}

/** 每一項能力的字母等級，例如「打擊 C・力量 B」 */
function gradeSummary(p: Player): string {
  return Object.entries(p.ratings)
    .map(([k, v]) => `${RATING_FULL[k as Rating]} ${gradeOf(v)}`)
    .join('・')
}

/** 選要提升的能力，列出提升前後的字母；已經滿的不能選 */
function chooseRating(p: Player): Promise<Rating | null> {
  return choiceModal<Rating>({
    title: T.whichRating(p.name),
    options: Object.entries(p.ratings).map(([k, v]) => ({
      value: k as Rating,
      label: T.ratingStep(RATING_FULL[k as Rating], gradeOf(v), gradeOf(Math.min(10, v + 1))),
      sub: `${v.toFixed(1)} → ${Math.min(10, v + 1).toFixed(1)}`,
      locked: v >= 10 ? '已經是上限' : undefined,
    })),
  })
}

/** 選一位球員再選一項能力；取消回傳 null */
async function choosePlayerRating(t: Tournament, title: string): Promise<{ player: Player; rating: Rating } | null> {
  const roster = t.setup.team.roster
  const player = await choosePlayer(roster, title, allPlayers(roster), gradeSummary)
  if (!player) return null
  const rating = await chooseRating(player)
  return rating ? { player, rating } : null
}

// ---- 商店 ----

export function showShop(root: HTMLElement, t: Tournament, go: Go, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'draft-screen shop-screen')
  screen.append(restHeader(T.shopTitle, T.shopHint, t, toTitle))

  const grid = el('section', 'shop-grid')
  grid.setAttribute('aria-label', T.shopTitle)
  t.shop.forEach((item, i) => {
    const cell = el('div', `shop-cell ${item.sold ? 'sold' : ''}`)
    const card = item.card.kind === 'player' ? playerCard(item.card.player, false, false, i) : itemCard(item.card, false, false, i)
    if (item.card.kind === 'player') addGainLine(card, t.setup.team.roster, item.card.player, relicsOf(t))
    if (item.card.kind === 'relic') {
      const preview = relicPreview(item.card.id, t.setup.team.roster, relicsOf(t))
      if (preview) card.querySelector('.draft-inner')?.append(preview)
    }
    card.tabIndex = -1
    const price = el('button', 'btn-yellow shop-price', item.sold ? T.sold : T.buyFor(item.price))
    price.disabled = item.sold || t.funds < item.price
    if (!item.sold && t.funds < item.price) price.title = T.notEnough
    const purchase = () => void buyItem(t, i, item.card, go)
    price.onclick = purchase
    if (!price.disabled) card.onclick = purchase
    cell.append(card, price)
    grid.append(cell)
  })
  screen.append(grid)

  const side = el('div', 'draft-side')
  const actions = el('footer', 'draft-footer shop-actions')
  const cost = upgradeCost(t.upgrades)
  const up = el('button', 'btn-white', T.upgradeFor(cost))
  up.disabled = t.funds < cost
  up.onclick = async () => {
    const pick = await choosePlayerRating(t, T.upgradeWho)
    if (!pick) return
    toast(T.ratingUp(pick.player.name, RATING_FULL[pick.rating]))
    go(upgrade(t, pick.player.id, pick.rating))
  }
  const reroll = el('button', 'btn-white', T.rerollShopFor(SHOP_REROLL_COST))
  reroll.disabled = t.funds < SHOP_REROLL_COST
  reroll.onclick = () => go(rerollShop(t))
  const leave = el('button', 'btn-yellow', T.leaveShop)
  leave.append(kbd('ENTER'))
  leave.onclick = () => go(leaveShop(t))
  actions.append(up, reroll, leave)
  side.append(actions)
  screen.append(side)
  root.append(screen)
  setKeys({ Enter: () => leave.click() })
}

/** 買一格商品：依種類決定要換掉誰、給誰帶、給誰學 */
async function buyItem(t: Tournament, index: number, card: RewardCard, go: Go): Promise<void> {
  const roster = t.setup.team.roster
  switch (card.kind) {
    case 'player': {
      // 買下球員就是交易：跟獎勵一樣的「要換掉誰」列表
      const pick = card.player
      const close = infoModal(
        T.trade,
        replaceList(roster, pick, relicsOf(t), rosterSlots(roster), (slot, out) => {
          close()
          toast(`${T.joined(pick.name, out.name)}・${T.fundsEarned(releaseValue(out))}`)
          go(buy(t, index, { release: slot }))
        }),
      )
      return
    }
    case 'equipment': {
      const target = await chooseWearer(roster, card.id, true)
      if (!target) return
      toast(target.player ? T.equipped(EQUIPMENT_NAMES[card.id], target.player.name) : T.stashed(EQUIPMENT_NAMES[card.id]))
      return go(buy(t, index, { playerId: target.player?.id ?? null, replace: target.replace }))
    }
    case 'trait': {
      const id = card.id
      const players = allPlayers(roster).filter((p) => canLearnTrait(p, id))
      const who = await choosePlayer(roster, T.traitWho(TRAIT_NAMES[id]), players, (p) =>
        p.traits.length ? p.traits.map((x) => TRAIT_NAMES[x]).join('・') : T.noTraits,
      )
      if (!who) return
      toast(T.learned(who.name, TRAIT_NAMES[id]))
      return go(buy(t, index, { playerId: who.id }))
    }
    case 'relic':
      toast(T.relicGained(RELIC_NAMES[card.id]))
      return go(buy(t, index))
    case 'pitchTrait':
    case 'newPitch': {
      const name = card.kind === 'pitchTrait' ? T.pitchTraitName(PITCH_TRAIT_NAMES[card.id], T.pitchNames[card.pitch]) : T.pitchNames[card.pitch]
      const ok = (p: Player) => (card.kind === 'pitchTrait' ? canLearnPitchTrait(p, card.pitch) : canLearnPitch(p, card.pitch))
      const who = await choosePlayer(roster, T.pitchWho(name), allPlayers(roster).filter(ok), (p) =>
        repertoire(p as Pitcher).map((x) => T.pitchNames[x]).join('・'),
      )
      if (!who) return
      toast(T.pitchLearned(who.name, name))
      return go(buy(t, index, { playerId: who.id }))
    }
  }
}

// ---- 訓練 ----

export function showTraining(root: HTMLElement, t: Tournament, go: Go, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'draft-screen rest-screen')
  screen.append(restHeader(T.trainingTitle, T.trainingHint, t, toTitle))
  const box = el('section', 'event-box')
  const start = el('button', 'btn-yellow btn-big', T.trainWho)
  start.append(kbd('ENTER'))
  start.onclick = async () => {
    const pick = await choosePlayerRating(t, T.trainWho)
    if (!pick) return
    const next = train(t, pick.player.id, pick.rating)
    // 訓練推進潛能，剛好覺醒的話一起提示
    const woke = next.awakened?.[0]
    toast(woke ? T.awakened(pick.player.name, TRAIT_NAMES[woke.trait]) : T.ratingUp(pick.player.name, RATING_FULL[pick.rating]))
    go(next)
  }
  const icon = el('span', 'item-icon event-icon')
  icon.innerHTML = PLACE_ICONS.training
  box.append(icon, start)
  screen.append(box)
  root.append(screen)
  setKeys({ Enter: () => start.click() })
}

// ---- 事件 ----

export function showEvent(root: HTMLElement, t: Tournament, go: Go, toTitle: () => void): void {
  const event = t.event!
  const text = EVENT_TEXT[event]
  root.replaceChildren()
  const screen = el('div', 'draft-screen rest-screen')
  screen.append(restHeader(T.eventTitle, T.restPlaces.event.desc, t, toTitle))
  const box = el('section', 'event-box')
  box.setAttribute('aria-label', text.title)
  const icon = el('span', 'item-icon event-icon')
  icon.innerHTML = PLACE_ICONS.event
  box.append(icon, el('h2', 'event-title', text.title), el('p', 'event-body', text.body))
  const keys: Record<string, () => void> = {}
  EVENTS[event].forEach((opt, i) => {
    const btn = el('button', i === 0 ? 'btn-yellow event-option' : 'btn-white event-option')
    btn.append(el('span', '', text.options[i]))
    if (opt.cost) btn.append(el('span', 'event-cost', T.eventCost(opt.cost)))
    btn.append(kbd(String(i + 1)))
    btn.disabled = !canChoose(t, event, i)
    btn.onclick = async () => {
      const targets = eventTargets(t, event, i)
      let playerId: string | undefined
      if (targets) {
        const who = await choosePlayer(t.setup.team.roster, T.eventPickWho, targets, gradeSummary)
        if (!who) return
        playerId = who.id
      }
      const result = resolveEvent(t, i, playerId)
      toast(eventToast(result.t, result.got, result.playerId))
      go(result.t)
    }
    if (!btn.disabled) keys[String(i + 1)] = () => btn.click()
    box.append(btn)
  })
  screen.append(box)
  root.append(screen)
  setKeys(keys)
}

/** 事件結算的提示：拿到什麼，或是誰染上了紅特 */
function eventToast(t: Tournament, got?: RewardCard, playerId?: string): string {
  if (!got) return T.eventDone
  if (got.kind === 'trait') {
    const who = allPlayers(t.setup.team.roster).find((p) => p.id === playerId)?.name ?? ''
    return TRAITS[got.id].tier === 'red' ? T.eventGotTrait(who, TRAIT_NAMES[got.id]) : T.learned(who, TRAIT_NAMES[got.id])
  }
  if (got.kind === 'equipment') return T.eventGot(EQUIPMENT_NAMES[got.id])
  if (got.kind === 'relic') return T.eventGot(RELIC_NAMES[got.id])
  return T.eventDone
}
