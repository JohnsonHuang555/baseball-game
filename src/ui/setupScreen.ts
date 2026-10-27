import { cardTier, isSpecial, overall, teamAverage, teamName } from '../sim/generate'
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
import { TRAITS } from '../sim/traits'
import type { Player, Position, Team } from '../sim/types'
import { avatar } from './avatar'
import { gradeBadge, overallBadge } from './grades'
import { el, traitTag } from './playerCard'
import { kbd, setKeys, type KeyMap } from './keys'
import { infoModal } from './modal'
import { TEAM_NAME_MAX, saveTeamName } from './prefs'
import { play } from './sound'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { POSITION_FULL, RATING_FULL, RATING_LABELS, T } from './strings'
import { applyCardState, miniCard, playerHeader, ratingBars, toast, traitList } from './visual'

export interface RosterEditorOptions {
  setup: PregameSetup
  /** 每次重畫時取得；改隊名可能會讓對手換名字 */
  opponent: () => Team
  /** 標題上方的小字，例如「我的球隊」或「錦標賽・八強」 */
  heading: string
  /** 開打前可以整隊重骰和改隊名；比賽之間只能調整陣容 */
  allowReroll: boolean
  /** 能不能重骰單一球員（錦標賽中用贏球得到的球員骰子）；沒給就跟 allowReroll 一樣 */
  allowPlayerReroll?: boolean
  startLabel: string
  onChange?: (setup: PregameSetup) => void
  onStart: (setup: PregameSetup) => void
  onBack: () => void
}

/** 球場圖（366 × 286）上各守位的中心點，對照一般的守備位置圖 */
const FIELD_W = 366
const FIELD_H = 286
const SPOTS: Record<Position | 'P', [number, number]> = {
  CF: [183, 28],
  LF: [58, 50],
  RF: [308, 50],
  SS: [123, 104],
  '2B': [243, 104],
  '3B': [76, 166],
  '1B': [290, 166],
  P: [183, 176],
  C: [183, 240],
  DH: [104, 240],
}

const FIELD_SVG = `<svg viewBox="0 0 366 286" aria-hidden="true">
  <defs><pattern id="mow" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="20" fill="#000" opacity="0.07"/></pattern></defs>
  <rect width="366" height="286" fill="#2E8C43"/>
  <path d="M183 262 L0 79 A259 259 0 0 1 366 79 Z" fill="#43B356"/>
  <path d="M183 262 L0 79 A259 259 0 0 1 366 79 Z" fill="url(#mow)"/>
  <path d="M0 79 A259 259 0 0 1 366 79" fill="none" stroke="#E3A867" stroke-width="10"/>
  <path d="M183 282 L279 190 L183 96 L87 190 Z" fill="#E3A867"/>
  <path d="M183 250 L241 190 L183 132 L125 190 Z" fill="#43B356"/>
  <path d="M183 262 L0 79 M183 262 L366 79" stroke="#FFF" stroke-width="2.5"/>
  <circle cx="183" cy="190" r="11" fill="#E3A867"/>
  <rect x="249" y="184" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 255 190)"/>
  <rect x="177" y="112" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 183 118)"/>
  <rect x="105" y="184" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 111 190)"/>
</svg>`

const ICONS = {
  back: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  pencil: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  shuffle: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>',
  dice: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="16" cy="16" r="1.4" fill="currentColor"/></svg>',
  close: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  star: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z"/></svg>',
}

function iconButton(className: string, icon: string, label: string): HTMLButtonElement {
  const b = el('button', className)
  b.type = 'button'
  b.innerHTML = icon
  b.setAttribute('aria-label', label)
  return b
}

function withIcon(className: string, icon: string, text: string): HTMLButtonElement {
  const b = el('button', className)
  b.type = 'button'
  b.innerHTML = icon
  b.append(text)
  return b
}

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

