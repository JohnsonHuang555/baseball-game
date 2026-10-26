import { replay } from '../sim/game'
import { cardTier, teamAverage } from '../sim/generate'
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
import { avatar } from './avatar'
import { showGame } from './gameScreen'
import { gradeBadge, gradeOf, overallBadge } from './grades'
import { kbd, setKeys, type KeyMap } from './keys'
import { el, traitTag } from './playerCard'
import { applyCardState, sideTag, toast } from './visual'
import { clearTournament, saveTournament } from './save'
import { play } from './sound'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { rays, showRosterEditor } from './setupScreen'
import { POSITION_FULL, RATING_FULL, RATING_LABELS, T, TRAIT_DESC } from './strings'

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
        opponent: () => t.opponent,
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
    resultActions: (g) => [{ label: T.continue, primary: true, onClick: () => go(finishGame(t, g.score)) }],
  })
}

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
const CHECK_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

function backButton(onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-btn')
  b.type = 'button'
  b.innerHTML = BACK_ICON
  b.setAttribute('aria-label', T.backToTitle)
  b.onclick = onClick
  return b
}

/** 斜切的小緞帶，給下一個對手、奪冠、淘汰用 */
function ribbon(text: string, tone: 'yellow' | 'lilac'): HTMLElement {
  const wrap = el('div', 'hub-ribbon-wrap')
  const r = el('span', `hub-ribbon ${tone}`)
  r.append(el('span', '', text))
  wrap.append(r)
  return wrap
}

function teamTile(name: string, team: 'user' | 'opponent'): HTMLElement {
  return el('span', `team-tile ${team}`, name.slice(0, 1))
}

/** 電腦版版面的分界，跟 desktop.css 一致 */
const DESKTOP = window.matchMedia('(min-width: 1024px)')

/** 畫面還在的話，視窗跨過電腦版分界時重畫一次（賽程樹是用像素排的） */
function redrawOnLayoutChange(screen: HTMLElement, redraw: () => void): void {
  DESKTOP.addEventListener('change', () => screen.isConnected && redraw(), { once: true })
}

/** 每一場的戰績：決賽三戰兩勝要標第幾戰 */
function recordRows(t: Tournament): { round: string; won: boolean; score: string; opponent: string }[] {
  let finals = 0
  return t.history.map((g) => ({
    round: g.round === 'final' ? T.finalNth(++finals) : T.roundNames[g.round],
    won: g.won,
    score: `${g.userRuns}:${g.opponentRuns}`,
    opponent: t.teamNames[t.opponents[ROUNDS.indexOf(g.round)]],
  }))
}

