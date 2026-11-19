// 羈絆與隊長的說明資料（畫面無關的純函式）：條件、門檻、目前人數、參與球員、實際加成、未啟動原因、改善建議、
// 草稿與存檔的差異、換隊長的影響。
// 門檻、隊長權重、守備門檻來自 sim/synergy.ts，加成數值來自 sim/game.ts 的 SYNERGY_EFFECT：
// 這裡不寫死任何數字，改了規則說明就跟著變。
import { SYNERGY_EFFECT } from '../sim/game'
import { withEquipment, type RelicId } from '../sim/items'
import { POSITION_SYNERGY_FIELDING, THRESHOLD_RELICS, captainIn, captainWeight, thresholds, type SynergyKey, type SynergyTier } from '../sim/synergy'
import type { Archetype, Batter, LineupSpot } from '../sim/types'
import { gradeOf } from './grades'
import { ARCHETYPE_NAMES, POSITION_SPOT, SYNERGY_NAMES } from './strings'
import { synergyRows, type SynergyRow } from './synergyUi'

// ---- 加成文字（數字全部讀 SYNERGY_EFFECT） ----

/** 0.18 → 18；0.025 → 2.5 */
const pp = (x: number) => `${Math.round(x * 1000) / 10}`
/** 0.75 → 25（減少的百分比） */
const less = (x: number) => `${Math.round((1 - x) * 100)}`
const num = (x: number) => `${Math.round(x * 100) / 100}`

/** 這個羈絆在某一階的實際加成（tier 1 或 2；守位羈絆只有 1） */
export function synergyEffects(key: SynergyKey, tier: 1 | 2): string[] {
  const E = SYNERGY_EFFECT
  switch (key) {
    case 'power':
      return [`打擊力量 +${num(E.slugPower[tier])}`, `全壘打機率 ×${num(E.homer[tier])}`, `二、三壘安打機率 ×${num(E.extraBase[tier])}`, `揮棒落空機率 +${pp(E.powerWhiff[tier])} 個百分點（代價）`]
    case 'speed':
      return [`盜壘成功率 +${pp(E.steal[tier])} 個百分點`, `跑壘多推進一個壘時，速度視為 +${num(E.running[tier])}`, `安打機率 +${pp(E.infieldHit[tier])} 個百分點（內野安打）`]
    case 'skill':
      return [`碰到球的機率 +${pp(E.skillContact[tier])} 個百分點`, `追打壞球的機率 −${pp(E.skillChase[tier])} 個百分點`, `兩好球後安打機率 +${pp(E.twoStrikeHit[tier])} 個百分點`]
    case 'defense':
      return [`全隊失誤 −${less(E.ironError[tier])}%`, `對手安打機率 −${pp(E.ironRange[tier])} 個百分點（守備範圍變大）`]
    case 'middle':
      return [`雙殺成功率 +${pp(E.middleDoublePlay)} 個百分點`, `二壘手、游擊手的失誤 −${less(E.middleError)}%`]
    case 'battery':
      return [`投手控球 +${num(E.batteryControl)}`, `對手盜壘成功率 −${pp(E.batterySteal)} 個百分點`]
  }
}

/** 羈絆的作用（一句話） */
export const SYNERGY_DESC: Record<SynergyKey, string> = {
  power: '力量型打者打得更遠：全壘打、長打變多，但揮空也稍微變多。只作用在先發的力量型打者身上。',
  speed: '速度型打者跑得更積極：盜壘、跑壘推進、內野安打變多。只作用在先發的速度型打者身上。',
  skill: '技巧型打者更會選球：比較容易碰到球、少追壞球、兩好球後更容易擊出安打。只作用在先發的技巧型打者身上。',
  defense: '防守型夠多時整個守備變穩：全隊失誤變少、守備範圍變大，作用在全隊守備。',
  middle: '二壘手與游擊手都是本職、守備夠好：雙殺更容易、二游失誤變少。',
  battery: '捕手是本職、守備夠好：投手控球變好，對手比較難盜壘。',
}

// ---- 每個羈絆的詳細狀態 ----

export interface SynergyMember {
  id: string
  name: string
  captain: boolean
  /** 這個人算幾人（隊長 2 或 3，其他 1） */
  weight: number
}

export interface SynergyDetail {
  key: SynergyKey
  name: string
  position: boolean
  tier: SynergyTier
  /** 流派羈絆：加權後的人數；守位羈絆：成立 1、未成立 0 */
  count: number
  low: number
  high: number
  members: SynergyMember[]
  /** 在先發裡、但不算進這個羈絆的人與原因（防守型當指定打擊） */
  excluded: { name: string; why: string }[]
  desc: string
  /** 目前生效的加成（未啟動是空的） */
  current: string[]
  /** 下一階：還差幾人、到了之後的加成；已是最高階是 null */
  next: { missing: number; effects: string[] } | null
  /** 未啟動（或未升級）的原因 */
  reason: string
  /** 怎麼改善（調整陣容或隊長） */
  tips: string[]
}

