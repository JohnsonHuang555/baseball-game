// 單場 MVP（Phase 9 PR 4）：戰報的 MVP 區塊、球員詳情的 MVP 紀錄、歡迎回來摘要的 MVP 統計。
// 全部只讀存檔：結算時存下的 SettledMatch.mvp、該場的 lines、球員的 mvp 紀錄。評分公式在 domain/mvp.ts，這裡不另算一套；
// 舊比賽沒有 MVP 就顯示「未記錄」，不用目前的能力或舊的 Box Score 補算
import { avatar } from '../../ui/avatar'
import { el } from '../../ui/playerCard'
import { RATING_FULL } from '../../ui/strings'
import type { ClubSave, PlayerRecord, SettledMatch } from '../domain/club'
import { MVP_CONFIG, mvpBonusUnits, mvpToNext, mvpUnits, unpackMvp, type MatchMvp, type RatingKey } from '../domain/mvp'
import { recordOf } from '../domain/roster'
import { batOf, pitOf } from '../domain/stats'
import { icon } from './icons'
import { batLine, pitLine } from './statsView'
import { V2T } from './strings'

const ratingName = (k: RatingKey) => RATING_FULL[k as keyof typeof RATING_FULL]

/** 名字：生涯數據裡的（釋出後也查得到），沒有就用名單 */
export function mvpName(club: Pick<ClubSave, 'stats' | 'players'>, id: string): string {
  return club.stats.players[id]?.name ?? recordOf(club as ClubSave, id)?.player.name ?? id
}

/** 這場 MVP 的關鍵數據（真實數據：該場的 lines ＋ 事件流的盜壘、勝利打點） */
export function mvpStatLine(m: SettledMatch, mvp: MatchMvp): string {
  if (mvp.role === 'pitcher') {
    const row = m.lines?.pit.find((r) => r[0] === mvp.playerId)
    if (!row) return ''
    const p = pitOf(row.slice(1) as number[])
    const parts = [pitLine(p)]
    if (m.lines!.pit.length === 1 && p.outs >= 27) parts.push(p.r === 0 ? '完封' : '完投')
    return parts.join('・')
  }
  const row = m.lines?.bat.find((r) => r[0] === mvp.playerId)
  if (!row) return ''
  const b = batOf(row.slice(1) as number[])
  const parts = [batLine(b)]
  if (b.d) parts.push(`${b.d} 二壘安打`)
  if (b.t) parts.push(`${b.t} 三壘安打`)
  if (b.r) parts.push(`${b.r} 得分`)
  if (mvp.sb) parts.push(`${mvp.sb} 盜壘`)
  if (mvp.cs) parts.push(`${mvp.cs} 盜壘失敗`)
  if (mvp.key) parts.push(V2T.mvpWinningRbi)
  return parts.join('・')
}

/** 本次的成長進度：觸發成長、已達上限、或還差幾次 */
export function mvpProgressText(mvp: MatchMvp, m: SettledMatch, record: PlayerRecord | undefined): string {
  if (mvp.growth) return V2T.mvpGrowth(mvp.count, ratingName(mvp.growth))
  // 這一場之前就已經到上限：第 5 次成長發生在這場之前
  const fifth = record?.mvp?.grants[MVP_CONFIG.maxUnits - 1]
  if (fifth && fifth.atMatch < m.matchIndex) return V2T.mvpCapped(mvp.count)
  return V2T.mvpProgress(mvp.count, MVP_CONFIG.perGrowth - (mvp.count % MVP_CONFIG.perGrowth))
}

