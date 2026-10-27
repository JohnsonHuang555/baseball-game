// 錦標賽各畫面共用的卡片與名單：獎勵卡、球員卡、裝備圖示、選擇誰帶裝備
import { cardTier, type CardTier } from '../sim/generate'
import { EQUIPMENT, MAX_EQUIPMENT, type EquipmentId, type RelicId } from '../sim/items'
import { getSlot, type Slot } from '../sim/setup'
import { canEquip, rewardTier, type RewardCard } from '../sim/tournament'
import { TRAITS } from '../sim/traits'
import type { Player, Roster } from '../sim/types'
import { avatar, avatarSvg } from './avatar'
import { gradeBadge, gradeOf, overallBadge } from './grades'
import { kbd, type KeyMap } from './keys'
import { choiceModal } from './modal'
import { el, potentialTag, traitTag } from './playerCard'
import { applyCardState, handChip, pitchChip, tendencyChip } from './visual'
import {
  EQUIPMENT_NAMES,
  PITCH_TRAIT_DESC,
  PITCH_TRAIT_NAMES,
  POSITION_FULL,
  RATING_FULL,
  RATING_LABELS,
  RELIC_DESC,
  RELIC_NAMES,
  T,
  TRAIT_DESC,
  equipmentDesc,
} from './strings'

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
const CHECK_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

const SVG_LINE = 'stroke="#141633" stroke-width="3" stroke-linejoin="round"'

/** 裝備的圖：球棒、釘鞋、手套、止滑粉袋、臂套 */
export const GEAR_ICONS = {
  // 直立的球棒轉 45 度：上粗下細，握把和尾端左右對稱
  bat: `<svg aria-hidden="true" viewBox="0 0 64 64"><g transform="rotate(45 32 32)"><path d="M28 7 Q28 3 32 3 Q36 3 36 7 L36 30 L33.6 46 L33.6 53 L36.5 55 L36.5 59 L27.5 59 L27.5 55 L30.4 53 L30.4 46 L28 30 Z" fill="#E8B07A" ${SVG_LINE}/><path d="M30.4 44 H33.6 M30.4 48 H33.6" stroke="#141633" stroke-width="1.5"/></g></svg>`,
  shoe: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M14 54 L18 57 L22 54 M28 54 L32 57 L36 54 M44 54 L48 57 L52 54" fill="#141633" ${SVG_LINE}/><path d="M8 50 L10 20 Q18 21 23 28 L34 34 Q52 36 56 44 L56 50 Z" fill="#6FB6FF" ${SVG_LINE}/><path d="M20 30 L24 26 M25 33 L29 29 M30 35 L34 31" stroke="#141633" stroke-width="2"/></svg>`,
  glove: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M14 48 Q8 34 11 22 Q13 14 19 16 L22 28 L23 12 Q25 6 30 8 L32 26 L34 10 Q37 5 41 8 L41 28 L45 18 Q49 14 52 18 Q53 32 47 44 Q40 56 28 56 Q18 56 14 48 Z" fill="#C8763A" ${SVG_LINE}/><path d="M20 42 Q30 48 42 40" fill="none" stroke="#141633" stroke-width="2" stroke-dasharray="3 3"/></svg>`,
  pouch: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M20 24 Q12 50 22 57 H42 Q52 50 44 24 Z" fill="#F4F1E8" ${SVG_LINE}/><path d="M18 24 Q32 18 46 24" fill="none" ${SVG_LINE}/><path d="M27 20 L32 9 L37 20" fill="none" ${SVG_LINE}/><circle cx="28" cy="40" r="2" fill="#B4B9CC"/><circle cx="36" cy="46" r="2" fill="#B4B9CC"/><circle cx="34" cy="34" r="2" fill="#B4B9CC"/></svg>`,
  // 護腕：一圈布料，上面看得到開口
  sleeve: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M12 22 V42 Q32 54 52 42 V22" fill="#FF8A2A" ${SVG_LINE}/><ellipse cx="32" cy="22" rx="20" ry="8" fill="#FF8A2A" ${SVG_LINE}/><ellipse cx="32" cy="22" rx="12" ry="4" fill="#141633"/><path d="M12 34 Q32 46 52 34" fill="none" stroke="#FFFFFF" stroke-width="4"/></svg>`,
}

