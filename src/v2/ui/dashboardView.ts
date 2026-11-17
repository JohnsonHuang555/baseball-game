// 球團首頁（Phase 6A 重新整理）：讓玩家一眼回答「球隊在做什麼、我現在能做什麼、下一個目標是什麼」。
// 由上到下：目前比賽（直播入口）→ 目前建議（同一時間只有一個）→ 新手任務（未完成時）→ 球隊與養成 → 聯盟進度 → 未領取收益 → 最近比賽。
// 只有「目前比賽」和「目前建議」有醒目的主按鈕，其他區塊用較輕的樣式，不讓每張卡片搶一樣的注意力
import { el } from '../../ui/playerCard'
import type { Side } from '../../sim/game'
import { basesSvg } from '../../ui/gameScreen'
import { T, runnersText } from '../../ui/strings'
import type { LiveMatchInfo } from '../application/liveMatch'
import type { ReplayState } from '../application/replayPlayer'
import type { DueMatches } from '../application/idleEngine'
import { gradeBadge } from '../../ui/grades'
import { canAfford } from '../application/economyService'
import { nearestUpgrade, suggestNextAction, type Suggestion, type SuggestionKind } from '../application/guidance'
import type { ClubSave, SettledMatch } from '../domain/club'
import { eligibility, leagueOf } from '../domain/league'
import { onboardingProgress, type OnboardingTaskId } from '../domain/onboarding'
import { upgradeCost } from '../domain/progression'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCost, rosterFull } from '../domain/recruitment'
import { assignedIds } from '../domain/roster'
import { recentForm, teamPower } from '../domain/growthInfo'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'

export interface DashboardActions {
  claim: () => void
  openReport: (m: SettledMatch) => void
  allReports: () => void
  /** 觀看進行中的比賽 */
  watchLive?: () => void
  /** 目前比賽卡片的資料（每秒由 updateCountdown 更新） */
  liveCard?: () => LiveCard | null
  recruit: () => void
  lineup: () => void
  /** 打開某位球員的養成畫面（「目前建議」培養球員用） */
  openPlayer?: (playerId: string) => void
  /** 收合／展開新手任務 */
  toggleOnboarding?: (collapsed: boolean) => void
  /** 觀看最近一次晉級挑戰賽；沒有保留就是 null（不顯示） */
  watchChallenge?: (() => void) | null
  /** 帶上按鈕顯示時的聯盟與挑戰序號（不是送出當下重新讀到的值） */
  challenge: (expected: { fromTier: number; challengeSeq: number }) => void
}

export { teamPower }

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
  const suggestion = suggestNextAction(club, { canWrite: state.canWrite })

  const live = liveSection(club, state, actions)
  const next = nextSection(suggestion, state, actions)
  const onboard = onboardingSection(club, state, actions, suggestion.kind)
  const team = teamSection(club, actions)
  const league = leagueCard(state, actions)
  const rewards = rewardsSection(club, state, actions)
  const recent = recentSection(club, actions)

  page.append(live, next)
  if (onboard) page.append(onboard)
  page.append(team, league, rewards, recent)
  updateCountdown(page, controller.due(), state, actions.liveCard?.() ?? null)
  return page
}

/** 目前比賽（直播）：每秒由 updateCountdown 更新比分、局數、剩餘時間；底下一行說明比賽是自動進行的 */
function liveSection(club: ClubSave, state: ControllerState, actions: DashboardActions): HTMLElement {
  const live = el('section', 'v2-card v2-live-card')
  live.dataset.liveCard = ''
  live.setAttribute('aria-live', 'polite')
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
  const foot = el('div', 'v2-live-foot')
  const played = el('span', 'v2-live-played', V2T.livePlayed(club.idle.nextMatchIndex))
  const due = el('span', 'v2-live-due')
  due.dataset.due = ''
  foot.append(el('span', 'v2-live-how', V2T.liveFoot), played, due)
  live.append(liveHead, liveBody, watch, foot)
  // 沒有 Web Locks：照實說明限制，不宣稱跨分頁安全
  if (!state.crossTab) live.append(el('p', 'v2-hint v2-limit', V2T.exclusiveLimit))
  return live
}

