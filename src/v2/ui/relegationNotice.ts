// 降級通知要說什麼（純函式，只讀存檔，不寫入、不影響結算）。
//
// 存檔裡可驗證的降級事件：
// - league.lastRelegation：最近一次降級（從哪一級、到哪一級、哪一場），它的序號就是 league.relegations（累計次數只增不減）
// - recentMatches 裡 ranked.relegatedTo 不是 null 的比賽：每一次降級都存在造成降級的那一場上（只保留最近 50 場）
// - league.challenges：晉級挑戰的紀錄（matchIndexAt 是挑戰當下的結算游標）
//
// 不能從「目前聯盟」與「累計降級次數」反推路徑（玩家可能降級後又晉級，累計次數是歷史，不是這次的變化）。所以：
// 1. 只通知「仍然有效」的最後一次降級：目前聯盟 = lastRelegation.toTier（之後重新晉級過就一定不相等，事件已經過去）
// 2. 沒通知過的事件超過一次時，只把「同一路連續往下降、中間沒有晉級」而且找得到比賽紀錄的事件合併成一個通知；
//    中間有晉級的較早事件是歷史，不合併、不通知；找不到紀錄的（已經超出近期比賽保留範圍）照實說「還有 N 次較早的降級沒有細節」
// 3. 這個裝置沒有通知紀錄時（換裝置、清掉資料），只有最後一次降級發生在最近一次離線結算的範圍內才通知，避免舊事件打斷正常遊玩
import type { ClubSave } from '../domain/club'
import { IDLE_CONFIG } from '../domain/config'

export interface RelegationNotice {
  /** 這次通知涵蓋到的事件序號（= 最後一次降級的累計序號），已讀紀錄寫這個值 */
  seq: number
  /** 合併的連續降級中，最早那一次之前的聯盟 */
  fromTier: number
  /** 現在的聯盟（= 最後一次降級的目的地） */
  toTier: number
  /** 合併的連續降級次數（有比賽紀錄可以驗證的） */
  count: number
  /** 還沒通知、但無法確認是不是同一路連續降級的較早事件數（比賽紀錄已經不在） */
  unverified: number
}

/** 已讀紀錄（localStorage 的 JSON）：{ clubId, count }，count 是已經通知到第幾次降級（沿用 Phase 7B 第一版的格式） */
export interface SeenRelegations {
  clubId: string
  count: number
}

export function parseSeen(raw: string | null, clubId: string): number | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<SeenRelegations>
    return v && v.clubId === clubId && Number.isInteger(v.count) && (v.count as number) >= 0 ? (v.count as number) : null
  } catch {
    return null
  }
}

/**
 * 現在該不該通知降級、通知什麼。seen：這個裝置已經通知到第幾次（null = 沒有紀錄）
 */
export function pendingRelegation(club: ClubSave, seen: number | null): RelegationNotice | null {
  const { league } = club
  const last = league.lastRelegation
  if (!last || league.relegations < 1) return null
  // 已經通知過最後一次
  if (seen !== null && seen >= league.relegations) return null
  // 之後重新晉級過（目前不在降級後的聯盟）：最後一次降級已經是歷史
  if (league.tier !== last.toTier) return null
  // 這個裝置沒有紀錄：只通知最近一次離線結算範圍內發生的降級（更早的當作歷史，不打擾）
  const recent = (matchIndex: number) => seen !== null || club.idle.nextMatchIndex - 1 - matchIndex < IDLE_CONFIG.MAX_BATCH_MATCHES
  if (!recent(last.matchIndex)) return null

  const unseen = league.relegations - (seen ?? 0)
  // 往回找連續往下降、中間沒有晉級的事件（用存下的比賽紀錄驗證）
  const records = club.recentMatches
    .filter((m) => m.ranked?.relegatedTo != null && m.matchIndex <= last.matchIndex)
    .sort((a, b) => b.matchIndex - a.matchIndex)
  const promotedBetween = (from: number, to: number) => league.challenges.some((c) => c.won && c.matchIndexAt > from && c.matchIndexAt <= to)
  let fromTier = last.fromTier
  let count = 1
  let cursor = last.matchIndex
  let broken = false
  for (const m of records) {
    if (count >= unseen) break
    if (m.matchIndex === last.matchIndex) continue
    const r = m.ranked!
    // 不是接在後面那一次之前的降級、中間晉級過、或（沒有紀錄的裝置）不在最近一次離線範圍：更早的都是歷史事件，不合併
    if (r.relegatedTo !== fromTier || promotedBetween(m.matchIndex, cursor) || !recent(m.matchIndex)) {
      broken = true
      break
    }
    fromTier = r.tier
    cursor = m.matchIndex
    count++
  }
  // 還有沒通知的事件、但近期比賽裡已經找不到：它們一定比保留的最舊一場更早。
  // 如果在那之後有晉級過，它們跟這次一定不連續（歷史事件，不通知）；否則無法確認路徑，照實說有幾次沒有細節
  if (seen === null) broken = true
  if (!broken && count < unseen) {
    const oldest = club.recentMatches.length ? Math.min(...club.recentMatches.map((m) => m.matchIndex)) : cursor
    if (promotedBetween(oldest - 1, cursor)) broken = true
  }
  const unverified = broken ? 0 : Math.max(0, unseen - count)
  return { seq: league.relegations, fromTier, toTier: last.toTier, count, unverified }
}
