// 戰報：全部近期比賽的列表、單場戰報、離線回歸摘要。
// 單場戰報只讀結算時存下的摘要與 Box Score（每局比分、安打、失誤、我方打者與投手成績），不重新模擬比賽。
// Box Score 從 schemaVersion 7 起才有；更早結算、又沒有保留完整 Replay 可以補算的場次，只顯示摘要並說明
import { el } from '../../ui/playerCard'
import type { BoxScore, ClubSave, SettledMatch, SummaryHighlight } from '../domain/club'
import { leagueOf } from '../domain/league'
import { IDLE_CONFIG } from '../domain/config'
import type { ControllerState, WelcomeSummary } from './clubController'
import { V2T } from './strings'
import { announceModal, v2Modal } from './dialog'
import { icon } from './icons'

const fmt = (x: number) => x.toLocaleString('zh-Hant')

/** 戰報列表：依日期分組（今天、昨天、M/D），每列是一張可以點的卡片；只保留最近 50 場 */
export function renderReports(state: ControllerState, open: (m: SettledMatch) => void, now: number = Date.now()): HTMLElement {
  const page = el('div', 'v2-page v2-reports')
  const head = el('div', 'v2-page-head')
  const titles = el('div', 'v2-page-titles')
  titles.append(el('h2', 'v2-page-title', V2T.reportsTitle), el('span', 'v2-page-sub', V2T.reportsKeep))
  head.append(titles)
  page.append(head)
  const matches = [...(state.club?.recentMatches ?? [])].reverse()
  if (!matches.length) {
    page.append(el('p', 'v2-empty v2-empty-dark', V2T.noMatches))
    return page
  }
  const list = el('div', 'v2-report-list')
  let lastDay = ''
  const all = state.club?.recentMatches ?? []
  for (const m of matches) {
    const day = dayLabel(matchTime(m, all), now)
    if (day !== lastDay) {
      list.append(el('h3', 'v2-day-label', day))
      lastDay = day
    }
    list.append(reportRow(m, open))
  }
  page.append(list, el('p', 'v2-list-end', V2T.reportsEnd))
  return page
}

/**
 * 比賽的時間（分組與戰報日期用）：用比賽本身的時間，不用結算時間。
 * playedAt 是預定結束時間；離線很久回來才結算的比賽，結算時間是「重新開啟遊戲」的時間，不能拿來分組。
 * 存檔升級前的比賽沒有 playedAt：同一次結算的比賽 settledAt 相同，最後一場在結算前打完，
 * 前面的每場往前推一個比賽間隔，用這個估計比賽時間
 */
export function matchTime(m: SettledMatch, all: readonly SettledMatch[]): number {
  if (m.playedAt !== undefined) return m.playedAt
  let last = m.matchIndex
  for (const x of all) if (x.settledAt === m.settledAt && x.playedAt === undefined && x.matchIndex > last) last = x.matchIndex
  return m.settledAt - (last - m.matchIndex) * IDLE_CONFIG.MATCH_INTERVAL_MS
}

