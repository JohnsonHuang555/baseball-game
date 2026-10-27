// 比賽結果的成長名單：錦標賽列出誰成長了多少；自由練習只列本場 MVP
import type { Game, Side } from '../sim/game'
import { performance, type Growth } from '../sim/growth'
import { avatar } from './avatar'
import { gradeBadge } from './grades'
import { el } from './playerCard'
import { RATING_FULL, T } from './strings'

/** growth 給 null 代表不成長（自由練習），只顯示 MVP */
export function growthPanel(game: Game, side: Side, growth: readonly Growth[] | null): HTMLElement {
  const box = el('section', 'growth-box')
  box.setAttribute('aria-label', growth ? T.growthTitle : T.mvpTitle)
  box.append(el('h2', 'growth-title', growth ? T.growthTitle : T.mvpTitle))

  const row = (id: string, g?: Growth) => {
    const p = game.player(id)!
    const line = game.box[id]
    const r = el('div', `growth-row ${g?.mvp ? 'mvp' : ''}`)
    const who = el('span', 'growth-who')
    const name = el('span', 'growth-name', p.name)
    if (!growth || g?.mvp) name.append(el('span', 'mvp-tag', 'MVP'))
    who.append(name, el('span', 'growth-line', p.role === 'batter' ? T.batterLine(line) : T.pitcherLine(line)))
    r.append(avatar(p.id, side === game.userSide ? 'user' : 'opponent', 'ring'), who)
    if (g) {
      const before = (p.ratings as unknown as Record<string, number>)[g.rating]
      const change = el('span', 'growth-change')
      change.append(el('span', 'growth-rating', RATING_FULL[g.rating]), gradeBadge(before, 'sm'), el('span', 'diff-arrow', '→'), gradeBadge(before + g.amount, 'sm'))
      r.append(change)
    }
    return r
  }

  if (growth) {
    if (growth.length === 0) box.append(el('p', 'growth-empty', T.noGrowth))
    for (const g of growth) box.append(row(g.playerId, g))
    box.append(el('p', 'growth-hint', T.growthHint))
    return box
  }
  // 自由練習：本場表現分最高的人
  const best = [...game.rosterIds(side)]
    .filter((id) => game.box[id])
    .sort((a, b) => performance(game.player(b)!, game.box[b]) - performance(game.player(a)!, game.box[a]))[0]
  if (best) box.append(row(best))
  return box
}
