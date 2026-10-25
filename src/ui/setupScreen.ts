import { teamAverage, teamName } from '../sim/generate'
import { Rng } from '../sim/rng'
import {
  getSlot,
  isPitcherSlot,
  rerollPlayer,
  rerollTeam,
  swapSlots,
  type PregameSetup,
  type Slot,
} from '../sim/setup'
import type { Team } from '../sim/types'
import { el, playerCard, type Reveal } from './playerCard'
import { TEAM_NAME_MAX, saveTeamName } from './prefs'
import { POSITION_NAMES, T } from './strings'

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

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

/** 組隊畫面：重骰（開打前）、交換打序與換人，然後開打 */
export function showRosterEditor(root: HTMLElement, opts: RosterEditorOptions): void {
  let setup = opts.setup
  const { allowReroll } = opts
  let selected: Slot | null = null
  let revealed: Slot[] | 'all' = 'all'
  let renaming = false

  function update(next: PregameSetup): void {
    setup = next
    opts.onChange?.(setup)
  }

  function rename(name: string): void {
    update({ ...setup, team: { ...setup.team, name } })
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

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'screen setup')
    const opponent = opts.opponent()

    const header = el('header', 'setup-header')
    const back = el('button', 'link', '‹')
    back.onclick = opts.onBack
    const titles = el('div')
    titles.append(el('div', 'eyebrow', opts.heading), el('h1', '', setup.team.name))
    header.append(back, titles)
    screen.append(header)
    if (allowReroll && renaming) screen.append(nameEditor())
    else if (allowReroll) {
      const row = el('div', 'row')
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
    const mine = el('div', 'versus')
    mine.append(el('span', '', T.myTeam), el('span', 'muted', `${T.avgOverall} ${teamAverage(setup.team.roster).toFixed(1)}`))
    const vs = el('div', 'versus')
    vs.append(
      el('span', '', `${T.opponent}：${opponent.name}`),
      el('span', 'muted', `${T.avgOverall} ${teamAverage(opponent.roster).toFixed(1)}`),
    )
    screen.append(mine, vs)

    if (allowReroll) {
      const rerollAll = el('button', 'btn btn-secondary', `${T.rerollTeam}（${T.left(setup.teamRerollsLeft)}）`)
      rerollAll.disabled = setup.teamRerollsLeft <= 0
      rerollAll.onclick = () => {
        update(rerollTeam(setup))
        selected = null
        revealed = 'all'
        render()
      }
      screen.append(rerollAll)
    } else {
      screen.append(el('div', 'hint', T.lineupOnlyHint))
    }

    const r = setup.team.roster
    const section = (title: string, cards: [Slot, string][]) => {
      const sec = el('section', 'roster-section')
      sec.append(el('h2', '', title))
      const list = el('div', 'card-list')
      for (const [slot, label] of cards) {
        const reveal: Reveal = revealed === 'all' || revealed.some((s) => sameSlot(s, slot)) ? 'flip' : 'none'
        const card = playerCard(getSlot(r, slot), label, { selected: sameSlot(selected, slot), reveal })
        card.onclick = () => onCardTap(slot)
        list.append(card)
      }
      sec.append(list)
      screen.append(sec)
    }
    section(
      T.lineup,
      r.lineup.map((s, i) => [{ kind: 'lineup', index: i }, `${i + 1} ${POSITION_NAMES[s.position]}`]),
    )
    section(
      T.bench,
      r.bench.map((_, i) => [{ kind: 'bench', index: i }, T.bench]),
    )
    section(T.pitchers, [
      [{ kind: 'starter' }, T.starter],
      ...r.relievers.map((_, i): [Slot, string] => [{ kind: 'reliever', index: i }, T.reliever]),
    ])

    const bar = el('div', 'action-bar')
    if (selected) {
      const slot = selected
      bar.append(el('div', 'hint', `${getSlot(r, slot).name}：${T.swapHint}`))
      const row = el('div', 'row')
      const cancel = el('button', 'btn btn-ghost', T.cancel)
      cancel.onclick = () => {
        selected = null
        revealed = []
        render()
      }
      row.append(cancel)
      if (allowReroll) {
        const reroll = el('button', 'btn btn-secondary', `${T.rerollPlayer}（${T.left(setup.playerRerollsLeft)}）`)
        reroll.disabled = setup.playerRerollsLeft <= 0
        reroll.onclick = () => {
          update(rerollPlayer(setup, slot))
          revealed = [slot]
          selected = null
          render()
        }
        row.append(reroll)
      }
      bar.append(row)
    } else {
      const start = el('button', 'btn btn-primary', opts.startLabel)
      start.onclick = () => opts.onStart(setup)
      bar.append(start)
    }
    screen.append(bar)
    root.append(screen)
  }

  function onCardTap(slot: Slot): void {
    revealed = []
    if (!selected) selected = slot
    else if (sameSlot(selected, slot)) selected = null
    else if (isPitcherSlot(selected) === isPitcherSlot(slot)) {
      const swapped = swapSlots(setup.team.roster, selected, slot)
      if (swapped) update({ ...setup, team: { ...setup.team, roster: swapped } })
      selected = null
    } else selected = slot
    render()
  }

  render()
}

/** 介面層產生種子，模擬內部不碰 Math.random()（ADR-0001） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}
