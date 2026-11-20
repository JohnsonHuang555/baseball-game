// 單場 MVP 與永久能力成長（Phase 9 PR 4）。全部是純函式、確定性：不用 Math.random、不讀時間、不消耗比賽亂數。
//
// 資料來源（只用正式結算的資料，不推測、不倒算）：
// - 該場的 Phase 8 精簡數據 lines（打者：pa ab h d t hr r rbi bb so ibb sf sh gidp roe hbp；投手：bf outs h hr r er bb k ibb hbp）
// - 從正式事件流收集的 MvpFacts（matchRunner）：我方每位跑者的盜壘成功／失敗、勝利打點的打者
// 評分公式、權重、同分規則、成長規則都集中在這裡；戰報、球員詳情、平衡腳本都呼叫這裡，不另寫一套。
import type { Batter, BatterRatings, Pitcher, PitcherRatings, Player } from '../../sim/types'
import { ARCHETYPE_STAT } from '../../sim/generate'
import type { PlayerRecord } from './club'
import { leveled, MAX_LEVEL } from './progression'
import { MAX_RATING } from './progressionConfig'
import { batOf, pitOf, type BattingCounts, type MatchLines, type PitchingCounts } from './stats'

// ---- 設定（整數：千分之一分；平衡見 docs/balance/v2-phase9-mvp.md） ----

export const MVP_CONFIG = {
  /** 打者：線性得分權重（千分之一分）。各種安打互斥：一壘安打 = 安打 − 二壘 − 三壘 − 全壘打 */
  batter: {
    single: 900,
    double: 1250,
    triple: 1600,
    homeRun: 2000,
    /** 四壞（含故意四壞）、觸身（引擎沒有觸身，永遠是 0） */
    walk: 700,
    /** 出局：打數 − 安打（含三振、失誤上壘）＋ 高飛犧牲打；雙殺打多算一個出局。犧牲觸擊不算（教練的戰術） */
    out: -270,
    rbi: 100,
    run: 0,
    steal: 200,
    caughtStealing: -400,
  },
  /**
   * 投手：(出局數 × 聯盟每出局平均自責分 − 自責分) × 尺度，也就是「比平均少丟幾分」：平均水準的先發接近 0 分，好的先發才會高。
   * 兩個數字都是量出來的，不是硬性補丁（balance:v2:mvp 的 A 節）：
   * - runsPerOut：4,800 場（八種隊伍 × 四種戰術）量到的每出局自責分 0.108（每 9 局 2.92 分）
   * - scale：每場我方打者評分加總對得分回歸的斜率 1.48（R² 0.76）＝打者「多得一分」值 1.48 評分；投手「少失一分」用同一個價值
   * 三振不另外加分：三振已經反映在出局數與自責分裡
   */
  pitcher: {
    /** 聯盟平均每個出局的自責分（千分之一分） */
    runsPerOut: 108,
    /** 「少失一分」值多少評分（千分之一倍） */
    scale: 1480,
    strikeout: 0,
  },
  /** 每幾次 MVP 成長一次 */
  perGrowth: 10,
  /** 每次成長的單位：1 單位 = 能力 +0.1 */
  unitValue: 0.1,
  /** 一名球員 MVP 成長的總上限（單位）：5 = +0.5 */
  maxUnits: 5,
} as const

/**
 * 可調的規則（平衡腳本比較「有／沒有 MVP 成長」、Golden 測試證明「沒有成長時結果跟以前一模一樣」用；遊戲裡就是預設值）。
 * growth = false：照樣選 MVP、累計次數，但不給能力成長
 */
export const MVP_RULES = { growth: true }

export type BatterRatingKey = keyof BatterRatings
export type PitcherRatingKey = keyof PitcherRatings
export type RatingKey = BatterRatingKey | PitcherRatingKey

// ---- 單場事實 ----

