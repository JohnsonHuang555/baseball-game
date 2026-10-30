import type { PregameSetup } from '../sim/setup'
import { OUTFITS, isUnlocked, type Outfit } from './progress'

const TEAM_NAME_KEY = 'dice-baseball.teamName'
export const TEAM_NAME_MAX = 10

// 跟存檔一樣，瀏覽器儲存不能用時就當作沒有設定

/** 玩家自訂的隊名；沒有自訂（或選了隨機隊名）就是 null */
export function loadTeamName(): string | null {
  try {
    return localStorage.getItem(TEAM_NAME_KEY)
  } catch {
    return null
  }
}

export function saveTeamName(name: string | null): void {
  try {
    if (name) localStorage.setItem(TEAM_NAME_KEY, name)
    else localStorage.removeItem(TEAM_NAME_KEY)
  } catch {
    // 記不住就算了
  }
}

const PROMPT_KEY = 'dice-baseball.decisionPrompts'

/** 決策提示頻率：多、少、只提醒換投、關閉 */
export type PromptLevel = 'many' | 'few' | 'pitcher' | 'off'
export const PROMPT_LEVELS: readonly PromptLevel[] = ['few', 'many', 'pitcher', 'off']

export function loadPromptLevel(): PromptLevel {
  try {
    const v = localStorage.getItem(PROMPT_KEY) as PromptLevel | null
    return v && PROMPT_LEVELS.includes(v) ? v : 'few'
  } catch {
    return 'few'
  }
}

export function savePromptLevel(level: PromptLevel): void {
  try {
    localStorage.setItem(PROMPT_KEY, level)
  } catch {
    // 記不住就用預設
  }
}

const SYNERGY_EXPANDED_KEY = 'dice-baseball.synergyExpanded'

/** 手機版佈陣畫面的羈絆晶片有沒有展開全部 */
export function loadSynergyExpanded(): boolean {
  try {
    return localStorage.getItem(SYNERGY_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSynergyExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(SYNERGY_EXPANDED_KEY, expanded ? '1' : '0')
  } catch {
    // 記不住就每次收合
  }
}

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

export function saveAvatarSpecies(species: AvatarSpecies): void {
  try {
    localStorage.setItem(SPECIES_KEY, species)
  } catch {
    // 記不住就用預設
  }
}

const OUTFIT_KEY = 'dice-baseball.outfit'

/** 我方球員頭像的裝扮；沒解鎖（或記錄壞掉）就用標準 */
export function loadOutfit(): Outfit {
  try {
    const v = localStorage.getItem(OUTFIT_KEY) as Outfit | null
    return v && OUTFITS.includes(v) && isUnlocked(v) ? v : 'standard'
  } catch {
    return 'standard'
  }
}

export function saveOutfit(outfit: Outfit): void {
  try {
    localStorage.setItem(OUTFIT_KEY, outfit)
  } catch {
    // 記不住就用預設
  }
}

const MANUAL_KEY = 'dice-baseball.manual'

/** 親自操作：關、只在關鍵時刻、每一球 */
export type ManualMode = 'off' | 'clutch' | 'all'
export const MANUAL_MODES: readonly ManualMode[] = ['off', 'clutch', 'all']

/** 預設「關鍵」，讓新玩家自然碰到親自出手；以前存的「開」就是每一球 */
export function loadManual(): ManualMode {
  try {
    const v = localStorage.getItem(MANUAL_KEY)
    if (v === 'on') return 'all'
    return v === 'off' || v === 'all' ? v : 'clutch'
  } catch {
    return 'clutch'
  }
}

export function saveManual(mode: ManualMode): void {
  try {
    localStorage.setItem(MANUAL_KEY, mode)
  } catch {
    // 記不住就算了
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

/** 新的隊伍套用玩家記住的隊名 */
export function withSavedName(setup: PregameSetup): PregameSetup {
  const name = loadTeamName()
  return name ? { ...setup, team: { ...setup.team, name } } : setup
}
