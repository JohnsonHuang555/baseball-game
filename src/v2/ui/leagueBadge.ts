// 聯盟徽章（設計稿 p7 IdLgBadge）：盾牌、星數 = 聯盟等級（新秀 1 顆 … 傳奇 5 顆），顏色來自 LEAGUES。
// 三種狀態：reached（已到達）、current（目前所在，加粗框）、locked（尚未到達：灰色、鎖）
import { el } from '../../ui/playerCard'
import { leagueOf } from '../domain/league'

export type BadgeState = 'reached' | 'current' | 'locked'

const INK = '#141633'
const LOCK_BG = '#D6D9EE'
const LOCK_INK = '#8A8FAE'
const SHIELD = 'M24 3 41 9v13c0 11-7.2 18.6-17 22C14.2 40.6 7 33 7 22V9Z'

function star(cx: number, cy: number, r: number, fill: string, stroke: string): string {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`)
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="0.9" stroke-linejoin="round"/>`
}

/** 星星排在盾牌中間：1～3 顆一排，4、5 顆兩排 */
function stars(n: number, fill: string, stroke: string): string {
  const rows = n <= 3 ? [n] : [n - 2, 2]
  const r = n <= 2 ? 6 : 4.6
  const gap = r * 2.15
  const out: string[] = []
  rows.forEach((count, row) => {
    const y = rows.length === 1 ? 22 : 17 + row * 10.5
    const start = 24 - ((count - 1) * gap) / 2
    for (let i = 0; i < count; i++) out.push(star(start + i * gap, y, r, fill, stroke))
  })
  return out.join('')
}

const LOCK = `<g transform="translate(16 13)"><path d="M3.5 8V5.5a4.5 4.5 0 0 1 9 0V8" fill="none" stroke="${LOCK_INK}" stroke-width="2.4" stroke-linecap="round"/><rect x="1" y="8" width="14" height="10.5" rx="2.5" fill="${LOCK_INK}"/></g>`

/** 徽章的 SVG 字串（裝飾用；名稱另外用文字表示） */
export function leagueBadgeSvg(tier: number, state: BadgeState = 'reached', size = 44): string {
  const def = leagueOf(tier)
  const locked = state === 'locked'
  const bg = locked ? LOCK_BG : def.color
  const line = locked ? LOCK_INK : INK
  const w = state === 'current' ? 3.2 : 2.2
  const inner = locked ? LOCK : stars(tier + 1, '#FFFFFF', INK)
  return `<svg class="v2-lg-badge-svg" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 48 48"><path d="${SHIELD}" fill="${bg}" stroke="${line}" stroke-width="${w}" stroke-linejoin="round"/>${inner}</svg>`
}

export function leagueBadge(tier: number, state: BadgeState = 'reached', size = 44): HTMLElement {
  const span = el('span', `v2-lg-badge ${state}`)
  span.dataset.tier = String(tier)
  span.style.width = `${size}px`
  span.style.height = `${size}px`
  span.innerHTML = leagueBadgeSvg(tier, state, size)
  return span
}

/** 這個聯盟對球團是哪一種狀態（沒有球團資料時一律 locked 以外的 reached：只看規則） */
export function badgeStateFor(tier: number, current: number | null, highest: number | null): BadgeState {
  if (current === null || highest === null) return 'reached'
  if (tier === current) return 'current'
  return tier <= highest ? 'reached' : 'locked'
}
