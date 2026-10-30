// 「要換掉誰」：獎勵與商店拿到新球員時，只回答一個問題——換掉誰最划算
import type { RelicId } from '../sim/items'
import { fieldingAtPosition, positionPenalty } from '../sim/positions'
import { releaseValue } from '../sim/prices'
import { captainIn } from '../sim/synergy'
import { getSlot, setSlot, type Slot } from '../sim/setup'
import { TRAITS } from '../sim/traits'
import type { Batter, Player, Roster } from '../sim/types'
import { avatar } from './avatar'
import { overallBadge, gradeOf } from './grades'
import { el, traitTag } from './playerCard'
import { ARCHETYPE_NAMES, POSITION_SPOT, RATING_LABELS, SYNERGY_SHORT, T } from './strings'
import { archetypeIcon, diffTag, isPositionKey, synergyDiff, warnTag, type SynergyDiff } from './synergyUi'
import { rosterSlots } from './cards'

const GRADE_ORDER = 'SABCDEFG'

/** 一項能力的變化：字母不上等級色，變好綠、變壞紅 */
interface RatingChange {
  label: string
  from: string
  to: string
}

/** 換掉某一格之後的結果 */
export interface ReplaceOption {
  slot: Slot
  out: Player
  /** 這一格的說明：「左外野・本職中外野」「板凳」「先發投手」 */
  where: string
  order: string
  /** 能力淨變化：每項能力升降幾級加總（守備用新球員守那個位置的實際值） */
  net: number
  changes: RatingChange[]
  diffs: SynergyDiff[]
  losesCaptain: boolean
  note: string
  refund: number
  score: number
}

/** 換掉每一格的結果，最划算的排前面：先看羈絆變好多少，再看能力淨變化 */
export function replaceOptions(roster: Roster, pick: Player, relics: readonly RelicId[], slots: [Slot, string][]): ReplaceOption[] {
  const captain = captainIn(roster.lineup, roster.captain)
  const options = slots
    .filter(([slot]) => getSlot(roster, slot).role === pick.role)
    .map(([slot]): ReplaceOption => {
      const out = getSlot(roster, slot)
      const after = setSlot(roster, slot, pick)
      const position = slot.kind === 'lineup' ? roster.lineup[slot.index].position : null
      const changes: RatingChange[] = []
      let net = 0
      for (const key of Object.keys(out.ratings)) {
        const value = (p: Player) => {
          const v = (p.ratings as unknown as Record<string, number>)[key]
          return key === 'fielding' && position && p.role === 'batter' ? fieldingAtPosition(p, position) : v
        }
        const from = gradeOf(value(out))
        const to = gradeOf(value(pick))
        const steps = GRADE_ORDER.indexOf(from) - GRADE_ORDER.indexOf(to)
        net += steps
        if (steps) changes.push({ label: RATING_LABELS[key as keyof typeof RATING_LABELS], from, to })
      }
      const diffs = synergyDiff(roster, after, relics)
      const gain = diffs.reduce((sum, d) => sum + (d.kind === 'up' || d.kind === 'act' ? 1 : d.kind === 'lose' || d.kind === 'down' ? -1 : 0), 0)
      const losesCaptain = out.id === captain
      const lost = out.traits.filter((t) => TRAITS[t].tier !== 'red' && !pick.traits.includes(t))
      const notes: string[] = []
      if (position && position !== 'DH' && pick.role === 'batter') {
        notes.push(positionPenalty(pick.primary, position) ? T.replaceOffPosition(pick.name, POSITION_SPOT[position]) : T.replaceNative(pick.name, POSITION_SPOT[position]))
      }
      if (lost.length) notes.push(T.replaceLosesTraits(lost.length))
      notes.push(T.refund(releaseValue(out)))
      return {
        slot,
        out,
        where: whereText(roster, slot),
        order: slot.kind === 'lineup' ? String(slot.index + 1) : slot.kind === 'bench' ? T.benchMark : slot.kind === 'starter' ? T.starter : T.reliever,
        net,
        changes,
        diffs,
        losesCaptain,
        note: notes.join('。'),
        refund: releaseValue(out),
        // 板凳不上場，能力變好的價值只算一半；羈絆每變好一階抵三級能力
        score: gain * 3 + (slot.kind === 'bench' ? net / 2 : net) - (losesCaptain ? 1 : 0),
      }
    })
  return options.sort((a, b) => b.score - a.score)
}

