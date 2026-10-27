import './style.css'
import './theme.css'
import './team.css'
import './match.css'
import './decision.css'
import './screens.css'
import './desktop.css'
import { Game } from './sim/game'
import { cardTier, generateBatter, generateTeam, teamName, type CardTier } from './sim/generate'
import { Rng } from './sim/rng'
import { createSetup } from './sim/setup'
import { addLegend, createTournament, updateSetup, type Tier, type Tournament } from './sim/tournament'
import { availableTiers, clearedTier, legends, outfitForTier, trophies } from './ui/progress'
import { showClubHistory } from './ui/clubHistory'
import type { Batter, Team } from './sim/types'
import { avatar, avatarSpecies, avatarSvg, setAvatarSpecies } from './ui/avatar'
import { showGame } from './ui/gameScreen'
import { growthPanel } from './ui/growthPanel'
import { gradeBadge, overallBadge } from './ui/grades'
import { setKeys } from './ui/keys'
import { soundToggle } from './ui/sound'
import { choiceModal, confirmModal } from './ui/modal'
import { maybeTutorial, resetTutorials } from './ui/tutorial'
import { TUTORIAL_STEPS } from './ui/tutorialSteps'
import { toast } from './ui/visual'
import { el } from './ui/playerCard'
import { withSavedName } from './ui/prefs'
import { discardOldTournament, loadTournament } from './ui/save'
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

/** 電腦版首頁右邊的三張展示卡：用固定種子挑出銅、金、彩虹卡各一位，每次都一樣 */
function showcaseCards(): HTMLElement {
  const rng = new Rng(20261026)
  const picks = new Map<CardTier, Batter>()
  for (let i = 0; i < 50000 && picks.size < 3; i++) {
    const p = generateBatter(rng)
    const tier = cardTier(p)
    if ((tier === 'bronze' || tier === 'gold' || tier === 'rainbow') && !picks.has(tier)) picks.set(tier, p)
  }
  const box = el('div', 'home-cards')
  box.setAttribute('aria-hidden', 'true')
  for (const tier of ['bronze', 'gold', 'rainbow'] as const) {
    const p = picks.get(tier)
    if (!p) continue
    const card = el('div', `showcase-card tier-${tier}`)
    const inner = el('div', 'showcase-inner')
    const top = el('div', 'showcase-top')
    top.append(el('span', 'tier-tag', T.tierNames[tier]), overallBadge(p, 'lg'))
    const grades = el('div', 'showcase-grades')
    for (const v of Object.values(p.ratings)) grades.append(gradeBadge(v, 'md'))
    inner.append(top, avatar(p.id, 'user', 'showcase-avatar'), el('span', 'showcase-name', p.name), grades)
    card.append(inner)
    box.append(card)
  }
  return box
}

/** 開新錦標賽前選難度：只通過到第 n 級時，可以選 1～n+1 級；只有第 1 級可選就不問 */
async function chooseTier(): Promise<Tier | null> {
  const tiers = availableTiers()
  if (tiers.length === 1) return tiers[0]
  const cleared = clearedTier()
  return choiceModal<Tier>({
    title: T.tierTitle,
    message: T.tierMessage,
    options: tiers.map((tier) => {
      const reward = tier > cleared ? outfitForTier(tier) : null
      return {
        value: tier,
        label: `${T.levelNames[tier]}${tier <= cleared ? `（${T.tierCleared}）` : ''}`,
        sub: [T.tierStrength(tier), reward ? T.tierReward(T.outfitNames[reward]) : ''].filter(Boolean).join('・'),
        current: tier === tiers[tiers.length - 1],
      }
    }),
  })
}

/** 開新錦標賽時，傳奇館有人就問要不要帶一位加入；取消整個開新流程回傳 null */
async function withLegend(t: Tournament): Promise<Tournament | null> {
  const list = legends()
  if (!list.length) return t
  const SKIP = -1
  const picked = await choiceModal<number>({
    title: T.legendPickTitle,
    message: T.legendPickMessage,
    options: [
      { value: SKIP, label: T.legendSkip },
      ...list.map((l, i) => ({
        value: i,
        label: `${l.player.name}（${l.player.role === 'pitcher' ? T.pitcher : T.batter}）`,
        sub: T.legendFrom(l.teamName, T.levelNames[l.tier]),
        icon: avatarSvg(l.player.id, 'user'),
      })),
    ],
  })
  if (picked === null) return null
  if (picked === SKIP) return t
  toast(T.legendJoined(list[picked].player.name))
  return addLegend(t, list[picked].player)
}

/** 首頁左上角：球員頭像要用貓咪還是小狗，換了就重畫首頁 */
function speciesPicker(): HTMLElement {
  const box = el('div', 'species-picker')
  box.setAttribute('role', 'group')
  box.setAttribute('aria-label', T.speciesLabel)
  for (const kind of ['cat', 'dog'] as const) {
    const btn = el('button', 'species-option')
    btn.type = 'button'
    btn.setAttribute('aria-pressed', String(avatarSpecies() === kind))
    const face = el('span', 'species-face')
    face.innerHTML = avatarSvg(kind === 'cat' ? 'p-cat-sample' : 'p-dog-sample', 'user', kind)
    btn.append(face, T.speciesNames[kind])
    btn.onclick = () => {
      if (avatarSpecies() === kind) return
      setAvatarSpecies(kind)
      showTitle()
    }
    box.append(btn)
  }
  return box
}

function showTitle(): void {
  root.replaceChildren()
  const screen = el('div', 'home-screen')
  // 首頁右上角的音效開關，按 M 也可以切換
  const sound = soundToggle('sound-btn home-sound')
  setKeys({ m: () => sound.click() })
  const main = el('div', 'home-main')
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
  fresh.onclick = async () => {
    if (saved && !(await confirmModal({ title: T.newTournament, message: T.confirmOverwrite, confirmLabel: T.overwriteConfirm, danger: true }))) return
    const tier = await chooseTier()
    if (!tier) return
    const created = createTournament(randomSeed(), tier)
    const t = await withLegend(updateSetup(created, withSavedName(created.setup)))
    if (!t) return
    openTournament(root, t, showTitle)
  }
  if (saved) {
    const resume = el('button', 'btn-yellow btn-big', T.continueTournament(T.roundNames[saved.round]))
    resume.onclick = () => openTournament(root, saved, showTitle)
    buttons.append(resume, quick, fresh)
  } else buttons.append(quick, fresh)
  const cabinet = el('button', 'btn-outline-light trophy-btn', T.clubHistoryCount(trophies().length))
  cabinet.type = 'button'
  cabinet.onclick = () => showClubHistory(root, showTitle)
  buttons.append(cabinet)
  const replay = el('button', 'home-link', T.tutorialReplay)
  replay.type = 'button'
  replay.onclick = () => {
    resetTutorials()
    toast(T.tutorialReset)
    void maybeTutorial('home', TUTORIAL_STEPS.home)
  }
  buttons.append(replay)

  main.append(hero, buttons)
  screen.append(sound, speciesPicker(), main, showcaseCards())
  root.append(screen)
  void maybeTutorial('home', TUTORIAL_STEPS.home)
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
        manualToggle: true,
        resultExtra: (g) => growthPanel(g, g.userSide, null),
        resultActions: () => [
          { label: T.playAgain, primary: true, onClick: startQuickMatch },
          { label: T.backToTitle, onClick: showTitle },
        ],
      }),
    onBack: showTitle,
  })
}

showTitle()
if (discardOldTournament()) toast(T.oldSaveDiscarded)
