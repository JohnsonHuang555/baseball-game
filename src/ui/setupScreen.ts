import { teamAverage, teamName } from '../sim/generate'
import { Rng } from '../sim/rng'
import {
  getSlot,
  isPitcherSlot,
  rerollPlayer,
  rerollTeam,
  swapPositions,
  swapSlots,
  type PregameSetup,
  type Slot,
} from '../sim/setup'
import type { Position, Team } from '../sim/types'
import { avatar } from './avatar'
import { gradeBadge, overallBadge } from './grades'
import { el } from './playerCard'
import { TEAM_NAME_MAX, saveTeamName } from './prefs'
import { POSITION_NAMES, T } from './strings'
import { USER_COLOR, applyCardState, gradeLine, miniCard, playerHeader, ratingBars, toast, traitList } from './visual'

export interface RosterEditorOptions {
  setup: PregameSetup
  /** 每次重畫時取得；改隊名可能會讓對手換名字 */
  opponent: () => Team
  /** 標題上方的小字，例如「我的球隊」或「錦標賽・八強」 */
  heading: string
  /** 開打前可以重骰和改隊名；比賽之間只能調整陣容 */
  allowReroll: boolean
  startLabel: string
  onChange?: (setup: PregameSetup) => void
  onStart: (setup: PregameSetup) => void
  onBack: () => void
}

/** 球場圖上各守位的位置（百分比），對照一般的守備位置圖 */
const SPOTS: Record<Position | 'P', [number, number]> = {
  CF: [50, 14],
  LF: [16, 27],
  RF: [84, 27],
  SS: [35, 44],
  '2B': [65, 44],
  '3B': [17, 58],
  '1B': [83, 58],
  P: [50, 62],
  C: [50, 85],
  DH: [13, 87],
}

const FIELD_SVG = `<svg viewBox="0 0 100 95" preserveAspectRatio="none" aria-hidden="true">
  <rect width="100" height="95" fill="#1d5a2a"/>
  <path d="M50 92 L2 44 A68 68 0 0 1 98 44 Z" fill="#2f8a3e"/>
  <path d="M50 92 L20 62 A42 42 0 0 1 80 62 Z" fill="#b98558"/>
  <path d="M50 86 L33 69 L50 52 L67 69 Z" fill="#2f8a3e"/>
  <circle cx="50" cy="69" r="3" fill="#b98558"/>
  <path d="M50 92 L2 44 M50 92 L98 44" stroke="#f4f1e8" stroke-width="0.4"/>
  <path d="M2 44 A68 68 0 0 1 98 44" fill="none" stroke="#f2c94c" stroke-width="0.8"/>
</svg>`

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

