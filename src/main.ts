import './style.css'
import { showGame } from './ui/gameScreen'
import { el } from './ui/playerCard'
import { showSetup } from './ui/setupScreen'
import { T } from './ui/strings'

const root = document.getElementById('app')!

function showTitle(): void {
  root.replaceChildren()
  const screen = el('div', 'screen title')
  screen.append(el('div', 'logo', '⚾🎲'), el('h1', '', T.gameTitle), el('p', 'muted', T.gameSubtitle))
  const quick = el('button', 'btn btn-primary', T.quickMatch)
  quick.onclick = startQuickMatch
  const tournament = el('button', 'btn btn-ghost', `${T.tournament}（${T.comingSoon}）`)
  tournament.disabled = true
  screen.append(quick, tournament)
  root.append(screen)
}

function startQuickMatch(): void {
  showSetup(
    root,
    (user, opponent) => showGame(root, user, opponent, (again) => (again ? startQuickMatch() : showTitle())),
    showTitle,
  )
}

showTitle()
