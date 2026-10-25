// 用 SVG 組出球員頭像：膚色、髮型、鬍子、表情由球員 id 決定，所以同一名球員永遠長一樣

const SKINS = ['#f6d5bb', '#ecbf98', '#d9a272', '#b37a4c', '#7f5233']
const HAIRS = ['#1f1a17', '#3d2a1c', '#7a4b26', '#c9a063', '#8f8f8f', '#a33a1f']

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 從同一個雜湊值依序取出多個特徵 */
function picker(seed: number) {
  let s = seed
  return (n: number) => {
    const v = s % n
    s = Math.floor(s / n) ^ Math.imul(s, 2654435761) >>> 0
    s >>>= 0
    return v
  }
}

export function avatarSvg(id: string, capColor: string): string {
  const pick = picker(hash(id))
  const skin = SKINS[pick(SKINS.length)]
  const hair = HAIRS[pick(HAIRS.length)]
  const hairStyle = pick(3) // 0 短髮、1 長髮、2 光頭
  const facial = pick(5) // 0、1 無、2 八字鬍、3 落腮鬍、4 鬍渣
  const mouth = pick(3) // 0 微笑、1 平、2 咧嘴
  const brow = pick(2)

  const hairSide =
    hairStyle === 0
      ? `<path d="M19 28 Q19 36 22 38 L22 30 Z M45 28 Q45 36 42 38 L42 30 Z" fill="${hair}"/>`
      : hairStyle === 1
        ? `<path d="M18 27 Q16 42 23 46 L23 30 Z M46 27 Q48 42 41 46 L41 30 Z" fill="${hair}"/>`
        : ''
  const beard =
    facial === 2
      ? `<path d="M27 40 Q32 38 37 40 Q32 41.5 27 40 Z" fill="${hair}"/>`
      : facial === 3
        ? `<path d="M21 34 Q22 47 32 48 Q42 47 43 34 Q41 43 32 44 Q23 43 21 34 Z" fill="${hair}"/>`
        : facial === 4
          ? `<path d="M23 38 Q32 47 41 38 Q32 44 23 38 Z" fill="${hair}" opacity="0.35"/>`
          : ''
  const mouthPath =
    mouth === 0
      ? '<path d="M28.5 41 Q32 43.5 35.5 41" stroke="#5a2e1e" stroke-width="1.4" fill="none" stroke-linecap="round"/>'
      : mouth === 1
        ? '<path d="M29 41.5 L35 41.5" stroke="#5a2e1e" stroke-width="1.4" stroke-linecap="round"/>'
        : '<path d="M28 40.5 Q32 45 36 40.5 Z" fill="#fff" stroke="#5a2e1e" stroke-width="1"/>'
  const browY = brow ? 30 : 31

  return `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M8 64 Q10 50 32 49 Q54 50 56 64 Z" fill="${capColor}"/>
    <path d="M27 49 L32 55 L37 49 Z" fill="#ffffff" opacity="0.85"/>
    <rect x="28" y="42" width="8" height="8" fill="${skin}"/>
    <ellipse cx="19.5" cy="34" rx="2.5" ry="3.5" fill="${skin}"/>
    <ellipse cx="44.5" cy="34" rx="2.5" ry="3.5" fill="${skin}"/>
    <ellipse cx="32" cy="34" rx="12.5" ry="13.5" fill="${skin}"/>
    ${hairSide}
    ${beard}
    <path d="M18.5 28 Q19 13 32 13 Q45 13 45.5 28 Z" fill="${capColor}"/>
    <path d="M17 28 Q32 24 51 29 Q50 31.5 45 31 Q32 28.5 18 30 Z" fill="${capColor}" opacity="0.8"/>
    <circle cx="32" cy="14" r="1.6" fill="#ffffff" opacity="0.6"/>
    <path d="M25 ${browY} L29.5 ${browY - 0.5} M34.5 ${browY - 0.5} L39 ${browY}" stroke="#2b1d14" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="27.5" cy="34" r="1.4" fill="#1f1a17"/>
    <circle cx="36.5" cy="34" r="1.4" fill="#1f1a17"/>
    ${mouthPath}
  </svg>`
}

export function avatar(id: string, capColor: string, className = ''): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = `avatar ${className}`
  wrap.innerHTML = avatarSvg(id, capColor)
  return wrap
}
