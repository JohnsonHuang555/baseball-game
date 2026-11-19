// 晉級挑戰賽的結果對話框：對手、比分、成功或失敗、新聯盟、獎勵、下一步建議
import { el } from '../../ui/playerCard'
import type { ChallengeOutcome } from '../application/leagueService'
import type { ClubSave } from '../domain/club'
import { canRelegate, leagueOf, rankedEnabled } from '../domain/league'
import { PROMOTION_CONFIG, RANKED_CONFIG } from '../domain/leagueConfig'
import { leagueBadge } from './leagueBadge'
import { announceModal, type CloseReason } from './dialog'
import { icon } from './icons'
import { V2T } from './strings'

/** watch 有給（這次挑戰有保留 Replay）就多一個「觀看挑戰過程」：觀戰畫面蓋在結果對話框上方，返回後回到這裡 */
export function challengeResultModal(out: ChallengeOutcome, clubName: string, onClose: (reason: CloseReason) => void, watch?: () => void, owner?: unknown): () => void {
  const c = out.challenge
  const body = el('div', `v2-challenge-result ${c.won ? 'won' : 'lost'}`)
  const score = el('div', 'v2-challenge-score')
  score.append(el('span', 'v2-challenge-runs', `${c.runsFor} : ${c.runsAgainst}`), el('span', 'v2-challenge-opp', `${V2T.challengeOpponent(c.opponentName)}・${V2T.innings(c.innings)}`))
  body.append(score)
  if (c.won) {
    const lines = el('ul', 'v2-challenge-lines')
    lines.append(el('li', 'v2-challenge-line', V2T.challengePromoted(leagueOf(c.toTier).name)))
    if (c.reward.funds || c.reward.experience) lines.append(el('li', 'v2-challenge-line reward', V2T.challengeReward(c.reward.funds, c.reward.experience)))
    else lines.append(el('li', 'v2-challenge-line', V2T.challengeRewardTaken))
    // 競技積分（挑戰者以上）：重設為起始值、開啟保護；職業、傳奇有降級風險
    if (rankedEnabled(c.toTier)) lines.append(el('li', 'v2-challenge-line ranked', V2T.challengeRankedStart(RANKED_CONFIG.initialPoints, RANKED_CONFIG.promotionProtectionMatches)))
    if (canRelegate(c.toTier)) lines.append(el('li', 'v2-challenge-line ranked', V2T.challengeRelegationRisk(leagueOf(c.toTier).name, leagueOf(c.toTier - 1).name)))
    body.append(lines)
  }
  const advice = el('p', 'v2-advice')
  advice.append(el('span', 'v2-advice-tag', V2T.adviceTag), c.won ? V2T.challengeNextWin : V2T.challengeNextLose(PROMOTION_CONFIG.retryAfterMatches))
  body.append(advice)
  return announceModal({
    icon: c.won ? 'league' : 'alert',
    badge: c.won ? 'yellow' : 'white',
    title: c.won ? V2T.challengeWin : V2T.challengeLose,
    titleClass: 'v2-challenge-verdict',
    sub: c.won ? V2T.challengeWinSub(clubName, leagueOf(c.toTier).name) : V2T.challengeLoseSub(leagueOf(c.fromTier).name),
    content: [body],
    primary: { label: c.won ? V2T.challengeContinue : V2T.gotIt, closes: true },
    secondary: watch ? { label: V2T.watchChallengeReplay, action: 'watch-challenge', run: watch } : undefined,
    celebrate: c.won,
    className: `v2-challenge-modal ${c.won ? 'won' : 'lost'}`,
    onClose,
    owner,
  })
}

/**
 * 挑戰賽開打：結果已經確定並存檔，先不揭曉，讓玩家選要觀看比賽過程，或直接看結果。
 * 關掉這個對話框（Esc、點外面）等於直接看結果，結果不會消失
 */
