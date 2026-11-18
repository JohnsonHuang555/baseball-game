// 戰報：全部近期比賽的列表、單場戰報、離線回歸摘要。
// 單場戰報只讀結算時存下的摘要與 Box Score（每局比分、安打、失誤、我方打者與投手成績），不重新模擬比賽。
// Box Score 從 schemaVersion 7 起才有；更早結算、又沒有保留完整 Replay 可以補算的場次，只顯示摘要並說明
import { el } from '../../ui/playerCard'
import type { BoxScore, ClubSave, SettledMatch, SummaryHighlight } from '../domain/club'
import { leagueOf } from '../domain/league'
import type { ControllerState, WelcomeSummary } from './clubController'
import { matchList } from './dashboardView'
import { V2T } from './strings'
import { v2Modal } from './dialog'

const fmt = (x: number) => x.toLocaleString('zh-Hant')

export function renderReports(state: ControllerState, open: (m: SettledMatch) => void): HTMLElement {
  const page = el('div', 'v2-page')
  const card = el('section', 'v2-card')
  card.append(el('h2', 'v2-card-title', V2T.reportsTitle), el('p', 'v2-hint', V2T.reportsHint))
  const matches = [...(state.club?.recentMatches ?? [])].reverse()
  card.append(matches.length ? matchList(matches, open) : el('p', 'v2-empty', V2T.noMatches))
  page.append(card)
  return page
}

export function highlightText(h: SummaryHighlight): string {
  return V2T.highlight[h.kind](h.playerName || '—', h.runs, V2T.inningHalf(h.inning, h.half))
}

/** 單場戰報：日期、聯盟、對手、比分、勝敗、每局比分、安打、失誤、我方打者與投手成績、精彩事件、收益 */
export function openMatchReport(m: SettledMatch, club: ClubSave): () => void {
  const r = m.result
  const body = el('div', 'v2-report')
  const score = el('div', `v2-report-score ${r.won ? 'won' : 'lost'}`)
  score.append(
    teamScore(club.clubName, r.runsFor, true),
    el('span', 'v2-report-result', r.won ? V2T.win : V2T.loss),
    teamScore(r.opponentName, r.runsAgainst, false),
  )
  const when = new Date(m.playedAt ?? m.settledAt).toLocaleString('zh-Hant')
  const meta = el('p', 'v2-report-meta', `${leagueOf(r.leagueTier ?? 0).name}・${V2T.innings(r.innings)}・${when}`)
  meta.dataset.league = String(r.leagueTier ?? 0)
  const rewards = el('div', 'v2-report-section')
  rewards.append(el('h3', '', V2T.rewards), el('p', 'v2-report-rewards', V2T.earned(m.earnedFunds, m.earnedExperience)))
  const highlights = el('div', 'v2-report-section')
  highlights.append(el('h3', '', V2T.highlights))
  if (r.highlights.length) {
    const ul = el('ul', 'v2-highlights')
    for (const h of r.highlights) ul.append(el('li', h.ours ? 'ours' : 'theirs', highlightText(h)))
    highlights.append(ul)
  } else highlights.append(el('p', 'v2-empty', V2T.noHighlights))
  body.append(score, meta)
  if (m.box) body.append(...boxDetails(m.box, club.clubName, r.opponentName, r.userSide))
  else body.append(el('p', 'v2-replay-missing', V2T.noBoxScore))
  body.append(highlights, rewards)
  return v2Modal(V2T.reportTitle(m.matchIndex + 1), body)
}

/** Box Score：每局比分（R／H／E）、我方打者、我方投手 */
function boxDetails(box: BoxScore, ours: string, theirs: string, userSide: 'home' | 'away'): HTMLElement[] {
  const section = el('div', 'v2-report-section')
  section.append(el('h3', '', V2T.linescore))
  const wrap = el('div', 'v2-linescore-wrap')
  const table = el('table', 'v2-linescore')
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
  section.append(wrap)

  const batting = el('div', 'v2-report-section')
  batting.append(el('h3', '', V2T.topPerformers))
  const bl = el('ul', 'v2-box')
  for (const [name, pa, hits, hr, rbi, so] of box.batters) {
    const parts = [`${pa} 打席 ${hits} 安打`]
    if (hr) parts.push(`${hr} 全壘打`)
    if (rbi) parts.push(`${rbi} 打點`)
    if (so) parts.push(`${so} 三振`)
    bl.append(boxRow(name, parts.join('・')))
  }
  batting.append(bl)
  const pitching = el('div', 'v2-report-section')
  pitching.append(el('h3', '', V2T.pitching))
  const pl = el('ul', 'v2-box')
  for (const [name, outs, runs, k] of box.pitchers) {
    const ip = `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''} 局`
    pl.append(boxRow(name, `${ip}・失 ${runs} 分・${k} 次三振`))
  }
  pitching.append(pl)
  return [section, batting, pitching]
}

function boxRow(name: string, text: string): HTMLElement {
  const li = el('li')
  li.append(el('span', 'v2-box-name', name), el('span', 'v2-box-line', text))
  return li
}

function teamScore(name: string, runs: number, ours: boolean): HTMLElement {
  const box = el('div', `v2-report-team ${ours ? 'ours' : ''}`)
  box.append(el('span', 'v2-report-runs', String(runs)), el('span', 'v2-report-name', name))
  return box
}

/** 離線回歸摘要：完成場次、勝敗、獲得資源、精彩時刻 */
export function welcomeModal(w: WelcomeSummary, onClose: () => void): () => void {
  const body = el('div', 'v2-welcome')
  body.append(el('p', 'v2-welcome-lead', V2T.welcomeBody(w.matches)))
  const stats = el('div', 'v2-welcome-stats')
  const item = (label: string, value: string, kind = '') => {
    const s = el('div', `v2-stat ${kind}`)
    s.append(el('span', 'v2-stat-value', value), el('span', 'v2-stat-label', label))
    return s
  }
  stats.append(item(V2T.wins, fmt(w.wins)), item(V2T.losses, fmt(w.losses)), item(V2T.funds, `+${fmt(w.funds)}`, 'funds'), item(V2T.experience, `+${fmt(w.experience)}`, 'exp'))
  body.append(stats)
  if (w.highlights.length) {
    body.append(el('h3', 'v2-welcome-h', V2T.welcomeHighlights))
    const ul = el('ul', 'v2-highlights')
    for (const h of w.highlights) ul.append(el('li', 'ours', highlightText(h)))
    body.append(ul)
  }
  return v2Modal(V2T.welcomeTitle, body, onClose, V2T.welcomeClose)
}

/** V2 的對話框：沿用共用的 modal 樣式（ui/shared.css），Esc、點外面、按鈕都能關 */
export { v2Modal } from './dialog'
