// 傳奇總冠軍賽（Phase 10 PR 1）：首頁的冠軍賽卡片、開始前確認、打完一場後的「觀看或看結果」、單場與系列賽結果。
// 規則與狀態全部由 domain/championship.ts 的 championshipView 決定，這裡只負責畫。慶祝動畫留給 PR 2（這裡不放彩帶）。
import { el } from '../../ui/playerCard'
import { ARCHETYPE_NAMES } from '../../ui/strings'
import type { PlayGameOutcome } from '../application/championshipService'
import { CHAMPIONSHIP_CONFIG, championshipView, type ChampionshipView, type SeriesGame } from '../domain/championship'
import type { ClubSave } from '../domain/club'
import { leagueOf } from '../domain/league'
import { IDLE_CONFIG } from '../domain/config'
import { announceModal, type CloseReason } from './dialog'
import { icon } from './icons'
import { V2T } from './strings'

export interface ChampionshipActions {
  start: (expected: { seriesSeq: number }) => void
  play: (expected: { seriesSeq: number; game: number }) => void
  /** 觀看最近一場冠軍賽；沒有保留就是 null */
  watch: (() => void) | null
}

/** 要不要在首頁顯示冠軍賽卡片：到過傳奇、或已經有系列賽與冠軍紀錄 */
export function showsChampionship(club: ClubSave): boolean {
  const ch = club.championship
  return club.league.highestTier >= CHAMPIONSHIP_CONFIG.tier || ch.active !== null || ch.titles > 0 || ch.history.length > 0
}

const dateText = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
const hoursText = (matches: number) => {
  const h = (matches * IDLE_CONFIG.MATCH_INTERVAL_MS) / 3_600_000
  return h >= 1 ? `${Math.ceil(h)} 小時` : `${Math.ceil(h * 60)} 分鐘`
}

/** 七場的小格子：打過的顯示勝敗與比分，還沒打的是空格 */
function gameStrip(games: readonly SeriesGame[]): HTMLElement {
  const strip = el('ol', 'v2-champ-games')
  strip.setAttribute('aria-label', '系列賽各場結果')
  for (let n = 1; n <= CHAMPIONSHIP_CONFIG.maxGames; n++) {
    const g = games[n - 1]
    const li = el('li', `v2-champ-game ${g ? (g.won ? 'won' : 'lost') : 'todo'}`)
    li.dataset.game = String(n)
    li.append(el('span', 'v2-champ-game-n', String(n)), el('span', 'v2-champ-game-r', g ? `${g.runsFor}:${g.runsAgainst}` : '—'))
    li.setAttribute('aria-label', g ? (g.won ? V2T.champGameWin(n, g.runsFor, g.runsAgainst) : V2T.champGameLose(n, g.runsFor, g.runsAgainst)) : V2T.champGameDot(n))
    strip.append(li)
  }
  return strip
}

function needList(v: ChampionshipView): HTMLElement {
  const e = v.eligibility
  const list = el('ul', 'v2-league-need v2-champ-need')
  const item = (ok: boolean, text: string, key: string) => {
    const li = el('li', ok ? 'done' : '')
    li.dataset.need = key
    const top = el('span', 'v2-need-top')
    const dot = el('span', 'v2-need-dot')
    if (ok) dot.append(icon('check', 10))
    top.append(dot, el('span', 'v2-need-text', text))
    li.append(top)
    list.append(li)
  }
  item(e.matches.ok, V2T.champNeedMatches(e.matches.have, e.matches.need), 'matches')
  item(e.winRate.ok, V2T.champNeedRate(e.winRate.have, e.winRate.games, e.winRate.need, e.winRate.window), 'rate')
  item(e.points.ok, V2T.champNeedPoints(e.points.have, e.points.need), 'points')
  return list
}

