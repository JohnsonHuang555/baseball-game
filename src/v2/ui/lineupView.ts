// 陣容：看 9 位先發、板凳、先發投手、後援與能力、流派、特性；點兩位球員交換，改完按「儲存陣容」。
// 修改先放在畫面上的草稿，儲存時才交給 ClubController.saveRoster → updateSettings（先結算到期的比賽、新陣容從下一場生效）
import { gradeLine, offPosIcon, pitchChip, toast } from '../../ui/visual'
import { choiceModal } from '../../ui/modal'
import { el, traitChips } from '../../ui/playerCard'
import { archetypeChip, captainIcon, synergyBadges } from '../../ui/synergyUi'
import { POSITION_FULL, POSITION_SPOT } from '../../ui/strings'
import { getSlot, type Slot } from '../../sim/setup'
import { isOffPosition } from '../../sim/positions'
import type { Player } from '../../sim/types'
import type { PersistentRoster } from '../domain/club'
import { autoArrange, lineupIssues, setStartingPitcher, substitute, swapBattingOrder, swapFieldPositions } from '../domain/lineup'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './reportView'
import { V2T } from './strings'

export interface LineupView {
  render(state: ControllerState): HTMLElement
  /** 存檔變了（儲存成功、其他分頁改了）：沒有未儲存的修改就換成最新陣容 */
  sync(state: ControllerState): void
}

export function createLineupView(controller: ClubController): LineupView {
  let saved: PersistentRoster | null = null
  let draft: PersistentRoster | null = null
  let selected: Slot | null = null
  let lastState: ControllerState = controller.state
  let container: HTMLElement | null = null

  const dirty = () => !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft)

  function sync(state: ControllerState): void {
    const roster = state.club?.roster ?? null
    if (!roster) return
    if (!saved || !dirty()) {
      draft = structuredClone(roster)
      selected = null
    }
    saved = roster
  }

  function rerender(): void {
    if (container?.isConnected) container.replaceWith(render(lastState))
  }

  function apply(next: PersistentRoster, message?: string): void {
    draft = next
    selected = null
    if (message) toast(message)
    rerender()
  }

  async function pick(slot: Slot): Promise<void> {
    if (!draft) return
    if (!selected) {
      selected = slot
      return rerender()
    }
    const a = selected
    const b = slot
    if (sameSlot(a, b)) {
      selected = null
      return rerender()
    }
    const r = draft
    const kinds = [a.kind, b.kind].sort().join('+')
    const index = (s: Slot) => ('index' in s ? s.index : 0)
    const lineupOf = (x: Slot, y: Slot) => (x.kind === 'lineup' ? [x, y] : [y, x])
    if (kinds === 'lineup+lineup') {
      const choice = await choiceModal<'pos' | 'order'>({
        title: V2T.swapChoiceTitle,
        options: [
          { value: 'pos', label: V2T.swapPositions, sub: `${POSITION_SPOT[r.lineup[index(a)].position]} ↔ ${POSITION_SPOT[r.lineup[index(b)].position]}` },
          { value: 'order', label: V2T.swapOrder, sub: `${index(a) + 1} ↔ ${index(b) + 1}` },
        ],
      })
      if (!choice) {
        selected = null
        return rerender()
      }
      return apply(choice === 'pos' ? swapFieldPositions(r, index(a), index(b)) : swapBattingOrder(r, index(a), index(b)))
    }
    if (kinds === 'bench+lineup') {
      const [l, bn] = lineupOf(a, b)
      const outName = r.lineup[index(l)].player.name
      const inName = r.bench[index(bn)].name
      return apply(substitute(r, index(l), index(bn)), V2T.substituted(inName, outName))
    }
    if (kinds === 'reliever+starter') {
      const rel = a.kind === 'reliever' ? a : b
      return apply(setStartingPitcher(r, index(rel)), V2T.pitcherSwapped(r.relievers[index(rel)].name))
    }
    // 打者 ↔ 投手、板凳 ↔ 板凳、後援 ↔ 後援：沒有意義的交換，換成選這一位
    toast(V2T.cannotSwap)
    selected = slot
    rerender()
  }

  function row(slot: Slot, label: string, roster: PersistentRoster, opts: { off?: boolean } = {}): HTMLElement {
    const p: Player = getSlot(roster, slot)
    const b = el('button', 'v2-player')
    b.type = 'button'
    const isSelected = !!selected && sameSlot(selected, slot)
    b.setAttribute('aria-pressed', String(isSelected))
    if (isSelected) b.classList.add('selected')
    b.disabled = !lastState.canWrite || lastState.saving
    const tag = el('span', 'v2-player-slot', label)
    const main = el('span', 'v2-player-main')
    const name = el('span', 'v2-player-name', p.name)
    if (p.role === 'batter' && roster.captain === p.id) name.append(captainIcon(14))
    if (opts.off) {
      const off = el('span', 'v2-offpos')
      off.append(offPosIcon(11), V2T.offPosition)
      name.append(off)
    }
    const chips = el('span', 'v2-player-chips')
    if (p.role === 'batter') chips.append(archetypeChip(p))
    else chips.append(pitchChip(p))
    if (p.traits.length) chips.append(traitChips(p))
    main.append(name, gradeLine(p), chips)
    b.append(tag, main)
    if (isSelected) b.append(el('span', 'v2-selected-note', V2T.selected))
    b.onclick = () => void pick(slot)
    return b
  }

  function render(state: ControllerState): HTMLElement {
    lastState = state
    if (!draft) sync(state)
    const page = el('div', 'v2-page v2-lineup')
    container = page
    const r = draft
    if (!r) return page

    const intro = el('section', 'v2-card')
    const head = el('div', 'v2-card-head')
    head.append(el('h2', 'v2-card-title', V2T.lineupTitle))
    const auto = el('button', 'btn-white v2-auto', V2T.autoArrange)
    auto.type = 'button'
    auto.disabled = !state.canWrite || state.saving
    auto.onclick = () => openAutoArrange(r, (next) => apply(next))
    head.append(auto)
    intro.append(head, el('p', 'v2-hint', V2T.lineupHint), synergyBadges(r.lineup, r.captain, []), el('p', 'v2-effective', V2T.lineupEffective))

    const starters = el('section', 'v2-card')
    starters.append(el('h3', 'v2-section-title', V2T.starters))
    const list = el('div', 'v2-player-list')
    r.lineup.forEach((s, i) => {
      list.append(row({ kind: 'lineup', index: i }, `${i + 1}・${POSITION_SPOT[s.position]}`, r, { off: s.position !== 'DH' && isOffPosition(s.player, s.position) }))
    })
    starters.append(list)

    const bench = el('section', 'v2-card')
    bench.append(el('h3', 'v2-section-title', V2T.bench))
    const benchList = el('div', 'v2-player-list')
    r.bench.forEach((_, i) => benchList.append(row({ kind: 'bench', index: i }, V2T.bench, r)))
    bench.append(benchList)

    const pitchers = el('section', 'v2-card')
    pitchers.append(el('h3', 'v2-section-title', `${V2T.starterPitcher}・${V2T.relievers}`))
    const pList = el('div', 'v2-player-list')
    pList.append(row({ kind: 'starter' }, V2T.starterPitcher, r))
    r.relievers.forEach((_, i) => pList.append(row({ kind: 'reliever', index: i }, V2T.relievers, r)))
    pitchers.append(pList)

    // 儲存列：有修改才能存；不合法就顯示原因、不能存
    const bar = el('div', 'v2-savebar')
    const issues = lineupIssues(r)
    const status = el('span', 'v2-savebar-status', issues.length ? issues.join('；') : dirty() ? V2T.unsavedChanges : V2T.lineupEffective)
    if (issues.length) status.classList.add('error')
    const reset = el('button', 'btn-white', V2T.resetDraft)
    reset.type = 'button'
    reset.disabled = !dirty() || state.saving
    reset.onclick = () => {
      draft = saved ? structuredClone(saved) : draft
      selected = null
      rerender()
    }
    const save = el('button', 'btn-yellow', state.saving ? V2T.saving : V2T.saveLineup)
    save.type = 'button'
    save.disabled = !dirty() || issues.length > 0 || state.saving || !state.canWrite
    save.onclick = async () => {
      save.disabled = true
      const res = await controller.saveRoster(r)
      if (res.message) toast(res.message)
      if (res.ok) {
        saved = controller.state.club?.roster ?? saved
        draft = saved ? structuredClone(saved) : draft
        rerender()
      }
    }
    const buttons = el('div', 'v2-savebar-buttons')
    buttons.append(reset, save)
    bar.append(status, buttons)

    page.append(intro, starters, bench, pitchers, bar)
    return page
  }

  return { render, sync }
}

