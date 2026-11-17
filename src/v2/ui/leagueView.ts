// 晉級挑戰賽的結果對話框：對手、比分、成功或失敗、新聯盟、獎勵、下一步建議
import { el } from '../../ui/playerCard'
import type { ChallengeOutcome } from '../application/leagueService'
import { leagueOf } from '../domain/league'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { v2Modal } from './reportView'
import { V2T } from './strings'

export function challengeResultModal(out: ChallengeOutcome, onClose: () => void): () => void {
  const c = out.challenge
  const body = el('div', `v2-challenge-result ${c.won ? 'won' : 'lost'}`)
  body.append(el('p', 'v2-challenge-verdict', c.won ? V2T.challengeWin : V2T.challengeLose))
  const score = el('div', 'v2-challenge-score')
  score.append(el('span', 'v2-challenge-runs', `${c.runsFor} : ${c.runsAgainst}`), el('span', 'v2-match-sub', `${V2T.challengeOpponent(c.opponentName)}・${V2T.innings(c.innings)}`))
  body.append(score)
  if (c.won) {
    body.append(el('p', 'v2-challenge-line', V2T.challengePromoted(leagueOf(c.toTier).name)))
    if (c.reward.funds || c.reward.experience) body.append(el('p', 'v2-challenge-line reward', V2T.challengeReward(c.reward.funds, c.reward.experience)))
    body.append(el('p', 'v2-hint', V2T.challengeNextWin))
  } else {
    body.append(el('p', 'v2-hint', V2T.challengeNextLose(PROMOTION_CONFIG.retryAfterMatches)))
  }
  return v2Modal(V2T.challengeTitle, body, onClose)
}