/** 對手陣容：打序（守位、左右打、四項能力、特性），再來是投手與板凳 */
function opponentRoster(team: Team): HTMLElement {
  const r = team.roster
  const box = el('div', 'opp-roster')
  const row = (p: Player, label: string) => {
    const line = el('div', 'opp-row')
    const who = el('span', 'opp-who')
    const hand = p.role === 'batter' ? T.bats[p.bats] : T.throws[p.throws]
    who.append(el('span', 'opp-name', p.name), el('span', 'opp-pos', `${label}・${hand}`))
    const grades = el('span', 'opp-grades')
    for (const v of Object.values(p.ratings)) grades.append(gradeBadge(v, 'sm'))
    const traits = el('span', 'opp-traits')
    traits.append(...p.traits.map(traitTag))
    line.append(avatar(p.id, 'opponent', 'ring'), who, grades, traits)
    return line
  }
  // 每一段的標題列，右邊對齊能力字母放欄位名稱
  const section = (title: string, sample: Player, rows: HTMLElement[]) => {
    const head = el('div', 'opp-head')
    const labels = el('span', 'opp-grades')
    for (const k of Object.keys(sample.ratings)) labels.append(el('span', 'opp-label', RATING_LABELS[k as keyof typeof RATING_LABELS]))
    head.append(el('h3', 'opp-title', title), labels)
    box.append(head, ...rows)
  }
  section(T.battingOrder, r.lineup[0].player, r.lineup.map((s, i) => row(s.player, `${i + 1}・${POSITION_FULL[s.position]}`)))
  section(T.pitcher, r.starter, [row(r.starter, T.starter), ...r.relievers.map((p) => row(p, T.reliever))])
  if (r.bench.length) section(T.bench, r.bench[0], r.bench.map((p) => row(p, T.bench)))
  return box
}

