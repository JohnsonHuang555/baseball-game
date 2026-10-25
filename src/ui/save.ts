import type { Tournament } from '../sim/tournament'

const KEY = 'dice-baseball.tournament.v1'

// 瀏覽器儲存可能被停用（無痕模式、封鎖網站資料），讀寫失敗時就當作沒有存檔

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (addMissingFielding(JSON.parse(raw)) as Tournament) : null
  } catch {
    return null
  }
}

/** 加入守備能力之前的存檔，打者沒有守備值；補上聯盟平均 5 */
function addMissingFielding(value: unknown): unknown {
  if (Array.isArray(value)) value.forEach(addMissingFielding)
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const ratings = obj.ratings as Record<string, number> | undefined
    if (obj.role === 'batter' && ratings && ratings.fielding === undefined) ratings.fielding = 5
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