/** 從正式事件流收集、lines 沒有的資料（matchRunner 產生；只包含我方） */
export interface MvpFacts {
  /** 跑者 → [盜壘成功, 盜壘失敗] */
  steals: Record<string, [number, number]>
  /**
   * 勝利打點：贏球時，取得「之後沒再被追平」領先的那一個打席的打者（安打、四壞、出局皆可，失誤與雙殺不算）。
   * 輸球、或領先是靠失誤／雙殺取得的：null
   */
  winningRbi: string | null
}

export interface MvpCandidate {
  id: string
  role: 'batter' | 'pitcher'
  /** 評分（千分之一分，整數；不會有浮點誤差） */
  score: number
  /** 勝利打點（同分時的第一個比較） */
  key: boolean
  /** 打者的總壘打數；投手的出局數（同角色同分時比較） */
  volume: number
  /** 在名單裡的順序：先發打序、替補，投手是先發、牛棚（同分時比較） */
  order: number
}

// ---- 評分 ----

export function batterScore(b: BattingCounts, steals: readonly [number, number] = [0, 0]): number {
  const w = MVP_CONFIG.batter
  const singles = b.h - b.d - b.t - b.hr
  const outs = b.ab - b.h + b.sf + b.gidp
  return (
    singles * w.single +
    b.d * w.double +
    b.t * w.triple +
    b.hr * w.homeRun +
    (b.bb + b.hbp) * w.walk +
    outs * w.out +
    b.rbi * w.rbi +
    b.r * w.run +
    steals[0] * w.steal +
    steals[1] * w.caughtStealing
  )
}

export function pitcherScore(p: PitchingCounts): number {
  const w = MVP_CONFIG.pitcher
  // 整數運算：(outs × runsPerOut − er × 1000) × scale / 1000，再四捨五入成整數
  return Math.round(((p.outs * w.runsPerOut - p.er * 1000) * w.scale) / 1000) + p.k * w.strikeout
}

/** 總壘打數 */
export const totalBases = (b: BattingCounts) => b.h + b.d + 2 * b.t + 3 * b.hr

/**
 * 這場我方每一位有出場的球員（打者有打擊列、投手有投球列）的評分。
 * 打者與投手都能得獎，替補、代跑、後援都算。一位球員同時有打擊與投球列時各自評分，取較高的一個
 */
export function mvpCandidates(lines: MatchLines, facts: MvpFacts | null): MvpCandidate[] {
  const out = new Map<string, MvpCandidate>()
  const put = (c: MvpCandidate) => {
    const prev = out.get(c.id)
    if (!prev || compareCandidates(c, prev) < 0) out.set(c.id, c)
  }
  lines.bat.forEach(([id, ...counts], i) => {
    const b = batOf(counts)
    put({ id, role: 'batter', score: batterScore(b, facts?.steals[id] ?? [0, 0]), key: facts?.winningRbi === id, volume: totalBases(b), order: i })
  })
  lines.pit.forEach(([id, ...counts], i) => {
    const p = pitOf(counts)
    put({ id, role: 'pitcher', score: pitcherScore(p), key: false, volume: p.outs, order: i })
  })
  return [...out.values()]
}

/**
 * 同分規則（依序）：
 * 1. 評分高的
 * 2. 有勝利打點的
 * 3. 同角色：打者比總壘打、投手比出局數；跨角色不比（數字意義不同）
 * 4. 跨角色：打者優先（固定規則，只在評分到千分之一分都相同、也都沒有勝利打點時才用到）；
 *    同角色：名單順序前面的（先發打序、先發投手）
 * 5. 球員編號字典序（保證一定分得出來）
 */
export function compareCandidates(a: MvpCandidate, b: MvpCandidate): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.key !== b.key) return a.key ? -1 : 1
  if (a.role === b.role) {
    if (a.volume !== b.volume) return b.volume - a.volume
    if (a.order !== b.order) return a.order - b.order
  } else return a.role === 'batter' ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export class MvpError extends Error {
  override name = 'MvpError'
}

