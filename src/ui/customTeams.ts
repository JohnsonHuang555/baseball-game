// 自由練習的自製球隊：存在這台裝置上，可以存好幾隊；比賽結果完全不記錄
import type { Team } from '../sim/types'

const KEY = 'dice-baseball.customTeams'

export interface CustomTeam {
  id: string
  team: Team
  /** 最後修改時間（ISO 字串），列表新的在前 */
  updatedAt: string
}

function load(): CustomTeam[] {
  try {
    const raw = localStorage.getItem(KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? (list as CustomTeam[]) : []
  } catch {
    return []
  }
}

function save(list: CustomTeam[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // 存不了就只在這次開著的時候有效
  }
}

/** 自製球隊，最近修改的在前 */
export function customTeams(): CustomTeam[] {
  return [...load()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 新增或更新一隊（同一個 id 就覆蓋） */
export function saveCustomTeam(team: Team, id = newId()): CustomTeam {
  const entry: CustomTeam = { id, team, updatedAt: new Date().toISOString() }
  save([...load().filter((x) => x.id !== id), entry])
  return entry
}

export function deleteCustomTeam(id: string): void {
  save(load().filter((x) => x.id !== id))
}

function newId(): string {
  return `ct-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}
