// 晉級挑戰賽的結果對話框：對手、比分、成功或失敗、新聯盟、獎勵、下一步建議
import { el } from '../../ui/playerCard'
import type { ChallengeOutcome } from '../application/leagueService'
import { leagueOf } from '../domain/league'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { v2Modal } from './reportView'
import { V2T } from './strings'

/** watch 有給（這次挑戰有保留 Replay）就多一個「觀看挑戰過程」：觀戰畫面蓋在結果對話框上方，返回後回到這裡 */
export function challengeResultModal(out: ChallengeOutcome, onClose: () => void, watch?: () => void): () => void {
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
  if (watch) {
    const b = el('button', 'btn-white v2-watch-btn', V2T.watchChallenge)
    b.type = 'button'
    b.dataset.action = 'watch-challenge'
    b.onclick = watch
    body.append(b)
  }
  return v2Modal(V2T.challengeTitle, body, onClose)
}

/**
 * 挑戰賽開打：結果已經確定並存檔，先不揭曉，讓玩家選要觀看比賽過程，或直接看結果。
 * 關掉這個對話框（Esc、點外面）等於直接看結果，結果不會消失
 */
export function challengeStartModal(out: ChallengeOutcome, watch: () => void, reveal: () => void): () => void {
  const body = el('div', 'v2-challenge-start')
  body.append(
    el('p', 'v2-challenge-line', V2T.challengeStartLine(leagueOf(out.challenge.toTier).name)),
    el('p', 'v2-match-sub', V2T.challengeOpponent(out.challenge.opponentName)),
    el('p', 'v2-hint', V2T.challengeStartHint),
  )
  let chosen = false
  const watchBtn = el('button', 'btn-yellow btn-big v2-watch-btn', V2T.watchChallenge)
  watchBtn.type = 'button'
  watchBtn.dataset.action = 'watch-challenge'
  body.append(watchBtn)
  const close = v2Modal(V2T.challengeTitle, body, () => {
    if (!chosen) reveal()
  }, V2T.challengeShowResult)
  watchBtn.onclick = () => {
    chosen = true
    close()
    watch()
  }
  return close
}
