import { archetypeFromRatings, batsFor, primaryFor, throwsFor } from '../sim/generate'
import type { BatterRatings } from '../sim/types'
import type { Tournament } from '../sim/tournament'

const KEY = 'dice-baseball.tournament.v2'
/** 改版前（16 隊單淘汰）的存檔，結構完全不同，不能繼續（ADR-0005） */
const OLD_KEY = 'dice-baseball.tournament.v1'

// 瀏覽器儲存可能被停用（無痕模式、封鎖網站資料），讀寫失敗時就當作沒有存檔

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const t = addMissingFields(JSON.parse(raw)) as Tournament
    if (t.version !== 2) return null
    // 打到一半的比賽是舊規則存的，就照舊規則重播，結果才會一樣
    if (t.currentGame && t.currentGame.setup.rules === undefined) t.currentGame.setup.rules = 1
    return t
  } catch {
    return null
  }
}

/** 有舊版的錦標賽存檔就清掉，回傳有沒有清（首頁提示一次） */
export function discardOldTournament(): boolean {
  try {
    if (localStorage.getItem(OLD_KEY) === null) return false
    localStorage.removeItem(OLD_KEY)
    return true
  } catch {
    return false
  }
}

/**
 * 舊存檔補上後來新增的欄位：打者的守備值（聯盟平均 5）、擊球方向傾向（平均，跟以前的模擬一樣）、本職守位。
 * 自製球隊和傳奇館的球員也用這個補
 */
export function addMissingFields(value: unknown): unknown {
  if (Array.isArray(value)) value.forEach(addMissingFields)
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // 先發陣容裡的人把目前的守位當本職，打到一半的錦標賽才不會突然一堆人守非本職
    const spotPlayer = obj.player as Record<string, unknown> | undefined
    if (spotPlayer?.role === 'batter' && spotPlayer.primary === undefined && typeof obj.position === 'string' && obj.position !== 'DH') spotPlayer.primary = obj.position
    const ratings = obj.ratings as Record<string, number> | undefined
    if (obj.role === 'batter' && ratings && ratings.fielding === undefined) ratings.fielding = 5
    if (obj.role === 'batter' && obj.tendency === undefined) obj.tendency = 'even'
    // 慣用手由球員編號推算，跟新產生的球員一致
    if (obj.role === 'batter' && obj.bats === undefined) obj.bats = batsFor(obj.id as string)
    if (obj.role === 'pitcher' && obj.throws === undefined) obj.throws = throwsFor(obj.id as string)
    if (obj.role === 'batter' && obj.primary === undefined) obj.primary = primaryFor(obj.id as string)
    if (obj.role === 'batter' && obj.archetype === undefined) obj.archetype = archetypeFromRatings(ratings as unknown as BatterRatings)
    Object.values(obj).forEach(addMissingFields)
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