const pos = (p: 'C' | '2B' | 'SS') => POSITION_SPOT[p]
const fielding = (b: Batter) => withEquipment(b).ratings.fielding

/**
 * 六個羈絆的詳細狀態。pool 是不在先發裡、可以換上來的打者（板凳＋預備），用來產生改善建議。
 * 規則與 synergyRows／比賽引擎相同（strict：守位羈絆要守備 B 以上、防守型當指定打擊不算鐵壁球隊）
 */
export function synergyDetails(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[], pool: readonly Batter[] = []): SynergyDetail[] {
  const cap = captainIn(lineup, captain)
  const w = captainWeight(relics)
  const rows = synergyRows(lineup, cap, relics)
  return rows.map((row) => (row.position ? positionDetail(row, lineup, pool) : archetypeDetail(row, lineup, cap, w, pool)))
}

function archetypeDetail(row: SynergyRow, lineup: readonly LineupSpot[], cap: string | null, w: number, pool: readonly Batter[]): SynergyDetail {
  const a = row.key as Archetype
  const type = ARCHETYPE_NAMES[a]
  const members: SynergyMember[] = row.members.map((p) => ({ id: p.id, name: p.name, captain: p.id === cap, weight: p.id === cap ? w : 1 }))
  const excluded = a === 'defense' ? lineup.filter((s) => s.position === 'DH' && s.player.archetype === 'defense').map((s) => ({ name: s.player.name, why: '防守型守指定打擊不算（鐵壁球隊看的是守備）' })) : []
  const tier = row.tier
  const nextTier = tier === 2 ? null : ((tier + 1) as 1 | 2)
  const missing = nextTier ? (nextTier === 1 ? row.low : row.high) - row.count : 0
  const tips: string[] = []
  if (nextTier) {
    const bench = pool.filter((p) => p.archetype === a)
    if (bench.length) tips.push(`板凳或預備有 ${bench.length} 位${type}（${bench.slice(0, 3).map((p) => p.name).join('、')}${bench.length > 3 ? '…' : ''}），換進先發每人 +1`)
    const capIsMember = members.some((m) => m.captain)
    if (!capIsMember && members.length) tips.push(`把 ${members[0].name} 設為隊長：${type}人數 +${w - 1}（隊長在自己流派算 ${w} 人）`)
    if (excluded.length) tips.push(`${excluded.map((e) => e.name).join('、')} 改守野手位置（不要當指定打擊）就會算進來`)
    if (!tips.length) tips.push(`先發裡的${type}不夠，可以從招募市場找${type}打者`)
  }
  const reason =
    tier === 2
      ? '已達最高階'
      : tier === 1
        ? `已啟動 ${row.low} 人階；再 ${missing} 人升到 ${row.high} 人階`
        : row.count === 0
          ? `先發沒有${type}`
          : `目前 ${row.count} 人，要 ${row.low} 人才啟動（差 ${missing} 人）`
  return {
    key: a,
    name: SYNERGY_NAMES[a],
    position: false,
    tier,
    count: row.count,
    low: row.low,
    high: row.high,
    members,
    excluded,
    desc: SYNERGY_DESC[a],
    current: tier ? synergyEffects(a, tier as 1 | 2) : [],
    next: nextTier ? { missing, effects: synergyEffects(a, nextTier) } : null,
    reason,
    tips,
  }
}

function positionDetail(row: SynergyRow, lineup: readonly LineupSpot[], pool: readonly Batter[]): SynergyDetail {
  const key = row.key as 'middle' | 'battery'
  const spots: ('C' | '2B' | 'SS')[] = key === 'middle' ? ['2B', 'SS'] : ['C']
  const grade = gradeOf(POSITION_SYNERGY_FIELDING)
  const tips: string[] = []
  if (!row.tier) {
    for (const p of spots) {
      const s = lineup.find((x) => x.position === p)
      if (s && s.player.primary === p && fielding(s.player) >= POSITION_SYNERGY_FIELDING) continue
      // 能補上的人：本職這個守位、守備 B 以上（含裝備），不論在先發其他位置、板凳或預備
      const fits = [...lineup.map((x) => x.player), ...pool].filter((b) => b.primary === p && fielding(b) >= POSITION_SYNERGY_FIELDING && b.id !== s?.player.id)
      tips.push(
        fits.length
          ? `讓本職${pos(p)}、守備 ${grade} 以上的 ${fits.slice(0, 2).map((b) => b.name).join('、')} 守${pos(p)}`
          : `目前隊上沒有本職${pos(p)}、守備 ${grade} 以上的球員：可以養成或招募`,
      )
    }
  }
  return {
    key,
    name: SYNERGY_NAMES[key],
    position: true,
    tier: row.tier,
    count: row.count,
    low: 1,
    high: 1,
    members: row.members.map((p) => ({ id: p.id, name: p.name, captain: false, weight: 1 })),
    excluded: [],
    desc: SYNERGY_DESC[key],
    current: row.tier ? synergyEffects(key, 1) : [],
    next: row.tier ? null : { missing: 1, effects: synergyEffects(key, 1) },
    reason: row.reason,
    tips,
  }
}

