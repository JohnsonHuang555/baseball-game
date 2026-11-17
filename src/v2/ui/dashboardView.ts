// 球團首頁：目前比賽（直播入口）、球團資訊、聯盟與晉級、自動比賽進度（倒數）、未領取收益、最近比賽
import { el } from '../../ui/playerCard'
import type { Side } from '../../sim/game'
import { basesSvg } from '../../ui/gameScreen'
import { T, runnersText } from '../../ui/strings'
import type { LiveMatchInfo } from '../application/liveMatch'
import type { ReplayState } from '../application/replayPlayer'
import type { DueMatches } from '../application/idleEngine'
import { overall } from '../../sim/generate'
import { gradeBadge } from '../../ui/grades'
import { canAfford } from '../application/economyService'
import type { ClubSave, SettledMatch } from '../domain/club'
import { eligibility, leagueOf } from '../domain/league'
import { upgradeCost } from '../domain/progression'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCost, rosterFull } from '../domain/recruitment'
import { assignedIds, resolveRoster } from '../domain/roster'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'

export interface DashboardActions {
  claim: () => void
  refresh: () => void
  openReport: (m: SettledMatch) => void
  allReports: () => void
  /** 觀看進行中的比賽 */
  watchLive?: () => void
  /** 目前比賽卡片的資料（每秒由 updateCountdown 更新） */
  liveCard?: () => LiveCard | null
  recruit: () => void
  lineup: () => void
  /** 觀看最近一次晉級挑戰賽；沒有保留就是 null（不顯示） */
  watchChallenge?: (() => void) | null
  /** 帶上按鈕顯示時的聯盟與挑戰序號（不是送出當下重新讀到的值） */
  challenge: (expected: { fromTier: number; challengeSeq: number }) => void
}

/** 上場 14 人（先發、板凳、投手）的平均能力，含養成 */
export function teamPower(club: ClubSave): number {
  const r = resolveRoster(club)
  const players = [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers]
  return players.reduce((sum, p) => sum + overall(p), 0) / players.length
}

/** 上場球員裡，現在的資產就付得起下一級的人數 */
export function upgradeableCount(club: ClubSave): number {
  const active = assignedIds(club.roster)
  return club.players.filter((r) => active.has(r.player.id)).filter((r) => {
    const cost = upgradeCost(r.level)
    return cost !== null && canAfford(club, cost)
  }).length
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

  const league = leagueCard(state, actions)

  // 球隊戰力、養成與招募的提示
  const growth = el('section', 'v2-card v2-growth')
  const power = teamPower(club)
  const powerBox = el('div', 'v2-power')
  powerBox.append(el('span', 'v2-power-label', V2T.teamPower), gradeBadge(power, 'md'), el('span', 'v2-power-value', power.toFixed(2)))
  const upgradeable = upgradeableCount(club)
  const lineupBtn = el('button', upgradeable ? 'btn-yellow v2-growth-btn' : 'btn-white v2-growth-btn', upgradeable ? V2T.upgradeReady(upgradeable) : V2T.upgradeNone)
  lineupBtn.type = 'button'
  lineupBtn.dataset.action = 'lineup'
  lineupBtn.onclick = actions.lineup
  const cost = recruitCost(club.recruitment.count)
  const full = rosterFull(club)
  const recruitBtn = el('button', 'btn-white v2-growth-btn', full ? V2T.rosterFull : `${V2T.recruitEntry}・${V2T.recruitCost(cost.funds)}`)
  recruitBtn.type = 'button'
  recruitBtn.dataset.action = 'recruit'
  if (!full && club.economy.assets.funds < cost.funds) recruitBtn.append(el('span', 'v2-short', `（${V2T.notEnoughFunds}）`))
  recruitBtn.onclick = actions.recruit
  growth.append(powerBox, el('p', 'v2-hint', `${V2T.teamPowerHint}・${V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers)}`), lineupBtn, recruitBtn)

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
  progress.append(el('h2', 'v2-card-title', V2T.progressTitle), board, meta, el('p', 'v2-hint', V2T.offlineCap))
  // 沒有 Web Locks：照實說明限制，不宣稱跨分頁安全
  if (!state.crossTab) progress.append(el('p', 'v2-hint v2-limit', V2T.exclusiveLimit))
  progress.append(refresh)

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

  // 目前比賽（直播）：每秒由 updateCountdown 更新內容
  const live = el('section', 'v2-card v2-live-card')
  live.dataset.liveCard = ''
  const liveHead = el('div', 'v2-card-head')
  const liveBadge = el('span', 'v2-live-badge live', V2T.liveBadge)
  liveBadge.dataset.liveBadge = ''
  liveHead.append(el('h2', 'v2-card-title', V2T.liveCardTitle), liveBadge)
  const liveBody = el('div', 'v2-live-body')
  liveBody.dataset.liveBody = ''
  const watch = el('button', 'btn-yellow btn-big v2-live-watch', V2T.liveWatch)
  watch.type = 'button'
  watch.dataset.action = 'watch-live'
  watch.onclick = () => actions.watchLive?.()
  live.append(liveHead, liveBody, watch)

  page.append(live, info, league, growth, progress, rewards, recent)
  updateCountdown(page, controller.due(), state, actions.liveCard?.() ?? null)
  return page
}

