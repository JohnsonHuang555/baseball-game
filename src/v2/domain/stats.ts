// 球員比賽數據（Phase 8）：每場的精簡原始數據、生涯累計、期間聚合與比率公式。
// 規格見 docs/phase8-statistics-spec.md。近期、生涯、排行、戰報全部用這裡的同一組函式，結果不會互相矛盾。
//
// 存檔只存「計數」，比率每次從累積值重算（不平均每場的比率）。分母是 0 的比率是 null，畫面顯示「—」。
import { emptyBatting, emptyPitching, type BattingCounts, type PitchingCounts, type ScoreLine } from '../../sim/scoring'

export type { BattingCounts, PitchingCounts } from '../../sim/scoring'

/**
 * 存檔裡的欄位順序：常見的在前、幾乎都是 0 的在後，每列結尾連續的 0 省略不存。
 * 改順序等於改存檔格式，只能加在最後面
 */
export const BAT_STORE = ['pa', 'ab', 'h', 'd', 't', 'hr', 'r', 'rbi', 'bb', 'so', 'ibb', 'sf', 'sh', 'gidp', 'roe', 'hbp'] as const satisfies readonly (keyof BattingCounts)[]
export const PIT_STORE = ['bf', 'outs', 'h', 'hr', 'r', 'er', 'bb', 'k', 'ibb', 'hbp'] as const satisfies readonly (keyof PitchingCounts)[]

/** 一場比賽一位打者：[playerId, ...BAT_STORE 的計數（結尾的 0 省略）] */
export type BatRow = [playerId: string, ...counts: number[]]
/** 一場比賽一位投手：[playerId, ...PIT_STORE 的計數（結尾的 0 省略）] */
export type PitRow = [playerId: string, ...counts: number[]]

/** 一場比賽我方每位有出場球員的原始數據（schemaVersion 10 起的比賽才有） */
export interface MatchLines {
  bat: BatRow[]
  pit: PitRow[]
}

/** 一位球員的生涯累計（只算記錄起點之後的正式一般比賽） */
export interface CareerRecord {
  /** 最後一次出場時的名字（球員被釋出後，戰報與詳情仍然叫得出名字） */
  name: string
  role: 'batter' | 'pitcher'
  /** 打者出場數、打擊計數（BAT_STORE 順序、完整長度）；沒當過打者是 null */
  bg: number
  bat: number[] | null
  /** 投手登板數、投球計數（PIT_STORE 順序、完整長度）；沒登板過是 null */
  pg: number
  pit: number[] | null
  /** 第一次、最後一次出場的場次 */
  first: number
  last: number
  /** 被釋出時的結算游標；還在隊上是 undefined */
  releasedAt?: number
}

/** 球團的球員數據（ClubSave.stats） */
export interface ClubStats {
  /** 從第幾場開始記錄：新球團是 0；從 V9 遷移的存檔是遷移當時的 nextMatchIndex（之前的比賽不回填） */
  sinceMatch: number
  /** 生涯已經算到第幾場（不含）：一定等於 idle.nextMatchIndex，同一場不會累加兩次 */
  throughMatch: number
  players: Record<string, CareerRecord>
}

/** 已釋出、而且最近 50 場都沒出現的球員，最多保留幾位的生涯紀錄（最早釋出的先刪） */
export const RELEASED_STATS_LIMIT = 60

export const newClubStats = (sinceMatch = 0): ClubStats => ({ sinceMatch, throughMatch: sinceMatch, players: {} })

// ---- 編碼 ----

function encode<K extends string>(keys: readonly K[], counts: Record<K, number>): number[] {
  const out = keys.map((k) => counts[k])
  while (out.length > 0 && out[out.length - 1] === 0) out.pop()
  return out
}

function decode<K extends string, T extends Record<K, number>>(keys: readonly K[], values: readonly number[], empty: () => T): T {
  const out = empty()
  keys.forEach((k, i) => {
    ;(out as Record<K, number>)[k] = values[i] ?? 0
  })
  return out
}