const GEAR_OF: Record<EquipmentId, keyof typeof GEAR_ICONS> = {
  trainingBat: 'bat',
  masterBat: 'bat',
  weightedBat: 'bat',
  compressedBat: 'bat',
  legendBat: 'bat',
  spikes: 'shoe',
  carbonSpikes: 'shoe',
  leatherGlove: 'glove',
  goldGlove: 'glove',
  fireballGlove: 'glove',
  gripBag: 'pouch',
  precisionSleeve: 'sleeve',
  elbowGuard: 'sleeve',
  enduranceBand: 'sleeve',
  goldenSleeve: 'sleeve',
}

/** 秘寶是寶石、特性是星星、球種卡是帶縫線的棒球（球種特性加速度線、新球種加一個加號） */
const BALL = `<circle cx="34" cy="34" r="20" fill="#FFFFFF" ${SVG_LINE}/><path d="M24 18 Q30 34 24 50 M44 18 Q38 34 44 50" fill="none" stroke="#E5383B" stroke-width="2.5" stroke-dasharray="4 3"/>`
export const KIND_ICONS: Record<'relic' | 'trait' | 'pitchTrait' | 'newPitch', string> = {
  pitchTrait: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M4 22 H14 M2 32 H12 M4 42 H14" stroke="#B57BFF" stroke-width="4" stroke-linecap="round"/>${BALL}</svg>`,
  newPitch: `<svg aria-hidden="true" viewBox="0 0 64 64">${BALL}<circle cx="50" cy="14" r="11" fill="#5FE3A1" ${SVG_LINE}/><path d="M50 8 V20 M44 14 H56" stroke="#141633" stroke-width="3.5" stroke-linecap="round"/></svg>`,
  relic:
    '<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M20 10 H44 L56 26 L32 56 L8 26 Z" fill="#B57BFF" stroke="#141633" stroke-width="3" stroke-linejoin="round"/><path d="M8 26 H56 M20 10 L26 26 L32 56 L38 26 L44 10" fill="none" stroke="#141633" stroke-width="2"/></svg>',
  trait:
    '<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M32 6 L39 24 L58 25 L43 37 L48 56 L32 45 L16 56 L21 37 L6 25 L25 24 Z" fill="#FFD23F" stroke="#141633" stroke-width="3" stroke-linejoin="round"/></svg>',
}

export function backButton(onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-btn')
  b.type = 'button'
  b.innerHTML = BACK_ICON
  b.setAttribute('aria-label', T.backToTitle)
  b.onclick = onClick
  return b
}


/** 名單上每位球員的位置說明，例如「游擊手・第 3 棒」「後援投手」 */
export function rosterSlots(roster: Roster): [Slot, string][] {
  return [
    ...roster.lineup.map((s, i): [Slot, string] => [{ kind: 'lineup', index: i }, `${POSITION_FULL[s.position]}・${T.orderNth(i + 1)}`]),
    ...roster.bench.map((_, i): [Slot, string] => [{ kind: 'bench', index: i }, T.bench]),
    [{ kind: 'starter' }, T.starter],
    ...roster.relievers.map((_, i): [Slot, string] => [{ kind: 'reliever', index: i }, T.reliever]),
  ]
}

/** 秘寶或裝備的小標籤，卡色當底色 */
export function kitChip(label: string, desc: string, tier: CardTier, button = false): HTMLElement {
  const chip = el(button ? 'button' : 'span', `kit-chip tier-${tier}`)
  if (chip instanceof HTMLButtonElement) chip.type = 'button'
  chip.append(el('b', 'kit-chip-name', label), el('span', 'kit-chip-desc', desc))
  chip.title = desc
  return chip
}