/** 目前建議：規則見 application/guidance.ts；按鈕只帶玩家過去，需要資源或確認的操作仍在原本的畫面確認 */
function nextSection(s: Suggestion, state: ControllerState, actions: DashboardActions): HTMLElement {
  const box = el('section', `v2-card v2-next ${s.kind === 'watch' ? 'calm' : 'act'}`)
  box.dataset.suggestion = s.kind
  const text = el('div', 'v2-next-text')
  text.append(el('span', 'v2-next-label', V2T.nextTitle))
  // 沒有其他事時建議觀戰：「目前比賽」的大按鈕就在正上方，這裡只放較輕的連結，不搶主按鈕
  const button = el('button', s.kind === 'watch' ? 'v2-link v2-next-link' : 'btn-yellow v2-next-btn')
  button.type = 'button'
  button.dataset.action = `next-${s.kind}`
  const add = (title: string, why: string, label: string, run: () => void) => {
    text.append(el('strong', 'v2-next-title', title), el('span', 'v2-next-why', why))
    button.textContent = label
    button.onclick = run
  }
  switch (s.kind) {
    case 'claim':
      add(V2T.nextClaimTitle, V2T.nextClaimWhy(s.unclaimed.funds, s.unclaimed.experience), state.claiming ? V2T.claiming : V2T.nextClaimButton, () => {
        button.disabled = true
        actions.claim()
      })
      button.disabled = state.claiming
      break
    case 'challenge':
      add(V2T.nextChallengeTitle(s.toLeague), V2T.nextChallengeWhy, V2T.nextChallengeButton, () => focusChallenge(box))
      button.disabled = state.challenging
      break
    case 'upgrade':
      add(V2T.nextUpgradeTitle(s.name, s.level), V2T.nextUpgradeWhy(s.cost.funds, s.cost.experience), V2T.nextUpgradeButton, () => actions.openPlayer?.(s.playerId))
      break
    case 'lineup':
      add(V2T.nextLineupTitle(s.name), V2T.nextLineupWhy(s.name, s.replaceName), V2T.nextLineupButton, actions.lineup)
      break
    case 'watch':
      add(V2T.nextWatchTitle, V2T.nextWatchWhy, V2T.nextWatchButton, () => actions.watchLive?.())
      if (s.goal) text.append(el('span', 'v2-next-goal', V2T.nextWatchGoal(s.goal.name, s.goal.short.experience, s.goal.short.funds)))
      break
  }
  box.append(text, button)
  return box
}

/** 「前往聯盟挑戰」：捲到聯盟卡片、把焦點放在挑戰按鈕上（挑戰仍要玩家自己按） */
function focusChallenge(from: HTMLElement): void {
  const btn = from.closest('.v2-dashboard')?.querySelector<HTMLButtonElement>('[data-action="challenge"]')
  if (!btn) return
  btn.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
  btn.focus({ preventScroll: true })
  btn.closest('.v2-league')?.classList.add('v2-pulse')
}

/** 新手任務會對應到哪一種建議：任務與建議相同時，任務不另外放按鈕（避免兩個地方叫玩家做同一件事） */
const TASK_SUGGESTION: Partial<Record<OnboardingTaskId, SuggestionKind>> = { watch: 'watch', claim: 'claim', upgrade: 'upgrade', lineup: 'lineup' }

/** 新手任務：不限順序、完成自動打勾、可以收起；全部完成後只剩一行，收起後就不再佔首頁 */
function onboardingSection(club: ClubSave, state: ControllerState, actions: DashboardActions, suggested: SuggestionKind): HTMLElement | null {
  const p = onboardingProgress(club)
  if (p.allDone && p.collapsed) return null
  const box = el('section', `v2-card v2-onboard ${p.collapsed ? 'collapsed' : ''} ${p.allDone ? 'all-done' : ''}`)
  box.dataset.onboarding = `${p.done}/${p.total}`
  const head = el('div', 'v2-card-head')
  const title = el('h2', 'v2-card-title', V2T.onboardTitle)
  title.append(el('span', 'v2-onboard-count', V2T.onboardCount(p.done, p.total)))
  const toggle = el('button', 'v2-link v2-onboard-toggle', p.collapsed ? V2T.onboardExpand : V2T.onboardCollapse)
  toggle.type = 'button'
  toggle.dataset.action = 'toggle-onboarding'
  toggle.setAttribute('aria-expanded', String(!p.collapsed))
  toggle.disabled = !state.canWrite
  toggle.onclick = () => {
    toggle.disabled = true
    actions.toggleOnboarding?.(!p.collapsed)
  }
  head.append(title, toggle)
  const bar = el('div', 'v2-onboard-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', String(p.total))
  bar.setAttribute('aria-valuenow', String(p.done))
  const fill = el('span', 'v2-onboard-fill')
  fill.style.width = `${Math.round((p.done / p.total) * 100)}%`
  bar.append(fill)
  box.append(head, bar)
  if (p.collapsed) return box
  if (p.allDone) {
    box.append(el('p', 'v2-onboard-done', V2T.onboardAllDone))
    return box
  }

  const list = el('ol', 'v2-onboard-list')
  const unclaimed = club.economy.unclaimed
  const goal = nearestUpgrade(club)
  for (const t of p.tasks) {
    const copy = V2T.onboardTasks[t.id]
    const li = el('li', `v2-task ${t.done ? 'done' : ''}`)
    li.dataset.task = t.id
    li.dataset.done = String(t.done)
    const mark = el('span', 'v2-task-mark', t.done ? '✓' : '')
    mark.setAttribute('aria-hidden', 'true')
    const body = el('div', 'v2-task-body')
    body.append(el('span', 'v2-task-title', copy.title))
    li.setAttribute('aria-label', `${copy.title}${t.done ? '（已完成）' : ''}`)
    if (!t.done) {
      let hint: string = copy.hint
      if (t.id === 'claim' && unclaimed.funds === 0 && unclaimed.experience === 0) hint = V2T.onboardClaimWait
      if (t.id === 'upgrade' && goal) hint = `${copy.hint}。${V2T.onboardUpgradeShort(goal.short.experience, goal.short.funds)}`
      if (hint) body.append(el('span', 'v2-task-hint', hint))
    }
    li.append(mark, body)
    if (!t.done) {
      const go = taskAction(t.id, club, state, actions, suggested)
      if (go) li.append(go)
    }
    list.append(li)
  }
  box.append(list)
  return box
}