/**
 * 這場的 MVP。正式新比賽一定有我方球員的數據；沒有就是資料異常，丟錯（不默默指定第一位球員）。
 * 舊比賽（沒有 lines）不要呼叫這裡：畫面顯示「未記錄」
 */
export function selectMvp(lines: MatchLines | undefined, facts: MvpFacts | null): MvpCandidate {
  if (!lines || (lines.bat.length === 0 && lines.pit.length === 0)) throw new MvpError('這場沒有我方球員的數據，無法選出 MVP')
  const all = mvpCandidates(lines, facts)
  for (const c of all) if (!Number.isSafeInteger(c.score)) throw new MvpError(`MVP 評分不合法：${c.id} ${c.score}`)
  return all.sort(compareCandidates)[0]
}

// ---- 永久成長 ----

/** PlayerRecord.mvp：生涯 MVP 次數與每一次能力成長（最多 maxUnits 筆，每筆 +0.1） */
export interface MvpRecord {
  /** 生涯 MVP 次數（達到成長上限後仍繼續累計，當作榮譽紀錄） */
  count: number
  /** 每次成長：哪一項能力、第幾場結算後（從下一場起生效） */
  grants: { rating: RatingKey; atMatch: number }[]
}

export const mvpUnits = (r: Pick<PlayerRecord, 'mvp'>): number => r.mvp?.grants.length ?? 0

/** MVP 加成（單位）：每項能力幾個 +0.1 */
export function mvpBonusUnits(r: Pick<PlayerRecord, 'mvp'>): Partial<Record<RatingKey, number>> {
  const out: Partial<Record<RatingKey, number>> = {}
  for (const g of r.mvp?.grants ?? []) out[g.rating] = (out[g.rating] ?? 0) + 1
  return out
}

/** 距離下一次成長還差幾次 MVP；已達上限是 null */
export function mvpToNext(r: Pick<PlayerRecord, 'mvp'>): number | null {
  if (mvpUnits(r) >= MVP_CONFIG.maxUnits) return null
  return MVP_CONFIG.perGrowth - ((r.mvp?.count ?? 0) % MVP_CONFIG.perGrowth)
}

/** 小數兩位（跟 leveled 一致），避免 0.1 反覆相加的浮點誤差：加成以整數單位存，套用時一次換算 */
const round2 = (x: number) => Math.round(x * 100) / 100

/** 套用 MVP 加成：有效能力 = min(10, 等級後能力 + 單位 × 0.1)。原生 Lv.1 能力不改 */
export function withMvpBonus<P extends Player>(player: P, record: Pick<PlayerRecord, 'mvp'>): P {
  if (!record.mvp?.grants.length) return player
  const bonus = mvpBonusUnits(record)
  const ratings: Record<string, number> = { ...player.ratings }
  for (const [k, units] of Object.entries(bonus)) {
    if (!(k in ratings)) continue
    ratings[k] = Math.min(MAX_RATING, round2(ratings[k] + units! * MVP_CONFIG.unitValue))
  }
  return { ...player, ratings } as P
}

/** 這個角色可以成長的能力（不發明新屬性） */
export const ratingKeysOf = (role: Player['role']): RatingKey[] => (role === 'batter' ? ['contact', 'power', 'speed', 'fielding'] : ['stuff', 'control', 'stamina'])

/**
 * 下一次成長給哪一項能力（確定性、可解釋、沒有亂數）：
 * - 用「Lv.20 滿級能力 ＋ 已有的 MVP 加成」判斷還有沒有空間（≤ 9.9），避免日後升級後加成被上限 10 吃掉
 * - 打者：流派的主要能力（力量→長打、速度→速度、技巧→打擊、防守→守備）；滿了就換其他能力裡最高的（同分依打擊、長打、速度、守備）
 * - 投手：球威、控球之中較低的一項（補短板；同分取球威）；兩項都滿了才給體力
 * 全部能力都沒有空間：回傳 null（這次不成長，不浪費）
 */
