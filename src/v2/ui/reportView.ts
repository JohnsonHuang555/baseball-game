// 戰報：全部近期比賽的列表、單場戰報、離線回歸摘要。
// 有保留完整 replay 的場次（最近 3 場），用 V1 的 replay() 重播算出每局比分與個人成績；其他場次只顯示摘要
import { replay } from '../../sim/game'
import { setKeys } from '../../ui/keys'
import { el } from '../../ui/playerCard'
import type { ClubSave, SettledMatch, SummaryHighlight } from '../domain/club'
import type { ControllerState, WelcomeSummary } from './clubController'
import { matchList } from './dashboardView'
import { V2T } from './strings'

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

/** 單場戰報 */
export function openMatchReport(m: SettledMatch, club: ClubSave): () => void {
  const r = m.result
  const body = el('div', 'v2-report')
  const score = el('div', `v2-report-score ${r.won ? 'won' : 'lost'}`)
  score.append(
    teamScore(club.clubName, r.runsFor, true),
    el('span', 'v2-report-result', r.won ? V2T.win : V2T.loss),
    teamScore(r.opponentName, r.runsAgainst, false),
  )
  const meta = el('p', 'v2-report-meta', `${V2T.innings(r.innings)}・${V2T.settledAt} ${new Date(m.settledAt).toLocaleString('zh-Hant')}`)
  const rewards = el('div', 'v2-report-section')
  rewards.append(el('h3', '', V2T.rewards), el('p', 'v2-report-rewards', V2T.earned(m.earnedFunds, m.earnedExperience)))
  const highlights = el('div', 'v2-report-section')
  highlights.append(el('h3', '', V2T.highlights))
  if (r.highlights.length) {
    const ul = el('ul', 'v2-highlights')
    for (const h of r.highlights) ul.append(el('li', h.ours ? 'ours' : 'theirs', highlightText(h)))
    highlights.append(ul)
  } else highlights.append(el('p', 'v2-empty', V2T.noHighlights))
  body.append(score, meta, rewards, highlights)

  const kept = club.replays.find((x) => x.matchId === m.matchId)
  if (kept) body.append(...replayDetails(kept.replay))
  else body.append(el('p', 'v2-hint', V2T.noReplay))
  return v2Modal(V2T.reportTitle(m.matchIndex + 1), body)
}

/** 用保存的 replay 重播一次，拿每局比分與個人成績；重播失敗就只顯示摘要 */
function replayDetails(rep: ClubSave['replays'][number]['replay']): HTMLElement[] {
  let game
  try {
    game = replay(rep.setup, rep.commands)
  } catch {
    return [el('p', 'v2-hint', V2T.noReplay)]
  }
  const ours = rep.setup.userSide
  const box = el('div', 'v2-report-section')
  box.append(el('h3', '', V2T.linescore))
  const wrap = el('div', 'v2-linescore-wrap')
  const table = el('table', 'v2-linescore')
  const innings = Math.max(game.linescore.away.length, game.linescore.home.length)
  const headRow = el('tr')
  headRow.append(el('th', '', ''))
  for (let i = 1; i <= innings; i++) headRow.append(el('th', '', String(i)))
  headRow.append(el('th', 'total', 'R'), el('th', 'total', 'H'), el('th', 'total', 'E'))
  table.append(headRow)
  for (const side of ['away', 'home'] as const) {
    const row = el('tr', side === ours ? 'ours' : '')
    row.append(el('th', 'team', rep.setup[side].name))
    for (let i = 0; i < innings; i++) row.append(el('td', '', game.linescore[side][i] === undefined ? 'X' : String(game.linescore[side][i])))
    row.append(el('td', 'total', String(game.score[side])), el('td', 'total', String(game.hits[side])), el('td', 'total', String(game.errors[side])))
    table.append(row)
  }
  wrap.append(table)
  box.append(wrap)

  const batting = el('div', 'v2-report-section')
  batting.append(el('h3', '', V2T.topPerformers))
  const bl = el('ul', 'v2-box')
  const pitching = el('div', 'v2-report-section')
  pitching.append(el('h3', '', V2T.pitching))
  const pl = el('ul', 'v2-box')
  for (const id of game.rosterIds(ours)) {
    const p = game.player(id)
    const line = game.box[id]
    if (!p || !line) continue
    if (p.role === 'batter' && line.pa > 0) {
      const parts = [`${line.pa} 打席 ${line.hits} 安打`]
      if (line.hr) parts.push(`${line.hr} 全壘打`)
      if (line.rbi) parts.push(`${line.rbi} 打點`)
      bl.append(boxRow(p.name, parts.join('・')))
    } else if (p.role === 'pitcher' && line.outs + line.runs > 0) {
      const ip = `${Math.floor(line.outs / 3)}${line.outs % 3 ? `.${line.outs % 3}` : ''} 局`
      pl.append(boxRow(p.name, `${ip}・失 ${line.runs} 分・${line.k} 次三振`))
    }
  }
  batting.append(bl)
  pitching.append(pl)
  return [box, batting, pitching]
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

/** V2 的對話框：沿用 V1 的 modal 樣式，Esc、點外面、按鈕都能關 */
export function v2Modal(title: string, body: HTMLElement, onClose?: () => void, closeLabel: string = V2T.close): () => void {
  const overlay = el('div', 'modal-overlay v2-modal-overlay')
  const box = el('section', 'modal-box v2-modal')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')
  const heading = el('h2', 'modal-title', title)
  heading.id = `v2-modal-${Math.random().toString(36).slice(2)}`
  box.setAttribute('aria-labelledby', heading.id)
  const close = el('button', 'btn-yellow v2-modal-close', closeLabel)
  close.type = 'button'
  box.append(heading, body, close)
  overlay.append(box)
  document.body.append(overlay)
  const previous = setKeys({ Escape: () => done() })
  let closed = false
  function done(): void {
    if (closed) return
    closed = true
    overlay.remove()
    setKeys(previous)
    onClose?.()
  }
  close.onclick = done
  overlay.onclick = (e) => {
    if (e.target === overlay) done()
  }
  // 焦點放在關閉鈕，但不要捲到最下面：從頭開始看
  close.focus({ preventScroll: true })
  box.scrollTop = 0
  return done
}
