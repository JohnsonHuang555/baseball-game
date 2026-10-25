import './style.css'
import { Game } from './sim/game'
import { generateTeam } from './sim/generate'
import { Rng } from './sim/rng'
import { createSetup } from './sim/setup'
import { createTournament, currentRound } from './sim/tournament'
import { showGame } from './ui/gameScreen'
import { el } from './ui/playerCard'
import { loadTournament } from './ui/save'
import { randomSeed, showRosterEditor } from './ui/setupScreen'
import { T } from './ui/strings'
import { openTournament } from './ui/tournamentScreen'

const root = document.getElementById('app')!

function showTitle(): void {
  root.replaceChildren()
  const screen = el('div', 'screen title')
  screen.append(el('div', 'logo', '⚾🎲'), el('h1', '', T.gameTitle), el('p', 'muted', T.gameSubtitle))
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
    openTournament(root, createTournament(randomSeed()), showTitle)
  }
  screen.append(fresh)
  root.append(screen)
}

function startQuickMatch(): void {
  // 快速比賽的對手跟玩家一樣全隨機，不能重骰
  const opponent = generateTeam(new Rng(randomSeed()))
  showRosterEditor(root, {
    setup: createSetup(randomSeed()),
    opponent,
    heading: T.myTeam,
    allowReroll: true,
    startLabel: T.startGame,
    onStart: (setup) =>
      showGame(root, {
        game: new Game({ home: setup.team, away: opponent, seed: randomSeed(), userSide: 'home' }),
        resultActions: () => [
          { label: `🎲 ${T.playAgain}`, primary: true, onClick: startQuickMatch },
          { label: T.backToTitle, onClick: showTitle },
        ],
      }),
    onBack: showTitle,
  })
}

showTitle()