export function nextGrowthRating(record: Pick<PlayerRecord, 'player' | 'mvp'>): RatingKey | null {
  const p = record.player
  const top = withMvpBonus(leveled(p, MAX_LEVEL), record).ratings as unknown as Record<string, number>
  const room = (k: RatingKey) => round2(top[k] + MVP_CONFIG.unitValue) <= MAX_RATING
  if (p.role === 'batter') {
    const primary = ARCHETYPE_STAT[(p as Batter).archetype]
    if (room(primary)) return primary
    const order: BatterRatingKey[] = ['contact', 'power', 'speed', 'fielding']
    const others = order.filter((k) => k !== primary && room(k)).sort((a, b) => top[b] - top[a] || order.indexOf(a) - order.indexOf(b))
    return others[0] ?? null
  }
  const r = (p as Pitcher).ratings
  const pair: PitcherRatingKey[] = r.control < r.stuff ? ['control', 'stuff'] : ['stuff', 'control']
  // 比的是目前（Lv.20）的高低：較低的那一項先補
  pair.sort((a, b) => top[a] - top[b] || (a === 'stuff' ? -1 : 1))
  for (const k of [...pair, 'stamina' as const]) if (room(k)) return k
  return null
}

export interface MvpAward {
  playerId: string
  /** 這次之後的生涯 MVP 次數 */
  count: number
  /** 這次觸發的能力成長（沒有就 null） */
  growth: RatingKey | null
}

/**
 * 記一次 MVP（不改輸入）：次數 +1；達到 10 的倍數且還沒到成長上限，就加一筆成長（從下一場起生效）。
 * 到達上限之後仍然累計次數
 */
export function awardMvp(record: PlayerRecord, matchIndex: number): { record: PlayerRecord; award: MvpAward } {
  const prev = record.mvp ?? { count: 0, grants: [] }
  const count = prev.count + 1
  let growth: RatingKey | null = null
  const grants = [...prev.grants]
  if (MVP_RULES.growth && count % MVP_CONFIG.perGrowth === 0 && grants.length < MVP_CONFIG.maxUnits) {
    growth = nextGrowthRating(record)
    if (growth) grants.push({ rating: growth, atMatch: matchIndex })
  }
  return { record: { ...record, mvp: { count, grants } }, award: { playerId: record.player.id, count, growth } }
}

/** 這位球員還可能再成長嗎（沒到上限、還有能力有空間） */
export function canGrowMore(record: Pick<PlayerRecord, 'player' | 'mvp'>): boolean {
  return MVP_RULES.growth && mvpUnits(record) < MVP_CONFIG.maxUnits && nextGrowthRating(record) !== null
}

/**
 * 分段結算的上限：從現在起最多再打幾場「一定不會有 MVP 能力成長」。
 * 每場只有一位 MVP，所以球員 X 最快也要 (10 − 目前進度) 場才會達到下一次成長；對所有可能出場、還能成長的球員取最小值。
 * 這是證明，不是預測：不假設誰會或不會得獎。沒有任何人能再成長就是 Infinity
 */
export function matchesBeforePossibleMvpGrowth(players: readonly PlayerRecord[], canAppear: (id: string) => boolean): number {
  let min = Infinity
  for (const r of players) {
    if (!canAppear(r.player.id) || !canGrowMore(r)) continue
    min = Math.min(min, MVP_CONFIG.perGrowth - ((r.mvp?.count ?? 0) % MVP_CONFIG.perGrowth))
  }
  return min
}