/** 戰報的 MVP 區塊 */
export function mvpReport(m: SettledMatch, club: ClubSave, openPlayer: (id: string) => void): HTMLElement {
  const box = el('section', 'v2-report-card v2-report-mvp')
  const head = el('div', 'v2-report-mvp-head')
  head.append(el('h3', '', V2T.mvpTitle))
  box.append(head)
  if (!m.mvp) {
    head.append(el('span', 'v2-report-tactics-style none', V2T.mvpNone))
    box.append(el('p', 'v2-hint', V2T.mvpNoneNote))
    return box
  }
  const mvp = unpackMvp(m.mvp)
  const name = mvpName(club, mvp.playerId)
  const record = recordOf(club, mvp.playerId)
  box.dataset.player = mvp.playerId
  box.dataset.role = mvp.role
  const who = el('button', 'v2-report-mvp-who')
  who.type = 'button'
  who.dataset.action = 'mvp-player'
  who.setAttribute('aria-label', `${V2T.mvpOpenPlayer}：${name}`)
  who.disabled = !record
  who.onclick = () => openPlayer(mvp.playerId)
  const face = el('span', 'v2-report-mvp-face')
  face.append(avatar(mvp.playerId, 'user', 'v2-report-mvp-avatar'), el('span', 'v2-mvp-badge', 'MVP'))
  const words = el('span', 'v2-report-mvp-words')
  const top = el('span', 'v2-report-mvp-name')
  top.append(el('strong', '', name), el('span', `v2-report-mvp-role ${mvp.role}`, V2T.mvpRole[mvp.role]))
  const score = mvp.score / 1000
  const reason = mvp.role === 'pitcher' ? V2T.mvpReasonPitcher(score / (MVP_CONFIG.pitcher.scale / 1000), score) : V2T.mvpReasonBatter(score)
  words.append(top, el('span', 'v2-report-mvp-line', mvpStatLine(m, mvp)), el('span', 'v2-report-mvp-reason', reason))
  who.append(face, words)
  if (record) who.append(icon('chev', 18))
  box.append(who)
  const progress = el('p', `v2-report-mvp-progress${mvp.growth ? ' grew' : ''}`)
  if (mvp.growth) progress.append(icon('upgrade', 18))
  progress.append(el('span', '', mvpProgressText(mvp, m, record)))
  if (mvp.growth) progress.append(el('span', 'v2-report-mvp-from', V2T.mvpGrowthFrom(m.matchIndex + 2)))
  box.append(progress)
  return box
}

