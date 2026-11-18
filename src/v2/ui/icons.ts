// 放置經營的圖示（設計稿 IdIcon）：24×24、圓角線條。
// 線條與單色填色都用 currentColor，跟著文字顏色變；資金、經驗、聯盟徽章有固定的配色
import { el } from '../../ui/playerCard'

export type IconName =
  | 'club'
  | 'lineup'
  | 'tactics'
  | 'report'
  | 'coin'
  | 'exp'
  | 'play'
  | 'clock'
  | 'check'
  | 'lock'
  | 'claim'
  | 'upgrade'
  | 'recruit'
  | 'challenge'
  | 'sound'
  | 'alert'
  | 'chev'
  | 'close'
  | 'swap'
  | 'release'
  | 'league'
  | 'save'
  | 'undo'
  | 'pause'
  | 'fast'

const INK = '#141633'
const C = 'currentColor'
const line = (d: string, w = 2.4) => `<path d="${d}" fill="none" stroke="${C}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const fill = (d: string, f = C, stroke = 'none', w = 0) =>
  `<path d="${d}" fill="${f}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const SHIELD = 'M12 2.5 20 5.5v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6Z'

const PATHS: Record<IconName, string> = {
  club: line(SHIELD) + line('M8.5 12.5h7M12 9v7', 2.2),
  lineup: line('M4 6h16M4 12h16M4 18h10', 2.6) + fill('M20 15.5l-3 2.5 3 2.5Z'),
  tactics:
    line('M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5Z') + line('M8 9l2 2 3.5-3.5M8 15.5h8', 2.2),
  report: line('M5 20V11M10 20V5M15 20v-7M20 20V8', 2.8),
  coin:
    fill('M12 2.5a9.5 9.5 0 1 0 0 19a9.5 9.5 0 1 0 0-19Z', '#FFC21A', INK, 1.8) +
    fill('M12 5.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13Z', '#FFE58A', '#C99400', 1.2) +
    `<path d="M12 8.5v7M10 10.2c0-1 1-1.5 2-1.5s2 .5 2 1.4c0 2-4 1.2-4 3.3 0 .9 1 1.5 2 1.5s2-.5 2-1.5" fill="none" stroke="#8A6100" stroke-width="1.5" stroke-linecap="round"/>`,
  exp:
    fill('M12 2.4l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.4l-5.7 3.2 1.4-6.3L2.9 9l6.4-.7Z', '#6FD3FF', INK, 1.6) +
    fill('M12 6.8l1.4 3.1 3.3.4-2.5 2.2.7 3.3L12 14.1l-2.9 1.7.7-3.3-2.5-2.2 3.3-.4Z', '#FFFFFF'),
  play: fill('M7 4.5v15L19.5 12Z'),
  clock: line('M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z') + line('M12 7.5V12l3 2', 2.4),
  check: line('M5 12.5l4.5 4.5L19 7.5', 3),
  lock: line('M7.5 11V8a4.5 4.5 0 0 1 9 0v3') + fill('M5.5 11h13v9.5h-13Z'),
  claim:
    line('M4 10h16v10.5H4Z') + line('M2.8 6.5h18.4V10H2.8Z') + line('M12 6.5v14M12 6.5C10.5 3 7 3 7 5s3 1.5 5 1.5c2 0 5 .5 5-1.5s-3.5-2-5 1.5', 2),
  upgrade: line('M12 20V5M6 11l6-6 6 6', 3),
  recruit: line('M10 3.5a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z') + line('M3 20.5c.8-4 3.5-6 7-6s6.2 2 7 6M19 8v6M16 11h6', 2.4),
  challenge: line('M6 3.5h12v4a6 6 0 0 1-12 0Z') + line('M6 5H3v1.5A3.5 3.5 0 0 0 6.5 10M18 5h3v1.5A3.5 3.5 0 0 1 17.5 10M12 13.5V17M8 20.5h8M9.5 17h5v3.5h-5Z', 2.2),
  sound: fill('M4 9h4l5-4.5v15L8 15H4Z') + line('M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12', 2.2),
  alert: line('M12 3 22 20.5H2Z', 2.2) + line('M12 9.5v5', 2.6) + fill('M12 16.6a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6Z'),
  chev: line('M9 5l7 7-7 7', 3),
  close: line('M6 6l12 12M18 6 6 18', 3),
  swap: line('M4 8h14l-3.5-3.5M20 16H6l3.5 3.5', 2.6),
  release: line('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', 2.2),
  league: fill(SHIELD, C, INK, 1.6) + fill('M12 7.2l1.3 2.8 3 .3-2.3 2 .7 3L12 13.8l-2.7 1.5.7-3-2.3-2 3-.3Z', '#FFFFFF'),
  save: line('M5 3.5h11l3.5 3.5v13.5h-14.5Z') + line('M8 3.5v5h7v-5M8 20.5v-6h8v6', 2),
  undo: line('M8.5 5 4 9.5 8.5 14') + line('M4 9.5h10a6 6 0 0 1 0 12h-3', 2.4),
  pause: fill('M6 4.5h4v15H6ZM14 4.5h4v15h-4Z'),
  fast: fill('M3 5.5v13l8.5-6.5ZM12 5.5v13l8.5-6.5Z'),
}

/** 圖示的 SVG 字串（裝飾用，aria-hidden） */
export function iconSvg(name: IconName, size = 24): string {
  return `<svg class="v2-icon" aria-hidden="true" focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24">${PATHS[name]}</svg>`
}

/** 圖示元素：包在一個 span 裡，方便放進 flex 版面 */
export function icon(name: IconName, size = 24, cls = ''): HTMLElement {
  const span = el('span', `v2-ico ${cls}`.trim())
  span.innerHTML = iconSvg(name, size)
  return span
}
