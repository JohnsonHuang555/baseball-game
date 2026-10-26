// 用 SVG 組出球員頭像：膚色、髮型、鬍子、眼睛、嘴巴由球員 id 決定，所以同一名球員永遠長一樣

/** 頭像依隊伍換帽子和背景色：我方藍、對手橘 */
export type AvatarTeam = 'user' | 'opponent'

const SKINS = ['#FBD9B7', '#F0BB8C', '#D79563', '#AE6E40', '#74482A']
const SKIN_SHADES = ['#EDC29C', '#DDA474', '#C07E4E', '#955A31', '#5E3A21']
const HAIRS = ['#231B18', '#4B2E1D', '#8B5A2B', '#C9A15A']
const TEAM_COLORS: Record<AvatarTeam, { bg: string; cap: string; capDark: string }> = {
  user: { bg: '#D9E6FF', cap: '#2D7CFF', capDark: '#1A4FB8' },
  opponent: { bg: '#FFE3CC', cap: '#FF7A1A', capDark: '#C2530A' },
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export function avatarSvg(id: string, team: AvatarTeam): string {
  const h = hash(id)
  const at = (n: number, shift: number) => (h >>> shift) % n
  const skin = at(5, 0)
  const hair = at(4, 5) // 0 光頭、1 側邊、2 瀏海、3 長髮
  const beardRoll = at(9, 9)
  const beard = beardRoll > 3 ? 0 : beardRoll // 0 無、1 八字鬍、2 鬍渣、3 落腮鬍；多數人沒有鬍子
  const eyes = at(4, 14) // 0 圓點、1 笑眼、2 兇、3 酷
  const mouth = at(4, 18) // 0 微笑、1 平、2 咧嘴、3 歪嘴笑
  const hairColor = HAIRS[at(4, 23)]
  const c = TEAM_COLORS[team]
  const show = (on: boolean) => (on ? '' : ' display="none"')

  return `<svg viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="32" fill="${c.bg}"/>
  <path d="M17 30 C15 44 18 52 22 55 L42 55 C46 52 49 44 47 30 Z" fill="${hairColor}"${show(hair === 3)}/>
  <path d="M7 64 C9 52 20 47 32 47 C44 47 55 52 57 64 Z" fill="${c.cap}"/>
  <path d="M26 47.5 L32 54 L38 47.5" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round"/>
  <rect x="27" y="40" width="10" height="9" fill="${SKIN_SHADES[skin]}"/>
  <circle cx="18" cy="35" r="4" fill="${SKINS[skin]}"/>
  <circle cx="46" cy="35" r="4" fill="${SKINS[skin]}"/>
  <ellipse cx="32" cy="35" rx="14" ry="15" fill="${SKINS[skin]}"/>
  <g fill="${hairColor}"${show(hair === 1)}><rect x="18.5" y="27" width="3.2" height="9" rx="1.6"/><rect x="42.3" y="27" width="3.2" height="9" rx="1.6"/></g>
  <path d="M19 28 Q23 34 27 29 Q31 34 35 29 Q39 34 45 28 L45 26 L19 26 Z" fill="${hairColor}"${show(hair === 2)}/>
  <path d="M18 38 C19 46 25 50 32 50 C39 50 45 46 46 38 C43 44 38 46.5 32 46.5 C26 46.5 21 44 18 38 Z" fill="${hairColor}" opacity="0.35"${show(beard === 2)}/>
  <path d="M18 36 C18 47 25 51.5 32 51.5 C39 51.5 46 47 46 36 C44 42 40 44.5 37 44.5 L27 44.5 C24 44.5 20 42 18 36 Z" fill="${hairColor}"${show(beard === 3)}/>
  <circle cx="22.5" cy="41" r="2.3" fill="#FF7A7A" opacity="0.35"/>
  <circle cx="41.5" cy="41" r="2.3" fill="#FF7A7A" opacity="0.35"/>
  <g fill="#1E1714"${show(eyes === 0)}><circle cx="26.5" cy="37" r="1.9"/><circle cx="37.5" cy="37" r="1.9"/></g>
  <g fill="none" stroke="#1E1714" stroke-width="1.9" stroke-linecap="round"${show(eyes === 1)}><path d="M24 37.6 Q26.5 35 29 37.6"/><path d="M35 37.6 Q37.5 35 40 37.6"/></g>
  <g stroke="#1E1714" stroke-width="1.9" stroke-linecap="round" fill="#1E1714"${show(eyes === 2)}><circle cx="26.5" cy="37.5" r="1.7" stroke="none"/><circle cx="37.5" cy="37.5" r="1.7" stroke="none"/><path d="M23.5 33.2 L29.5 34.8" fill="none"/><path d="M40.5 33.2 L34.5 34.8" fill="none"/></g>
  <g fill="none" stroke="#1E1714" stroke-width="1.9" stroke-linecap="round"${show(eyes === 3)}><path d="M24 37 h5"/><path d="M35 37 h5"/></g>
  <path d="M27 41.6 Q32 39.4 37 41.6 Q32 43.2 27 41.6 Z" fill="${hairColor}"${show(beard === 1)}/>
  <path d="M28 43.2 Q32 46.8 36 43.2" fill="none" stroke="#1E1714" stroke-width="1.9" stroke-linecap="round"${show(mouth === 0)}/>
  <path d="M29 44.2 h6" fill="none" stroke="#1E1714" stroke-width="1.9" stroke-linecap="round"${show(mouth === 1)}/>
  <path d="M27.6 42.6 Q32 49.4 36.4 42.6 Z" fill="#7A2E2E" stroke="#1E1714" stroke-width="1.4" stroke-linejoin="round"${show(mouth === 2)}/>
  <path d="M29 44.4 Q33 45.2 36.2 42.6" fill="none" stroke="#1E1714" stroke-width="1.9" stroke-linecap="round"${show(mouth === 3)}/>
  <path d="M17 30 C17 18 24 12.5 32 12.5 C40 12.5 47 18 47 30 Z" fill="${c.cap}"/>
  <circle cx="32" cy="12.8" r="1.6" fill="${c.capDark}"/>
  <circle cx="32" cy="22" r="4.4" fill="#FFFFFF"/>
  <path d="M30 20 h4 M32 20 v4.4" stroke="${c.cap}" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M15 29 Q32 34.5 49 29 Q50.5 31 49 33 Q32 38.5 15 33 Q13.5 31 15 29 Z" fill="${c.capDark}"/>
</svg>`
}

export function avatar(id: string, team: AvatarTeam, className = ''): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = `avatar ${className}`
  wrap.innerHTML = avatarSvg(id, team)
  return wrap
}
