import { replay } from '../sim/game'
import { teamAverage } from '../sim/generate'
import { getSlot, type Slot } from '../sim/setup'
import {
  ROUNDS,
  beginGame,
  bracket,
  currentRound,
  draftPick,
  finishGame,
  saveProgress,
  skipDraft,
  startTournament,
  updateRoster,
  updateSetup,
  type Tournament,
} from '../sim/tournament'
import { showGame } from './gameScreen'
import { el, playerCard } from './playerCard'
import { clearTournament, saveTournament } from './save'
import { showRosterEditor } from './setupScreen'
import { POSITION_NAMES, T } from './strings'

/** 依錦標賽目前的階段，打開對應的畫面。每次狀態改變都會存檔 */
export function openTournament(root: HTMLElement, t: Tournament, toTitle: () => void): void {
  const go = (next: Tournament) => openTournament(root, next, toTitle)
  const roundName = T.roundNames[currentRound(t)]
  if (t.phase === 'champion' || t.phase === 'eliminated') clearTournament()
  else saveTournament(t)

  switch (t.phase) {
    case 'pregame':
      return showRosterEditor(root, {
        setup: t.setup,
        opponent: t.opponent,
        heading: T.tournamentHeading(roundName),
        allowReroll: true,
        startLabel: T.startTournament,
        onChange: (setup) => {
          t = updateSetup(t, setup)
          saveTournament(t)
        },
        onStart: (setup) => go(beginGame(startTournament(updateSetup(t, setup)))),
        onBack: toTitle,
      })
    case 'playing':
      return playCurrentGame(root, t, go)
    case 'draft':
      return showDraft(root, t, go, toTitle)
    default:
      return showHub(root, t, go, toTitle)
  }
}

function gameSubtitle(t: Tournament): string {
  const round = currentRound(t)
  if (round !== 'final') return T.tournamentHeading(T.roundNames[round])
  return T.finalGame(t.series.user + t.series.opponent + 1, t.series.user, t.series.opponent)
}

function playCurrentGame(root: HTMLElement, t: Tournament, go: (t: Tournament) => void): void {
  const saved = t.currentGame!
  // 用種子和指令紀錄重播回中斷的那一步（ADR-0001）
  const game = replay(saved.setup, saved.commands, saved.stepIndex)
  showGame(root, {
    game,
    subtitle: gameSubtitle(t),
    onProgress: (g) => {
      t = saveProgress(t, g.commands, g.stepIndex)
      saveTournament(t)
    },
    resultActions: (g) => [{ label: `▶ ${T.continue}`, primary: true, onClick: () => go(finishGame(t, g.score)) }],
  })
}