function taskAction(id: OnboardingTaskId, club: ClubSave, state: ControllerState, actions: DashboardActions, suggested: SuggestionKind): HTMLElement | null {
  if (TASK_SUGGESTION[id] === suggested) return el('span', 'v2-task-tag', V2T.onboardSuggested)
  const make = (label: string, run: () => void, disabled = false) => {
    const b = el('button', 'btn-small v2-task-go', label)
    b.type = 'button'
    b.dataset.action = `task-${id}`
    b.disabled = disabled
    b.onclick = run
    return b
  }
  switch (id) {
    case 'watch':
      return make(V2T.onboardGo.watch, () => actions.watchLive?.())
    case 'claim': {
      const { funds, experience } = club.economy.unclaimed
      if (funds === 0 && experience === 0) return null
      return make(V2T.onboardGo.claim, actions.claim, state.claiming || !state.canWrite)
    }
    case 'upgrade':
      return make(V2T.onboardGo.upgrade, actions.lineup)
    case 'lineup':
      return make(V2T.onboardGo.lineup, actions.lineup)
    default:
      return null
  }
}

/** 球隊：戰績、可用資源、戰力，以及養成、招募的入口（升級不夠時說明還差多少） */
function teamSection(club: ClubSave, actions: DashboardActions): HTMLElement {
  const growth = el('section', 'v2-card v2-growth v2-club')
  const { wins, losses } = club.record
  const games = wins + losses
  const head = el('div', 'v2-card-head')
  head.append(el('h2', 'v2-card-title', V2T.teamTitle))
  const stats = el('div', 'v2-stats')
  stats.append(
    stat(V2T.wins, fmt(wins)),
    stat(V2T.losses, fmt(losses)),
    stat(V2T.winRate, games ? (wins / games).toFixed(3).replace(/^0/, '') : '---'),
    stat(V2T.funds, fmt(club.economy.assets.funds), 'funds'),
    stat(V2T.experience, fmt(club.economy.assets.experience), 'exp'),
  )
  const power = teamPower(club)
  const powerBox = el('div', 'v2-power')
  powerBox.append(el('span', 'v2-power-label', V2T.teamPower), gradeBadge(power, 'md'), el('span', 'v2-power-value', power.toFixed(2)))
  const upgradeable = upgradeableCount(club)
  const goal = upgradeable ? null : nearestUpgrade(club)
  const lineupBtn = el(
    'button',
    upgradeable ? 'btn-yellow v2-growth-btn' : 'btn-white v2-growth-btn',
    upgradeable ? V2T.upgradeReady(upgradeable) : goal ? V2T.upgradeShort(goal.short.experience, goal.short.funds) : V2T.upgradeNone,
  )
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
  growth.append(head, stats, powerBox, el('p', 'v2-hint', `${V2T.teamPowerHint}・${V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers)}`))
  // 近期戰績對照：只放事實（勝敗），並說明不一定是升級造成的
  const form = recentForm(club)
  if (form) {
    const box = el('div', 'v2-form')
    box.dataset.form = ''
    box.append(el('span', 'v2-form-item', V2T.formLast(form.last.wins, form.last.losses)))
    if (form.previous) box.append(el('span', 'v2-form-item prev', V2T.formPrev(form.previous.wins, form.previous.losses)))
    box.append(el('span', 'v2-hint v2-form-note', V2T.formNote))
    growth.append(box)
  }
  growth.append(lineupBtn, recruitBtn, el('p', 'v2-hint', V2T.growthHint))
  return growth
}

