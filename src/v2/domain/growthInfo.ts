// 成長回饋（Phase 6C）用的純函式：球隊戰力、升級後的戰力、最近 10 場與前 10 場的戰績對照。
// 只用存檔裡已經有的資料，不重新模擬、不推論因果。
import { overall } from '../../sim/generate'
import type { ClubSave, PlayerRecord } from './club'
import { leveled, upgradeCost } from './progression'
import { assignedIds, resolveRoster } from './roster'

/** 上場 14 人（先發、板凳、投手）的平均能力，含養成 */
export function teamPower(club: Pick<ClubSave, 'players' | 'roster'>): number {
  const r = resolveRoster(club)
  const players = [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers]
  return players.reduce((sum, p) => sum + overall(p), 0) / players.length
}

/**
 * 某位球員升到 level 之後的球隊戰力；不在上場名單（預備球員）就是 null（升級不會改變目前的戰力）。
 * 用的是跟比賽相同的養成公式（progression.ts 的 leveled），不改輸入
 */
export function teamPowerIf(club: Pick<ClubSave, 'players' | 'roster'>, playerId: string, level: number): number | null {
  if (!assignedIds(club.roster).has(playerId)) return null
  const players = club.players.map((r) => (r.player.id === playerId ? { ...r, level } : r))
  return teamPower({ players, roster: club.roster })
}

export interface FormWindow {
  wins: number
  losses: number
}

export interface RecentForm {
  /** 最近 10 場 */
  last: FormWindow
  /** 再往前 10 場；不足 10 場、或兩段不在同一個聯盟（對手強度不同，不能比）就是 null */
  previous: FormWindow | null
}

const WINDOW = 10

/** 最近 10 場與前 10 場的戰績（近期比賽紀錄，舊的在前）；最近不到 10 場就是 null */
export function recentForm(club: Pick<ClubSave, 'recentMatches'>): RecentForm | null {
  const ms = club.recentMatches
  if (ms.length < WINDOW) return null
  const tally = (xs: typeof ms): FormWindow => ({ wins: xs.filter((m) => m.result.won).length, losses: xs.filter((m) => !m.result.won).length })
  const last = ms.slice(-WINDOW)
  const prev = ms.length >= WINDOW * 2 ? ms.slice(-WINDOW * 2, -WINDOW) : null
  const tier = (m: (typeof ms)[number]) => m.result.leagueTier ?? 0
  const sameLeague = prev !== null && [...prev, ...last].every((m) => tier(m) === tier(last[0]))
  return { last: tally(last), previous: prev && sameLeague ? tally(prev) : null }
}

/** 升一級的效益：整體能力（overall）提升多少、要多少經驗；已經滿級是 null */
export function upgradeEfficiency(record: PlayerRecord): { gain: number; experience: number; per100: number } | null {
  const cost = upgradeCost(record.level)
  if (!cost) return null
  const gain = overall(leveled(record.player, record.level + 1)) - overall(leveled(record.player, record.level))
  return { gain, experience: cost.experience, per100: (gain / cost.experience) * 100 }
}

/**
 * 上場球員裡，同樣的經驗能換到「明顯更多」（至少 2 倍）能力提升的那一位；沒有就是 null。
 * 成長是前快後慢、成本是前低後高，所以先升等級低的球員通常比較划算（見 docs/balance/v2-phase6c-report.md）
 */
export function betterUpgrade(club: Pick<ClubSave, 'players' | 'roster'>, playerId: string): { playerId: string; name: string; level: number; ratio: number } | null {
  const self = club.players.find((r) => r.player.id === playerId)
  const mine = self && upgradeEfficiency(self)
  if (!mine || mine.per100 <= 0) return null
  const active = assignedIds(club.roster)
  let best: { playerId: string; name: string; level: number; ratio: number } | null = null
  for (const r of club.players) {
    if (r.player.id === playerId || !active.has(r.player.id)) continue
    const e = upgradeEfficiency(r)
    if (!e) continue
    const ratio = e.per100 / mine.per100
    if (ratio >= 2 && (!best || ratio > best.ratio)) best = { playerId: r.player.id, name: r.player.name, level: r.level, ratio }
  }
  return best
}
