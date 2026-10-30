// 羈絆系統的圖示：流派徽章、羈絆、隊長、羈絆秘寶。形狀照設計稿（BdIcon），24 格的 SVG
import type { RelicId } from '../sim/items'
import type { Archetype } from '../sim/types'

const INK = '#141633'
const W = '#FFFFFF'

/** 流派色：力量洋紅、速度青、技巧萊姆綠、防守石板灰；避開特性的黃藍紅與兩隊的藍橘 */
export const ARCHETYPE_COLORS: Record<Archetype, string> = { power: '#D6267F', speed: '#0FA3C2', skill: '#5DAA16', defense: '#5B6577' }

/** 只看形狀也分得出流派：力量六角形、速度平行四邊形、技巧圓形、防守盾形 */
const BASE: Record<Archetype, string> = {
  power: 'M12 1.6 21.4 7v10L12 22.4 2.6 17V7Z',
  speed: 'M7.5 3.2h14.2l-5.2 17.6H2.3Z',
  skill: 'M12 2.2a9.8 9.8 0 1 0 0 19.6a9.8 9.8 0 1 0 0-19.6Z',
  defense: 'M12 1.8 21 5v6.6c0 5.5-3.8 9.1-9 10.6-5.2-1.5-9-5.1-9-10.6V5Z',
}

const SQUARE = 'M5 1.5h14a3.5 3.5 0 0 1 3.5 3.5v14a3.5 3.5 0 0 1-3.5 3.5H5A3.5 3.5 0 0 1 1.5 19V5A3.5 3.5 0 0 1 5 1.5Z'

const path = (d: string, fill: string, stroke = 'none', width = 0, transform = '') =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${transform ? ` transform="${transform}"` : ''}/>`

/** 流派圖示中間的白色記號：爆裂星、雙箭頭、準星、磚牆；C 是隊長 */
function glyph(kind: Archetype | 'C', t = ''): string {
  switch (kind) {
    case 'power':
      return path('M12 5.6l1.7 3.6 3.9-1-1.9 3.5 3 2.5-3.9.6.1 4L12 16.3 9.1 18.8l.1-4-3.9-.6 3-2.5-1.9-3.5 3.9 1Z', W, 'none', 0, t)
    case 'speed':
      return path('M7.6 8.2l3.8 3.8-3.8 3.8M12.6 8.2l3.8 3.8-3.8 3.8', 'none', W, 2.8, t)
    case 'skill':
      return (
        path('M12 7.2a4.8 4.8 0 1 0 0 9.6a4.8 4.8 0 1 0 0-9.6Z', 'none', W, 2, t) +
        path('M12 4.6v3M12 16.4v3M4.6 12h3M16.4 12h3', 'none', W, 2, t) +
        path('M12 10.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2Z', W, 'none', 0, t)
      )
    case 'defense':
      return path('M7.5 8.6h9M7.5 12.2h9M7.5 15.8h9M12 8.6v3.6M9.6 12.2v3.6M14.4 12.2v3.6', 'none', W, 1.9, t)
    case 'C':
      return path('M15.4 9.2a4.3 4.3 0 1 0 0 5.6', 'none', W, 2.8, t)
  }
}

function svg(size: number, body: string, label = ''): string {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'
  return `<svg ${a11y} width="${size}" height="${size}" viewBox="0 0 24 24" style="display:block;overflow:visible;flex:none">${body}</svg>`
}

/** 流派徽章 */
export function archetypeSvg(a: Archetype, size: number, label = ''): string {
  return svg(size, path(BASE[a], ARCHETYPE_COLORS[a], INK, 1.6) + glyph(a), label)
}

/** 流派羈絆：流派記號外面套圓角方框 */
export function synergySvg(a: Archetype, size: number): string {
  return svg(
    size,
    path(SQUARE, ARCHETYPE_COLORS[a], INK, 1.6) + path('M5 4.2h14', 'none', 'rgba(255,255,255,0.45)', 1.4) + path('M5 19.8h14', 'none', 'rgba(20,22,51,0.35)', 1.4) + glyph(a),
  )
}

/** 守位羈絆：黃金二遊（兩顆金色壘包）、投捕搭檔（手套接球） */
export function positionSynergySvg(kind: 'middle' | 'battery', size: number): string {
  if (kind === 'middle') {
    return svg(
      size,
      path(SQUARE, '#2A2E66', INK, 1.6) +
        path('M8.5 15.5c1.6-3 5.4-3 7 0', 'none', '#FFE58A', 1.6) +
        path('M3.8 12 7.4 8.4 11 12 7.4 15.6Z', '#FFC21A', INK, 1.3) +
        path('M13 12 16.6 8.4 20.2 12 16.6 15.6Z', '#FFC21A', INK, 1.3),
    )
  }
  return svg(
    size,
    path(SQUARE, '#2A2E66', INK, 1.6) +
      path('M4.6 11a5 5 0 0 1 10 0v4.2a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4Z', '#C77B30', INK, 1.3) +
      path('M7 12.5h5.2M7 15h5.2', 'none', '#8A4E16', 1.1) +
      path('M16.6 4.4a3.3 3.3 0 1 0 0 6.6a3.3 3.3 0 1 0 0-6.6Z', W, INK, 1.3) +
      path('M15.2 5.4c.8 1.3.8 3.3 0 4.6M18 5.4c-.8 1.3-.8 3.3 0 4.6', 'none', '#D9283C', 0.9),
  )
}

/** 隊長標記：深藍底、金框、白色 C，像隊長臂章 */
export function captainSvg(size: number, label = ''): string {
  return svg(size, path('M5.5 3h13a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-13a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Z', INK, '#FFC21A', 2) + glyph('C'), label)
}

/** 羈絆相關的秘寶：寶石外形，裡面放對應的流派記號；隊長臂章是深藍寶石加金框 */
const SYNERGY_RELICS: Partial<Record<RelicId, Archetype | 'captain'>> = {
  powerFactory: 'power',
  runSchool: 'speed',
  hitClass: 'skill',
  ironCurtain: 'defense',
  captainBand: 'captain',
}

export function synergyRelicSvg(id: RelicId, size: number): string | null {
  const kind = SYNERGY_RELICS[id]
  if (!kind) return null
  const gem = 'M6.2 2.6h11.6l4.4 6.2L12 21.8 1.8 8.8Z'
  const captain = kind === 'captain'
  return svg(
    size,
    path(gem, captain ? INK : ARCHETYPE_COLORS[kind], INK, 1.6) +
      path('M1.8 8.8h20.4M8.4 2.6 6.6 8.8 12 21.8 17.4 8.8 15.6 2.6', 'none', 'rgba(255,255,255,0.35)', 1) +
      path(gem, 'none', captain ? '#FFC21A' : INK, 1.6) +
      glyph(captain ? 'C' : kind, 'translate(4.4 2.2) scale(0.64)'),
  )
}