/** 今天、昨天；今年的其他日子寫「11/14」，其他年份寫「2025/12/30」（依裝置的時區算日界） */
export function dayLabel(t: number, now: number): string {
  const d = new Date(t)
  const today = new Date(now)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  // 用日曆日相減（避開日光節約時間造成的 23／25 小時）
  const diff = Math.round((start(today) - start(d)) / 86_400_000)
  if (diff <= 0) return V2T.today
  if (diff === 1) return V2T.yesterday
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}/${md}`
}

function reportRow(m: SettledMatch, open: (m: SettledMatch) => void): HTMLElement {
  const r = m.result
  const b = el('button', `v2-match v2-report-row ${r.won ? 'won' : 'lost'}`)
  b.type = 'button'
  b.setAttribute('aria-label', `${V2T.matchNo(m.matchIndex + 1)} ${r.won ? V2T.win : V2T.loss} ${r.runsFor} 比 ${r.runsAgainst} ${V2T.vs(r.opponentName)}`)
  const body = el('span', 'v2-match-body')
  body.append(el('span', 'v2-match-opp', V2T.vs(r.opponentName)), el('span', 'v2-match-sub', `${V2T.matchNo(m.matchIndex + 1)}・${V2T.innings(r.innings)}`))
  const earned = el('span', 'v2-report-earned')
  earned.append(el('span', '', `+${fmt(m.earnedFunds)} ${V2T.funds}`), el('span', '', `+${fmt(m.earnedExperience)} ${V2T.experience}`))
  b.append(el('span', 'v2-result-badge', r.won ? V2T.win : V2T.loss), body, el('span', 'v2-match-score', `${r.runsFor} : ${r.runsAgainst}`), earned, icon('chev', 16, 'v2-report-chev'))
  b.onclick = () => open(m)
  return b
}

export function highlightText(h: SummaryHighlight): string {
  return V2T.highlight[h.kind](h.playerName || '—', h.runs, V2T.inningHalf(h.inning, h.half))
}

/** 單場戰報：勝敗、聯盟、局數、日期、比分、每局比分、精彩時刻、我方打擊與投手成績、這場收益 */
export function openMatchReport(m: SettledMatch, club: ClubSave): () => void {
  const r = m.result
  const body = el('div', 'v2-report')
  const score = el('section', `v2-report-card v2-report-score ${r.won ? 'won' : 'lost'}`)
  const when = new Date(matchTime(m, club.recentMatches)).toLocaleString('zh-Hant', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const meta = el('p', 'v2-report-meta', `${leagueOf(r.leagueTier ?? 0).name}・${V2T.innings(r.innings)}・${when}`)
  meta.dataset.league = String(r.leagueTier ?? 0)
  const line = el('div', 'v2-report-line')
  line.append(el('span', 'v2-report-name ours', club.clubName), el('span', 'v2-report-runs', `${r.runsFor} : ${r.runsAgainst}`), el('span', 'v2-report-name', r.opponentName))
  score.append(el('span', 'v2-report-result', r.won ? V2T.win : V2T.loss), meta, line)
  if (m.box) score.append(linescore(m.box, club.clubName, r.opponentName, r.userSide))
  body.append(score)

  if (!m.box) {
    const old = el('section', 'v2-report-old v2-replay-missing')
    old.append(icon('report', 28), el('strong', '', V2T.noBoxTitle), el('span', '', V2T.noBoxScore))
    body.append(old)
  }
  const hl = el('section', 'v2-report-card')
  hl.append(el('h3', '', V2T.highlights))
  if (r.highlights.length) {
    const ul = el('ul', 'v2-highlights')
    for (const h of r.highlights) ul.append(el('li', h.ours ? 'ours' : 'theirs', highlightText(h)))
    hl.append(ul)
  } else hl.append(el('p', 'v2-hint', V2T.noHighlights))
  body.append(hl)
  if (m.box) body.append(boxTables(m.box))
  const rewards = el('section', 'v2-report-card v2-report-rewards')
  rewards.setAttribute('aria-label', `${V2T.rewards} ${V2T.earned(m.earnedFunds, m.earnedExperience)}`)
  const amount = (name: 'coin' | 'exp', v: number) => {
    const x = el('span', 'v2-report-amount')
    x.append(icon(name, 18), `+${fmt(v)}`)
    return x
  }
  rewards.append(el('span', 'v2-report-rewards-label', V2T.rewards), amount('coin', m.earnedFunds), amount('exp', m.earnedExperience))
  body.append(rewards, el('p', 'v2-report-note', V2T.rewardsGoUnclaimed))
  return v2Modal(V2T.reportTitle(m.matchIndex + 1), body, undefined, { sheet: true, noCloseButton: true, className: 'v2-report-modal' })
}

/** 每局比分（R／H／E） */
function linescore(box: BoxScore, ours: string, theirs: string, userSide: 'home' | 'away'): HTMLElement {
  const wrap = el('div', 'v2-linescore-wrap')
  const table = el('table', 'v2-linescore')
  table.setAttribute('aria-label', V2T.linescore)
  const innings = Math.max(box.linescore.away.length, box.linescore.home.length, 9)
  const headRow = el('tr')
  headRow.append(el('th', '', ''))
  for (let i = 1; i <= innings; i++) headRow.append(el('th', '', String(i)))
  headRow.append(el('th', 'total', 'R'), el('th', 'total', 'H'), el('th', 'total', 'E'))
  table.append(headRow)
  for (const side of ['away', 'home'] as const) {
    const row = el('tr', side === userSide ? 'ours' : '')
    row.append(el('th', 'team', side === userSide ? ours : theirs))
    const line = box.linescore[side]
    for (let i = 0; i < innings; i++) row.append(el('td', '', line[i] === undefined ? (i < line.length || side === 'away' ? '' : 'X') : String(line[i])))
    const runs = line.reduce((a, b) => a + b, 0)
    row.append(el('td', 'total', String(runs)), el('td', 'total', String(box.hits[side])), el('td', 'total', String(box.errors[side])))
    table.append(row)
  }
  wrap.append(table)
  return wrap
}

/** 我方打擊、我方投手 */
function boxTables(box: BoxScore): HTMLElement {
  const sec = el('section', 'v2-report-card')
  const table = (cols: readonly string[], rows: (string | number)[][]) => {
    const t = el('table', 'v2-box')
    const head = el('thead')
    const hr = el('tr')
    cols.forEach((c, i) => hr.append(el('th', i ? '' : 'name', c)))
    head.append(hr)
    const tb = el('tbody')
    for (const r of rows) {
      const tr = el('tr')
      r.forEach((v, i) => tr.append(el(i ? 'td' : 'th', i ? '' : 'name', String(v))))
      tb.append(tr)
    }
    t.append(head, tb)
    return t
  }
  sec.append(
    el('h3', '', V2T.topPerformers),
    table(V2T.battingCols, box.batters.map(([name, pa, hits, hr, rbi, so]) => [name, pa, hits, hr, rbi, so])),
    el('h3', '', V2T.pitching),
    table(
      V2T.pitchingCols,
      box.pitchers.map(([name, outs, runs, k]) => [name, `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`, runs, k]),
    ),
  )
  return sec
}

/** 離線回歸摘要：完成場次、勝敗、獲得資源（已加到未領取收益）、精彩時刻 */
export function welcomeModal(w: WelcomeSummary, onClose: () => void): () => void {
  const body = el('div', 'v2-welcome')
  const stats = el('div', 'v2-welcome-stats')
  const item = (label: string, value: string, kind: string) => {
    const s = el('div', `v2-stat ${kind}`)
    s.append(el('span', 'v2-stat-label', label), el('span', 'v2-stat-value', value))
    return s
  }
  stats.append(item(V2T.wins, fmt(w.wins), 'wins'), item(V2T.losses, fmt(w.losses), 'losses'), item(V2T.funds, `+${fmt(w.funds)}`, 'funds'), item(V2T.experience, `+${fmt(w.experience)}`, 'exp'))
  body.append(stats, el('p', 'v2-effective', V2T.welcomeUnclaimed))
  if (w.highlights.length) {
    const box = el('div', 'v2-welcome-hl')
    box.append(el('h3', 'v2-welcome-h', V2T.welcomeHighlights))
    const ul = el('ul', 'v2-highlights')
    for (const h of w.highlights) ul.append(el('li', 'ours', highlightText(h)))
    box.append(ul)
    body.append(box)
  }
  const lead = V2T.welcomeBody(w.matches)
  const close = announceModal({
    icon: 'clock',
    title: V2T.welcomeTitle,
    sub: lead,
    content: [body],
    primary: { label: V2T.welcomeClose, closes: true },
    className: 'v2-welcome-modal',
    onClose,
  })
  // 測試與輔助科技用：說明文字也掛在 .v2-welcome-lead
  document.querySelector('.v2-welcome-modal .v2-announce-sub')?.classList.add('v2-welcome-lead')
  return close
}