/** 首頁的冠軍賽卡片 */
export function championshipCard(club: ClubSave, state: { busy: boolean; canWrite: boolean }, actions: ChampionshipActions): HTMLElement {
  const v = championshipView(club)
  const card = el('section', `v2-card v2-champ ${v.status}${v.titles ? ' champion' : ''}`)
  card.dataset.status = v.status
  card.setAttribute('aria-label', V2T.champLabel)
  const head = el('div', 'v2-champ-head')
  const badge = el('span', 'v2-champ-badge')
  badge.append(icon('league', 36))
  badge.setAttribute('aria-hidden', 'true')
  const names = el('div', 'v2-champ-names')
  const row = el('span', 'v2-champ-name-row')
  row.append(el('strong', 'v2-champ-name', V2T.champTitle))
  if (v.titles) row.append(el('span', 'v2-champ-title-chip', V2T.champTitles(v.titles)))
  names.append(row, el('span', 'v2-champ-intro', V2T.champIntro))
  head.append(badge, names)
  card.append(head)

  // 已經奪冠：永久的冠軍紀錄（不管現在在哪個聯盟）
  if (v.firstTitle) {
    const banner = el('div', 'v2-champ-banner')
    banner.dataset.champion = ''
    banner.append(el('strong', 'v2-champ-banner-title', V2T.champChampion), el('span', 'v2-champ-banner-line', V2T.champFirstLine(v.firstTitle.wins, v.firstTitle.losses, dateText(v.firstTitle.at))))
    card.append(banner)
  }

  const button = (label: string, action: string, run: () => void, primary = true) => {
    const b = el('button', `${primary ? 'btn-white v2-challenge' : 'v2-link'} v2-champ-btn`)
    b.type = 'button'
    b.dataset.action = action
    if (primary) b.append(icon('challenge', 20))
    b.append(label)
    b.disabled = state.busy || !state.canWrite
    b.onclick = () => {
      b.disabled = true
      run()
    }
    return b
  }

  if (v.status === 'in-progress' && v.series) {
    const s = v.series
    const rec = el('div', 'v2-champ-record')
    rec.append(el('strong', 'v2-champ-record-main', V2T.champRecord(s.wins, s.losses)), el('span', 'v2-champ-record-sub', `${V2T.champToTitle(s.winsToTitle)}・${V2T.champToElim(s.lossesToElimination)}`))
    card.append(rec, gameStrip(s.games), el('p', 'v2-champ-opp', V2T.champOpponent(s.opponent.name, ARCHETYPE_NAMES[s.opponent.style])))
    if (v.relegatedDuringSeries) card.append(el('p', 'v2-champ-warn', V2T.champRelegatedDuring))
    const play = button(state.busy ? V2T.champPlaying : V2T.champPlay(s.nextGame), 'champ-play', () => actions.play({ seriesSeq: s.seq, game: s.nextGame }))
    play.dataset.seq = String(s.seq)
    play.dataset.game = String(s.nextGame)
    card.append(play)
  } else if (v.status === 'eligible') {
    card.append(el('p', 'v2-league-ready v2-champ-ready', V2T.champReady))
    const start = button(state.busy ? V2T.champStarting : V2T.champStart, 'champ-start', () => actions.start({ seriesSeq: v.nextSeriesSeq }))
    start.dataset.seq = String(v.nextSeriesSeq)
    card.append(start)
  } else if (v.status === 'cooldown') {
    card.append(el('p', 'v2-champ-cooldown', V2T.champCooldown(v.eligibility.cooldown.remaining, hoursText(v.eligibility.cooldown.remaining))))
  } else if (v.status === 'not-eligible') {
    const missing = [v.eligibility.matches, v.eligibility.winRate, v.eligibility.points].filter((x) => !x.ok).length
    const h = el('p', 'v2-champ-need-head')
    h.append(el('strong', '', V2T.champNeedTitle), el('span', 'v2-champ-missing', V2T.champMissing(missing)))
    card.append(h, needList(v))
  } else if (v.status === 'locked' && v.relegated) {
    card.append(el('p', 'v2-champ-warn', V2T.champLockedRelegated(leagueOf(club.league.tier).name)))
  }

  if (v.last && v.status !== 'in-progress') {
    const last = el('div', 'v2-champ-last')
    last.append(el('span', 'v2-champ-last-line', V2T.champLast(v.last.won, v.last.wins, v.last.losses)))
    const strip = gameStrip(v.last.scores.map(([a, b], i) => ({ game: i + 1, won: a > b, runsFor: a, runsAgainst: b }) as SeriesGame))
    strip.classList.add('done')
    last.append(strip)
    card.append(last)
  }
  if (actions.watch && club.championship.lastGame) {
    const n = club.championship.lastGame.game.game
    const w = el('button', 'v2-link v2-watch-challenge v2-champ-watch', V2T.champWatchLast(n))
    w.type = 'button'
    w.dataset.action = 'champ-watch'
    w.onclick = actions.watch
    card.append(w)
  }
  return card
}

