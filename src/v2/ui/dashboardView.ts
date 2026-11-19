// 球團首頁（Phase 6A 重新整理）：讓玩家一眼回答「球隊在做什麼、我現在能做什麼、下一個目標是什麼」。
// 由上到下：目前比賽（直播入口）→ 目前建議（同一時間只有一個）→ 新手任務（未完成時）→ 球隊與養成 → 聯盟進度 → 未領取收益 → 最近比賽。
// 只有「目前比賽」和「目前建議」有醒目的主按鈕，其他區塊用較輕的樣式，不讓每張卡片搶一樣的注意力。
// 版面照設計稿 v7：手機一欄；電腦版三欄（比賽與建議／球隊與收益／聯盟、任務、最近比賽），DOM 順序就是閱讀順序
import { el } from '../../ui/playerCard'
import type { Side } from '../../sim/game'
import { basesSvg } from '../../ui/bases'
import { T, runnersText } from '../../ui/strings'
import type { LiveMatchInfo } from '../application/liveMatch'
import type { ReplayState } from '../application/replayPlayer'
import type { DueMatches } from '../application/idleEngine'
import { gradeBadge } from '../../ui/grades'
import { canAfford } from '../application/economyService'
import { nearestUpgrade, suggestNextAction, type Suggestion, type SuggestionKind } from '../application/guidance'
import type { ClubSave, SettledMatch } from '../domain/club'
import { eligibility, leagueOf, rankedView } from '../domain/league'
import { onboardingProgress, type OnboardingTaskId } from '../domain/onboarding'
import { upgradeCost } from '../domain/progression'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCost, rosterFull } from '../domain/recruitment'
import { assignedIds } from '../domain/roster'
import { recentForm, teamPower } from '../domain/growthInfo'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'
import { icon, type IconName } from './icons'
import { MAX_TIER, PROMOTION_CONFIG, RANKED_CONFIG } from '../domain/leagueConfig'
import { leagueBadge } from './leagueBadge'
import { rankedCard, rankedDeltaChip } from './leagueInfo'

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
  /** 電腦版三欄 */
  desk?: boolean
  /** 打開聯盟之路（首頁「下一個目標」卡） */
  openRoad?: () => void
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
  const page = el('div', `v2-page v2-dashboard ${actions.desk ? 'desk' : ''}`.trim())
  const suggestion = suggestNextAction(club, { canWrite: state.canWrite })

  const live = liveSection(club, state, actions)
  const next = nextSection(suggestion, state, actions)
  const goal = goalCard(club, actions)
  const onboard = onboardingSection(club, state, actions, suggestion.kind)
  const team = teamSection(club, state, actions)
  const league = leagueCard(state, actions)
  const rewards = rewardsSection(club, state, actions)
  const recent = recentSection(club, actions)

  if (actions.desk) {
    const col = (...xs: (HTMLElement | null)[]) => {
      const c = el('div', 'v2-dash-col')
      for (const x of xs) if (x) c.append(x)
      return c
    }
    page.append(col(live, next, goal), col(team, rewards), col(league, onboard, recent))
  } else {
    page.append(live, next, goal)
    if (onboard) page.append(onboard)
    page.append(team, league, rewards, recent)
  }
  updateCountdown(page, controller.due(), state, actions.liveCard?.() ?? null)
  return page
}