/** 組隊畫面：球場上的先發、板凳與後援、打序表；點球員看詳細資料、重骰或交換 */
export function showRosterEditor(root: HTMLElement, opts: RosterEditorOptions): void {
  let setup = opts.setup
  const { allowReroll } = opts
  const allowPlayerReroll = opts.allowPlayerReroll ?? allowReroll
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

  function isRevealed(slot: Slot): boolean {
    return revealed === 'all' || revealed.some((s) => sameSlot(s, slot))
  }

  function slotLabel(slot: Slot): string {
    switch (slot.kind) {
      case 'lineup': {
        const spot = setup.team.roster.lineup[slot.index]
        return T.orderAndPosition(slot.index + 1, POSITION_FULL[spot.position])
      }
      case 'bench':
        return T.bench
      case 'starter':
        return T.starter
      case 'reliever':
        return T.reliever
    }
  }

  function header(): HTMLElement {
    const head = el('header', 'team-header')
    const top = el('div', 'team-header-row')
    const back = iconButton('icon-btn', ICONS.back, T.backToTitle)
    back.onclick = opts.onBack
    top.append(back)

    if (allowReroll && renaming) {
      const box = el('div', 'rename')
      const label = el('label', 'sr-only', T.teamNamePlaceholder)
      label.htmlFor = 'team-name'
      const input = el('input', 'rename-input')
      input.id = 'team-name'
      input.value = setup.team.name
      input.maxLength = TEAM_NAME_MAX
      input.placeholder = T.teamNamePlaceholder
      const save = el('button', 'btn-small btn-yellow', T.confirm)
      save.onclick = () => {
        const name = input.value.trim().slice(0, TEAM_NAME_MAX)
        if (!name) return input.focus()
        saveTeamName(name)
        rename(name)
      }
      input.onkeydown = (e) => {
        if (e.key === 'Enter') save.click()
        if (e.key === 'Escape') {
          renaming = false
          render()
        }
      }
      box.append(label, input, save)
      top.append(box)
      queueMicrotask(() => input.focus())
    } else {
      const titles = el('div', 'team-titles')
      titles.append(el('span', 'eyebrow-light', opts.heading), el('h1', 'team-name', setup.team.name))
      top.append(titles)
    }
    const ovr = el('div', 'team-ovr')
    ovr.append(el('span', 'eyebrow-light', T.overallLabel), gradeBadge(teamAverage(setup.team.roster), 'xl'))
    top.append(ovr)

    const sub = el('div', 'team-header-row')
    if (allowReroll) {
      if (!renaming) {
        const edit = withIcon('pill-btn', ICONS.pencil, T.rename)
        edit.onclick = () => {
          renaming = true
          render()
        }
        sub.append(edit)
      }
      const random = withIcon('pill-btn', ICONS.shuffle, T.randomName)
      random.onclick = () => {
        // 選隨機隊名代表不再沿用自訂的名字
        saveTeamName(null)
        let name = setup.team.name
        while (name === setup.team.name) name = teamName(new Rng(randomSeed()))
        rename(name)
      }
      sub.append(random)
    } else {
      sub.append(el('span', 'lineup-hint', allowPlayerReroll ? T.lineupDiceHint(setup.playerRerollsLeft) : T.lineupOnlyHint))
    }
    // 對手：點一下看完整陣容，佈陣時可以對照
    const opponent = opts.opponent()
    const vs = el('button', 'vs-pill')
    vs.type = 'button'
    vs.title = T.opponentRoster
    vs.append(el('span', 'vs-mark', T.versus), el('span', 'vs-name', opponent.name), gradeBadge(teamAverage(opponent.roster), 'sm'), el('span', 'vs-more', T.viewRoster))
    vs.onclick = () => infoModal(T.opponentRosterOf(opponent.name), opponentRoster(opponent), true)
    sub.append(vs)
    head.append(top, sub)
    return head
  }

  /** 球場圖：九個守位加上指定打擊，重骰時依打序一張張翻開 */
  function field(): HTMLElement {
    const r = setup.team.roster
    const box = el('section', 'pitch')
    box.setAttribute('aria-label', '守備位置')
    box.innerHTML = FIELD_SVG
    const place = (slot: Slot, spot: Position | 'P', order: number | null) => {
      const p = getSlot(r, slot)
      const node = el('button', 'field-node')
      node.type = 'button'
      node.dataset.pid = p.id
      const [x, y] = SPOTS[spot]
      node.style.left = `${(x / FIELD_W) * 100}%`
      node.style.top = `${(y / FIELD_H) * 100}%`
      applyCardState(node, p, { selected: sameSlot(swapFrom, slot), reveal: isRevealed(slot) })
      if (swapFrom && !sameSlot(swapFrom, slot) && isPitcherSlot(swapFrom) === isPitcherSlot(slot)) node.classList.add('target')
      if (isRevealed(slot)) node.style.setProperty('--delay', `${(order ?? 0) * 60}ms`)
      const ring = el('span', 'node-ring')
      ring.append(avatar(p.id, 'user'), overallBadge(p, 'sm'))
      ring.append(el('span', order === null ? 'node-tag-p' : 'node-order', order === null ? T.pitcherMark : String(order)))
      node.append(ring, el('span', 'node-name', p.name))
      if (spot === 'DH') node.append(el('span', 'node-dh', T.designatedHitter))
      node.setAttribute('aria-label', `${slotLabel(slot)} ${p.name}`)
      node.onclick = () => onTap(slot, 'field')
      box.append(node)
    }
    r.lineup.forEach((s, i) => place({ kind: 'lineup', index: i }, s.position, i + 1))
    place({ kind: 'starter' }, 'P', null)
    return box
  }

  function reserves(): HTMLElement {
    const r = setup.team.roster
    const sec = el('section', 'reserves')
    const labels = el('div', 'reserve-labels')
    labels.append(el('span', '', T.bench), el('span', '', T.relievers))
    const grid = el('div', 'reserve-grid')
    const slots: Slot[] = [
      ...r.bench.map((_, i): Slot => ({ kind: 'bench', index: i })),
      ...r.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i })),
    ]
    for (const slot of slots) {
      // 身分標籤只在電腦版顯示；手機版改用上方的「板凳／後援投手」標題
      const role = slot.kind === 'bench' ? T.bench : T.relievers
      const card = miniCard(getSlot(r, slot), role, 'user', { selected: sameSlot(swapFrom, slot), reveal: isRevealed(slot) })
      card.onclick = () => onTap(slot, 'reserve')
      grid.append(card)
    }
    sec.append(labels, grid)
    return sec
  }

  /** 手機版用短標籤（打），電腦版用全名（打擊） */
  function dualLabel(short: string, full: string): HTMLElement {
    const s = el('span')
    s.append(el('span', 'mobile-only', short), el('span', 'desk-only', full))
    return s
  }

  /** 打序表：可以捲動；點一列跟點球場上的人一樣。電腦版多出卡色、特性欄與先發投手列 */
  function orderTable(): { section: HTMLElement; list: HTMLElement } {
    const sec = el('section', 'order-panel')
    sec.setAttribute('aria-label', T.battingOrder)
    const head = el('div', 'order-head')
    head.append(dualLabel(T.orderColumn, T.orderColumnFull), el('span'), el('span', 'left', T.playerColumn))
    for (const k of ['contact', 'power', 'speed', 'fielding'] as const) head.append(dualLabel(RATING_SHORT[k], RATING_FULL[k]))
    head.append(el('span', 'left desk-only', T.traitsColumn))
    const list = el('div', 'order-list')
    setup.team.roster.lineup.forEach((spot, i) => {
      const slot: Slot = { kind: 'lineup', index: i }
      const p = spot.player
      const row = el('button', `order-row ${sameSlot(swapFrom, slot) ? 'selected' : ''}`)
      row.type = 'button'
      const who = el('span', 'order-who')
      who.append(el('span', 'order-name', p.name), el('span', 'order-pos', `${POSITION_FULL[spot.position]}・${T.bats[p.bats]}`))
      who.append(el('span', `tier-tag desk-only tier-${cardTier(p)}`, T.tierNames[cardTier(p)]))
      row.append(el('span', 'order-num', String(i + 1)), avatar(p.id, 'user', 'ring'), who)
      for (const k of ['contact', 'power', 'speed', 'fielding'] as const) row.append(gradeBadge(p.ratings[k], 'md'))
      const traits = el('span', 'order-traits desk-only')
      traits.append(...p.traits.map(traitTag))
      row.append(traits)
      row.setAttribute('aria-label', `第 ${i + 1} 棒 ${p.name}`)
      row.onclick = () => onTap(slot, 'list')
      list.append(row)
    })
    sec.append(head, list)

    // 電腦版：表格底部的先發投手列
    const starter = setup.team.roster.starter
    const pitcherRow = el('button', 'order-pitcher desk-only')
    pitcherRow.type = 'button'
    const who = el('span', 'order-who')
    who.append(el('span', 'order-name', starter.name), el('span', 'order-pos', `${T.pitcher}・${T.throws[starter.throws]}`))
    pitcherRow.append(el('span', 'order-num-label', T.starter), avatar(starter.id, 'user', 'ring'), who)
    for (const [k, v] of Object.entries(starter.ratings)) {
      const cell = el('span', 'pitcher-stat')
      cell.append(el('span', 'pitcher-stat-label', RATING_FULL[k as keyof typeof RATING_FULL]), gradeBadge(v, 'md'))
      pitcherRow.append(cell)
    }
    pitcherRow.onclick = () => onTap({ kind: 'starter' }, 'list')
    sec.append(pitcherRow)
    return { section: sec, list }
  }

  /** 電腦版右欄上方的提示列：平常是操作說明，交換時變成黃底並有取消鍵 */
  function hintBar(): HTMLElement {
    const bar = el('div', `hint-bar desk-only ${swapFrom ? 'swapping' : ''}`)
    if (!swapFrom) {
      bar.append(el('span', 'hint-text', T.swapGuide))
      return bar
    }
    bar.append(el('span', 'hint-title', T.swapPick(getSlot(setup.team.roster, swapFrom).name)))
    const cancel = el('button', 'btn-small btn-white-small', T.cancel)
    cancel.append(kbd('ESC'))
    cancel.onclick = cancelSwap
    bar.append(cancel)
    return bar
  }

  function cancelSwap(): void {
    swapFrom = null
    render()
  }

  function startGame(): void {
    opts.onStart(setup)
  }

  function rerollWholeTeam(): void {
    if (!allowReroll || setup.teamRerollsLeft <= 0) return
    const before = new Set(allIds())
    play('dice')
    update(rerollTeam(setup))
    toast(T.rerolledTeam(setup.teamRerollsLeft))
    revealed = 'all'
    render()
    celebrate(newPlayers(before))
  }

  /** 底部按鈕列（電腦版移到頂部右側）。手機版交換時改顯示交換提示；電腦版交換提示在右欄 */
  function footer(): HTMLElement {
    const bar = el('footer', `team-footer ${swapFrom ? 'swapping' : ''}`)
    if (swapFrom) {
      const words = el('div', 'swap-words mobile-only')
      words.append(el('span', 'swap-title', T.swapPick(getSlot(setup.team.roster, swapFrom).name)))
      if (swapFrom.kind === 'lineup') words.append(el('span', 'swap-hint', T.swapHintLineup))
      const cancel = el('button', 'btn-outline-light mobile-only', T.cancel)
      cancel.onclick = cancelSwap
      bar.append(words, cancel)
    }
    const row = el('div', 'footer-buttons')
    if (allowReroll) {
      const rerollAll = withIcon('btn-indigo', ICONS.dice, T.rerollTeam)
      rerollAll.append(el('span', 'count-pill', String(setup.teamRerollsLeft)), kbd('R'))
      rerollAll.disabled = setup.teamRerollsLeft <= 0
      rerollAll.onclick = rerollWholeTeam
      row.append(rerollAll)
    }
    const start = el('button', 'btn-yellow btn-big', opts.startLabel)
    start.append(kbd('ENTER'))
    start.onclick = startGame
    row.append(start)
    bar.append(row)
    return bar
  }

  function allIds(): string[] {
    const r = setup.team.roster
    return [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].map((p) => p.id)
  }

  function newPlayers(before: Set<string>): Player[] {
    const r = setup.team.roster
    return [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].filter((p) => !before.has(p.id))
  }

  function render(): void {
    // 記下球場上每個人的位置，重畫後讓換位置的人滑過去（FLIP）
    const before = new Map<string, DOMRect>()
    root.querySelectorAll<HTMLElement>('.field-node').forEach((n) => before.set(n.dataset.pid!, n.getBoundingClientRect()))
    const scrollTop = root.querySelector('.order-list')?.scrollTop ?? 0

    root.replaceChildren()
    const screen = el('div', 'team-screen')
    const { section, list } = orderTable()
    // 手機版 team-side 不參與排版（display: contents）；電腦版是右欄
    const side = el('div', 'team-side')
    side.append(hintBar(), section)
    screen.append(header(), field(), reserves(), side, footer())
    root.append(screen)
    list.scrollTop = scrollTop
    setKeys({
      Enter: () => {
        if (!swapFrom && !renaming) startGame()
      },
      r: () => {
        if (!swapFrom && !renaming) rerollWholeTeam()
      },
      Escape: () => {
        if (swapFrom) cancelSwap()
        else if (renaming) {
          renaming = false
          render()
        }
      },
    })

    if (revealed.length === 0) {
      root.querySelectorAll<HTMLElement>('.field-node').forEach((n) => {
        const old = before.get(n.dataset.pid!)
        if (!old) return
        const now = n.getBoundingClientRect()
        const dx = old.left - now.left
        const dy = old.top - now.top
        if (dx || dy) n.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 280, easing: 'ease-out' })
      })
    }
    revealed = []
  }

  function onTap(slot: Slot, source: 'field' | 'list' | 'reserve'): void {
    if (!swapFrom) return openDetail(slot)
    if (sameSlot(swapFrom, slot)) swapFrom = null
    else if (isPitcherSlot(swapFrom) === isPitcherSlot(slot)) {
      const roster = setup.team.roster
      const a = getSlot(roster, swapFrom)
      const b = getSlot(roster, slot)
      if (swapFrom.kind === 'lineup' && slot.kind === 'lineup' && source === 'field') {
        update({ ...setup, team: { ...setup.team, roster: swapPositions(roster, swapFrom.index, slot.index) } })
        toast(T.swappedPositions(a.name, b.name))
      } else {
        const swapped = swapSlots(roster, swapFrom, slot)
        if (swapped) {
          update({ ...setup, team: { ...setup.team, roster: swapped } })
          const bothStarters = swapFrom.kind === 'lineup' && slot.kind === 'lineup'
          toast(bothStarters ? T.swappedOrder(a.name, b.name) : T.swapped(a.name, b.name))
        }
      }
      swapFrom = null
    } else return
    render()
  }

  /** 點球員：卡色外框的大頭像、能力值字母與長條、特性說明，加上交換與重骰 */
  function openDetail(slot: Slot): void {
    const p = getSlot(setup.team.roster, slot)
    // 手機版是底部面板；電腦版是畫面中央的彈出視窗（player-modal）
    const sheet = el('div', 'sheet player-modal')
    const panel = el('section', 'sheet-panel paper')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', p.name)
    let previousKeys: KeyMap = {}
    const close = () => {
      sheet.remove()
      setKeys(previousKeys)
    }
    sheet.onclick = (e) => {
      if (e.target === sheet) close()
    }
    const x = iconButton('icon-btn sheet-close', ICONS.close, T.close)
    x.append(kbd('ESC'))
    x.onclick = close
    const stats = el('div', 'stat-box')
    stats.append(ratingBars(p))
    panel.append(el('span', 'sheet-handle'), x, playerHeader(p, slotLabel(slot)), stats)
    if (p.traits.length) panel.append(traitList(p))

    const row = el('div', 'detail-buttons')
    const swap = el('button', 'btn-white', T.swap)
    swap.append(kbd('X'))
    const startSwap = () => {
      close()
      swapFrom = slot
      render()
    }
    swap.onclick = startSwap
    row.append(swap)
    let rerollThis: (() => void) | null = null
    if (allowPlayerReroll) {
      const reroll = el('button', 'btn-indigo', T.rerollPlayer)
      reroll.append(el('span', 'count-pill', String(setup.playerRerollsLeft)), kbd('R'))
      reroll.disabled = setup.playerRerollsLeft <= 0
      rerollThis = () => {
        if (setup.playerRerollsLeft <= 0) return
        play('dice')
        update(rerollPlayer(setup, slot))
        const fresh = getSlot(setup.team.roster, slot)
        toast(T.rerolledPlayer(p.name, fresh.name))
        close()
        revealed = [slot]
        render()
        celebrate([fresh])
      }
      reroll.onclick = rerollThis
      row.append(reroll)
    } else row.classList.add('single')
    panel.append(row)
    sheet.append(panel)
    root.append(sheet)
    previousKeys = setKeys({ Escape: close, x: startSwap, ...(rerollThis ? { r: rerollThis } : {}) })
  }

  /** 抽到彩虹卡或帶金特的球員：全螢幕登場特效，挑最強的一位 */
  function celebrate(players: Player[]): void {
    const special = players.filter(isSpecial).sort((a, b) => overall(b) - overall(a))[0]
    if (!special) return
    const r = setup.team.roster
    const slot = (
      [
        ...r.lineup.map((_, i): Slot => ({ kind: 'lineup', index: i })),
        ...r.bench.map((_, i): Slot => ({ kind: 'bench', index: i })),
        { kind: 'starter' } as Slot,
        ...r.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i })),
      ] as Slot[]
    ).find((s) => getSlot(r, s).id === special.id)!

    const overlay = el('div', 'reveal-overlay')
    overlay.innerHTML = `<svg class="rays" aria-hidden="true" viewBox="-380 -380 760 760">${rays(380)}</svg>`
    const tier = cardTier(special)
    // 彩虹卡用彩虹框；因為金特而稀有的其他卡色用金框
    const card = el('div', `reveal-card ${tier === 'rainbow' ? 'frame-rainbow' : 'frame-gold'}`)
    const inner = el('div', 'reveal-inner')
    const top = el('div', 'reveal-top')
    top.append(el('span', 'tier-tag', T.tierNames[tier]), overallBadge(special, 'lg'))
    inner.append(el('span', 'sheen'), top, avatar(special.id, 'user', 'reveal-avatar'), el('span', 'reveal-name', special.name))
    inner.append(el('span', 'reveal-label', slotLabel(slot)), ratingBars(special))
    const gold = special.traits.filter((t) => TRAITS[t].tier === 'gold')
    if (gold.length) {
      const tags = el('div', 'traits')
      tags.append(...gold.map(traitTag))
      inner.append(tags)
    }
    card.append(inner)
    const ok = el('button', 'btn-yellow btn-big reveal-ok', T.accept)
    ok.onclick = () => overlay.remove()
    overlay.append(el('p', 'reveal-title', T.rareArrived), card, ok)
    // 等翻牌跑完再登場
    window.setTimeout(() => {
      root.append(overlay)
      play('sparkle')
    }, 700)
  }

  render()
  void maybeTutorial('team', TUTORIAL_STEPS.team)
}

const RATING_SHORT = { contact: '打', power: '力', speed: '速', fielding: '守' } as const

/** 放射狀的光芒，給登場特效和勝利畫面用 */
export function rays(radius: number): string {
  let d = ''
  for (let i = 0; i < 12; i++) {
    const a0 = ((i * 30 - 6) * Math.PI) / 180
    const a1 = ((i * 30 + 6) * Math.PI) / 180
    d += `<path d="M0 0 L${(radius * Math.cos(a0)).toFixed(1)} ${(radius * Math.sin(a0)).toFixed(1)} L${(radius * Math.cos(a1)).toFixed(1)} ${(radius * Math.sin(a1)).toFixed(1)} Z"/>`
  }
  return d
}

/** 介面層產生種子，模擬內部不碰 Math.random()（ADR-0001） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}
