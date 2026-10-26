// 用 SVG 組出球員頭像：貓咪或小狗（玩家在首頁選），毛色、花紋、耳朵、眼睛、嘴巴由球員 id 決定，
// 所以同一名球員永遠長一樣。戴著隊伍顏色的球帽、穿隊伍顏色的球衣，深色描邊跟卡牌風格一致
import { loadAvatarSpecies, loadOutfit, saveAvatarSpecies, saveOutfit, type AvatarSpecies } from './prefs'
import type { Outfit } from './progress'

/** 頭像依隊伍換帽子和背景色：我方藍、對手橘 */
export type AvatarTeam = 'user' | 'opponent'

const INK = '#141633'
const TEAM_COLORS: Record<AvatarTeam, { bg: string; cap: string; capDark: string }> = {
  user: { bg: '#D9E6FF', cap: '#2D7CFF', capDark: '#1A4FB8' },
  opponent: { bg: '#FFE3CC', cap: '#FF7A1A', capDark: '#C2530A' },
}

/** 毛色：主色、深一階（耳朵內側以外的陰影、花紋）、嘴邊的淺色 */
interface Fur {
  main: string
  dark: string
  light: string
}
const CAT_FURS: Fur[] = [
  { main: '#F4A259', dark: '#D97F2E', light: '#FFE7CC' }, // 橘貓
  { main: '#A7A9B4', dark: '#7C7F8E', light: '#ECEDF2' }, // 灰貓
  { main: '#3B3B48', dark: '#24242E', light: '#F2F2F2' }, // 黑貓（賓士）
  { main: '#F5F1EA', dark: '#D8CFC2', light: '#FFFFFF' }, // 白貓
  { main: '#EBC99A', dark: '#C9A06A', light: '#FFF4E3' }, // 奶油
  { main: '#9C6B47', dark: '#6F4A30', light: '#E9D3BF' }, // 虎斑
]
const DOG_FURS: Fur[] = [
  { main: '#E3B26B', dark: '#C08E45', light: '#FFF1D6' }, // 黃金獵犬
  { main: '#8B5A3C', dark: '#633F28', light: '#E8CDB5' }, // 巧克力
  { main: '#2F2A2A', dark: '#1A1717', light: '#C9A27A' }, // 黑色
  { main: '#F5F1EA', dark: '#D9CFC0', light: '#FFFFFF' }, // 白色
  { main: '#D9894A', dark: '#B0652B', light: '#FFF4E8' }, // 柴犬
  { main: '#9AA0A6', dark: '#6E747B', light: '#E9ECEF' }, // 灰色
]

let species: AvatarSpecies = loadAvatarSpecies()
let outfit: Outfit = loadOutfit()

export function avatarOutfit(): Outfit {
  return outfit
}

export function setAvatarOutfit(next: Outfit): void {
  outfit = next
  saveOutfit(next)
}

/** 金色：黃金戰袍、金色球帽用 */
const GOLD = { main: '#F2C230', dark: '#B8860B' }

export function avatarSpecies(): AvatarSpecies {
  return species
}