function whereText(roster: Roster, slot: Slot): string {
  if (slot.kind === 'bench') return T.bench
  if (slot.kind === 'starter') return T.starter
  if (slot.kind === 'reliever') return T.reliever
  const spot = roster.lineup[slot.index]
  const p = spot.player
  return positionPenalty(p.primary, spot.position) && spot.position !== 'DH'
    ? `${POSITION_SPOT[spot.position]}・${T.primaryShort(POSITION_SPOT[p.primary])}`
    : POSITION_SPOT[spot.position]
}

/** 球員卡上「最多能讓」：換掉最適合的人時，最好的一個羈絆結果；沒有變化回傳 null */
export function bestSynergyGain(roster: Roster, pick: Player, relics: readonly RelicId[], slots: [Slot, string][]): SynergyDiff | null {
  if (pick.role !== 'batter') return null
  const gains = replaceOptions(roster, pick, relics, slots).flatMap((o) => o.diffs.filter((d) => d.kind === 'up' || d.kind === 'act'))
  return gains.sort((a, b) => (a.kind === 'up' ? 0 : 1) - (b.kind === 'up' ? 0 : 1))[0] ?? null
}

/** 「最多能讓」的文字：「重砲 4→5 升級」「二遊 成立」 */
export function gainText(d: SynergyDiff): string {
  if (isPositionKey(d.key)) return T.diffFormed(SYNERGY_SHORT[d.key])
  return T.gainText(SYNERGY_SHORT[d.key], d.from, d.to, d.kind === 'up')
}

/**
 * 「要換掉誰」列表：上面是新球員的摘要，先列推薦 3 人，其他人收起來。
 * 每列收合時只有名字、守位、能力淨變化和最多兩個標籤；點「看能力變化」才展開
 */
export function replaceList(roster: Roster, pick: Player, relics: readonly RelicId[], slots: [Slot, string][], onPick: (slot: Slot, out: Player) => void): HTMLElement {
  const box = el('section', 'replace-list')
  box.setAttribute('aria-label', T.replaceWhoTitle(pick.name))
  const head = el('div', 'replace-head')
  const face = el('span', 'replace-face')
  face.append(avatar(pick.id, 'user'))
  if (pick.role === 'batter') face.append(archetypeIcon(pick.archetype, 16))
  const titles = el('span', 'replace-titles')
  titles.append(el('span', 'replace-title', T.replaceWhoTitle(pick.name)), el('span', 'replace-sub', pickSummary(pick)))
  head.append(face, titles, overallBadge(pick, 'md'))
  box.append(head)

  const options = replaceOptions(roster, pick, relics, slots)
  const recommended = options.slice(0, 3)
  const rest = options.slice(3)
  const body = el('div', 'replace-body')
  body.append(el('span', 'replace-section', T.recommended))
  recommended.forEach((o, i) => body.append(optionRow(o, i === 0, onPick)))
  if (rest.length) {
    const more = el('button', 'replace-more')
    more.type = 'button'
    more.setAttribute('aria-expanded', 'false')
    more.append(el('span', 'replace-more-title', T.othersCount(rest.length)), el('span', 'replace-more-names', rest.map((o) => o.out.name).join('、')))
    more.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#141633" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>')
    const others = el('div', 'replace-others')
    others.hidden = true
    others.append(...rest.map((o) => optionRow(o, false, onPick)))
    more.onclick = () => {
      others.hidden = !others.hidden
      more.setAttribute('aria-expanded', String(!others.hidden))
    }
    body.append(more, others)
  }
  box.append(body)
  return box
}