/** 聯盟卡片：名稱、徽章、本聯盟戰績、最近勝率、晉級進度，以及「挑戰下一聯盟」或還差哪些條件 */
export function leagueCard(state: ControllerState, actions: Pick<DashboardActions, 'challenge' | 'watchChallenge'>): HTMLElement {
  const club = state.club!
  const { league } = club
  const def = leagueOf(league.tier)
  const e = eligibility(league, club.idle.nextMatchIndex)
  const card = el('section', 'v2-card v2-league')
  card.dataset.tier = String(league.tier)
  const head = el('div', 'v2-league-head')
  const badge = el('span', 'v2-league-badge', String(league.tier + 1))
  badge.style.background = def.color
  badge.setAttribute('aria-hidden', 'true')
  const names = el('div', 'v2-league-names')
  names.append(el('strong', 'v2-league-name', def.name), el('span', 'v2-league-sub', e.atMaxTier ? V2T.leagueTop : V2T.leagueNext(leagueOf(league.tier + 1).name)))
  head.append(badge, names)
  const lines = el('div', 'v2-league-lines')
  lines.append(
    el('span', '', V2T.leagueRecord(league.wins, league.losses)),
    el('span', '', league.recent.length ? V2T.leagueRecent(e.winRate.have, league.recent.length) : V2T.leagueRecent(0, 0)),
    el('span', 'v2-hint', V2T.leagueHint(def.rewardMultiplier)),
  )
  card.append(head, lines)
  if (actions.watchChallenge) {
    const watch = el('button', 'v2-link v2-watch-challenge', V2T.watchLastChallenge)
    watch.type = 'button'
    watch.dataset.action = 'watch-last-challenge'
    watch.onclick = actions.watchChallenge
    card.append(watch)
  }
  if (e.atMaxTier) return card

  // 進度條：場數與勝率兩個條件裡，比較落後的那個
  const matchRatio = Math.min(1, e.matches.have / e.matches.need)
  const rateRatio = e.winRate.games < e.winRate.window ? Math.min(matchRatio, e.winRate.have / e.winRate.need) : Math.min(1, e.winRate.have / e.winRate.need)
  const ratio = e.ok ? 1 : Math.min(matchRatio, rateRatio)
  const bar = el('div', 'v2-league-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  const fill = el('span', 'v2-league-fill')
  fill.style.width = `${Math.round(ratio * 100)}%`
  fill.style.background = def.color
  bar.append(fill)
  card.append(bar)

  if (e.ok) {
    const btn = el('button', 'btn-yellow btn-big v2-challenge', state.challenging ? V2T.challenging : V2T.challengeButton)
    btn.type = 'button'
    btn.dataset.action = 'challenge'
    // 記住畫面顯示時的聯盟與挑戰序號：畫面過期（別的分頁已經晉級）時，服務會拒絕，不會挑戰到另一個聯盟
    const expected = { fromTier: league.tier, challengeSeq: league.nextChallengeSeq }
    btn.dataset.tier = String(expected.fromTier)
    btn.dataset.seq = String(expected.challengeSeq)
    btn.disabled = state.challenging || !state.canWrite
    btn.onclick = () => {
      btn.disabled = true
      actions.challenge(expected)
    }
    card.append(btn)
  } else {
    const need = el('ul', 'v2-league-need')
    const item = (ok: boolean, text: string) => {
      const li = el('li', ok ? 'done' : '', `${ok ? '✓' : '・'} ${text}`)
      need.append(li)
    }
    item(e.matches.have >= e.matches.need, V2T.leagueMatchesNeed(e.matches.have, e.matches.need))
    item(e.winRate.games >= e.winRate.window && e.winRate.have >= e.winRate.need, V2T.leagueRateNeed(e.winRate.need, e.winRate.window))
    if (e.retryRemaining > 0) item(false, V2T.leagueRetry(e.retryRemaining))
    card.append(need)
  }
  return card
}

/** 每秒更新倒數與「可結算」場數：只改文字，不重畫整個畫面 */
/** 目前比賽卡片需要的資料（application/liveMatch.ts 推算） */
export interface LiveCard {
  info: LiveMatchInfo
  state: ReplayState
  userSide: Side
  teamNames: Record<Side, string>
  now: number
}

/** 目前比賽卡片：我方、對手、比分、局數、出局、壘上、剩餘時間；跟直播畫面用同一份時間軸 */
export function renderLiveCard(card: HTMLElement, live: LiveCard | null): void {
  const body = card.querySelector<HTMLElement>('[data-live-body]')
  const badge = card.querySelector<HTMLElement>('[data-live-badge]')
  if (!body) return
  if (!live) {
    body.replaceChildren(el('p', 'v2-empty', V2T.liveNone))
    return
  }
  const { state: s, info, userSide, teamNames, now } = live
  const other: Side = userSide === 'home' ? 'away' : 'home'
  const upcoming = now < info.startsAt
  if (badge) {
    badge.textContent = upcoming ? V2T.liveUpcoming : V2T.liveBadge
    badge.className = `v2-live-badge ${upcoming ? 'waiting' : 'live'}`
  }
  const teams = el('div', 'v2-live-teams')
  const team = (side: Side) => {
    const row = el('div', `v2-live-team ${side === userSide ? 'ours' : ''}`)
    const sc = el('span', 'v2-live-score', String(s.score[side]))
    sc.dataset.liveScore = side === userSide ? 'us' : 'them'
    row.append(el('span', 'v2-live-name', teamNames[side]), sc)
    return row
  }
  teams.append(team(userSide), team(other))
  const meta = el('div', 'v2-live-meta')
  const inning = el('span', 'v2-live-inning', upcoming ? V2T.matchNo(info.matchIndex + 1) : `${s.inning} ${s.half === 'top' ? T.halfTop : T.halfBottom}`)
  inning.dataset.liveInning = `${s.inning}${s.half}`
  const outs = el('span', 'v2-live-outs', V2T.liveOuts(s.outs))
  outs.dataset.liveOuts = String(s.outs)
  const bases = el('span', 'v2-live-bases')
  bases.innerHTML = basesSvg(s.bases.map(Boolean))
  bases.setAttribute('role', 'img')
  bases.setAttribute('aria-label', runnersText(s.bases.map(Boolean)))
  const left = Math.max(0, upcoming ? info.startsAt - now : info.endsAt - now)
  const secs = Math.ceil(left / 1000)
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const remain = el('span', 'v2-live-remain', upcoming ? V2T.liveStartsIn(clock) : V2T.liveRemaining(clock))
  remain.dataset.liveRemain = String(secs)
  meta.append(inning, outs, bases, remain)
  body.replaceChildren(teams, meta)
}

export function updateCountdown(scope: HTMLElement, due: DueMatches | null, state: ControllerState, live: LiveCard | null = null): void {
  const card = scope.querySelector<HTMLElement>('[data-live-card]')
  if (card) renderLiveCard(card, live)
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
