import { generateTeam, overall } from '../sim/generate'
import { Rng } from '../sim/rng'
import {
  createSetup,
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
import { POSITION_NAMES, T } from './strings'

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

function teamAverage(team: Team): number {
  const r = team.roster
  const all = [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers]
  return all.reduce((sum, p) => sum + overall(p), 0) / all.length
}

/** 快速比賽的組隊畫面：重骰、換人，然後開打 */
export function showSetup(root: HTMLElement, onStart: (user: Team, opponent: Team) => void, onBack: () => void): void {
  let setup: PregameSetup = createSetup(randomSeed())
  // 快速比賽的對手跟玩家一樣全隨機，不能重骰
  const opponent = generateTeam(new Rng(randomSeed()))
  let selected: Slot | null = null
  let revealed: Slot[] | 'all' = 'all'

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'screen setup')

    const header = el('header', 'setup-header')
    const back = el('button', 'link', '‹')
    back.onclick = onBack
    const titles = el('div')
    titles.append(el('div', 'eyebrow', T.myTeam), el('h1', '', setup.team.name))
    header.append(back, titles)
    const vs = el('div', 'versus')
    vs.append(
      el('span', '', `${T.opponent}：${opponent.name}`),
      el('span', 'muted', `${T.avgOverall} ${teamAverage(opponent).toFixed(1)}`),
    )
    const mine = el('div', 'versus')
    mine.append(el('span', '', T.myTeam), el('span', 'muted', `${T.avgOverall} ${teamAverage(setup.team).toFixed(1)}`))

    const rerollAll = el('button', 'btn btn-secondary', `🎲 ${T.rerollTeam}（${T.left(setup.teamRerollsLeft)}）`)
    rerollAll.disabled = setup.teamRerollsLeft <= 0
    rerollAll.onclick = () => {
      setup = rerollTeam(setup)
      selected = null
      revealed = 'all'
      render()
    }

    screen.append(header, mine, vs, rerollAll)

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
      const hint = el('div', 'hint', `${getSlot(r, slot).name}：${T.swapHint}`)
      const reroll = el('button', 'btn btn-secondary', `🎲 ${T.rerollPlayer}（${T.left(setup.playerRerollsLeft)}）`)
      reroll.disabled = setup.playerRerollsLeft <= 0
      reroll.onclick = () => {
        setup = rerollPlayer(setup, slot)
        revealed = [slot]
        selected = null
        render()
      }
      const cancel = el('button', 'btn btn-ghost', T.cancel)
      cancel.onclick = () => {
        selected = null
        revealed = []
        render()
      }
      const row = el('div', 'row')
      row.append(cancel, reroll)
      bar.append(hint, row)
    } else {
      const start = el('button', 'btn btn-primary', `▶ ${T.startGame}`)
      start.onclick = () => onStart(setup.team, opponent)
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
      if (swapped) setup = { ...setup, team: { ...setup.team, roster: swapped } }
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