/** 錦標賽主畫面：戰績、賽程樹、下一個對手（或奪冠／淘汰） */
function showHub(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  if (t.phase === 'champion' || t.phase === 'eliminated') return showTourEnd(root, t, toTitle)
  root.replaceChildren()
  const screen = el('div', 'hub-screen')
  redrawOnLayoutChange(screen, () => showHub(root, t, go, toTitle))
  const round = currentRound(t)

  const header = el('header', 'hub-header')
  const titles = el('div', 'team-titles')
  titles.append(el('span', 'eyebrow-light', t.setup.team.name), el('h1', 'team-name', T.tournament))
  header.append(backButton(toTitle), titles)
  screen.append(header)

  // 戰績：每場一顆膠囊，可以左右捲
  if (t.history.length) {
    const record = el('section', 'hub-record')
    record.setAttribute('aria-label', T.historyTitle)
    record.append(el('span', 'hub-record-label', T.historyTitle))
    for (const g of t.history) {
      const chip = el('span', 'record-chip')
      const opponentName = t.teamNames[t.opponents[ROUNDS.indexOf(g.round)]]
      chip.append(
        el('span', `record-mark ${g.won ? 'won' : 'lost'}`, g.won ? T.winMark : T.loseMark),
        T.roundNames[g.round],
        el('b', 'record-score', `${g.userRuns}:${g.opponentRuns}`),
        opponentName,
      )
      record.append(chip)
    }
    screen.append(record)
  }

  screen.append(bracketPanel(t))

  // 底部：下一個對手
  const bottom = el('section', 'hub-bottom')
  {
    bottom.setAttribute('aria-label', T.nextOpponent)
    bottom.append(ribbon(`${round === 'final' ? gameSubtitle(t) : T.roundNames[round]}・${T.nextOpponent}`, 'yellow'))
    const vs = el('div', 'hub-vs')
    const side = (name: string, avg: number, team: 'user' | 'opponent') => {
      const box = el('div', `hub-side ${team}`)
      const words = el('span', 'hub-side-words')
      words.append(el('span', 'hub-side-name', name), gradeBadge(avg, 'sm'))
      if (team === 'user') words.append(sideTag(true))
      box.append(teamTile(name, team), words)
      return box
    }
    vs.append(
      side(t.setup.team.name, teamAverage(t.setup.team.roster), 'user'),
      el('span', 'hub-vs-mark', T.versus),
      side(t.opponent.name, teamAverage(t.opponent.roster), 'opponent'),
    )
    const next = el('button', 'btn-yellow btn-big', T.nextGame)
    next.append(kbd('ENTER'))
    setKeys({ Enter: () => next.click() })
    next.onclick = () =>
      showRosterEditor(root, {
        setup: t.setup,
        opponent: () => t.opponent,
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
    bottom.append(vs, next)
  }
  screen.append(bottom)
  root.append(screen)
  void maybeTutorial('hub', TUTORIAL_STEPS.hub)
}

/** 賽程樹：四欄、每場一個小方框，用線連起來；自己的晉級路線用藍線 */
function bracketPanel(t: Tournament): HTMLElement {
  if (DESKTOP.matches) return deskBracket(t)
  const panel = el('section', 'bracket-panel')
  panel.setAttribute('aria-label', T.bracketTitle)
  const heads = el('div', 'bracket-heads')
  ROUNDS.forEach((r, i) => heads.append(el('span', i === t.roundIndex ? 'current' : '', T.roundNames[r])))
  const scroll = el('div', 'bracket-scroll')
  panel.append(heads, scroll)

  const GAP = 6
  const H = 38
  const STEP = 53
  const width = Math.min(window.innerWidth, 480) - 24 - 16 - 5
  const W = Math.floor((width - GAP * 3) / 4)
  const colX = [0, 1, 2, 3].map((i) => i * (W + GAP))
  const centers: number[][] = [Array.from({ length: 8 }, (_, i) => i * STEP + 4 + H / 2)]
  for (let c = 1; c < 4; c++) {
    centers.push(centers[c - 1].filter((_, i) => i % 2 === 0).map((y, j) => (y + centers[c - 1][2 * j + 1]) / 2))
  }

  const tree = el('div', 'bracket-tree')
  tree.style.width = `${colX[3] + W}px`
  tree.style.height = `${8 * STEP}px`

  const rounds = sortedRounds(t)
  let lines = ''
  let myLine = ''
  for (let r = 0; r < 4; r++) {
    centers[r].forEach((cy, i) => tree.append(bracketBox(t, rounds, r, i, colX[r], cy, W, H)))
    if (r < 3) {
      const x = colX[r] + W
      const mid = x + GAP / 2
      for (let p = 0; p < centers[r].length / 2; p++) {
        const y1 = centers[r][2 * p]
        const y2 = centers[r][2 * p + 1]
        lines += `M${x} ${y1} H${mid} V${y2} H${x} M${mid} ${(y1 + y2) / 2} H${colX[r + 1]} `
      }
      // 自己贏了這一輪，就把藍線畫到下一輪
      const myMatch = rounds[r]?.findIndex((m) => m.a === 0 || m.b === 0) ?? -1
      if (r <= t.roundIndex && myMatch >= 0 && rounds[r][myMatch].winner === 0) {
        const y = centers[r][myMatch]
        const ny = centers[r + 1][Math.floor(myMatch / 2)]
        myLine += `M${x} ${y} H${mid} V${ny} H${colX[r + 1]} `
      }
    }
  }
  tree.insertAdjacentHTML(
    'afterbegin',
    `<svg class="bracket-lines" aria-hidden="true" width="${colX[3] + W}" height="${8 * STEP}"><path d="${lines}" class="all"/><path d="${myLine}" class="mine"/></svg>`,
  )
  scroll.append(tree)
  return panel
}

/** 每一輪的對戰依賽程位置排好，連線才接得起來 */
function sortedRounds(t: Tournament) {
  return bracket(t).map((matches, r) =>
    matches
      .map((m) => (m.a < m.b ? m : { a: m.b, b: m.a, winner: m.winner }))
      .sort((x, y) => Math.floor(x.a / 2 ** (r + 1)) - Math.floor(y.a / 2 ** (r + 1))),
  )
}

/** 賽程樹上的一個對戰方框 */
function bracketBox(t: Tournament, rounds: ReturnType<typeof sortedRounds>, r: number, i: number, x: number, cy: number, W: number, H: number): HTMLElement {
  const box = el('div', 'bracket-box')
  box.style.left = `${x}px`
  box.style.top = `${cy - H / 2}px`
  box.style.width = `${W}px`
  box.style.height = `${H}px`
  // 還沒打到的輪次不劇透 AI 之間的結果
  const m = r <= t.roundIndex ? rounds[r][i] : undefined
  if (!m) {
    box.classList.add('tbd')
    box.append(el('div', 'bracket-row tbd', T.pending), el('div', 'bracket-row tbd', T.pending))
    return box
  }
  const mine = m.a === 0 || m.b === 0
  if (mine && r === t.roundIndex && m.winner === null && t.phase !== 'eliminated') box.classList.add('next')
  const games = mine ? t.history.filter((g) => g.round === ROUNDS[r]) : []
  let score: { user: number; opp: number } | null = null
  if (games.length) {
    score =
      ROUNDS[r] === 'final'
        ? { user: games.filter((g) => g.won).length, opp: games.filter((g) => !g.won).length }
        : { user: games[0].userRuns, opp: games[0].opponentRuns }
  }
  for (const team of [m.a, m.b]) {
    const state = team === 0 ? 'me' : m.winner === null ? '' : m.winner === team ? 'win' : 'lose'
    const row = el('div', `bracket-row ${state} ${m.winner === team ? 'winner' : ''}`)
    row.append(el('span', 'bracket-name', t.teamNames[team]))
    if (score) row.append(el('span', 'bracket-score', String(team === 0 ? score.user : score.opp)))
    box.append(row)
  }
  return box
}

const TROPHY = (size: number, label = '') =>
  `<svg ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'} width="${size}" height="${size}" viewBox="0 0 24 24" fill="#FFD23F" stroke="#141633" stroke-width="1.2" stroke-linejoin="round"><path d="M7 3h10v4a5 5 0 0 1-10 0z"/><path d="M7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4" fill="none" stroke-width="1.4"/><path d="M10 12h4v4h-4z"/><path d="M8 20h8v-2H8z"/></svg>`

/** 電腦版賽程樹：左右各半區，決賽在正中間，上面放獎盃 */
function deskBracket(t: Tournament): HTMLElement {
  const panel = el('section', 'bracket-panel desk')
  panel.setAttribute('aria-label', T.bracketTitle)
  const W = 150
  const H = 56
  const X = [0, 174, 348, 522, 696, 870, 1044]
  const width = X[6] + W
  const height = 446
  // 每一輪在左、右半區的欄位，以及每個方框的中心高度
  const COLS = [[0, 6], [1, 5], [2, 4], [3, 3]]
  const CENTERS = [[56, 166, 276, 386], [111, 331], [221], [221]]
  const rounds = sortedRounds(t)
  const pos = (r: number, i: number) => {
    const half = Math.max(1, rounds[r].length / 2)
    const right = r < 3 && i >= half
    return { x: X[COLS[r][right ? 1 : 0]], cy: CENTERS[r][r < 3 ? i % half : 0], right }
  }

  const scroll = el('div', 'bracket-scroll')
  const inner = el('div', 'bracket-desk-inner')
  inner.style.width = `${width}px`
  // 視窗不夠寬就整棵縮小（扣掉畫面與面板的左右留白）
  inner.style.zoom = String(Math.min(1, (window.innerWidth - 140) / width))
  const heads = el('div', 'bracket-heads')
  for (const r of [0, 1, 2, 3, 2, 1, 0]) heads.append(el('span', `${r === t.roundIndex ? 'current' : ''} ${r === 3 ? 'final' : ''}`, T.roundNames[ROUNDS[r]]))
  const tree = el('div', 'bracket-tree')
  tree.style.width = `${width}px`
  tree.style.height = `${height}px`
  inner.append(heads, tree)
  scroll.append(inner)
  panel.append(scroll)

  for (let r = 0; r < 4; r++) {
    rounds[r].forEach((_, i) => {
      const p = pos(r, i)
      tree.append(bracketBox(t, rounds, r, i, p.x, p.cy, W, H))
    })
  }
  // 兩場合成下一場的連接線；dir 是往中間的方向
  let lines = ''
  const join = (xFrom: number, ys: number[], xTo: number, dir: number) => {
    const mid = xFrom + dir * 12
    lines += `M${xFrom} ${ys[0]} H${mid} V${ys[1]} H${xFrom} M${mid} ${(ys[0] + ys[1]) / 2} H${xTo} `
  }
  for (const r of [0, 1]) {
    const cs = CENTERS[r]
    for (let k = 0; k < cs.length; k += 2) {
      join(X[COLS[r][0]] + W, [cs[k], cs[k + 1]], X[COLS[r + 1][0]], 1)
      join(X[COLS[r][1]], [cs[k], cs[k + 1]], X[COLS[r + 1][1]] + W, -1)
    }
  }
  lines += `M${X[2] + W} 221 H${X[3]} M${X[4]} 221 H${X[3] + W}`
  // 自己贏了的輪次，藍線畫到下一輪
  let myLine = ''
  for (let r = 0; r < 3; r++) {
    const i = rounds[r]?.findIndex((m) => m.a === 0 || m.b === 0) ?? -1
    if (r > t.roundIndex || i < 0 || rounds[r][i].winner !== 0) continue
    const p = pos(r, i)
    const n = pos(r + 1, Math.floor(i / 2))
    const start = p.right ? p.x : p.x + W
    const end = p.right ? n.x + W : n.x
    const mid = r === 2 ? start : start + (p.right ? -12 : 12)
    myLine += `M${start} ${p.cy} H${mid} V${n.cy} H${end} `
  }
  tree.insertAdjacentHTML(
    'afterbegin',
    `<svg class="bracket-lines" aria-hidden="true" width="${width}" height="${height}"><path d="${lines}" class="all"/><path d="${myLine}" class="mine"/></svg><div class="bracket-trophy" style="left:${X[3]}px;width:${W}px">${TROPHY(64)}</div>`,
  )
  return panel
}

/** 彩色紙花，用固定的種子撒，每次一樣 */
function confetti(width: number, height: number, count: number, seed: number): string {
  const colors = ['#FF4F7B', '#FFD23F', '#5FE3A1', '#6FB6FF', '#B57BFF', '#FF8A2A']
  let s = seed
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  let out = ''
  for (let k = 0; k < count; k++) {
    const x = Math.round(rnd() * (width - 10))
    const y = Math.round(rnd() * (height - 20))
    const w = 6 + Math.round(rnd() * 7)
    const h = 10 + Math.round(rnd() * 10)
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors[k % 6]}" transform="rotate(${Math.round(rnd() * 360)} ${x} ${y})"/>`
  }
  return `<svg class="end-confetti" aria-hidden="true" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin slice">${out}</svg>`
}

const BALL_ICON = `<svg role="img" aria-label="${T.ballLabel}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#D9DCF2" stroke="#141633" stroke-width="3"/><path d="M18 10c8 10 8 34 0 44M46 10c-8 10-8 34 0 44" fill="none" stroke="#8A8FD8" stroke-width="2.5" stroke-dasharray="4 4"/></svg>`

/** 錦標賽結束：奪冠（獎盃、光芒、紙花）或止步某輪，列出這屆每一場 */
function showTourEnd(root: HTMLElement, t: Tournament, toTitle: () => void): void {
  const champ = t.phase === 'champion'
  play(champ ? 'champion' : 'lose')
  const screen = el('div', `end-screen ${champ ? 'champ' : 'out'}`)
  if (champ) {
    screen.insertAdjacentHTML('afterbegin', `<svg class="end-rays" aria-hidden="true" viewBox="-700 -700 1400 1400">${rays(700)}</svg>${confetti(1440, 420, 60, 11)}`)
  }
  const inner = el('div', 'end-inner')
  const main = el('div', 'end-main')
  const icon = el('div', 'end-icon')
  icon.innerHTML = champ ? TROPHY(120, T.trophyLabel) : BALL_ICON
  const title = el('h1', 'end-title', champ ? T.champion : T.eliminated(T.roundNames[currentRound(t)]))
  const team = el('div', 'end-team')
  team.append(teamTile(t.setup.team.name, 'user'), el('span', 'end-team-name', t.setup.team.name))
  const words = el('p', 'end-words', T.tournamentOver)
  const home = el('button', 'btn-yellow btn-big end-home', T.backToTitle)
  home.append(kbd('ENTER'))
  home.onclick = toTitle

  const record = el('section', 'end-record')
  record.setAttribute('aria-label', T.historyTitle)
  record.append(el('h2', 'panel-title desk-only', T.thisRun))
  for (const r of recordRows(t)) {
    const row = el('div', 'end-row')
    row.append(
      el('span', 'end-round', r.round),
      el('span', `record-mark ${r.won ? 'won' : 'lost'}`, r.won ? T.winMark : T.loseMark),
      el('span', 'end-score', r.score),
      el('span', 'end-opponent', r.opponent),
    )
    record.append(row)
  }
  main.append(icon, title, team, words, home)
  inner.append(main, record)
  screen.append(inner)
  root.replaceChildren(screen)
  setKeys({ Enter: toTitle })
}

/** 選秀：三張候選卡並排，選一張後列出可以替換的同角色球員 */
function showDraft(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  let chosen: number | null = null
  let firstRender = true

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'draft-screen')
    const header = el('header', 'draft-header')
    const top = el('div', 'draft-header-row')
    top.append(backButton(toTitle), el('h1', 'draft-title', T.draftTitle))
    const keyHints = el('span', 'draft-keys desk-only')
    keyHints.append(kbd('←'), kbd('→'), T.pickCard, kbd('ENTER'), T.confirmKey)
    header.append(top, el('p', 'draft-hint', T.draftHint), keyHints)
    screen.append(header)

    const cards = el('section', 'draft-cards')
    cards.setAttribute('aria-label', T.draftCandidates)
    t.draftOptions.forEach((p, i) => {
      const card = el('button', 'draft-pick')
      card.type = 'button'
      card.setAttribute('aria-pressed', String(chosen === i))
      applyCardState(card, p, { selected: chosen === i, reveal: firstRender })
      card.style.setProperty('--delay', `${i * 120}ms`)
      const inner = el('span', 'draft-inner')
      const topRow = el('span', 'draft-top')
      topRow.append(el('span', 'tier-tag', T.tierNames[cardTier(p)]), overallBadge(p, 'md'))
      inner.append(topRow, avatar(p.id, 'user', 'draft-avatar'), el('span', 'draft-name', p.name))
      inner.append(el('span', 'draft-role', p.role === 'pitcher' ? T.pitcher : T.batter))
      const stats = el('span', 'draft-stats')
      Object.entries(p.ratings).forEach(([k, v]) => {
        const row = el('span', 'draft-stat')
        const bar = el('span', 'draft-bar')
        const g = gradeOf(v)
        const fill = el('span', `bar-fill fill-${g}`)
        fill.style.width = `${v * 10}%`
        bar.append(fill)
        // 手機版：短標籤、長條、字母；電腦版：完整標籤、等級徽章、長條
        const key = k as keyof typeof RATING_FULL
        row.append(
          el('span', 'draft-stat-label mobile-only', RATING_LABELS[key]),
          el('span', 'draft-stat-label desk-only', RATING_FULL[key]),
          gradeBadge(v, 'sm'),
          bar,
          el('span', 'draft-stat-grade', g),
        )
        stats.append(row)
      })
      inner.append(stats)
      if (p.traits.length) inner.append(traitTag(p.traits[0]), el('span', 'draft-trait-desc', TRAIT_DESC[p.traits[0]]))
      card.append(inner)
      if (chosen === i) {
        const check = el('span', 'draft-check')
        check.innerHTML = CHECK_ICON
        card.append(check)
      }
      card.onclick = () => {
        chosen = chosen === i ? null : i
        render()
      }
      cards.append(card)
    })
    screen.append(cards)

    // 替換名單：只列同角色的球員
    const release = el('section', 'draft-release')
    const pick = chosen === null ? null : t.draftOptions[chosen]
    release.append(el('div', 'draft-release-head', pick ? T.replaceWho(pick.name, pick.role === 'pitcher' ? T.pitcher : T.batter) : T.pickFirst))
    const list = el('div', 'draft-release-list')
    if (pick) {
      const r = t.setup.team.roster
      const slots: [Slot, string][] =
        pick.role === 'pitcher'
          ? [
              [{ kind: 'starter' }, T.starter],
              ...r.relievers.map((_, i): [Slot, string] => [{ kind: 'reliever', index: i }, T.reliever]),
            ]
          : [
              ...r.lineup.map((s, i): [Slot, string] => [{ kind: 'lineup', index: i }, `${POSITION_FULL[s.position]}・${T.orderNth(i + 1)}`]),
              ...r.bench.map((_, i): [Slot, string] => [{ kind: 'bench', index: i }, T.bench]),
            ]
      for (const [slot, label] of slots) {
        const p = getSlot(r, slot)
        const row = el('div', 'release-row')
        const who = el('span', 'release-who')
        who.append(el('span', 'release-name', p.name), el('span', 'release-pos', label))
        const grades = el('span', 'release-grades')
        for (const v of Object.values(p.ratings)) grades.append(gradeBadge(v, 'sm'))
        const swap = el('button', 'btn-small', T.replace)
        swap.onclick = () => {
          toast(T.drafted(pick.name, p.name))
          go(draftPick(t, chosen!, slot))
        }
        row.append(avatar(p.id, 'user', 'ring'), who, grades, swap)
        list.append(row)
      }
    }
    release.append(list)

    const footer = el('footer', 'draft-footer')
    const skip = el('button', 'btn-outline-light btn-wide', T.skipDraft)
    skip.append(kbd('ESC'))
    skip.onclick = () => {
      toast(T.draftSkipped)
      go(skipDraft(t))
    }
    footer.append(skip)
    const side = el('div', 'draft-side')
    side.append(release, footer)
    screen.append(side)
    root.append(screen)
    if (firstRender) void maybeTutorial('draft', TUTORIAL_STEPS.draft)
    firstRender = false

    // ← → 選卡；Enter 先跳到替換名單，在名單上再按 Enter 就換掉那一位
    const n = t.draftOptions.length
    const move = (d: number) => {
      chosen = chosen === null ? (d > 0 ? 0 : n - 1) : (chosen + d + n) % n
      render()
    }
    const keys: KeyMap = {
      ArrowLeft: () => move(-1),
      ArrowRight: () => move(1),
      Escape: () => skip.click(),
      Enter: () => {
        const active = document.activeElement
        if (active instanceof HTMLButtonElement && list.contains(active)) active.click()
        else list.querySelector('button')?.focus()
      },
    }
    setKeys(keys)
  }

  render()
}