/** 未領取收益：沒有收益時只剩一行說明與（停用的）按鈕 */
function rewardsSection(club: ClubSave, state: ControllerState, actions: DashboardActions): HTMLElement {
  const { funds, experience } = club.economy.unclaimed
  const empty = funds === 0 && experience === 0
  const rewards = el('section', `v2-card v2-rewards ${empty ? 'empty' : ''}`)
  const amounts = el('div', 'v2-reward-amounts')
  amounts.append(rewardItem(V2T.funds, funds, 'funds'), rewardItem(V2T.experience, experience, 'exp'))
  const claim = el('button', 'btn-white v2-claim', state.claiming ? V2T.claiming : V2T.claimButton)
  claim.type = 'button'
  claim.disabled = state.claiming || !state.canWrite || empty
  claim.onclick = () => {
    claim.disabled = true
    actions.claim()
  }
  rewards.append(el('h2', 'v2-card-title', V2T.rewardsTitle), amounts)
  if (empty) rewards.append(el('p', 'v2-hint', V2T.rewardsEmpty))
  rewards.append(claim)
  return rewards
}

function recentSection(club: ClubSave, actions: DashboardActions): HTMLElement {
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
  return recent
}

/**
 * 聯盟卡片：目前聯盟、晉級進度（每個條件目前多少、需要多少、還差多少）、挑戰冷卻，以及「挑戰下一聯盟」。
 * 所有數字都來自 domain/league.ts 的 eligibility，不另外算一套條件
 */
export function leagueCard(state: ControllerState, actions: Pick<DashboardActions, 'challenge' | 'watchChallenge'>): HTMLElement {
  const club = state.club!
  const { league } = club
  const def = leagueOf(league.tier)
  const e = eligibility(league, club.idle.nextMatchIndex)
  const card = el('section', `v2-card v2-league ${e.ok ? 'ready' : ''}`)
  card.dataset.tier = String(league.tier)
  const head = el('div', 'v2-league-head')
  const badge = el('span', 'v2-league-badge', String(league.tier + 1))
  badge.style.background = def.color
  badge.setAttribute('aria-hidden', 'true')
  const names = el('div', 'v2-league-names')
  names.append(el('strong', 'v2-league-name', def.name), el('span', 'v2-league-sub', e.atMaxTier ? V2T.leagueTop : V2T.leagueNext(leagueOf(league.tier + 1).name)))
  head.append(badge, names)
  const lines = el('div', 'v2-league-lines')
  lines.append(el('span', '', V2T.leagueRecord(league.wins, league.losses)), el('span', 'v2-hint', V2T.leagueHint(def.rewardMultiplier)))
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

  const need = el('ul', 'v2-league-need')
  const item = (ok: boolean, text: string, key: string) => {
    const li = el('li', ok ? 'done' : '', `${ok ? '✓' : '・'} ${text}`)
    li.dataset.need = key
    need.append(li)
  }
  const rateOk = e.winRate.games >= e.winRate.window && e.winRate.have >= e.winRate.need
  item(e.matches.have >= e.matches.need, V2T.leagueMatchesLine(e.matches.have, e.matches.need), 'matches')
  item(rateOk, V2T.leagueRateLine(e.winRate.have, e.winRate.games, e.winRate.need, e.winRate.window), 'rate')
  if (e.retryRemaining > 0) item(false, V2T.leagueCooldownLine(e.retryRemaining), 'cooldown')
  const nextMult = leagueOf(league.tier + 1).rewardMultiplier
  card.append(el('h3', 'v2-section-title', V2T.leagueProgressTitle), bar, need)

  if (e.ok) {
    card.append(el('p', 'v2-league-ready', V2T.leagueReady), el('p', 'v2-hint', V2T.leagueWhy(nextMult)))
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
    card.append(el('p', 'v2-hint', `${V2T.leagueWhy(nextMult)}。${V2T.leagueLongTerm}`))
  }
  return card
}

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
  const dueEl = scope.querySelector<HTMLElement>('[data-due]')
  if (!dueEl || !due) return
  // 比賽打完、還沒結算的那幾秒：說明正在結算（結算由放置流程自動處理，玩家不用做任何事）
  dueEl.textContent = state.settling || due.matches > 0 ? V2T.liveSettling : ''
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