function showHub(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'screen hub')
  const round = currentRound(t)

  const header = el('header', 'setup-header')
  const back = el('button', 'link', '‹')
  back.onclick = toTitle
  const titles = el('div')
  titles.append(el('div', 'eyebrow', T.tournament), el('h1', '', t.setup.team.name))
  header.append(back, titles)
  screen.append(header)

  const status = el('div', 'status-card')
  if (t.phase === 'champion' || t.phase === 'eliminated') {
    status.append(
      el('h2', t.phase === 'champion' ? 'win' : 'lose', t.phase === 'champion' ? T.champion : T.eliminated(T.roundNames[round])),
      el('p', 'muted', T.tournamentOver),
    )
    const home = el('button', 'btn btn-primary', T.backToTitle)
    home.onclick = toTitle
    status.append(home)
  } else {
    status.append(
      el('div', 'eyebrow', `${T.nextOpponent}・${round === 'final' ? gameSubtitle(t) : T.roundNames[round]}`),
      el('h2', '', t.opponent.name),
      el('div', 'muted', `${T.avgOverall} ${teamAverage(t.opponent.roster).toFixed(1)}　vs　${T.myTeam} ${teamAverage(t.setup.team.roster).toFixed(1)}`),
    )
    const next = el('button', 'btn btn-primary', `▶ ${T.nextGame}`)
    next.onclick = () =>
      showRosterEditor(root, {
        setup: t.setup,
        opponent: t.opponent,
        heading: gameSubtitle(t),
        allowReroll: false,
        startLabel: T.startGame,
        onChange: (setup) => {
          t = updateRoster(t, setup.team.roster)
          saveTournament(t)
        },
        onStart: (setup) => go(beginGame(updateRoster(t, setup.team.roster))),
        onBack: () => go(t),
      })
    status.append(next)
  }
  screen.append(status)

  if (t.history.length) {
    const sec = el('section', 'roster-section')
    sec.append(el('h2', '', T.historyTitle))
    const list = el('ol', 'history')
    for (const g of t.history) {
      list.append(el('li', g.won ? 'won' : 'lost', T.gameRecord(T.roundNames[g.round], g.won, g.userRuns, g.opponentRuns)))
    }
    sec.append(list)
    screen.append(sec)
  }

  const sec = el('section', 'roster-section')
  sec.append(el('h2', '', T.bracketTitle))
  bracket(t).forEach((matches, r) => {
    // 還沒打到的輪次不劇透 AI 之間的結果
    if (r > t.roundIndex) {
      sec.append(el('div', 'bracket-round', `${T.roundNames[ROUNDS[r]]}：${T.pending}`))
      return
    }
    const box = el('div', 'bracket-round')
    box.append(el('div', 'bracket-title', T.roundNames[ROUNDS[r]]))
    for (const m of matches) {
      const row = el('div', 'bracket-match')
      const name = (i: number) => {
        const result = m.winner === i ? 'winner' : m.winner === null ? '' : 'loser'
        return el('span', `${result} ${i === 0 ? 'me' : ''}`, t.teamNames[i])
      }
      row.append(name(m.a), el('span', 'muted', 'vs'), name(m.b))
      box.append(row)
    }
    sec.append(box)
  })
  screen.append(sec)
  root.append(screen)
}

function showDraft(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  let chosen: number | null = null
  let firstRender = true

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'screen setup')
    const header = el('header', 'setup-header')
    const back = el('button', 'link', '‹')
    back.onclick = toTitle
    const titles = el('div')
    titles.append(el('div', 'eyebrow', T.tournamentHeading(T.roundNames[currentRound(t)])), el('h1', '', T.draftTitle))
    header.append(back, titles)
    screen.append(header, el('div', 'hint', T.draftHint))

    const list = el('div', 'card-list')
    t.draftOptions.forEach((p, i) => {
      const card = playerCard(p, p.role === 'pitcher' ? T.pitcher : T.batter, {
        selected: chosen === i,
        reveal: firstRender ? 'flip' : 'none',
      })
      card.onclick = () => {
        chosen = chosen === i ? null : i
        render()
      }
      list.append(card)
    })
    screen.append(list)

    if (chosen !== null) {
      const pick = t.draftOptions[chosen]
      const sec = el('section', 'roster-section')
      sec.append(el('h2', '', T.draftReleaseHint(pick.name)))
      const r = t.setup.team.roster
      const slots: [Slot, string][] =
        pick.role === 'pitcher'
          ? [
              [{ kind: 'starter' }, T.starter],
              ...r.relievers.map((_, i): [Slot, string] => [{ kind: 'reliever', index: i }, T.reliever]),
            ]
          : [
              ...r.lineup.map((s, i): [Slot, string] => [{ kind: 'lineup', index: i }, `${i + 1} ${POSITION_NAMES[s.position]}`]),
              ...r.bench.map((_, i): [Slot, string] => [{ kind: 'bench', index: i }, T.bench]),
            ]
      const releaseList = el('div', 'card-list release')
      for (const [slot, label] of slots) {
        const card = playerCard(getSlot(r, slot), label)
        card.onclick = () => go(draftPick(t, chosen!, slot))
        releaseList.append(card)
      }
      sec.append(releaseList)
      screen.append(sec)
    }

    const bar = el('div', 'action-bar')
    const skip = el('button', 'btn btn-ghost', T.skipDraft)
    skip.onclick = () => go(skipDraft(t))
    bar.append(skip)
    screen.append(bar)
    root.append(screen)
    firstRender = false
  }

  render()
}