/** 目前比賽（直播）：深色卡片，每秒由 updateCountdown 更新比分、局數、壘包、出局、剩餘時間 */
function liveSection(club: ClubSave, state: ControllerState, actions: DashboardActions): HTMLElement {
  const live = el('section', 'v2-card v2-live-card')
  live.dataset.liveCard = ''
  live.setAttribute('aria-label', V2T.liveCardTitle)
  live.setAttribute('aria-live', 'polite')
  const liveBody = el('div', 'v2-live-body')
  liveBody.dataset.liveBody = ''
  const watch = el('button', 'btn-white v2-live-watch')
  watch.type = 'button'
  watch.dataset.action = 'watch-live'
  watch.append(icon('play', 20), V2T.liveWatch)
  watch.onclick = () => actions.watchLive?.()
  const foot = el('p', 'v2-live-foot')
  const due = el('span', 'v2-live-due')
  due.dataset.due = ''
  foot.append(el('span', 'v2-live-how', V2T.liveFoot), el('span', 'v2-live-played', `・${V2T.livePlayed(club.idle.nextMatchIndex)}`), due)
  live.append(liveBody, watch, foot)
  // 沒有 Web Locks：照實說明限制，不宣稱跨分頁安全
  if (!state.crossTab) live.append(el('p', 'v2-live-foot v2-limit', V2T.exclusiveLimit))
  return live
}

const SUGGESTION_ICON: Record<SuggestionKind, IconName> = { claim: 'claim', challenge: 'challenge', upgrade: 'upgrade', lineup: 'lineup', watch: 'play' }