/** 選一位能帶這件裝備的球員；裝滿的人再選換下哪一件。allowBag 時多一個「先放進背包」（回傳 player: null） */
export async function chooseWearer(roster: Roster, id: EquipmentId, allowBag = false): Promise<{ player: Player | null; replace?: number } | null> {
  const slots = rosterSlots(roster).filter(([slot]) => canEquip(getSlot(roster, slot), id))
  const BAG = 'bag' as const
  const player = await choiceModal<Player | typeof BAG>({
    title: T.equipWho(EQUIPMENT_NAMES[id]),
    message: equipmentDesc(id),
    options: [...(allowBag ? [{ value: BAG, label: T.toBag }] : []), ...slots.map(([slot, label]) => {
      const p = getSlot(roster, slot)
      const items = (p.equipment ?? []).map((x) => EQUIPMENT_NAMES[x]).join('・')
      return { value: p, label: `${p.name}（${label}）`, sub: `${T.equipmentCount(p.equipment?.length ?? 0, MAX_EQUIPMENT)}${items ? `：${items}` : ''}`, icon: avatarSvg(p.id, 'user') }
    })],
  })
  if (!player) return null
  if (player === BAG) return { player: null }
  const current = player.equipment ?? []
  if (current.length < MAX_EQUIPMENT) return { player }
  const replace = await choiceModal<number>({
    title: T.pickReplace(player.name),
    options: current.map((x, i) => ({ value: i, label: T.replaceItem(EQUIPMENT_NAMES[x]), sub: equipmentDesc(x) })),
  })
  return replace === null ? null : { player, replace }
}


export function pickHeader(title: string, hint: string, toTitle: () => void, arrowKeys = true): HTMLElement {
  const header = el('header', 'draft-header')
  const top = el('div', 'draft-header-row')
  top.append(backButton(toTitle), el('h1', 'draft-title', title))
  header.append(top, el('p', 'draft-hint', hint))
  // 電腦版的按鍵說明：只有能用方向鍵選卡的畫面才有
  if (arrowKeys) {
    const keyHints = el('span', 'draft-keys desk-only')
    keyHints.append(kbd('←'), kbd('→'), T.pickCard, kbd('ENTER'), T.confirmKey)
    header.append(keyHints)
  }
  return header
}

/** ← → 在卡片之間移動 */
export function cardKeys(n: number, chosen: () => number | null, set: (i: number) => void): KeyMap {
  const move = (d: number) => {
    const c = chosen()
    set(c === null ? (d > 0 ? 0 : n - 1) : (c + d + n) % n)
  }
  return { ArrowLeft: () => move(-1), ArrowRight: () => move(1) }
}

