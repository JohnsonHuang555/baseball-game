// 球員數據的查詢（畫面用）：統計期間、單一球員、隊內排行。
// 全部由存檔推導（生涯累計、最近比賽的 lines），不重新模擬、不在畫面渲染時改存檔。
import type { ClubSave, SettledMatch } from '../domain/club'
import {
  battingRates,
  careerTotals,
  emptyTotals,
  pitchingRates,
  smallBatSample,
  smallPitSample,
  totalsByPlayer,
  type CareerRecord,
  type Totals,
} from '../domain/stats'

export type StatPeriod = 'last10' | 'last30' | 'career'

export const PERIOD_MATCHES: Record<Exclude<StatPeriod, 'career'>, number> = { last10: 10, last30: 30 }

export interface PeriodInfo {
  period: StatPeriod
  /** 期間裡球團已結算的一般正式比賽（不含晉級挑戰） */
  matches: number
  /** 其中有球員數據的場數（記錄起點之前的比賽沒有） */
  recorded: number
  /** 期間的第一場、最後一場（從 0 數的場次；沒有比賽是 null） */
  fromMatch: number | null
  toMatch: number | null
  /** 記錄起點：0 代表從球團成立就有完整紀錄 */
  sinceMatch: number
}

export interface PeriodTotals {
  info: PeriodInfo
  byPlayer: Map<string, Totals>
}

function windowOf(club: ClubSave, n: number): SettledMatch[] {
  return club.recentMatches.slice(-n)
}

/** 某個期間每位球員的累計 */
export function periodTotals(club: ClubSave, period: StatPeriod): PeriodTotals {
  const sinceMatch = club.stats.sinceMatch
  if (period === 'career') {
    const byPlayer = new Map<string, Totals>()
    for (const [id, rec] of Object.entries(club.stats.players)) byPlayer.set(id, careerTotals(rec))
    const total = club.idle.nextMatchIndex - sinceMatch
    return {
      info: { period, matches: total, recorded: total, fromMatch: total > 0 ? sinceMatch : null, toMatch: total > 0 ? club.idle.nextMatchIndex - 1 : null, sinceMatch },
      byPlayer,
    }
  }
  const matches = windowOf(club, PERIOD_MATCHES[period])
  return {
    info: {
      period,
      matches: matches.length,
      recorded: matches.filter((m) => m.lines).length,
      fromMatch: matches[0]?.matchIndex ?? null,
      toMatch: matches.at(-1)?.matchIndex ?? null,
      sinceMatch,
    },
    byPlayer: totalsByPlayer(matches),
  }
}

export type RosterStatus = 'lineup' | 'bench' | 'starter' | 'bullpen' | 'reserve' | 'released'

/** 球員目前在隊上的位置 */
export function rosterStatus(club: ClubSave, playerId: string): RosterStatus {
  const r = club.roster
  if (r.lineup.some((s) => s.playerId === playerId)) return 'lineup'
  if (r.bench.includes(playerId)) return 'bench'
  if (r.starter === playerId) return 'starter'
  if (r.relievers.includes(playerId)) return 'bullpen'
  if (club.players.some((p) => p.player.id === playerId)) return 'reserve'
  return 'released'
}

export interface PlayerStatsView {
  playerId: string
  name: string
  role: 'batter' | 'pitcher'
  status: RosterStatus
  career?: CareerRecord
  totals: Totals
  info: PeriodInfo
}

/** 一位球員（在隊上或已釋出）在某個期間的數據；從來沒出場的是全部 0 的 Totals（畫面顯示「尚無出賽紀錄」） */
export function playerStats(club: ClubSave, playerId: string, period: StatPeriod): PlayerStatsView | null {
  const record = club.players.find((p) => p.player.id === playerId)
  const career = club.stats.players[playerId]
  if (!record && !career) return null
  const { info, byPlayer } = periodTotals(club, period)
  return {
    playerId,
    name: record?.player.name ?? career!.name,
    role: record?.player.role ?? career!.role,
    status: rosterStatus(club, playerId),
    career,
    totals: byPlayer.get(playerId) ?? emptyTotals(),
    info,
  }
}

// ---- 排行 ----