/** 新球員的一行摘要：「力量型・本職左外野・打 C 力 A 速 D 守 B」 */
function pickSummary(p: Player): string {
  const grades = Object.entries(p.ratings)
    .map(([k, v]) => `${RATING_LABELS[k as keyof typeof RATING_LABELS]} ${gradeOf(v)}`)
    .join(' ')
  if (p.role !== 'batter') return `${T.pitcher}・${grades}`
  const b = p as Batter
  return `${ARCHETYPE_NAMES[b.archetype]}・${T.primaryShort(POSITION_SPOT[b.primary])}・${grades}`
}

function optionRow(o: ReplaceOption, top: boolean, onPick: (slot: Slot, out: Player) => void): HTMLElement {
  const row = el('div', `replace-row${top ? ' top' : ''}`)
  const main = el('div', 'replace-main')
  const face = el('span', 'replace-face small')
  face.append(avatar(o.out.id, 'user'))
  if (o.out.role === 'batter') face.append(archetypeIcon(o.out.archetype, 15))
  const who = el('span', 'replace-who')
  const name = el('span', 'replace-name-row')
  name.append(el('span', 'replace-name', o.out.name))
  if (top) name.append(el('span', 'replace-best', T.topPick))
  who.append(name, el('span', 'replace-where', o.where))
  const net = el('span', 'replace-net')
  net.append(el('span', 'replace-net-label', T.netChange), el('span', `replace-net-value ${o.net > 0 ? 'up' : o.net < 0 ? 'down' : ''}`, o.net > 0 ? `+${o.net}` : o.net === 0 ? '±0' : String(o.net)))
  const button = el('button', top ? 'btn-yellow replace-btn' : 'btn-white replace-btn', T.replaceHim)
  button.type = 'button'
  button.onclick = () => onPick(o.slot, o.out)
  main.append(el('span', 'replace-order', o.order), face, who, net, button)
  row.append(main)
  // 最多兩個標籤：羈絆變化，隊長被換掉時優先標出
  const tags = el('div', 'replace-tags')
  const items: HTMLElement[] = []
  if (o.losesCaptain) items.push(warnTag(T.loseCaptain, 'captain'))
  items.push(...o.diffs.map((d) => diffTag(d, true)))
  tags.append(...items.slice(0, 2))
  if (items.length) row.append(tags)
  // 看能力變化：只列有變的能力，加上一句說明
  const detail = el('div', 'replace-detail')
  detail.hidden = true
  const list = el('span', 'replace-changes')
  for (const c of o.changes) {
    const better = GRADE_ORDER.indexOf(c.to) < GRADE_ORDER.indexOf(c.from)
    list.append(el('span', `replace-change ${better ? 'up' : 'down'}`, `${c.label} ${c.from} → ${c.to}`))
  }
  if (!o.changes.length) list.append(el('span', 'replace-change', T.noRatingChange))
  detail.append(list, el('span', 'replace-note', o.note))
  const lost = o.out.traits.filter((t) => TRAITS[t].tier !== 'red')
  if (lost.length) {
    const traits = el('span', 'replace-traits')
    traits.append(...lost.map(traitTag))
    detail.append(traits)
  }
  const toggle = el('button', 'replace-toggle', T.showRatingChange)
  toggle.type = 'button'
  toggle.onclick = () => {
    detail.hidden = !detail.hidden
    toggle.textContent = detail.hidden ? T.showRatingChange : T.hideRatingChange
    row.classList.toggle('open', !detail.hidden)
  }
  row.append(toggle, detail)
  return row
}

/** 在球員卡底下加上「最多能讓 重砲 4→5 升級」；沒有羈絆會變好就不加 */
export function addGainLine(card: HTMLElement, roster: Roster, pick: Player, relics: readonly RelicId[]): void {
  const best = bestSynergyGain(roster, pick, relics, rosterSlots(roster))
  if (!best) return
  const line = el('span', 'gain-line')
  const tag = diffTag(best, true)
  tag.lastChild!.textContent = gainText(best)
  line.append(el('span', 'gain-label', T.bestGain), tag)
  ;(card.querySelector('.draft-inner') ?? card).append(line)
}
