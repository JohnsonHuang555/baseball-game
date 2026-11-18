// 瀏覽器裡的顯示偏好（不是遊戲進度）：頭像是貓咪還是小狗、我方頭像的裝扮、音效開關。
// 這些 key 是 V1 時期就有的，V2 沿用同樣的值；存檔不能用時就當作沒有設定
const SPECIES_KEY = 'dice-baseball.avatarSpecies'

/** 球員頭像要畫成貓咪還是小狗 */
export type AvatarSpecies = 'cat' | 'dog'

export function loadAvatarSpecies(): AvatarSpecies {
  try {
    return localStorage.getItem(SPECIES_KEY) === 'dog' ? 'dog' : 'cat'
  } catch {
    return 'cat'
  }
}

const OUTFIT_KEY = 'dice-baseball.outfit'

/** 我方球員頭像的裝扮（V1 錦標賽解鎖的；V2 沒有切換入口，只沿用玩家之前選好的） */
export const OUTFITS = ['standard', 'stripes', 'goldCap', 'shades', 'crown', 'gold'] as const
export type Outfit = (typeof OUTFITS)[number]

/** 之前存下的裝扮；記錄壞掉或不認得就用標準。存的時候已經檢查過解鎖，這裡不再讀 V1 的獎盃紀錄 */
export function loadOutfit(): Outfit {
  try {
    const v = localStorage.getItem(OUTFIT_KEY) as Outfit | null
    return v && OUTFITS.includes(v) ? v : 'standard'
  } catch {
    return 'standard'
  }
}

const SOUND_KEY = 'dice-baseball.sound'

/** 音效開關，預設開啟 */
export function loadSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function saveSoundOn(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off')
  } catch {
    // 記不住就用預設
  }
}
