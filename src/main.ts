import './style.css'
import './visual.css'
import { Game } from './sim/game'
import { generateTeam, teamName } from './sim/generate'
import { Rng } from './sim/rng'
import { createSetup } from './sim/setup'
import { createTournament, currentRound, updateSetup } from './sim/tournament'
import type { Team } from './sim/types'
import { showGame } from './ui/gameScreen'
import { el } from './ui/playerCard'
import { withSavedName } from './ui/prefs'
import { loadTournament } from './ui/save'
import { randomSeed, showRosterEditor } from './ui/setupScreen'
import { T } from './ui/strings'
import { openTournament } from './ui/tournamentScreen'

const root = document.getElementById('app')!

/** 首頁標誌：畫一顆棒球，不用 emoji */
function logo(): HTMLElement {
  const wrap = el('div', 'logo')
  wrap.innerHTML = `<svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">
    <circle cx="32" cy="32" r="28" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>
    <path d="M18 10 C26 22 26 42 18 54" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-dasharray="3 3"/>
    <path d="M46 10 C38 22 38 42 46 54" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-dasharray="3 3"/>
  </svg>`
  return wrap
}

function showTitle(): void {
  root.replaceChildren()
  const screen = el('div', 'screen title')
  screen.append(logo(), el('h1', '', T.gameTitle), el('p', 'muted', T.gameSubtitle))
  const quick = el('button', 'btn btn-primary', T.quickMatch)
  quick.onclick = startQuickMatch
  screen.append(quick)

  const saved = loadTournament()
  if (saved) {
    const resume = el('button', 'btn btn-primary', T.continueTournament(T.roundNames[currentRound(saved)]))
    resume.onclick = () => openTournament(root, saved, showTitle)
    screen.append(resume)
  }
  const fresh = el('button', 'btn btn-ghost', saved ? T.newTournament : T.tournament)
  fresh.onclick = () => {
    if (saved && !window.confirm(T.confirmOverwrite)) return
    const t = createTournament(randomSeed())
    openTournament(root, updateSetup(t, withSavedName(t.setup)), showTitle)
  }
  screen.append(fresh)
  root.append(screen)
}

function startQuickMatch(): void {
  // 快速比賽的對手跟玩家一樣全隨機，不能重骰
  let opponent: Team = generateTeam(new Rng(randomSeed()))
  let setup = withSavedName(createSetup(randomSeed()))
  showRosterEditor(root, {
    setup,
    opponent: () => {
      while (opponent.name === setup.team.name) opponent = { ...opponent, name: teamName(new Rng(randomSeed())) }
      return opponent
    },
    heading: T.myTeam,
    allowReroll: true,
    startLabel: T.startGame,
    onChange: (next) => (setup = next),
    onStart: (final) =>
      showGame(root, {
        game: new Game({ home: final.team, away: opponent, seed: randomSeed(), userSide: 'home' }),
        resultActions: () => [
          { label: T.playAgain, primary: true, onClick: startQuickMatch },
          { label: T.backToTitle, onClick: showTitle },
        ],
      }),
    onBack: showTitle,
  })
}

showTitle()