/** 最多羈絆排法：先列出會改的人，玩家確認才套用到草稿 */
function openAutoArrange(roster: PersistentRoster, apply: (r: PersistentRoster) => void): void {
  const best = autoArrange(roster)
  const body = el('div', 'v2-auto-body')
  body.append(el('p', 'v2-hint', V2T.autoArrangeHint))
  if (!best) {
    body.append(el('p', 'v2-empty', V2T.autoArrangeNone))
    v2Modal(V2T.autoArrange, body)
    return
  }
  const ul = el('ul', 'v2-moves')
  for (const m of best.moves) {
    ul.append(el('li', '', m.type === 'in' ? `${V2T.substituted(m.player.name, m.out.name)}（${POSITION_FULL[m.position]}）` : `${m.player.name}：${POSITION_FULL[m.from]} → ${POSITION_FULL[m.to]}`))
  }
  body.append(synergyBadges(best.roster.lineup, best.roster.captain, []), ul)
  const applyBtn = el('button', 'btn-yellow', V2T.autoArrangeApply)
  applyBtn.type = 'button'
  body.append(applyBtn)
  const close = v2Modal(V2T.autoArrange, body)
  applyBtn.onclick = () => {
    close()
    apply(best.roster)
  }
}

function sameSlot(a: Slot, b: Slot): boolean {
  return a.kind === b.kind && ('index' in a ? a.index : -1) === ('index' in b ? b.index : -1)
}