export function setAvatarSpecies(next: AvatarSpecies): void {
  species = next
  saveAvatarSpecies(next)
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

const show = (on: boolean) => (on ? '' : ' display="none"')

/** 球衣、背景與球帽：兩種動物共用。look 是裝扮（條紋、黃金戰袍會換球衣） */
function jersey(team: AvatarTeam, look: Outfit): string {
  const c = TEAM_COLORS[team]
  const fill = look === 'gold' ? GOLD.main : c.cap
  // 條紋：白色細直線，避開球衣邊緣
  const stripes =
    look === 'stripes'
      ? `<g stroke="#FFFFFF" stroke-width="1.3" opacity="0.85"><path d="M17 53.5 V64"/><path d="M24 50 V64"/><path d="M40 50 V64"/><path d="M47 53.5 V64"/></g>`
      : ''
  return `<circle cx="32" cy="32" r="32" fill="${c.bg}"/>
  <path d="M7 64 C9 52 20 47 32 47 C44 47 55 52 57 64 Z" fill="${fill}" stroke="${INK}" stroke-width="1.6"/>
  ${stripes}
  <path d="M26 47.5 L32 54 L38 47.5" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linejoin="round"/>`
}

/** 頭上：球帽（金色球帽、黃金戰袍換成金色），皇冠取代球帽 */
function cap(team: AvatarTeam, look: Outfit): string {
  if (look === 'crown') {
    return `<path d="M18 26 L16.5 12 L24.5 18.5 L32 8.5 L39.5 18.5 L47.5 12 L46 26 Z" fill="${GOLD.main}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M18 26 L46 26 L46 29.5 L18 29.5 Z" fill="${GOLD.dark}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>
  <circle cx="32" cy="20.5" r="2.3" fill="#E5383B" stroke="${INK}" stroke-width="0.9"/>
  <circle cx="24" cy="22.5" r="1.6" fill="#2D7CFF" stroke="${INK}" stroke-width="0.8"/>
  <circle cx="40" cy="22.5" r="1.6" fill="#2D7CFF" stroke="${INK}" stroke-width="0.8"/>`
  }
  const golden = look === 'goldCap' || look === 'gold'
  const c = golden ? { cap: GOLD.main, capDark: GOLD.dark } : TEAM_COLORS[team]
  return `<path d="M18 27 C18 16 24.5 11.5 32 11.5 C39.5 11.5 46 16 46 27 Z" fill="${c.cap}" stroke="${INK}" stroke-width="1.6"/>
  <circle cx="32" cy="11.8" r="1.6" fill="${c.capDark}"/>
  <circle cx="32" cy="20" r="4.2" fill="#FFFFFF"/>
  <path d="M30.1 18.2 h3.8 M32 18.2 v4" stroke="${c.cap}" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M16 26.5 Q32 31.5 48 26.5 Q49.4 28.4 48 30.2 Q32 35.2 16 30.2 Q14.6 28.4 16 26.5 Z" fill="${c.capDark}" stroke="${INK}" stroke-width="1.4"/>`
}

/** 眼睛：0 圓眼加亮點、1 笑眼、2 認真、3 睏睏 */
function eyes(kind: number, dark: boolean): string {
  const ink = dark ? '#FFFFFF' : INK
  return `<g${show(kind === 0)}><circle cx="25.5" cy="37" r="2.6" fill="${INK}"/><circle cx="38.5" cy="37" r="2.6" fill="${INK}"/><circle cx="26.3" cy="36.1" r="0.9" fill="#FFFFFF"/><circle cx="39.3" cy="36.1" r="0.9" fill="#FFFFFF"/></g>
  <g fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round"${show(kind === 1)}><path d="M23 37.8 Q25.5 35 28 37.8"/><path d="M36 37.8 Q38.5 35 41 37.8"/></g>
  <g${show(kind === 2)}><circle cx="25.5" cy="37.4" r="2.2" fill="${INK}"/><circle cx="38.5" cy="37.4" r="2.2" fill="${INK}"/><path d="M22.5 33.6 L28.4 34.8 M41.5 33.6 L35.6 34.8" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/></g>
  <g fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round"${show(kind === 3)}><path d="M23 37.4 h5"/><path d="M36 37.4 h5"/></g>`
}

/** 墨鏡：蓋在眼睛上 */
function shades(look: Outfit): string {
  if (look !== 'shades') return ''
  return `<path d="M20.5 34.2 H29.5 Q29.5 40.5 25 40.5 Q20.5 40.5 20.5 34.2 Z M34.5 34.2 H43.5 Q43.5 40.5 39 40.5 Q34.5 40.5 34.5 34.2 Z" fill="${INK}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M29.5 35.2 Q32 33.8 34.5 35.2" fill="none" stroke="${INK}" stroke-width="1.6"/>
  <path d="M22.5 35.6 L24.5 35.6" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="round" opacity="0.7"/>
  <path d="M36.5 35.6 L38.5 35.6" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="round" opacity="0.7"/>`
}

function cat(id: string, team: AvatarTeam, look: Outfit): string {
  const h = hash(id)
  const at = (n: number, shift: number) => (h >>> shift) % n
  const fur = CAT_FURS[at(CAT_FURS.length, 0)]
  const pattern = at(4, 4) // 0 無、1 虎斑紋、2 單邊色塊（三花）、3 白口罩
  const folded = at(5, 8) === 0 // 少數是摺耳
  const eye = at(4, 11)
  const mouth = at(3, 14) // 0 ω 嘴、1 張嘴、2 小嘴
  const dark = fur === CAT_FURS[2]
  return `<svg viewBox="0 0 64 64" aria-hidden="true">
  ${jersey(team, look)}
  <g${show(!folded)}><path d="M16 30 L15 13 L28 22 Z" fill="${fur.main}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M18 26 L17.5 17 L24.5 22 Z" fill="#FFB3C1"/>
  <path d="M48 30 L49 13 L36 22 Z" fill="${fur.main}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M46 26 L46.5 17 L39.5 22 Z" fill="#FFB3C1"/></g>
  <g${show(folded)}><path d="M15 27 Q15 19 23 21 Q20 25 21 28 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M49 27 Q49 19 41 21 Q44 25 43 28 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/></g>
  <ellipse cx="32" cy="37.5" rx="17" ry="14" fill="${fur.main}" stroke="${INK}" stroke-width="1.6"/>
  <g fill="${fur.dark}"${show(pattern === 1)}><path d="M15.5 36 h5 M15.8 40 h4.5" stroke="${fur.dark}" stroke-width="2" stroke-linecap="round"/><path d="M48.5 36 h-5 M48.2 40 h-4.5" stroke="${fur.dark}" stroke-width="2" stroke-linecap="round"/></g>
  <path d="M32 24 C42 24 48.6 30 49 37 C45 38 40 35 38 31 C36 28 34 26 32 24 Z" fill="${fur.dark}"${show(pattern === 2)}/>
  <path d="M24 44 C24 39 27 37.5 32 37.5 C37 37.5 40 39 40 44 C40 48.5 36 51 32 51 C28 51 24 48.5 24 44 Z" fill="${fur.light}"${show(pattern === 3)}/>
  <ellipse cx="32" cy="44.5" rx="6.5" ry="4.6" fill="${fur.light}" opacity="0.85"/>
  ${eyes(eye, dark)}
  ${shades(look)}
  <circle cx="21.5" cy="42" r="2.4" fill="#FF7A9A" opacity="0.35"/>
  <circle cx="42.5" cy="42" r="2.4" fill="#FF7A9A" opacity="0.35"/>
  <path d="M30.2 41.6 h3.6 L32 43.6 Z" fill="#F07C93" stroke="${INK}" stroke-width="0.9" stroke-linejoin="round"/>
  <path d="M28.6 45 Q30.3 47.2 32 45 Q33.7 47.2 35.4 45" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"${show(mouth === 0)}/>
  <path d="M29.2 44.8 Q32 49.6 34.8 44.8 Z" fill="#B23A4E" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"${show(mouth === 1)}/>
  <path d="M30.5 45.4 Q32 46.4 33.5 45.4" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"${show(mouth === 2)}/>
  <g stroke="${dark ? '#D8D8E6' : INK}" stroke-width="0.9" stroke-linecap="round" opacity="0.6"><path d="M22 43.5 L13.5 42"/><path d="M22 45.5 L14 47"/><path d="M42 43.5 L50.5 42"/><path d="M42 45.5 L50 47"/></g>
  ${cap(team, look)}
</svg>`
}

function dog(id: string, team: AvatarTeam, look: Outfit): string {
  const h = hash(id)
  const at = (n: number, shift: number) => (h >>> shift) % n
  const fur = DOG_FURS[at(DOG_FURS.length, 0)]
  const ears = at(3, 4) // 0 垂耳、1 立耳（柴犬）、2 半垂
  const pattern = at(4, 7) // 0 無、1 單眼眼罩、2 斑點、3 白鼻樑
  const eye = at(4, 10)
  const mouth = at(3, 13) // 0 吐舌、1 微笑、2 張嘴
  const dark = fur === DOG_FURS[2]
  return `<svg viewBox="0 0 64 64" aria-hidden="true">
  ${jersey(team, look)}
  <g${show(ears === 1)}><path d="M17 31 L16 14 L28 23 Z" fill="${fur.main}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M19 27 L18.5 19 L24.5 23.5 Z" fill="${fur.light}"/>
  <path d="M47 31 L48 14 L36 23 Z" fill="${fur.main}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M45 27 L45.5 19 L39.5 23.5 Z" fill="${fur.light}"/></g>
  <ellipse cx="32" cy="38" rx="16" ry="14" fill="${fur.main}" stroke="${INK}" stroke-width="1.6"/>
  <ellipse cx="25.5" cy="36.5" rx="5" ry="5.5" fill="${fur.dark}"${show(pattern === 1)}/>
  <g fill="${fur.dark}"${show(pattern === 2)}><circle cx="41" cy="33" r="2.3"/><circle cx="44" cy="40" r="1.6"/><circle cx="21" cy="42" r="1.8"/></g>
  <path d="M29.5 30 Q32 28.5 34.5 30 L35.5 41 L28.5 41 Z" fill="${fur.light}"${show(pattern === 3)}/>
  <g${show(ears === 0)}><path d="M18 28 C11 29 9 40 12 47 C15 48 18 45 19 40 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M46 28 C53 29 55 40 52 47 C49 48 46 45 45 40 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/></g>
  <g${show(ears === 2)}><path d="M18 27 L13.5 18 L25 22 C22 25 21 28 21 31 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/><path d="M46 27 L50.5 18 L39 22 C42 25 43 28 43 31 Z" fill="${fur.dark}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/></g>
  ${eyes(eye, dark && pattern !== 1)}
  ${shades(look)}
  <ellipse cx="32" cy="45" rx="8.5" ry="6" fill="${fur.light}" stroke="${INK}" stroke-width="1.2"/>
  <ellipse cx="32" cy="42.2" rx="3.4" ry="2.4" fill="${INK}"/>
  <circle cx="31" cy="41.5" r="0.8" fill="#FFFFFF" opacity="0.8"/>
  <path d="M32 44.6 v1.8 M28.8 46.2 Q32 49 35.2 46.2" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"${show(mouth !== 2)}/>
  <path d="M30.2 47.4 Q30.4 52 32.6 51.6 Q34.6 51.2 34 47.2 Z" fill="#FF7A8A" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round"${show(mouth === 0)}/>
  <path d="M28.8 46 Q32 51.5 35.2 46 Z" fill="#B23A4E" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"${show(mouth === 2)}/>
  ${cap(team, look)}
</svg>`
}

/** look：裝扮，沒給的話我方用玩家選的、對手一律標準 */
export function avatarSvg(id: string, team: AvatarTeam, kind: AvatarSpecies = species, look?: Outfit): string {
  const style = look ?? (team === 'user' ? outfit : 'standard')
  return kind === 'dog' ? dog(id, team, style) : cat(id, team, style)
}

export function avatar(id: string, team: AvatarTeam, className = ''): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = `avatar ${className}`
  wrap.innerHTML = avatarSvg(id, team)
  return wrap
}