export const batRow = (id: string, b: BattingCounts): BatRow => [id, ...encode(BAT_STORE, b)]
export const pitRow = (id: string, p: PitchingCounts): PitRow => [id, ...encode(PIT_STORE, p)]
export const batOf = (row: readonly number[]): BattingCounts => decode(BAT_STORE, row, emptyBatting)
export const pitOf = (row: readonly number[]): PitchingCounts => decode(PIT_STORE, row, emptyPitching)

/** 由整場的記分取出我方球員（ids 依出場順序） */
export function matchLinesOf(stats: Readonly<Record<string, ScoreLine>>, ids: readonly string[]): MatchLines {
  const bat: BatRow[] = []
  const pit: PitRow[] = []
  for (const id of ids) {
    const line = stats[id]
    if (!line) continue
    if (line.batting) bat.push(batRow(id, line.batting))
    if (line.pitching) pit.push(pitRow(id, line.pitching))
  }
  return { bat, pit }
}

// ---- 累加 ----

function addInto(target: number[], values: readonly number[], length: number): number[] {
  const out = target.length === length ? [...target] : Array.from({ length }, (_, i) => target[i] ?? 0)
  values.forEach((v, i) => {
    out[i] += v
  })
  return out
}

/**
 * 把一場比賽記進生涯。matchIndex 一定要等於 throughMatch（同一場不會記兩次，跳號直接報錯）。
 * names、roles 是球員目前的名字與角色（找不到就沿用生涯裡的）
 */
export function addMatchToCareer(stats: ClubStats, matchIndex: number, lines: MatchLines, info: (id: string) => { name: string; role: 'batter' | 'pitcher' } | undefined): ClubStats {
  if (matchIndex !== stats.throughMatch) throw new RangeError(`球員數據應該記第 ${stats.throughMatch} 場，收到第 ${matchIndex} 場`)
  const players = { ...stats.players }
  const touch = (id: string): CareerRecord => {
    const prev = players[id]
    const now = info(id)
    const rec: CareerRecord = prev
      ? { ...prev, name: now?.name ?? prev.name, role: now?.role ?? prev.role, last: matchIndex }
      : { name: now?.name ?? id, role: now?.role ?? 'batter', bg: 0, bat: null, pg: 0, pit: null, first: matchIndex, last: matchIndex }
    players[id] = rec
    return rec
  }
  for (const [id, ...counts] of lines.bat) {
    const rec = touch(id)
    rec.bg++
    rec.bat = addInto(rec.bat ?? [], counts, BAT_STORE.length)
  }
  for (const [id, ...counts] of lines.pit) {
    const rec = touch(id)
    rec.pg++
    rec.pit = addInto(rec.pit ?? [], counts, PIT_STORE.length)
  }
  return { ...stats, throughMatch: matchIndex + 1, players }
}

/** 球員被釋出：生涯紀錄留著（唯讀），標上釋出的時間點 */
export function markReleased(stats: ClubStats, playerId: string, atMatch: number): ClubStats {
  const rec = stats.players[playerId]
  if (!rec || rec.releasedAt !== undefined) return stats
  return { ...stats, players: { ...stats.players, [playerId]: { ...rec, releasedAt: atMatch } } }
}

/**
 * 控制存檔大小：已釋出、而且最近的比賽裡已經不會出現的球員，只保留最近 RELEASED_STATS_LIMIT 位。
 * referenced 是最近比賽（戰報）裡還找得到的球員，永遠保留
 */
export function pruneReleased(stats: ClubStats, referenced: ReadonlySet<string>, limit = RELEASED_STATS_LIMIT): ClubStats {
  const gone = Object.entries(stats.players)
    .filter(([id, r]) => r.releasedAt !== undefined && !referenced.has(id))
    .sort(([, a], [, b]) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0) || b.last - a.last)
  if (gone.length <= limit) return stats
  const players = { ...stats.players }
  for (const [id] of gone.slice(limit)) delete players[id]
  return { ...stats, players }
}