export function challengeStartModal(out: ChallengeOutcome, watch: () => void, reveal: () => void, owner?: unknown): () => void {
  const body = el('div', 'v2-challenge-start')
  const note = el('p', 'v2-lock-note')
  note.append(icon('lock', 16), V2T.challengeLockedNote)
  body.append(el('p', 'v2-challenge-opp', V2T.challengeOpponent(out.challenge.opponentName)), note)
  let chosen = false
  const close = announceModal({
    icon: 'challenge',
    title: V2T.challengeDoneTitle,
    sub: `${V2T.challengeStartLine(leagueOf(out.challenge.toTier).name)}。${V2T.challengeAsk}`,
    content: [body],
    primary: {
      label: V2T.watchChallenge,
      action: 'watch-challenge',
      run: () => {
        chosen = true
        close()
        watch()
      },
    },
    secondary: { label: V2T.challengeShowResult, closes: true },
    className: 'v2-challenge-modal',
    owner,
    // App 關閉時（dispose）不揭曉結果：結果已經存檔，下次打開還在
    onClose: (reason) => {
      if (!chosen && reason === 'user') reveal()
    },
  })
  return close
}

export interface RelegationNotice {
  /** 這次要通知的降級次數（一次離線可能降兩級） */
  count: number
  /** 第一次降級前的聯盟 */
  fromTier: number
}

/**
 * 降級結果（設計稿 p7 IdRank relegate）：原本聯盟 → 降級後聯盟、原因、保留的東西、新的目標。
 * 只讀存檔裡的 league.lastRelegation；什麼時候開、會不會重複開由 App 決定（見 app.ts 的 relegation 去重）
 */
export function relegationModal(club: ClubSave, notice: RelegationNotice, actions: { openRoad: () => void }, onClose?: (reason: CloseReason) => void, owner?: unknown): () => void {
  const last = club.league.lastRelegation!
  const to = club.league.tier
  const body = el('div', 'v2-relegation')
  const badges = el('div', 'v2-relegation-badges')
  const from = leagueBadge(notice.fromTier, 'reached', 48)
  from.classList.add('faded')
  badges.append(from, el('span', 'v2-relegation-arrow', '↓'), leagueBadge(to, 'current', 72))
  body.append(badges)
  const keep = el('div', 'v2-relegation-keep')
  keep.append(el('span', 'v2-relegation-k', V2T.relegationKeepTitle))
  const ul = el('ul', '')
  for (const t of V2T.relegationKeeps(leagueOf(club.league.highestTier).name)) ul.append(el('li', '', t))
  keep.append(ul)
  const goal = el('div', 'v2-relegation-goal')
  goal.style.borderLeftColor = leagueOf(to).color
  goal.append(el('span', 'v2-relegation-k', V2T.relegationGoalTitle), el('strong', '', V2T.relegationGoal(leagueOf(last.fromTier).name)), el('p', '', canRelegate(to) ? V2T.relegationGoalAgain(RANKED_CONFIG.initialPoints, leagueOf(to - 1).name) : V2T.relegationGoalFloor(leagueOf(to).name, PROMOTION_CONFIG.minMatches, Math.round(PROMOTION_CONFIG.winRate * 100), PROMOTION_CONFIG.window)))
  body.append(keep, goal)
  const sub = notice.count > 1 ? V2T.relegationSubMulti(notice.count, leagueOf(notice.fromTier).name, leagueOf(to).name) : V2T.relegationSub(leagueOf(last.fromTier).name, leagueOf(to).name)
  let close: () => void = () => {}
  close = announceModal({
    icon: 'alert',
    badge: 'white',
    title: V2T.relegationTitle(leagueOf(to).name),
    titleClass: 'v2-relegation-title',
    sub,
    content: [body],
    primary: {
      label: V2T.relegationRoad,
      action: 'relegation-road',
      run: () => {
        close()
        actions.openRoad()
      },
    },
    secondary: { label: V2T.relegationHome, closes: true },
    className: 'v2-relegation-modal',
    onClose,
    owner,
  })
  return close
}