/** 球員卡：頭像、能力長條、第一個特性 */
export function playerCard(p: Player, selected: boolean, reveal: boolean, i: number): HTMLButtonElement {
  const card = el('button', 'draft-pick')
  card.type = 'button'
  card.setAttribute('aria-pressed', String(selected))
  applyCardState(card, p, { selected, reveal })
  card.style.setProperty('--delay', `${i * 120}ms`)
  const inner = el('span', 'draft-inner')
  const topRow = el('span', 'draft-top')
  topRow.append(el('span', 'tier-tag', T.tierNames[cardTier(p)]), overallBadge(p, 'md'))
  inner.append(topRow, avatar(p.id, 'user', 'draft-avatar'), el('span', 'draft-name', p.name))
  inner.append(el('span', 'draft-role', `${T.rewardKinds.player}・${p.role === 'pitcher' ? T.pitcher : T.batter}`))
  const chips = el('span', 'draft-chips')
  chips.append(handChip(p))
  if (p.role === 'batter') chips.append(tendencyChip(p.tendency, true))
  else chips.append(pitchChip(p, true))
  inner.append(chips)
  const stats = el('span', 'draft-stats')
  Object.entries(p.ratings).forEach(([k, v]) => {
    const row = el('span', 'draft-stat')
    const bar = el('span', 'draft-bar')
    const g = gradeOf(v)
    const fill = el('span', `bar-fill fill-${g}`)
    fill.style.width = `${v * 10}%`
    bar.append(fill)
    // 手機版：短標籤、長條、字母；電腦版：完整標籤、等級徽章、長條
    const key = k as keyof typeof RATING_FULL
    row.append(
      el('span', 'draft-stat-label mobile-only', RATING_LABELS[key]),
      el('span', 'draft-stat-label desk-only', RATING_FULL[key]),
      gradeBadge(v, 'sm'),
      bar,
      el('span', 'draft-stat-grade', g),
    )
    stats.append(row)
  })
  inner.append(stats)
  if (p.traits.length) inner.append(traitTag(p.traits[0]), el('span', 'draft-trait-desc', TRAIT_DESC[p.traits[0]]))
  const pot = potentialTag(p)
  if (pot) inner.append(pot)
  card.append(inner)
  if (selected) card.append(checkMark())
  return card
}

/** 裝備、秘寶、特性卡：卡色、種類、圖、名稱、效果 */
export function itemCard(card: Exclude<RewardCard, { kind: 'player' }>, selected: boolean, reveal: boolean, i: number): HTMLButtonElement {
  const tier = rewardTier(card)
  const node = el('button', `draft-pick item-pick tier-${tier}`)
  node.type = 'button'
  node.setAttribute('aria-pressed', String(selected))
  if (selected) node.classList.add('selected')
  if (reveal) node.classList.add(tier === 'rainbow' ? 'reveal-special' : 'reveal')
  node.style.setProperty('--delay', `${i * 120}ms`)
  const inner = el('span', 'draft-inner')
  const topRow = el('span', 'draft-top')
  topRow.append(el('span', 'tier-tag', T.tierNames[tier]), el('span', 'item-kind', T.rewardKinds[card.kind]))
  const icon = el('span', 'item-icon')
  icon.innerHTML = card.kind === 'equipment' ? GEAR_ICONS[GEAR_OF[card.id]] : KIND_ICONS[card.kind]
  inner.append(topRow, icon)
  if (card.kind === 'equipment') {
    const role = EQUIPMENT[card.id].role === 'pitcher' ? T.pitcher : T.batter
    inner.append(el('span', 'draft-name', EQUIPMENT_NAMES[card.id]), el('span', 'draft-role', role), el('span', 'item-desc', equipmentDesc(card.id)))
  } else if (card.kind === 'relic') {
    inner.append(el('span', 'draft-name', RELIC_NAMES[card.id]), el('span', 'draft-role', T.relicsTitle), el('span', 'item-desc', RELIC_DESC[card.id as RelicId]))
  } else if (card.kind === 'pitchTrait') {
    const name = T.pitchTraitName(PITCH_TRAIT_NAMES[card.id], T.pitchNames[card.pitch])
    inner.append(el('span', 'draft-name', name), el('span', 'draft-role', T.pitcher), el('span', 'item-desc', PITCH_TRAIT_DESC[card.id]))
  } else if (card.kind === 'newPitch') {
    inner.append(el('span', 'draft-name', T.pitchNames[card.pitch]), el('span', 'draft-role', T.pitcher), el('span', 'item-desc', T.newPitchDesc))
  } else {
    const role = TRAITS[card.id].role === 'pitcher' ? T.pitcher : T.batter
    inner.append(traitTag(card.id), el('span', 'draft-role', role), el('span', 'item-desc', TRAIT_DESC[card.id]))
  }
  node.append(inner)
  if (selected) node.append(checkMark())
  return node
}

export function checkMark(): HTMLElement {
  const check = el('span', 'draft-check')
  check.innerHTML = CHECK_ICON
  return check
}