// ---- 聚合 ----

/** 一段期間的累計 */
export interface Totals {
  /** 打者出場、投手登板數 */
  g: number
  gp: number
  bat: BattingCounts
  pit: PitchingCounts
}

export const emptyTotals = (): Totals => ({ g: 0, gp: 0, bat: emptyBatting(), pit: emptyPitching() })

/** 生涯 → Totals */
export function careerTotals(rec: CareerRecord | undefined): Totals {
  if (!rec) return emptyTotals()
  return { g: rec.bg, gp: rec.pg, bat: batOf(rec.bat ?? []), pit: pitOf(rec.pit ?? []) }
}

/** 多場比賽的精簡數據 → 每位球員的 Totals（只算有 lines 的比賽） */
export function totalsByPlayer(matches: readonly { lines?: MatchLines }[]): Map<string, Totals> {
  const out = new Map<string, Totals>()
  const get = (id: string) => {
    let t = out.get(id)
    if (!t) out.set(id, (t = emptyTotals()))
    return t
  }
  for (const m of matches) {
    if (!m.lines) continue
    for (const [id, ...counts] of m.lines.bat) {
      const t = get(id)
      t.g++
      const b = batOf(counts)
      for (const k of BAT_STORE) t.bat[k] += b[k]
    }
    for (const [id, ...counts] of m.lines.pit) {
      const t = get(id)
      t.gp++
      const p = pitOf(counts)
      for (const k of PIT_STORE) t.pit[k] += p[k]
    }
  }
  return out
}

// ---- 公式 ----

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null)

export interface BattingRates {
  singles: number
  tb: number
  avg: number | null
  obp: number | null
  slg: number | null
  ops: number | null
}

/** AVG = H/AB；OBP = (H+BB+HBP)/(AB+BB+HBP+SF)；SLG = TB/AB；OPS = OBP+SLG；分母 0 → null */
export function battingRates(b: BattingCounts): BattingRates {
  const singles = b.h - b.d - b.t - b.hr
  const tb = singles + 2 * b.d + 3 * b.t + 4 * b.hr
  const avg = ratio(b.h, b.ab)
  const obp = ratio(b.h + b.bb + b.hbp, b.ab + b.bb + b.hbp + b.sf)
  const slg = ratio(tb, b.ab)
  return { singles, tb, avg, obp, slg, ops: obp === null || slg === null ? null : obp + slg }
}

export interface PitchingRates {
  /** 數學上的局數（Outs / 3） */
  ip: number
  era: number | null
  whip: number | null
}

/** ERA = ER×27/Outs；WHIP = (BB+H)×3/Outs；Outs 是 0 → null */
export function pitchingRates(p: PitchingCounts): PitchingRates {
  return { ip: p.outs / 3, era: ratio(p.er * 27, p.outs), whip: ratio((p.bb + p.h) * 3, p.outs) }
}

// ---- 樣本 ----

/** 樣本門檻：打席、出局數低於這個數，比率標「樣本少」、排行比率排序時不列名次 */
export const SAMPLE_CONFIG = { minPa: 20, minOuts: 30 } as const

export const smallBatSample = (b: BattingCounts) => b.pa < SAMPLE_CONFIG.minPa
export const smallPitSample = (p: PitchingCounts) => p.outs < SAMPLE_CONFIG.minOuts

// ---- 顯示 ----

/** 打擊率格式：.312、1.000；null 是「—」 */
export function fmtRate(v: number | null): string {
  if (v === null) return '—'
  const s = (Math.round(v * 1000) / 1000).toFixed(3)
  return s.startsWith('0.') ? s.slice(1) : s
}

/** 防禦率、WHIP：2 位小數；null 是「—」 */
export const fmtEra = (v: number | null): string => (v === null ? '—' : v.toFixed(2))

/** 局數的棒球寫法：出局數 7 → 「2.1」（2 又 1/3 局，不是 2.1 局） */
export const fmtIp = (outs: number): string => `${Math.floor(outs / 3)}.${outs % 3}`