/** 球員詳情：生涯 MVP、下一次成長的進度、加成（每項能力）、是否已達上限 */
export function mvpPlayerSection(record: PlayerRecord): HTMLElement {
  const box = el('section', 'v2-mvp-section')
  box.setAttribute('aria-label', V2T.mvpSection)
  const head = el('div', 'v2-mvp-head')
  head.append(el('h3', 'v2-detail-sub', V2T.mvpSection), el('span', 'v2-mvp-badge', 'MVP'))
  box.append(head)
  const count = record.mvp?.count ?? 0
  const units = mvpUnits(record)
  const toNext = mvpToNext(record)
  const dl = el('dl', 'v2-mvp-facts')
  const row = (key: string, label: string, value: HTMLElement | string) => {
    const r = el('div', 'v2-mvp-fact')
    r.dataset.key = key
    const dd = el('dd')
    dd.append(value)
    r.append(el('dt', '', label), dd)
    dl.append(r)
  }
  row('count', V2T.mvpCareer, V2T.mvpCareerCount(count))
  if (toNext === null) row('next', V2T.mvpNextLabel, V2T.mvpMaxed)
  else {
    const have = MVP_CONFIG.perGrowth - toNext
    const bar = el('span', 'v2-mvp-bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(MVP_CONFIG.perGrowth))
    bar.setAttribute('aria-valuenow', String(have))
    const fill = el('span', 'v2-mvp-bar-fill')
    fill.style.width = `${(have / MVP_CONFIG.perGrowth) * 100}%`
    bar.append(fill)
    const v = el('span', 'v2-mvp-next')
    v.append(bar, el('span', 'v2-num', V2T.mvpNextValue(have, MVP_CONFIG.perGrowth)))
    row('next', V2T.mvpNextLabel, v)
  }
  const bonus = mvpBonusUnits(record)
  const list = el('span', 'v2-mvp-bonus')
  const entries = Object.entries(bonus) as [RatingKey, number][]
  if (!entries.length) list.append(el('span', 'v2-hint', V2T.mvpBonusNone))
  for (const [k, u] of entries) {
    const chip = el('span', 'v2-mvp-bonus-chip', `${ratingName(k)} +${(u / 10).toFixed(1)}`)
    chip.dataset.rating = k
    list.append(chip)
  }
  list.append(el('span', `v2-mvp-bonus-total${units >= MVP_CONFIG.maxUnits ? ' maxed' : ''}`, V2T.mvpBonusTotal(units, MVP_CONFIG.maxUnits)))
  row('bonus', V2T.mvpBonusLabel, list)
  box.append(dl, el('p', 'v2-hint', units >= MVP_CONFIG.maxUnits ? V2T.mvpCappedRule : V2T.mvpRule))
  return box
}

/** 歡迎回來摘要最多列幾位能力提升的球員（其他的合併成一行） */
export const WELCOME_GROWTH_ROWS = 5

export interface WelcomeMvp {
  batters: number
  pitchers: number
  top: { playerId: string; name: string; count: number } | null
  growths: { playerId: string; name: string; rating: RatingKey; count: number; effectiveFromMatch: number }[]
}

/** 一批結算的 MVP 統計（歡迎回來摘要用）。舊比賽（沒有 mvp）不算 */
export function welcomeMvpOf(settled: readonly SettledMatch[], club: Pick<ClubSave, 'stats' | 'players'>): WelcomeMvp | null {
  const all = settled.filter((m) => m.mvp).map((m) => ({ m, mvp: unpackMvp(m.mvp!) }))
  if (!all.length) return null
  const counts = new Map<string, number>()
  for (const { mvp } of all) counts.set(mvp.playerId, (counts.get(mvp.playerId) ?? 0) + 1)
  // 最多的；同次數取先拿到的（照比賽順序，確定性）
  let top: WelcomeMvp['top'] = null
  for (const { mvp } of all) {
    const n = counts.get(mvp.playerId)!
    if (!top || n > top.count) top = { playerId: mvp.playerId, name: mvpName(club, mvp.playerId), count: n }
  }
  return {
    batters: all.filter((x) => x.mvp.role === 'batter').length,
    pitchers: all.filter((x) => x.mvp.role === 'pitcher').length,
    top,
    growths: all.filter((x) => x.mvp.growth).map(({ m, mvp }) => ({ playerId: mvp.playerId, name: mvpName(club, mvp.playerId), rating: mvp.growth!, count: mvp.count, effectiveFromMatch: m.matchIndex + 1 })),
  }
}

/** 歡迎回來摘要裡的 MVP 區塊：打者／投手次數、得獎最多的人、能力提升（可以點開球員） */
export function welcomeMvpBox(w: WelcomeMvp, openPlayer?: (id: string) => void): HTMLElement {
  const box = el('div', 'v2-welcome-mvp')
  box.append(el('h3', 'v2-welcome-h', V2T.welcomeMvpTitle))
  const link = (id: string, text: string, className: string) => {
    if (!openPlayer) return el('span', className, text)
    const b = el('button', `v2-link ${className}`, text)
    b.type = 'button'
    b.dataset.player = id
    b.onclick = () => openPlayer(id)
    return b
  }
  const p = el('p', 'v2-welcome-mvp-counts', V2T.welcomeMvpCounts(w.batters, w.pitchers))
  box.append(p)
  if (w.top) {
    const t = el('p', 'v2-welcome-mvp-top')
    t.append(el('span', 'v2-mvp-badge', 'MVP'), link(w.top.playerId, V2T.welcomeMvpTop(w.top.name, w.top.count), 'v2-welcome-mvp-name'))
    box.append(t)
  }
  if (w.growths.length) {
    // 同一位球員這批可能成長不只一次：合併成一行（各項能力的加總、最後的累積次數、最早生效的場次），最多列 5 位
    const byPlayer = new Map<string, { name: string; units: Map<RatingKey, number>; count: number; from: number }>()
    for (const g of w.growths) {
      const x = byPlayer.get(g.playerId) ?? { name: g.name, units: new Map(), count: 0, from: g.effectiveFromMatch }
      x.units.set(g.rating, (x.units.get(g.rating) ?? 0) + 1)
      x.count = Math.max(x.count, g.count)
      x.from = Math.min(x.from, g.effectiveFromMatch)
      byPlayer.set(g.playerId, x)
    }
    const ul = el('ul', 'v2-welcome-mvp-growth')
    ul.setAttribute('aria-label', V2T.welcomeMvpGrowth)
    const shown = [...byPlayer.entries()].slice(0, WELCOME_GROWTH_ROWS)
    for (const [id, x] of shown) {
      const li = el('li')
      li.dataset.player = id
      const gains = [...x.units.entries()].map(([k, u]) => `${ratingName(k)} +${(u / 10).toFixed(1)}`).join('、')
      li.append(icon('upgrade', 16), link(id, V2T.welcomeMvpGrowthRow(x.name, gains, x.count, x.from + 1), 'v2-welcome-mvp-name'))
      ul.append(li)
    }
    box.append(ul)
    if (byPlayer.size > shown.length) box.append(el('p', 'v2-hint', V2T.welcomeMvpMore(byPlayer.size - shown.length)))
  } else box.append(el('p', 'v2-hint', V2T.welcomeMvpNone))
  return box
}