/** 存檔驗證：次數、成長筆數、能力、場次合理 */
export function mvpIssues(record: Pick<PlayerRecord, 'player' | 'mvp'>): string[] {
  const m = record.mvp
  if (m === undefined) return []
  const out: string[] = []
  if (typeof m !== 'object' || m === null) return ['mvp 必須是物件']
  if (!Number.isSafeInteger(m.count) || m.count < 0) out.push('MVP 次數不合法')
  if (!Array.isArray(m.grants)) return [...out, 'MVP 成長紀錄必須是陣列']
  if (m.grants.length > MVP_CONFIG.maxUnits) out.push(`MVP 成長超過上限 ${MVP_CONFIG.maxUnits} 次`)
  if (Number.isSafeInteger(m.count) && m.grants.length > Math.floor(m.count / MVP_CONFIG.perGrowth)) out.push('MVP 成長次數超過 MVP 次數能換到的')
  const keys = ratingKeysOf(record.player.role)
  let last = -1
  for (const g of m.grants) {
    if (!g || !keys.includes(g.rating)) out.push(`MVP 成長的能力不合法：${String(g?.rating)}`)
    if (!Number.isSafeInteger(g?.atMatch) || g.atMatch < 0 || g.atMatch < last) out.push('MVP 成長的場次不合法')
    else last = g.atMatch
  }
  return out
}

// ---- 單場 MVP 紀錄（存在 SettledMatch.mvp） ----

/** 一場比賽的 MVP（只有 V13 起結算的正式一般比賽才有；舊比賽沒有，畫面顯示「未記錄」） */
export interface MatchMvp {
  playerId: string
  role: 'batter' | 'pitcher'
  /** 評分（千分之一分） */
  score: number
  /** 這次之後的生涯 MVP 次數 */
  count: number
  /** 盜壘成功／失敗（lines 沒有，戰報要顯示就存在這裡） */
  sb: number
  cs: number
  /** 勝利打點 */
  key: boolean
  /** 這次觸發的能力成長 */
  growth: RatingKey | null
}

/**
 * 存檔格式（近期 50 場都有，所以用精簡的陣列）：[球員, 0 打者／1 投手, 評分, 生涯次數, 盜壘成功, 盜壘失敗, 勝利打點 0／1, 成長的能力?]。
 * 名字不存：從生涯數據（stats.players）取，球員釋出後也查得到
 */
export type MatchMvpRecord = [playerId: string, role: 0 | 1, score: number, count: number, sb: number, cs: number, key: 0 | 1, growth?: RatingKey]

export function packMvp(m: MatchMvp): MatchMvpRecord {
  const out: MatchMvpRecord = [m.playerId, m.role === 'pitcher' ? 1 : 0, m.score, m.count, m.sb, m.cs, m.key ? 1 : 0]
  if (m.growth) out.push(m.growth)
  return out
}

export function unpackMvp(r: MatchMvpRecord): MatchMvp {
  return { playerId: r[0], role: r[1] === 1 ? 'pitcher' : 'batter', score: r[2], count: r[3], sb: r[4], cs: r[5], key: r[6] === 1, growth: r[7] ?? null }
}

/** 存檔裡的單場 MVP 格式對不對；對的話回傳 null */
export function matchMvpIssue(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 7 || value.length > 8) return '格式不對'
  const [id, role, score, count, sb, cs, key, growth] = value as unknown[]
  if (typeof id !== 'string' || !id) return '球員編號不對'
  if (role !== 0 && role !== 1) return '角色不對'
  if (!Number.isSafeInteger(score)) return '評分必須是整數'
  if (!Number.isSafeInteger(count) || (count as number) < 1) return '生涯次數不對'
  if (!Number.isSafeInteger(sb) || !Number.isSafeInteger(cs) || (sb as number) < 0 || (cs as number) < 0) return '盜壘數不對'
  if (key !== 0 && key !== 1) return '勝利打點不對'
  if (value.length === 8 && !ratingKeysOf(role === 1 ? 'pitcher' : 'batter').includes(growth as RatingKey)) return '成長的能力不對'
  return null
}
