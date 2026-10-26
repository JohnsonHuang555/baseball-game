import './style.css'
import './theme.css'
import './team.css'
import './match.css'
import './decision.css'
import './screens.css'
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
import { randomSeed, rays, showRosterEditor } from './ui/setupScreen'
import { T } from './ui/strings'
import { openTournament } from './ui/tournamentScreen'

const root = document.getElementById('app')!

/** 首頁標誌：骰子加上棒球縫線，用 SVG 畫，不用 emoji */
const LOGO = `<svg class="home-logo" role="img" aria-label="${T.gameTitle}" viewBox="0 0 132 132">
  <rect x="10" y="14" width="108" height="108" rx="26" fill="#141633"/>
  <rect x="8" y="6" width="108" height="108" rx="26" fill="#FFFFFF" stroke="#141633" stroke-width="5"/>
  <path d="M38 22 C54 44 54 76 38 98" fill="none" stroke="#E5383B" stroke-width="4.5" stroke-dasharray="6 5" stroke-linecap="round"/>
  <path d="M86 22 C70 44 70 76 86 98" fill="none" stroke="#E5383B" stroke-width="4.5" stroke-dasharray="6 5" stroke-linecap="round"/>
  <circle cx="62" cy="40" r="7" fill="#141633"/>
  <circle cx="62" cy="60" r="7" fill="#141633"/>
  <circle cx="62" cy="80" r="7" fill="#141633"/>
</svg>`

/** 首頁背景的放射光芒：12 條等距光束，以標誌為中心慢慢轉 */
const HOME_RAYS = `<svg class="home-rays" aria-hidden="true" viewBox="-400 -400 800 800">${rays(400)}</svg>`

function showTitle(): void {
  root.replaceChildren()
  const screen = el('div', 'home-screen')
  const hero = el('div', 'home-hero')
  hero.insertAdjacentHTML('afterbegin', HOME_RAYS + LOGO)
  const subtitle = el('p', 'home-subtitle')
  subtitle.append(T.gameSubtitleLines[0], el('br'), T.gameSubtitleLines[1])
  hero.append(el('h1', 'home-title', T.gameTitle), subtitle)

  const buttons = el('div', 'home-buttons')
  const saved = loadTournament()
  const quick = el('button', saved ? 'btn-white btn-big' : 'btn-yellow btn-big', T.quickMatch)
  quick.onclick = startQuickMatch
  const fresh = el('button', saved ? 'btn-outline-light' : 'btn-white btn-big', saved ? T.newTournament : T.tournament)
  fresh.onclick = () => {
    if (saved && !window.confirm(T.confirmOverwrite)) return
    const t = createTournament(randomSeed())
    openTournament(root, updateSetup(t, withSavedName(t.setup)), showTitle)
  }
  if (saved) {
    const resume = el('button', 'btn-yellow btn-big', T.continueTournament(T.roundNames[currentRound(saved)]))
    resume.onclick = () => openTournament(root, saved, showTitle)
    buttons.append(resume, quick, fresh)
  } else buttons.append(quick, fresh)

  screen.append(hero, buttons)
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
        resultLabel: T.quickMatch,
        resultActions: () => [
          { label: T.playAgain, primary: true, onClick: startQuickMatch },
          { label: T.backToTitle, onClick: showTitle },
        ],
      }),
    onBack: showTitle,
  })
}

showTitle()
