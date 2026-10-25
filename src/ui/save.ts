import type { Tournament } from '../sim/tournament'

const KEY = 'dice-baseball.tournament.v1'

// 瀏覽器儲存可能被停用（無痕模式、封鎖網站資料），讀寫失敗時就當作沒有存檔

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Tournament) : null
  } catch {
    return null
  }
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
