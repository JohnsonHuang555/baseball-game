import { batsFor, throwsFor } from '../sim/generate'
import type { Tournament } from '../sim/tournament'

const KEY = 'dice-baseball.tournament.v1'

// 瀏覽器儲存可能被停用（無痕模式、封鎖網站資料），讀寫失敗時就當作沒有存檔

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const t = addMissingFielding(JSON.parse(raw)) as Tournament
    // 打到一半的比賽是舊規則存的，就照舊規則重播，結果才會一樣
    if (t.currentGame && t.currentGame.setup.rules === undefined) t.currentGame.setup.rules = 1
    return t
  } catch {
    return null
  }
}

/** 舊存檔補上後來新增的欄位：打者的守備值（聯盟平均 5）、擊球方向傾向（平均，跟以前的模擬一樣） */
function addMissingFielding(value: unknown): unknown {
  if (Array.isArray(value)) value.forEach(addMissingFielding)
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const ratings = obj.ratings as Record<string, number> | undefined
    if (obj.role === 'batter' && ratings && ratings.fielding === undefined) ratings.fielding = 5
    if (obj.role === 'batter' && obj.tendency === undefined) obj.tendency = 'even'
    // 慣用手由球員編號推算，跟新產生的球員一致
    if (obj.role === 'batter' && obj.bats === undefined) obj.bats = batsFor(obj.id as string)
    if (obj.role === 'pitcher' && obj.throws === undefined) obj.throws = throwsFor(obj.id as string)
    Object.values(obj).forEach(addMissingFielding)
  }
  return value
}

export function saveTournament(t: Tournament): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    // 存不了就算了，遊戲照常進行
  }
}

export function clearTournament(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 同上
  }
}
