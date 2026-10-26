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
import { el, traitTag } from './playerCard'
import { applyCardState, toast } from './visual'
import { clearTournament, saveTournament } from './save'
import { showRosterEditor } from './setupScreen'
import { POSITION_FULL, RATING_LABELS, T, TRAIT_DESC } from './strings'

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

/** 錦標賽主畫面：戰績、賽程樹、下一個對手（或奪冠／淘汰） */
function showHub(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'hub-screen')
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

  // 底部：下一個對手，或錦標賽結束
  const bottom = el('section', 'hub-bottom')
  if (t.phase === 'champion' || t.phase === 'eliminated') {
    const champ = t.phase === 'champion'
    bottom.append(ribbon(champ ? T.champion : T.eliminated(T.roundNames[round]), champ ? 'yellow' : 'lilac'))
    bottom.append(el('p', 'hub-ended', T.tournamentOver))
    const home = el('button', 'btn-yellow btn-big', T.backToTitle)
    home.onclick = toTitle
    bottom.append(home)
  } else {
    bottom.setAttribute('aria-label', T.nextOpponent)
    bottom.append(ribbon(`${round === 'final' ? gameSubtitle(t) : T.roundNames[round]}・${T.nextOpponent}`, 'yellow'))
    const vs = el('div', 'hub-vs')
    const side = (name: string, avg: number, team: 'user' | 'opponent') => {
      const box = el('div', `hub-side ${team}`)
      const words = el('span', 'hub-side-words')
      words.append(el('span', 'hub-side-name', name), gradeBadge(avg, 'sm'))
      box.append(teamTile(name, team), words)
      return box
    }
    vs.append(
      side(t.setup.team.name, teamAverage(t.setup.team.roster), 'user'),
      el('span', 'hub-vs-mark', T.versus),
      side(t.opponent.name, teamAverage(t.opponent.roster), 'opponent'),
    )
    const next = el('button', 'btn-yellow btn-big', T.nextGame)
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
}

/** 賽程樹：四欄、每場一個小方框，用線連起來；自己的晉級路線用藍線 */
function bracketPanel(t: Tournament): HTMLElement {
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

  // 每一輪的對戰依賽程位置排好，連線才接得起來
  const rounds = bracket(t).map((matches, r) =>
    matches
      .map((m) => (m.a < m.b ? m : { a: m.b, b: m.a, winner: m.winner }))
      .sort((x, y) => Math.floor(x.a / 2 ** (r + 1)) - Math.floor(y.a / 2 ** (r + 1))),
  )
  const userScore = (r: number) => {
    const games = t.history.filter((g) => g.round === ROUNDS[r])
    if (!games.length) return null
    if (ROUNDS[r] === 'final') return { user: games.filter((g) => g.won).length, opp: games.filter((g) => !g.won).length }
    return { user: games[0].userRuns, opp: games[0].opponentRuns }
  }

  let lines = ''
  let myLine = ''
  for (let r = 0; r < 4; r++) {
    centers[r].forEach((cy, i) => {
      const box = el('div', 'bracket-box')
      box.style.left = `${colX[r]}px`
      box.style.top = `${cy - H / 2}px`
      box.style.width = `${W}px`
      box.style.height = `${H}px`
      // 還沒打到的輪次不劇透 AI 之間的結果
      const m = r <= t.roundIndex ? rounds[r][i] : undefined
      if (!m) {
        box.classList.add('tbd')
        box.append(el('div', 'bracket-row tbd', T.pending), el('div', 'bracket-row tbd', T.pending))
      } else {
        const mine = m.a === 0 || m.b === 0
        if (mine && r === t.roundIndex && m.winner === null && t.phase !== 'eliminated') box.classList.add('next')
        const score = mine ? userScore(r) : null
        for (const team of [m.a, m.b]) {
          const state = team === 0 ? 'me' : m.winner === null ? '' : m.winner === team ? 'win' : 'lose'
          const row = el('div', `bracket-row ${state} ${m.winner === team ? 'winner' : ''}`)
          row.append(el('span', 'bracket-name', t.teamNames[team]))
          if (score) row.append(el('span', 'bracket-score', String(team === 0 ? score.user : score.opp)))
          box.append(row)
        }
      }
      tree.append(box)
    })
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
    header.append(top, el('p', 'draft-hint', T.draftHint))
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
        row.append(el('span', 'draft-stat-label', RATING_LABELS[k as keyof typeof RATING_LABELS]), bar, el('span', 'draft-stat-grade', g))
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
    screen.append(release)

    const footer = el('footer', 'draft-footer')
    const skip = el('button', 'btn-outline-light btn-wide', T.skipDraft)
    skip.onclick = () => {
      toast(T.draftSkipped)
      go(skipDraft(t))
    }
    footer.append(skip)
    screen.append(footer)
    root.append(screen)
    firstRender = false
  }

  render()
}