/** 目前建議：規則見 application/guidance.ts；按鈕只帶玩家過去，需要資源或確認的操作仍在原本的畫面確認 */
function nextSection(s: Suggestion, state: ControllerState, actions: DashboardActions): HTMLElement {
  const calm = s.kind === 'watch'
  const box = el('section', `v2-card v2-next ${calm ? 'calm' : 'act'}`)
  box.dataset.suggestion = s.kind
  box.setAttribute('aria-label', V2T.nextTitle)
  const top = el('div', 'v2-next-top')
  const text = el('div', 'v2-next-text')
  text.append(el('span', 'v2-next-label', V2T.nextTitle))
  top.append(icon(SUGGESTION_ICON[s.kind], 26, 'v2-next-icon'), text)
  // 沒有其他事時建議觀戰：卡片改成細框、按鈕改白色（「目前比賽」已經有觀看按鈕，不搶主按鈕）
  const button = el('button', calm ? 'btn-white v2-next-btn' : 'btn-yellow v2-next-btn')
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
  box.append(top, button)
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

const CHEV_UP = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>'
const CHEV_DOWN = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'

/** 新手任務：不限順序、完成自動打勾、可以收起；全部完成後只剩一行，收起後就不再佔首頁 */
function onboardingSection(club: ClubSave, state: ControllerState, actions: DashboardActions, suggested: SuggestionKind): HTMLElement | null {
  const p = onboardingProgress(club)
  if (p.allDone && p.collapsed) return null
  const box = el('section', `v2-card v2-onboard ${p.collapsed ? 'collapsed' : ''} ${p.allDone ? 'all-done' : ''}`)
  box.dataset.onboarding = `${p.done}/${p.total}`
  const head = el('div', 'v2-onboard-head')
  const title = el('h2', 'v2-card-title', V2T.onboardTitle)
  const count = el('span', 'v2-onboard-count', V2T.onboardCount(p.done, p.total))
  const toggle = el('button', 'v2-icon-btn v2-onboard-toggle')
  toggle.type = 'button'
  toggle.dataset.action = 'toggle-onboarding'
  toggle.setAttribute('aria-expanded', String(!p.collapsed))
  toggle.setAttribute('aria-label', `${p.collapsed ? V2T.onboardExpand : V2T.onboardCollapse}${V2T.onboardTitle}`)
  toggle.innerHTML = p.collapsed ? CHEV_DOWN : CHEV_UP
  toggle.disabled = !state.canWrite
  toggle.onclick = () => {
    toggle.disabled = true
    actions.toggleOnboarding?.(!p.collapsed)
  }
  const bar = el('div', 'v2-onboard-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-label', V2T.onboardTitle)
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', String(p.total))
  bar.setAttribute('aria-valuenow', String(p.done))
  const fill = el('span', 'v2-onboard-fill')
  fill.style.width = `${Math.round((p.done / p.total) * 100)}%`
  bar.append(fill)
  head.append(title, count, bar, toggle)
  box.append(head)
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
    const mark = el('span', 'v2-task-mark')
    if (t.done) mark.append(icon('check', 14))
    mark.setAttribute('aria-hidden', 'true')
    const body = el('div', 'v2-task-body')
    body.append(el('span', 'v2-task-title', copy.title))
    li.setAttribute('aria-label', `${copy.title}${t.done ? '（已完成）' : ''}`)
    if (t.done) body.append(el('span', 'v2-task-hint', V2T.onboardDone))
    else {
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

/** 球隊：戰績、可用資源、戰力、近期戰績，以及養成、招募的入口（升級不夠時說明還差多少） */
function teamSection(club: ClubSave, state: ControllerState, actions: DashboardActions): HTMLElement {
  const growth = el('section', 'v2-card v2-growth v2-club')
  const { wins, losses } = club.record
  const games = wins + losses
  growth.append(el('h2', 'v2-card-title', V2T.teamTitle))
  const rec = el('div', 'v2-stats three')
  rec.append(
    stat(V2T.wins, fmt(wins), 'wins'),
    stat(V2T.losses, fmt(losses), 'losses'),
    stat(V2T.winRate, games ? (wins / games).toFixed(3).replace(/^0/, '') : '---', 'rate'),
  )
  const res = el('div', 'v2-stats two')
  res.append(stat(V2T.funds, fmt(club.economy.assets.funds), 'funds', 'coin'), stat(V2T.experience, fmt(club.economy.assets.experience), 'exp', 'exp'))

  const power = teamPower(club)
  const powerBox = el('div', 'v2-power')
  const powerText = el('span', 'v2-power-text')
  const powerLine = el('span', 'v2-power-line')
  powerLine.append(el('span', 'v2-power-label', V2T.teamPower), el('span', 'v2-power-value', power.toFixed(2)))
  powerText.append(powerLine, el('span', 'v2-power-hint', `${V2T.teamPowerHint}・${V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers)}`))
  powerBox.append(gradeBadge(power, 'lg'), powerText)
  growth.append(rec, res, powerBox)

  // 近期戰績對照：只放事實（勝敗），並說明不一定是升級造成的
  const form = recentForm(club)
  if (form) {
    const box = el('div', 'v2-form')
    box.dataset.form = ''
    box.append(el('span', 'v2-form-title', V2T.formTitle))
    const ms = club.recentMatches
    box.append(formRow(V2T.formLastLabel, ms.slice(-10), form.last, 'last'))
    if (form.previous) box.append(formRow(V2T.formPrevLabel, ms.slice(-20, -10), form.previous, 'prev'))
    box.append(el('span', 'v2-hint v2-form-note', V2T.formNote))
    growth.append(box)
  }

  const upgradeable = upgradeableCount(club)
  const goal = upgradeable ? null : nearestUpgrade(club)
  const entries = el('div', 'v2-entries')
  const entry = (name: IconName, label: string, sub: string | null, action: string, run: () => void) => {
    const b = el('button', 'v2-entry-btn')
    b.type = 'button'
    b.dataset.action = action
    const t = el('span', 'v2-entry-text', label)
    if (sub) t.append(el('span', 'v2-entry-sub', sub))
    b.append(icon(name, 20), t, icon('chev', 14, 'v2-entry-chev'))
    b.onclick = run
    return b
  }
  entries.append(
    entry('upgrade', upgradeable ? V2T.upgradeReady(upgradeable) : goal ? V2T.upgradeShort(goal.short.experience, goal.short.funds) : V2T.upgradeNone, null, 'lineup', actions.lineup),
  )
  const cost = recruitCost(club.recruitment.count)
  const full = rosterFull(club)
  const short = !full && club.economy.assets.funds < cost.funds
  entries.append(
    entry('recruit', full ? V2T.rosterFull : V2T.recruitEntry, full ? null : `・${V2T.recruitCost(cost.funds)}${short ? `（${V2T.notEnoughFunds}）` : ''}`, 'recruit', actions.recruit),
  )
  growth.append(entries)
  void state
  return growth
}

function formRow(label: string, ms: readonly SettledMatch[], tally: { wins: number; losses: number }, key: string): HTMLElement {
  const row = el('div', 'v2-form-row')
  row.dataset.formRow = key
  const dots = el('span', 'v2-form-dots')
  dots.setAttribute('aria-hidden', 'true')
  for (const m of ms) dots.append(el('span', m.result.won ? 'w' : 'l'))
  const v = el('span', 'v2-form-value', `${tally.wins}-${tally.losses}`)
  row.setAttribute('aria-label', `${label} ${tally.wins} 勝 ${tally.losses} 敗`)
  row.append(el('span', 'v2-form-label', label), dots, v)
  return row
}

/** 未領取收益：沒有收益時數字變灰、按鈕停用並說明 */
function rewardsSection(club: ClubSave, state: ControllerState, actions: DashboardActions): HTMLElement {
  const { funds, experience } = club.economy.unclaimed
  const empty = funds === 0 && experience === 0
  const rewards = el('section', `v2-card v2-rewards ${empty ? 'empty' : ''}`)
  const amounts = el('div', 'v2-stats two v2-reward-amounts')
  amounts.append(rewardItem(V2T.funds, funds, 'funds', 'coin'), rewardItem(V2T.experience, experience, 'exp', 'exp'))
  const claim = el('button', 'btn-white v2-claim')
  claim.type = 'button'
  claim.append(icon('claim', 20), state.claiming ? V2T.claiming : V2T.claimButton)
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
    const all = el('button', 'v2-link', `${V2T.seeAll} ›`)
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
 * 聯盟卡片：目前聯盟、晉級條件（每個條件目前多少、需要多少）、挑戰冷卻，以及「挑戰下一聯盟」。
 * 所有數字都來自 domain/league.ts 的 eligibility，不另外算一套條件
 */
export function leagueCard(state: ControllerState, actions: Pick<DashboardActions, 'challenge' | 'watchChallenge'>): HTMLElement {
  const club = state.club!
  const { league } = club
  const def = leagueOf(league.tier)
  const e = eligibility(league, club.idle.nextMatchIndex)
  const ready = e.ok && !e.atMaxTier
  const card = el('section', `v2-card v2-league ${ready ? 'ready' : ''}`)
  card.dataset.tier = String(league.tier)
  card.setAttribute('aria-label', V2T.leagueCardLabel)
  const head = el('div', 'v2-league-head')
  const badge = el('span', 'v2-league-badge')
  badge.style.color = def.color
  badge.append(icon('league', 44), el('span', 'v2-league-tier', String(league.tier + 1)))
  badge.setAttribute('aria-hidden', 'true')
  const names = el('div', 'v2-league-names')
  const nameRow = el('span', 'v2-league-name-row')
  nameRow.append(el('strong', 'v2-league-name', def.name))
  if (ready) nameRow.append(el('span', 'v2-ready-tag', V2T.leagueReadyTag))
  const line = el('span', 'v2-league-line', `${V2T.leagueRecord(league.wins, league.losses)}・${V2T.leagueHint(def.rewardMultiplier)}・`)
  line.append(el('span', 'v2-league-sub', e.atMaxTier ? V2T.leagueTop : V2T.leagueNext(leagueOf(league.tier + 1).name)))
  names.append(nameRow, line)
  head.append(badge, names)
  card.append(head)
  const ranked = rankedCard(rankedView(league), { compact: true })
  if (ranked) card.append(ranked)

  if (!e.atMaxTier) {
    const need = el('ul', 'v2-league-need')
    const item = (ok: boolean, text: string, value: string, ratio: number | null, key: string, mark?: number) => {
      const li = el('li', ok ? 'done' : '')
      li.dataset.need = key
      const top = el('span', 'v2-need-top')
      const dot = el('span', 'v2-need-dot')
      if (ok) dot.append(icon('check', 10))
      top.append(dot, el('span', 'v2-need-text', text), el('span', 'v2-need-value', value))
      li.append(top)
      if (ratio !== null) {
        const bar = el('span', 'v2-need-bar')
        bar.setAttribute('role', 'progressbar')
        bar.setAttribute('aria-label', text)
        bar.setAttribute('aria-valuemin', '0')
        bar.setAttribute('aria-valuemax', '100')
        bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
        const fill = el('span', 'v2-need-fill')
        fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`
        bar.append(fill)
        if (mark !== undefined) {
          const m = el('span', 'v2-need-mark')
          m.style.left = `${Math.round(mark * 100)}%`
          bar.append(m)
        }
        li.append(bar)
      }
      need.append(li)
    }
    const rateOk = e.winRate.games >= e.winRate.window && e.winRate.have >= e.winRate.need
    item(e.matches.have >= e.matches.need, V2T.leagueMatchesLine(e.matches.have, e.matches.need), `${fmt(e.matches.have)} / ${fmt(e.matches.need)}`, e.matches.have / e.matches.need, 'matches')
    item(rateOk, V2T.leagueRateLine(e.winRate.have, e.winRate.games, e.winRate.need, e.winRate.window), `${Math.round(e.winRate.have * 100)}%`, e.winRate.have, 'rate', e.winRate.need)
    if (e.retryRemaining > 0) {
      const total = PROMOTION_CONFIG.retryAfterMatches
      item(false, V2T.leagueCooldownLine(e.retryRemaining), `${total - e.retryRemaining} / ${total}`, (total - e.retryRemaining) / total, 'cooldown')
    }
    card.append(need)
    const nextMult = leagueOf(league.tier + 1).rewardMultiplier
    if (ready) {
      card.append(el('p', 'v2-league-ready', `${V2T.leagueReady}${V2T.leagueWhy(nextMult)}。`))
      const btn = el('button', 'btn-white v2-challenge')
      btn.type = 'button'
      btn.dataset.action = 'challenge'
      btn.append(icon('challenge', 20), state.challenging ? V2T.challenging : V2T.challengeButton)
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
  }
  if (actions.watchChallenge) {
    const watch = el('button', 'v2-link v2-watch-challenge', `${V2T.watchLastChallenge} ›`)
    watch.type = 'button'
    watch.dataset.action = 'watch-last-challenge'
    watch.onclick = actions.watchChallenge
    card.append(watch)
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
  if (!body) return
  if (!live) {
    body.replaceChildren(el('p', 'v2-empty', V2T.liveNone))
    return
  }
  const { state: s, info, userSide, teamNames, now } = live
  const other: Side = userSide === 'home' ? 'away' : 'home'
  const upcoming = now < info.startsAt

  const head = el('div', 'v2-live-head')
  const badge = el('span', `v2-live-badge ${upcoming ? 'waiting' : 'live'}`)
  badge.dataset.liveBadge = ''
  badge.append(el('span', 'v2-live-dot'), upcoming ? V2T.liveUpcoming : V2T.liveBadge)
  const left = Math.max(0, upcoming ? info.startsAt - now : info.endsAt - now)
  const secs = Math.ceil(left / 1000)
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const remain = el('span', 'v2-live-remain')
  remain.dataset.liveRemain = String(secs)
  remain.append(icon('clock', 16), upcoming ? V2T.liveStartsIn(clock) : V2T.liveRemaining(clock))
  head.append(badge, el('span', 'v2-live-no', V2T.matchNo(info.matchIndex + 1)), remain)

  const row = el('div', 'v2-live-row')
  const teams = el('div', 'v2-live-teams')
  const team = (side: Side) => {
    const ours = side === userSide
    const r = el('div', `v2-live-team ${ours ? 'ours' : 'theirs'}`)
    const sc = el('span', 'v2-live-score', String(s.score[side]))
    sc.dataset.liveScore = ours ? 'us' : 'them'
    r.append(el('span', 'v2-live-color'), el('span', 'v2-live-name', teamNames[side]), sc)
    return r
  }
  teams.append(team(userSide), team(other))
  const meta = el('div', 'v2-live-meta')
  const runners = s.bases.map(Boolean)
  meta.setAttribute('aria-label', `${upcoming ? V2T.matchNo(info.matchIndex + 1) : `${s.inning} ${s.half === 'top' ? T.halfTop : T.halfBottom}`}，${V2T.liveOuts(s.outs)}，${runnersText(runners)}`)
  const inning = el('span', 'v2-live-inning')
  inning.dataset.liveInning = `${s.inning}${s.half}`
  inning.append(el('span', 'v2-live-inning-no', String(s.inning)), ` ${s.half === 'top' ? T.halfTop : T.halfBottom}`)
  const bases = el('span', 'v2-live-bases')
  bases.innerHTML = basesSvg(runners)
  bases.setAttribute('aria-hidden', 'true')
  const outs = el('span', 'v2-live-outs')
  outs.dataset.liveOuts = String(s.outs)
  outs.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 2; i++) outs.append(el('span', i < s.outs ? 'on' : ''))
  meta.append(inning, bases, outs)
  row.append(teams, meta)
  body.replaceChildren(head, row)
}

export function updateCountdown(scope: HTMLElement, due: DueMatches | null, state: ControllerState, live: LiveCard | null = null): void {
  const card = scope.querySelector<HTMLElement>('[data-live-card]')
  if (card) renderLiveCard(card, live)
  const dueEl = scope.querySelector<HTMLElement>('[data-due]')
  if (!dueEl || !due) return
  // 比賽打完、還沒結算的那幾秒：說明正在結算（結算由放置流程自動處理，玩家不用做任何事）
  dueEl.textContent = state.settling || due.matches > 0 ? V2T.liveSettling : ''
}

/** 比賽列表：勝敗、對手、場次與局數、獲得資源、比分，點了看戰報 */
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
    body.append(
      el('span', 'v2-match-opp', V2T.vs(r.opponentName)),
      el('span', 'v2-match-sub', `${V2T.matchNo(m.matchIndex + 1)}・${V2T.innings(r.innings)}・${V2T.earned(m.earnedFunds, m.earnedExperience)}`),
    )
    const chip = rankedDeltaChip(m)
    if (chip) body.append(chip)
    b.append(badge, body, el('span', 'v2-match-score', `${r.runsFor} : ${r.runsAgainst}`))
    b.onclick = () => open(m)
    li.append(b)
    list.append(li)
  }
  return list
}

function stat(label: string, value: string, kind = '', ico?: IconName): HTMLElement {
  const box = el('div', `v2-stat ${kind}`)
  const v = el('span', 'v2-stat-num')
  if (ico) v.append(icon(ico, 20))
  v.append(el('span', 'v2-stat-value', value))
  box.append(el('span', 'v2-stat-label', label), v)
  return box
}

function rewardItem(label: string, value: number, kind: string, ico: IconName): HTMLElement {
  const box = el('div', `v2-stat v2-reward ${kind}`)
  const v = el('span', 'v2-stat-num')
  v.append(icon(ico, 20), el('span', 'v2-reward-value', value ? `+${fmt(value)}` : '0'))
  box.append(el('span', 'v2-stat-label', label), v)
  return box
}

export interface RateProgress {
  window: number
  /** 最近戰績裡有幾場（還沒滿 window 時比 window 少） */
  games: number
  wins: number
  /** 滿 window 場時要幾勝才達到門檻（跟 eligibility 的 have ≥ need 一致） */
  target: number
  full: boolean
  /** 還差幾場才有完整的最近戰績 */
  missingGames: number
  /** 目前跟目標的勝場差（只是現況，不是「再贏幾場」：舊比賽會被擠出視窗） */
  gap: number
}

/** 最近 window 場勝率的現況：全部從 eligibility 的結果推算，不另外定義門檻 */
export function rateProgress(e: ReturnType<typeof eligibility>): RateProgress {
  const { window, games, need, have } = e.winRate
  const wins = Math.round(have * games)
  const target = Math.ceil(need * window - 1e-9)
  return { window, games, wins, target, full: games >= window, missingGames: Math.max(0, window - games), gap: Math.max(0, target - wins) }
}

/**
 * 下一個目標（設計稿 p7 IdGoal）：目前聯盟、下一個聯盟要達成什麼、還差多少，以及「聯盟之路」入口。
 * 條件全部來自 eligibility（正式規則）；競技積分還在規劃，只加一行「示意」的說明，不顯示任何積分
 */
export function goalCard(club: ClubSave, actions: Pick<DashboardActions, 'openRoad'>): HTMLElement {
  const { league } = club
  const def = leagueOf(league.tier)
  const top = league.tier >= MAX_TIER
  const e = eligibility(league, club.idle.nextMatchIndex)
  const card = el('section', `v2-card v2-goal ${e.ok ? 'ready' : ''}`.trim())
  card.dataset.tier = String(league.tier)
  card.style.borderLeftColor = def.color
  card.setAttribute('aria-label', V2T.goalLabel)
  const head = el('div', 'v2-goal-head')
  const names = el('div', 'v2-goal-names')
  names.append(el('span', 'v2-goal-k', V2T.goalKicker(def.name)), el('strong', 'v2-goal-title', top ? V2T.goalTopTitle(def.name) : V2T.goalTitle(leagueOf(league.tier + 1).name)))
  head.append(leagueBadge(league.tier, 'current', 44), names)
  card.append(head)

  // 競技積分（挑戰者以上）：只讀存檔，跟晉級條件分開顯示
  const rv = rankedView(league)
  const ranked = rankedCard(rv)
  if (ranked) card.append(ranked)

  if (top) {
    card.append(el('p', 'v2-goal-text', V2T.goalTopText))
    const form = leagueForm(club.recentMatches.filter((m) => m.result.leagueTier === league.tier).slice(-10))
    if (form) card.append(form)
    const keep = el('div', 'v2-goal-need')
    keep.append(el('span', 'v2-goal-need-k', V2T.goalKeepTitle))
    const ul = el('ul', '')
    if (rv.points !== null) ul.append(el('li', '', rv.zone === 'danger' ? V2T.goalInDanger(rv.points, leagueOf(rv.relegateTo!).name) : V2T.goalAboveDanger(rv.aboveDanger!, rv.dangerThreshold)))
    ul.append(el('li', '', V2T.goalTopKeepGrowing))
    keep.append(ul)
    card.append(keep)
  } else {
    const rows = el('ul', 'v2-goal-conds')
    const row = (key: string, ok: boolean, label: string, value: string, ratio: number, mark?: number) => {
      const li = el('li', ok ? 'done' : '')
      li.dataset.need = key
      const line = el('span', 'v2-need-top')
      const dot = el('span', 'v2-need-dot')
      if (ok) dot.append(icon('check', 10))
      line.append(dot, el('span', 'v2-need-text', label), el('span', 'v2-need-value', value))
      const bar = el('span', 'v2-need-bar')
      bar.setAttribute('role', 'progressbar')
      bar.setAttribute('aria-label', label)
      bar.setAttribute('aria-valuemin', '0')
      bar.setAttribute('aria-valuemax', '100')
      bar.setAttribute('aria-valuenow', String(Math.round(Math.min(1, ratio) * 100)))
      const fill = el('span', 'v2-need-fill')
      fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`
      bar.append(fill)
      if (mark !== undefined) {
        const m = el('span', 'v2-need-mark')
        m.style.left = `${Math.round(mark * 100)}%`
        bar.append(m)
      }
      li.append(line, bar)
      rows.append(li)
    }
    const matchesOk = e.matches.have >= e.matches.need
    const rateOk = e.winRate.games >= e.winRate.window && e.winRate.have >= e.winRate.need
    row('matches', matchesOk, V2T.leagueMatchesLine(e.matches.have, e.matches.need), `${fmt(Math.min(e.matches.have, e.matches.need))} / ${fmt(e.matches.need)}`, e.matches.have / e.matches.need)
    row('rate', rateOk, V2T.leagueRateLine(e.winRate.have, e.winRate.games, e.winRate.need, e.winRate.window), `${Math.round(e.winRate.have * 100)}%`, e.winRate.have, e.winRate.need)
    card.append(rows)

    const needs: string[] = []
    if (!matchesOk) needs.push(V2T.goalNeedMatches(e.matches.need - e.matches.have))
    // 最近 60 場是滾動視窗：新比賽會擠掉最舊的一場，所以只說「現在幾勝、目標幾勝」，不承諾「再贏 N 場就達標」
    const rp = rateProgress(e)
    if (!rp.full) needs.push(V2T.goalNeedWindow(rp.missingGames, rp.window, rp.games, rp.wins))
    else if (!rateOk) needs.push(V2T.goalNeedRate(rp.wins, rp.target, rp.window))
    if (e.retryRemaining > 0) needs.push(V2T.leagueCooldownLine(e.retryRemaining))
    const need = el('div', `v2-goal-need ${needs.length ? '' : 'done'}`.trim())
    need.append(el('span', 'v2-goal-need-k', needs.length ? V2T.goalNeedTitle : V2T.goalReadyTitle))
    if (needs.length) {
      const ul = el('ul', '')
      for (const x of needs) ul.append(el('li', '', x))
      need.append(ul)
    } else need.append(el('span', 'v2-goal-need-ready', V2T.goalReady))
    if (rp.full && !rateOk) need.append(el('span', 'v2-goal-need-note', V2T.goalRollingNote(rp.window)))
    card.append(need)
  }
  if (league.tier + 1 === RANKED_CONFIG.enabledFromTier) card.append(el('p', 'v2-goal-plan', V2T.goalNextRanked(leagueOf(league.tier + 1).name, RANKED_CONFIG.winPoints, -RANKED_CONFIG.lossPoints)))
  if (rv.canRelegate && !top) card.append(el('p', 'v2-goal-plan danger', V2T.goalRelegationRisk(leagueOf(rv.relegateTo!).name)))
  if (actions.openRoad) {
    const b = el('button', 'btn-white v2-goal-road')
    b.type = 'button'
    b.dataset.action = 'open-road'
    b.append(icon('league', 20), V2T.goalRoad)
    const open = actions.openRoad
    b.onclick = () => {
      b.focus({ preventScroll: true })
      open()
    }
    card.append(b)
  }
  return card
}

/** 傳奇聯盟目標卡的近期戰績：本聯盟最近 10 場（舊的在左） */
function leagueForm(matches: readonly SettledMatch[]): HTMLElement | null {
  if (!matches.length) return null
  const box = el('div', 'v2-goal-form')
  const wins = matches.filter((m) => m.result.won).length
  box.append(el('span', 'v2-goal-form-k', V2T.goalRecentForm(matches.length, wins, matches.length - wins)))
  const dots = el('span', 'v2-goal-form-dots')
  dots.setAttribute('aria-hidden', 'true')
  for (const m of matches) dots.append(el('span', m.result.won ? 'w' : 'l'))
  box.append(dots)
  return box
}
