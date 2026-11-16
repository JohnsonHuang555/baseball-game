// 球團首頁：球團資訊、自動比賽進度（倒數）、未領取收益、最近比賽
import { el } from '../../ui/playerCard'
import type { DueMatches } from '../application/idleEngine'
import type { SettledMatch } from '../domain/club'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'

export interface DashboardActions {
  claim: () => void
  refresh: () => void
  openReport: (m: SettledMatch) => void
  allReports: () => void
}

const RECENT_ON_HOME = 8
const fmt = (x: number) => x.toLocaleString('zh-Hant')

export function renderDashboard(state: ControllerState, controller: ClubController, actions: DashboardActions): HTMLElement {
  const club = state.club!
  const page = el('div', 'v2-page v2-dashboard')

  // A. 球團資訊
  const info = el('section', 'v2-card v2-club')
  const { wins, losses } = club.record
  const games = wins + losses
  const stats = el('div', 'v2-stats')
  stats.append(
    stat(V2T.wins, fmt(wins)),
    stat(V2T.losses, fmt(losses)),
    stat(V2T.winRate, games ? (wins / games).toFixed(3).replace(/^0/, '') : '---'),
    stat(V2T.funds, fmt(club.economy.assets.funds), 'funds'),
    stat(V2T.experience, fmt(club.economy.assets.experience), 'exp'),
  )
  info.append(stats)

  // B. 自動比賽進度
  const progress = el('section', 'v2-card v2-progress')
  progress.setAttribute('aria-live', 'polite')
  const board = el('div', 'v2-scoreboard')
  const countdown = el('span', 'v2-countdown')
  countdown.dataset.countdown = ''
  const boardLabel = el('span', 'v2-board-label', V2T.nextMatchIn)
  boardLabel.dataset.boardLabel = ''
  board.append(boardLabel, countdown)
  const meta = el('div', 'v2-progress-meta')
  const played = el('span', '', `${V2T.matchesPlayed} ${fmt(club.idle.nextMatchIndex)}`)
  const due = el('span', '')
  due.dataset.due = ''
  meta.append(played, due)
  const refresh = el('button', 'btn-white v2-refresh', state.settling ? V2T.settling : V2T.refresh)
  refresh.type = 'button'
  refresh.disabled = state.settling || !state.canWrite
  refresh.onclick = actions.refresh
  progress.append(el('h2', 'v2-card-title', V2T.progressTitle), board, meta, el('p', 'v2-hint', V2T.offlineCap), refresh)

  // C. 未領取收益
  const rewards = el('section', 'v2-card v2-rewards')
  const { funds, experience } = club.economy.unclaimed
  const amounts = el('div', 'v2-reward-amounts')
  amounts.append(rewardItem(V2T.funds, funds, 'funds'), rewardItem(V2T.experience, experience, 'exp'))
  const claim = el('button', 'btn-yellow btn-big v2-claim', state.claiming ? V2T.claiming : V2T.claimButton)
  claim.type = 'button'
  claim.disabled = state.claiming || !state.canWrite || (funds === 0 && experience === 0)
  claim.onclick = () => {
    claim.disabled = true
    actions.claim()
  }
  rewards.append(el('h2', 'v2-card-title', V2T.rewardsTitle), amounts, claim)

  // D. 最近比賽
  const recent = el('section', 'v2-card v2-recent')
  const head = el('div', 'v2-card-head')
  head.append(el('h2', 'v2-card-title', V2T.recentTitle))
  if (club.recentMatches.length > RECENT_ON_HOME) {
    const all = el('button', 'v2-link', V2T.seeAll)
    all.type = 'button'
    all.onclick = actions.allReports
    head.append(all)
  }
  recent.append(head)
  const list = club.recentMatches.slice(-RECENT_ON_HOME).reverse()
  if (!list.length) recent.append(el('p', 'v2-empty', V2T.noMatches))
  else recent.append(matchList(list, actions.openReport))

  page.append(info, progress, rewards, recent)
  updateCountdown(page, controller.due(), state)
  return page
}

/** 每秒更新倒數與「可結算」場數：只改文字，不重畫整個畫面 */
export function updateCountdown(scope: HTMLElement, due: DueMatches | null, state: ControllerState): void {
  const countdown = scope.querySelector<HTMLElement>('[data-countdown]')
  const label = scope.querySelector<HTMLElement>('[data-board-label]')
  const dueEl = scope.querySelector<HTMLElement>('[data-due]')
  if (!countdown || !due) return
  if (state.settling || due.matches > 0) {
    if (label) label.textContent = state.settling ? V2T.settling : V2T.readyToSettle
    countdown.textContent = '0:00'
  } else {
    if (label) label.textContent = V2T.nextMatchIn
    const secs = Math.ceil(due.nextMatchInMs / 1000)
    countdown.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  }
  if (dueEl) dueEl.textContent = `${V2T.dueNow} ${fmt(due.matches)}`
}

/** 比賽列表：勝敗、比分、對手、局數、獲得資源，點了看戰報 */
export function matchList(matches: readonly SettledMatch[], open: (m: SettledMatch) => void): HTMLElement {
  const list = el('ul', 'v2-match-list')
  for (const m of matches) {
    const r = m.result
    const li = el('li')
    const b = el('button', `v2-match ${r.won ? 'won' : 'lost'}`)
    b.type = 'button'
    b.setAttribute('aria-label', `${V2T.matchNo(m.matchIndex + 1)} ${r.won ? V2T.win : V2T.loss} ${r.runsFor} 比 ${r.runsAgainst} ${V2T.vs(r.opponentName)}`)
    const badge = el('span', 'v2-result-badge', r.won ? V2T.win : V2T.loss)
    const body = el('span', 'v2-match-body')
    body.append(el('span', 'v2-match-opp', V2T.vs(r.opponentName)), el('span', 'v2-match-sub', `${V2T.matchNo(m.matchIndex + 1)}・${V2T.innings(r.innings)}`))
    const right = el('span', 'v2-match-right')
    right.append(el('span', 'v2-match-score', `${r.runsFor} : ${r.runsAgainst}`), el('span', 'v2-match-earned', V2T.earned(m.earnedFunds, m.earnedExperience)))
    b.append(badge, body, right)
    b.onclick = () => open(m)
    li.append(b)
    list.append(li)
  }
  return list
}

function stat(label: string, value: string, kind = ''): HTMLElement {
  const box = el('div', `v2-stat ${kind}`)
  box.append(el('span', 'v2-stat-value', value), el('span', 'v2-stat-label', label))
  return box
}

function rewardItem(label: string, value: number, kind: string): HTMLElement {
  const box = el('div', `v2-reward ${kind}`)
  box.append(el('span', 'v2-reward-value', `+${fmt(value)}`), el('span', 'v2-reward-label', label))
  return box
}