/** 組隊畫面：球場上的先發、板凳與後援；點球員看詳細資料、重骰或交換 */
export function showRosterEditor(root: HTMLElement, opts: RosterEditorOptions): void {
  let setup = opts.setup
  const { allowReroll } = opts
  /** 正在選交換對象時，記住第一個人 */
  let swapFrom: Slot | null = null
  let revealed: Slot[] | 'all' = 'all'
  let renaming = false

  function update(next: PregameSetup): void {
    setup = next
    opts.onChange?.(setup)
  }

  function rename(name: string): void {
    update({ ...setup, team: { ...setup.team, name } })
    toast(T.renamed(name))
    renaming = false
    revealed = []
    render()
  }

  function nameEditor(): HTMLElement {
    const box = el('div', 'rename')
    const input = el('input', 'rename-input')
    input.value = setup.team.name
    input.maxLength = TEAM_NAME_MAX
    input.placeholder = T.teamNamePlaceholder
    const save = el('button', 'btn btn-primary', T.save)
    save.onclick = () => {
      const name = input.value.trim().slice(0, TEAM_NAME_MAX)
      if (!name) return input.focus()
      saveTeamName(name)
      rename(name)
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') save.click()
    }
    const cancel = el('button', 'btn btn-ghost', T.cancel)
    cancel.onclick = () => {
      renaming = false
      render()
    }
    const row = el('div', 'row')
    row.append(cancel, save)
    box.append(input, row)
    queueMicrotask(() => input.focus())
    return box
  }

  function isRevealed(slot: Slot): boolean {
    return revealed === 'all' || revealed.some((s) => sameSlot(s, slot))
  }

  function slotLabel(slot: Slot): string {
    switch (slot.kind) {
      case 'lineup': {
        const spot = setup.team.roster.lineup[slot.index]
        return `${T.battingOrder} ${slot.index + 1}・${POSITION_NAMES[spot.position]}`
      }
      case 'bench':
        return T.bench
      case 'starter':
        return T.starter
      case 'reliever':
        return T.reliever
    }
  }

  function header(screen: HTMLElement): void {
    const head = el('header', 'setup-header')
    const back = el('button', 'link', '‹')
    back.onclick = opts.onBack
    const titles = el('div', 'grow')
    titles.append(el('div', 'eyebrow', opts.heading), el('h1', '', setup.team.name))
    const ovr = el('div', 'team-ovr')
    ovr.append(el('span', 'eyebrow', T.overallLabel), gradeBadge(teamAverage(setup.team.roster), 'lg'))
    head.append(back, titles, ovr)
    screen.append(head)

    if (allowReroll && renaming) screen.append(nameEditor())
    else if (allowReroll) {
      const row = el('div', 'row chips')
      const edit = el('button', 'chip', T.rename)
      edit.onclick = () => {
        renaming = true
        render()
      }
      const random = el('button', 'chip', T.randomName)
      random.onclick = () => {
        // 選隨機隊名代表不再沿用自訂的名字
        saveTeamName(null)
        let name = setup.team.name
        while (name === setup.team.name) name = teamName(new Rng(randomSeed()))
        rename(name)
      }
      row.append(edit, random)
      screen.append(row)
    }

    const opponent = opts.opponent()
    const vs = el('div', 'versus')
    const right = el('span', 'versus-right')
    right.append(el('span', 'muted', T.overallLabel), gradeBadge(teamAverage(opponent.roster), 'sm'))
    vs.append(el('span', '', `${T.opponent}：${opponent.name}`), right)
    screen.append(vs)
  }

  /** 球場圖：九個守位加上指定打擊 */
  function field(): HTMLElement {
    const r = setup.team.roster
    const box = el('div', 'diamond')
    box.innerHTML = FIELD_SVG
    const place = (slot: Slot, spot: Position | 'P', order: number | null) => {
      const p = getSlot(r, slot)
      const node = el('button', 'field-node')
      const [x, y] = SPOTS[spot]
      node.style.left = `${x}%`
      node.style.top = `${y}%`
      applyCardState(node, p, { selected: sameSlot(swapFrom, slot), reveal: isRevealed(slot) })
      const face = el('div', 'node-face')
      face.append(avatar(p.id, USER_COLOR), overallBadge(p, 'sm'))
      if (order !== null) face.append(el('span', 'order', String(order)))
      node.append(face, el('div', 'node-name', p.name))
      if (spot === 'DH') node.append(el('div', 'node-tag', T.designatedHitter))
      node.onclick = () => onTap(slot, 'field')
      box.append(node)
    }
    r.lineup.forEach((s, i) => place({ kind: 'lineup', index: i }, s.position, i + 1))
    place({ kind: 'starter' }, 'P', null)
    return box
  }

  function render(): void {
    root.replaceChildren()
    const scrollTop = root.querySelector('.order-list')?.scrollTop ?? 0
    const screen = el('div', 'screen setup editor')
    header(screen)
    screen.append(field())

    const r = setup.team.roster
    const reserves = el('div', 'reserves')
    const group = (title: string, slots: Slot[]) => {
      const g = el('div', 'reserve-group')
      g.append(el('div', 'eyebrow', title))
      const row = el('div', 'reserve-row')
      for (const slot of slots) {
        const card = miniCard(getSlot(r, slot), slotLabel(slot), USER_COLOR, {
          selected: sameSlot(swapFrom, slot),
          reveal: isRevealed(slot),
        })
        card.onclick = () => onTap(slot, 'reserve')
        row.append(card)
      }
      g.append(row)
      reserves.append(g)
    }
    group(
      T.bench,
      r.bench.map((_, i): Slot => ({ kind: 'bench', index: i })),
    )
    group(
      T.reliever,
      r.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i })),
    )
    screen.append(reserves)
    if (!allowReroll) screen.append(el('div', 'hint', T.lineupOnlyHint))

    // 條列式打序：填滿下方空間，可以捲動；點一列跟點球場上的人一樣
    const order = el('section', 'order-section')
    order.append(el('div', 'eyebrow', T.battingOrder))
    const list = el('ol', 'order-list')
    r.lineup.forEach((spot, i) => {
      const slot: Slot = { kind: 'lineup', index: i }
      const row = el('li')
      const btn = el('button', `order-row ${sameSlot(swapFrom, slot) ? 'selected' : ''}`)
      btn.append(
        el('span', 'order-num', String(i + 1)),
        avatar(spot.player.id, USER_COLOR, 'sm'),
        el('span', 'order-name', spot.player.name),
        el('span', 'order-pos', POSITION_NAMES[spot.position]),
        gradeLine(spot.player),
      )
      btn.onclick = () => onTap(slot, 'list')
      row.append(btn)
      list.append(row)
    })
    order.append(list)
    screen.append(order)

    const bar = el('div', 'action-bar')
    if (swapFrom) {
      bar.append(el('div', 'hint', T.swapPick(getSlot(r, swapFrom).name)))
      if (swapFrom.kind === 'lineup') bar.append(el('div', 'hint', T.swapHintLineup))
      const cancel = el('button', 'btn btn-ghost', T.cancel)
      cancel.onclick = () => {
        swapFrom = null
        render()
      }
      bar.append(cancel)
    } else {
      const row = el('div', 'row')
      if (allowReroll) {
        const rerollAll = el('button', 'btn btn-secondary', `${T.rerollTeam}（${setup.teamRerollsLeft}）`)
        rerollAll.disabled = setup.teamRerollsLeft <= 0
        rerollAll.onclick = () => {
          update(rerollTeam(setup))
          toast(T.rerolledTeam(setup.teamRerollsLeft))
          revealed = 'all'
          render()
        }
        row.append(rerollAll)
      }
      const start = el('button', 'btn btn-primary', opts.startLabel)
      start.onclick = () => opts.onStart(setup)
      row.append(start)
      bar.append(row)
    }
    screen.append(bar)
    root.append(screen)
    // 重畫時保留打序列表的捲動位置
    list.scrollTop = scrollTop
    revealed = []
  }

  /**
   * 點球員。選交換對象時，第二下點在哪裡決定換什麼：
   * 球場上的兩名先發互換守位；打序列表上的兩名先發互換棒次；牽涉板凳就是換人上場
   */
  function onTap(slot: Slot, source: 'field' | 'list' | 'reserve'): void {
    if (!swapFrom) return openDetail(slot)
    if (sameSlot(swapFrom, slot)) swapFrom = null
    else if (isPitcherSlot(swapFrom) === isPitcherSlot(slot)) {
      const roster = setup.team.roster
      const a = getSlot(roster, swapFrom)
      const b = getSlot(roster, slot)
      const bothStarters = swapFrom.kind === 'lineup' && slot.kind === 'lineup'
      if (swapFrom.kind === 'lineup' && slot.kind === 'lineup' && source === 'field') {
        update({ ...setup, team: { ...setup.team, roster: swapPositions(roster, swapFrom.index, slot.index) } })
        toast(T.swappedPositions(a.name, b.name))
      } else {
        const swapped = swapSlots(roster, swapFrom, slot)
        if (swapped) {
          update({ ...setup, team: { ...setup.team, roster: swapped } })
          toast(bothStarters ? T.swappedOrder(a.name, b.name) : T.swapped(a.name, b.name))
        }
      }
      swapFrom = null
    } else return
    render()
  }

  /** 點球員：大頭像、能力值字母與長條、特性說明，加上重骰與交換 */
  function openDetail(slot: Slot): void {
    const p = getSlot(setup.team.roster, slot)
    const sheet = el('div', 'sheet')
    const panel = el('div', 'sheet-panel')
    panel.append(playerHeader(p, slotLabel(slot), USER_COLOR), ratingBars(p))
    if (p.traits.length) panel.append(traitList(p))
    const close = () => sheet.remove()
    sheet.onclick = (e) => {
      if (e.target === sheet) close()
    }

    const row = el('div', 'row')
    const swap = el('button', 'btn btn-secondary', T.swap)
    swap.onclick = () => {
      swapFrom = slot
      close()
      render()
    }
    row.append(swap)
    if (allowReroll) {
      const reroll = el('button', 'btn btn-secondary', `${T.rerollPlayer}（${setup.playerRerollsLeft}）`)
      reroll.disabled = setup.playerRerollsLeft <= 0
      reroll.onclick = () => {
        update(rerollPlayer(setup, slot))
        toast(T.rerolledPlayer(p.name, getSlot(setup.team.roster, slot).name))
        revealed = [slot]
        close()
        render()
      }
      row.append(reroll)
    }
    const done = el('button', 'btn btn-ghost', T.close)
    done.onclick = close
    panel.append(row, done)
    sheet.append(panel)
    root.append(sheet)
  }

  render()
}

/** 介面層產生種子，模擬內部不碰 Math.random()（ADR-0001） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}