/** 開始系列賽前的確認：說明規則與獨立性 */
export function championshipConfirmModal(go: () => void, owner?: unknown): () => void {
  const body = el('div', 'v2-champ-confirm')
  const list = el('ul', 'v2-challenge-lines')
  for (const line of V2T.champConfirmLines) list.append(el('li', 'v2-challenge-line', line))
  body.append(list)
  return announceModal({
    icon: 'league',
    badge: 'yellow',
    title: V2T.champConfirmTitle,
    content: [body],
    primary: { label: V2T.champConfirmGo, action: 'champ-confirm', closes: true, run: go },
    secondary: { label: V2T.champConfirmCancel, closes: true },
    className: 'v2-champ-modal',
    owner,
  })
}

/** 一場打完：結果已經確定並存檔，先不揭曉，讓玩家選觀看或直接看結果。關掉等於直接看結果 */
export function championshipGameDoneModal(out: PlayGameOutcome, watch: () => void, reveal: () => void, owner?: unknown): () => void {
  const body = el('div', 'v2-challenge-start')
  const note = el('p', 'v2-lock-note')
  note.append(icon('lock', 16), V2T.challengeLockedNote)
  body.append(note)
  let chosen = false
  const close = announceModal({
    icon: 'challenge',
    title: V2T.champGameDoneTitle(out.game.game),
    sub: V2T.champGameDoneAsk,
    content: [body],
    primary: {
      label: V2T.champWatch,
      action: 'champ-watch-game',
      run: () => {
        chosen = true
        close()
        watch()
      },
    },
    secondary: { label: V2T.champShowResult, closes: true },
    className: 'v2-champ-modal',
    owner,
    onClose: (reason) => {
      if (!chosen && reason === 'user') reveal()
    },
  })
  return close
}

/** 一場的結果；這一場結束系列賽時，同時顯示奪冠或落敗 */
export function championshipResultModal(out: PlayGameOutcome, club: ClubSave, onClose: (reason: CloseReason) => void, watch?: () => void, owner?: unknown): () => void {
  const g = out.game
  const done = out.completed
  const body = el('div', `v2-challenge-result v2-champ-result ${g.won ? 'won' : 'lost'}`)
  const score = el('div', 'v2-challenge-score')
  score.append(el('span', 'v2-challenge-runs', `${g.runsFor} : ${g.runsAgainst}`), el('span', 'v2-challenge-opp', `${CHAMPIONSHIP_CONFIG.opponentName}・${V2T.innings(g.innings)}`))
  body.append(score)
  const games = done ? done.scores.map(([a, b], i) => ({ game: i + 1, won: a > b, runsFor: a, runsAgainst: b }) as SeriesGame) : (club.championship.active?.games ?? [])
  body.append(gameStrip(games))
  const v = championshipView(club)
  let title: string
  let sub: string
  if (done?.won) {
    title = V2T.champChampion
    sub = V2T.champChampionSub(club.clubName, done.wins, done.losses)
  } else if (done) {
    title = V2T.champSeriesLost
    sub = V2T.champSeriesLostSub(done.wins, done.losses, CHAMPIONSHIP_CONFIG.retryAfterMatches)
  } else {
    title = g.won ? V2T.champGameWonTitle(g.game) : V2T.champGameLostTitle(g.game)
    sub = v.series ? `${V2T.champRecord(v.series.wins, v.series.losses)}・${V2T.champToTitle(v.series.winsToTitle)}` : ''
  }
  if (done?.won && club.championship.firstTitle) body.append(el('p', 'v2-champ-first', V2T.champFirstLine(club.championship.firstTitle.wins, club.championship.firstTitle.losses, dateText(club.championship.firstTitle.at))))
  return announceModal({
    icon: done?.won ? 'league' : g.won ? 'check' : 'alert',
    badge: done?.won || (!done && g.won) ? 'yellow' : 'white',
    title,
    titleClass: 'v2-champ-verdict',
    sub,
    content: [body],
    primary: { label: done ? V2T.gotIt : V2T.champContinue, closes: true },
    secondary: watch ? { label: V2T.champWatch, action: 'champ-watch', run: watch } : undefined,
    className: `v2-champ-modal ${done ? (done.won ? 'champion' : 'lost') : g.won ? 'won' : 'lost'}`,
    onClose,
    owner,
  })
}
