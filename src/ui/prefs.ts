import type { PregameSetup } from '../sim/setup'

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

/** 新的隊伍套用玩家記住的隊名 */
export function withSavedName(setup: PregameSetup): PregameSetup {
  const name = loadTeamName()
  return name ? { ...setup, team: { ...setup.team, name } } : setup
}