export type BatSort = 'ops' | 'avg' | 'obp' | 'hr' | 'rbi'
export type PitSort = 'era' | 'whip' | 'k' | 'ip'
export const BAT_SORTS: readonly BatSort[] = ['ops', 'avg', 'obp', 'hr', 'rbi']
export const PIT_SORTS: readonly PitSort[] = ['era', 'whip', 'k', 'ip']
/** 比率指標：樣本不足時不列名次 */
const RATE: ReadonlySet<string> = new Set(['ops', 'avg', 'obp', 'era', 'whip'])
/** 越低越好的指標 */
const LOWER_BETTER: ReadonlySet<string> = new Set(['era', 'whip'])

export const isRateSort = (s: BatSort | PitSort) => RATE.has(s)
export const lowerIsBetter = (s: BatSort | PitSort) => LOWER_BETTER.has(s)

export interface LeaderRow {
  playerId: string
  name: string
  level: number
  status: RosterStatus
  totals: Totals
  /** 這段期間有出場（打者有打席、投手有出局或面對打者） */
  played: boolean
  small: boolean
}

export interface Leaderboard {
  info: PeriodInfo
  /** 有名次的（依排序） */
  ranked: LeaderRow[]
  /** 比率排序時樣本不足：照數值排在後面，不給名次 */
  smallSample: LeaderRow[]
  /** 這段期間沒有出場 */
  none: LeaderRow[]
}

function sortValue(row: LeaderRow, sort: BatSort | PitSort): number | null {
  const { bat, pit } = row.totals
  switch (sort) {
    case 'ops':
      return battingRates(bat).ops
    case 'avg':
      return battingRates(bat).avg
    case 'obp':
      return battingRates(bat).obp
    case 'hr':
      return bat.hr
    case 'rbi':
      return bat.rbi
    case 'era':
      return pitchingRates(pit).era
    case 'whip':
      return pitchingRates(pit).whip
    case 'k':
      return pit.k
    case 'ip':
      return pit.outs
  }
}

/**
 * 隊內排行：只排目前在隊上的球員、只用實際比賽數據（不含能力）。
 * 沒有有效樣本的球員不會因為數字是 0 或 null 排到前面：比率排序時樣本不足另外列、沒出場放最後
 */
export function leaderboard(club: ClubSave, role: 'batter' | 'pitcher', period: StatPeriod, sort: BatSort | PitSort): Leaderboard {
  const { info, byPlayer } = periodTotals(club, period)
  const rows: LeaderRow[] = club.players
    .filter((p) => p.player.role === role)
    .map((p) => {
      const totals = byPlayer.get(p.player.id) ?? emptyTotals()
      const played = role === 'batter' ? totals.bat.pa > 0 : totals.pit.bf + totals.pit.outs > 0
      return {
        playerId: p.player.id,
        name: p.player.name,
        level: p.level,
        status: rosterStatus(club, p.player.id),
        totals,
        played,
        small: played && (role === 'batter' ? smallBatSample(totals.bat) : smallPitSample(totals.pit)),
      }
    })
  const lower = lowerIsBetter(sort)
  const volume = (r: LeaderRow) => (role === 'batter' ? r.totals.bat.pa : r.totals.pit.outs)
  const cmp = (a: LeaderRow, b: LeaderRow) => {
    const va = sortValue(a, sort)
    const vb = sortValue(b, sort)
    // null（分母 0）一律排在有數字的後面
    if (va === null || vb === null) return va === null && vb === null ? 0 : va === null ? 1 : -1
    return (lower ? va - vb : vb - va) || volume(b) - volume(a) || a.name.localeCompare(b.name, 'zh-Hant')
  }
  const played = rows.filter((r) => r.played)
  const none = rows.filter((r) => !r.played).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
  if (!isRateSort(sort)) return { info, ranked: played.sort(cmp), smallSample: [], none }
  return {
    info,
    ranked: played.filter((r) => !r.small && sortValue(r, sort) !== null).sort(cmp),
    smallSample: played.filter((r) => r.small || sortValue(r, sort) === null).sort(cmp),
    none,
  }
}

/** 已經有任何正式比賽數據嗎（畫面的空狀態用） */
export function hasAnyStats(club: ClubSave): boolean {
  return Object.keys(club.stats.players).length > 0
}
