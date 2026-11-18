// 晉級挑戰賽的結果對話框：對手、比分、成功或失敗、新聯盟、獎勵、下一步建議
import { el } from '../../ui/playerCard'
import type { ChallengeOutcome } from '../application/leagueService'
import { leagueOf } from '../domain/league'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { announceModal } from './dialog'
import { icon } from './icons'
import { V2T } from './strings'

/** watch 有給（這次挑戰有保留 Replay）就多一個「觀看挑戰過程」：觀戰畫面蓋在結果對話框上方，返回後回到這裡 */
export function challengeResultModal(out: ChallengeOutcome, clubName: string, onClose: () => void, watch?: () => void): () => void {
  const c = out.challenge
  const body = el('div', `v2-challenge-result ${c.won ? 'won' : 'lost'}`)
  const score = el('div', 'v2-challenge-score')
  score.append(el('span', 'v2-challenge-runs', `${c.runsFor} : ${c.runsAgainst}`), el('span', 'v2-challenge-opp', `${V2T.challengeOpponent(c.opponentName)}・${V2T.innings(c.innings)}`))
  body.append(score)
  if (c.won) {
    const lines = el('ul', 'v2-challenge-lines')
    lines.append(el('li', 'v2-challenge-line', V2T.challengePromoted(leagueOf(c.toTier).name)))
    if (c.reward.funds || c.reward.experience) lines.append(el('li', 'v2-challenge-line reward', V2T.challengeReward(c.reward.funds, c.reward.experience)))
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
  })
}

/**
 * 挑戰賽開打：結果已經確定並存檔，先不揭曉，讓玩家選要觀看比賽過程，或直接看結果。
 * 關掉這個對話框（Esc、點外面）等於直接看結果，結果不會消失
 */
export function challengeStartModal(out: ChallengeOutcome, watch: () => void, reveal: () => void): () => void {
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
    onClose: () => {
      if (!chosen) reveal()
    },
  })
  return close
}