/** 啟動門檻的說明文字（流派：N 人啟動、M 人升級；守位：本職＋守備） */
export function conditionText(d: SynergyDetail): string {
  if (!d.position) return `先發裡${ARCHETYPE_NAMES[d.key as Archetype]}（隊長算 ${captainWeight([])} 人）達 ${d.low} 人啟動、${d.high} 人升級`
  const grade = gradeOf(POSITION_SYNERGY_FIELDING)
  return d.key === 'middle' ? `二壘手、游擊手都守本職，守備都 ${grade} 以上（含裝備）` : `捕手守本職，守備 ${grade} 以上（含裝備）`
}

// ---- 草稿 vs 存檔 ----

export interface SynergyChange {
  key: SynergyKey
  name: string
  before: SynergyTier
  after: SynergyTier
  kind: 'gained' | 'lost' | 'up' | 'down'
}

/** 兩個陣容之間羈絆的變化（只列有變的） */
export function synergyChanges(before: readonly SynergyRow[], after: readonly SynergyRow[]): SynergyChange[] {
  const out: SynergyChange[] = []
  for (const a of after) {
    const b = before.find((x) => x.key === a.key)!
    if (a.tier === b.tier) continue
    const kind = b.tier === 0 ? 'gained' : a.tier === 0 ? 'lost' : a.tier > b.tier ? 'up' : 'down'
    out.push({ key: a.key, name: SYNERGY_NAMES[a.key], before: b.tier, after: a.tier, kind })
  }
  return out
}

/** 換成每一位先發當隊長時，羈絆會怎麼變（跟目前的隊長比） */
export interface CaptainOption {
  id: string
  name: string
  archetype: Archetype
  current: boolean
  /** 階級有變的羈絆 */
  changes: SynergyChange[]
  /** 人數有變的流派羈絆（階級不一定變）：例如重砲 3 → 4 */
  counts: { key: Archetype; name: string; from: number; to: number }[]
}

export function captainOptions(lineup: readonly LineupSpot[], captain: string | null | undefined, relics: readonly RelicId[]): CaptainOption[] {
  const now = synergyRows(lineup, captain, relics)
  return lineup.map((s) => {
    const next = synergyRows(lineup, s.player.id, relics)
    const counts = next
      .filter((r) => !r.position)
      .map((r) => ({ key: r.key as Archetype, name: SYNERGY_NAMES[r.key], from: now.find((x) => x.key === r.key)!.count, to: r.count }))
      .filter((c) => c.from !== c.to)
    return { id: s.player.id, name: s.player.name, archetype: s.player.archetype, current: captainIn(lineup, captain) === s.player.id, changes: synergyChanges(now, next), counts }
  })
}

/** 隊長規則的說明（數字讀 captainWeight 與秘技設定） */
export function captainRules(relics: readonly RelicId[] = []): string[] {
  const base = captainWeight([])
  const band = captainWeight(['captainBand'])
  return [
    '頭像左下角的「C」是 Captain，也就是隊長。',
    `隊長在自己流派的人數算 ${base} 人（例如力量型隊長，重砲打線多算 ${base - 1} 人），對其他流派沒有影響。`,
    '隊長一定要是先發打者；被換到板凳或預備，這支球隊就沒有隊長，要重新指定。',
    '換隊長會改變流派人數，可能讓羈絆啟動、升級，或掉階。',
    `錦標賽的「隊長臂章」秘技會讓隊長算 ${band} 人${relics.includes('captainBand') ? '（目前有這個秘技）' : ''}；放置經營模式沒有秘技。`,
    `錦標賽另有各流派的「門檻 −1」秘技，啟動與升級門檻變成 ${thresholds('power', [THRESHOLD_RELICS.power]).join('／')} 人。`,
  ]
}
