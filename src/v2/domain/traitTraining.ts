// 球員特性培養（Phase 9 PR 3）：個人潛能池、有效特性、訓練資格、成本、進度。
// 全部是純函式、確定性（不用 Math.random、不讀時間）；共用模擬引擎的特性定義（TRAITS、TRAIT_CONFLICTS），不另外建一套。
//
// 三種資料分開保存（PlayerRecord）：
// - 原生特性：record.player.traits（Lv.1 的原始資料，永遠不改）
// - 訓練習得：record.dev.learned
// - 已改善的負面特性：record.dev.removed（原生特性仍保留在 player.traits，只是比賽裡不再套用）
// 有效特性 =（原生 − 已改善）∪ 已習得，由 effectivePlayer 套用，跟 leveled() 一樣只在組陣容時計算
import { Rng } from '../../sim/rng'
import { TRAITS, conflicts, type TraitId, type TraitTier } from '../../sim/traits'
import type { Player } from '../../sim/types'
import { deriveSeed, SEED_SALT, type PlayerRecord, type Resources } from './club'

/** 潛能池演算法的版本：之後改演算法時，舊存檔要照這個版本重現（或在遷移時把潛能池固定下來） */
export const POTENTIAL_VERSION = 1

/** 一名球員的正面特性（金、藍）上限，原生的也算 */
export const MAX_POSITIVE_TRAITS = 2

/** 潛能池的大小（候選的正面特性數） */
export const POTENTIAL_SIZE = 3

export type TrainingKind = 'learn' | 'improve'

/** 訓練的類別：一般（藍）、稀有（金）、改善負面（紅） */
export type TrainingClass = 'common' | 'rare' | 'improve'

/** 訓練成本與所需出場數（平衡見 docs/balance/v2-phase9-traits.md） */
export const TRAINING_CONFIG: Record<TrainingClass, { cost: Resources; appearances: number }> = {
  common: { cost: { funds: 6000, experience: 1000 }, appearances: 200 },
  rare: { cost: { funds: 15000, experience: 2500 }, appearances: 500 },
  improve: { cost: { funds: 8000, experience: 1200 }, appearances: 300 },
}

/** 訓練中的那一項 */
export interface ActiveTraining {
  playerId: string
  trait: TraitId
  kind: TrainingKind
  /** 已累積的出場數 */
  progress: number
  /** 需要的出場數 */
  need: number
  /** 從第幾場（matchIndex）開始累積：開始訓練時還沒開始的第一場 */
  startedAtMatch: number
  /** 最後一次計入進度的場次（沒有就是 null）；同一場不會計兩次 */
  lastCountedMatch: number | null
}

/** 完成的訓練（最近幾筆，給通知、歡迎回來摘要用） */
export interface CompletedTraining {
  playerId: string
  playerName: string
  trait: TraitId
  kind: TrainingKind
  /** 達成的那一場 */
  completedAtMatch: number
  /** 從這一場起生效（completedAtMatch + 1） */
  effectiveFromMatch: number
}

export interface TrainingState {
  potentialVersion: typeof POTENTIAL_VERSION
  /** 全球團只有一個訓練槽 */
  active: ActiveTraining | null
  /** 最近完成的訓練，舊的在前，最多 TRAINING_RECENT_LIMIT 筆 */
  recent: CompletedTraining[]
}

export const TRAINING_RECENT_LIMIT = 10

export function newTrainingState(): TrainingState {
  return { potentialVersion: POTENTIAL_VERSION, active: null, recent: [] }
}

const isPositive = (t: TraitId) => TRAITS[t].tier !== 'red'
const isNegative = (t: TraitId) => TRAITS[t].tier === 'red'

export function trainingClass(trait: TraitId): TrainingClass {
  const tier: TraitTier = TRAITS[trait].tier
  return tier === 'red' ? 'improve' : tier === 'gold' ? 'rare' : 'common'
}

// ---- 有效特性 ----

/** 有效特性：原生（去掉已改善的）加上習得的，保持原生在前、習得在後的順序，不重複 */
export function effectiveTraits(record: Pick<PlayerRecord, 'player' | 'dev'>): TraitId[] {
  const removed = new Set(record.dev?.removed ?? [])
  const out: TraitId[] = []
  for (const t of record.player.traits) if (!removed.has(t) && !out.includes(t)) out.push(t)
  for (const t of record.dev?.learned ?? []) if (!out.includes(t)) out.push(t)
  return out
}

/** 把養成結果套到（已經升級過的）球員物件上；沒有養成資料就原樣回傳（不複製） */
export function withDevelopment<P extends Player>(player: P, record: Pick<PlayerRecord, 'player' | 'dev'>): P {
  if (!record.dev || (record.dev.learned.length === 0 && record.dev.removed.length === 0)) return player
  return { ...player, traits: effectiveTraits(record) }
}

// ---- 潛能池 ----

/** 字串雜湊（FNV-1a 32 位元）：球員編號 → 數字 */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 每個正面特性跟哪項原始能力有關（決定權重）：適合的能力越高，越容易出現在潛能池。
 * 觸擊看打擊、而且長打越低越適合；守備相關看守備；投手的鐵腕看體力、終結者與奪三振看球威、滾地球看控球
 */
function fitOf(trait: TraitId, p: Player): number {
  const r = p.ratings as unknown as Record<string, number>
  switch (trait) {
    case 'slugger':
      return r.power
    case 'clutch':
      return (r.contact + r.power) / 2
    case 'eye':
    case 'lineDrive':
      return r.contact
    case 'stealer':
    case 'baserunner':
      return r.speed
    case 'bunter':
      return (r.contact + (10 - r.power)) / 2
    case 'goodGlove':
      return r.fielding
    case 'ironArm':
      return r.stamina
    case 'closer':
    case 'strikeoutArtist':
      return r.stuff
    case 'groundballer':
      return r.control
    case 'escapeArtist':
      return (r.stuff + r.control) / 2
    default:
      return 0
  }
}

/** 權重：能力 5 是 1，每高一級約 ×1.5；金色（稀有）再 ×0.4 */
function weightOf(trait: TraitId, p: Player): number {
  return 1.5 ** (fitOf(trait, p) - 5) * (TRAITS[trait].tier === 'gold' ? 0.4 : 1)
}

/**
 * 個人潛能池：最多 POTENTIAL_SIZE 個可以學的正面特性。
 * 只看固定的資料：球團種子、球員編號、原始（Lv.1）能力、角色、原生特性；升級、換陣容、重新整理都不會改變。
 * 排除：別的角色的特性、負面特性、已經有的、跟原生「正面」特性互斥的。
 * 跟原生「負面」特性互斥的（例如守備不穩 ↔ 好手套）可以在池子裡，但要先改善那個負面特性才能訓練（見 trainingBlock）
 */
export function potentialPool(clubSeed: number, player: Player): TraitId[] {
  const native = player.traits
  const candidates = (Object.keys(TRAITS) as TraitId[]).filter(
    (t) => TRAITS[t].role === player.role && isPositive(t) && !native.includes(t) && !native.some((n) => isPositive(n) && conflicts(n, t)),
  )
  const rng = new Rng(deriveSeed(clubSeed, hashString(player.id), SEED_SALT.potential))
  const pool: TraitId[] = []
  const left = [...candidates]
  while (pool.length < POTENTIAL_SIZE && left.length > 0) {
    const weights = left.map((t) => weightOf(t, player))
    const total = weights.reduce((a, b) => a + b, 0)
    let x = rng.next() * total
    let i = 0
    while (i < left.length - 1 && x >= weights[i]) x -= weights[i++]
    pool.push(left.splice(i, 1)[0])
  }
  // 顯示順序固定：金色在前，同等級依特性定義的順序
  const order = Object.keys(TRAITS) as TraitId[]
  return pool.sort((a, b) => (TRAITS[a].tier === 'gold' ? 0 : 1) - (TRAITS[b].tier === 'gold' ? 0 : 1) || order.indexOf(a) - order.indexOf(b))
}

// ---- 訓練資格 ----

export type TrainingBlock =
  /** 不在潛能池、角色不符 */
  | 'not-eligible'
  /** 已經有這個特性 */
  | 'owned'
  /** 已經改善過（負面特性） */
  | 'improved'
  /** 跟現有的特性互斥 */
  | 'conflict'
  /** 正面特性已經 3 個 */
  | 'cap'
  /** 訓練槽被占用（別的球員或同一位的另一項） */
  | 'slot-busy'
  | 'insufficient'

export interface TrainingOption {
  trait: TraitId
  kind: TrainingKind
  cls: TrainingClass
  cost: Resources
  need: number
  /** 不能開始的原因（可以就是 null）；互斥時附上衝突的特性 */
  block: TrainingBlock | null
  conflictWith?: TraitId
}

/** 正面特性數（有效的） */
export function positiveCount(record: Pick<PlayerRecord, 'player' | 'dev'>): number {
  return effectiveTraits(record).filter(isPositive).length
}

/**
 * 這位球員可以訓練的項目：潛能池裡的正面特性（習得）＋原生的負面特性（改善）。
 * 每一項附上成本、所需出場數與不能開始的原因（依序：已擁有 → 已改善 → 互斥 → 上限 → 訓練槽 → 資源）
 */
export function trainingOptions(clubSeed: number, record: PlayerRecord, ctx: { active: ActiveTraining | null; assets: Resources }): TrainingOption[] {
  const eff = effectiveTraits(record)
  const learned = new Set(record.dev?.learned ?? [])
  const removed = new Set(record.dev?.removed ?? [])
  const opt = (trait: TraitId, kind: TrainingKind): TrainingOption => {
    const cls = trainingClass(trait)
    const { cost, appearances } = TRAINING_CONFIG[cls]
    let block: TrainingBlock | null = null
    let conflictWith: TraitId | undefined
    if (kind === 'learn') {
      if (eff.includes(trait) || learned.has(trait)) block = 'owned'
      else {
        conflictWith = eff.find((t) => conflicts(t, trait))
        if (conflictWith) block = 'conflict'
        else if (positiveCount(record) >= MAX_POSITIVE_TRAITS) block = 'cap'
      }
    } else if (removed.has(trait)) block = 'improved'
    if (!block && ctx.active) block = 'slot-busy'
    if (!block && (ctx.assets.funds < cost.funds || ctx.assets.experience < cost.experience)) block = 'insufficient'
    return { trait, kind, cls, cost, need: appearances, block, ...(conflictWith ? { conflictWith } : {}) }
  }
  return [...potentialPool(clubSeed, record.player).map((t) => opt(t, 'learn')), ...record.player.traits.filter(isNegative).map((t) => opt(t, 'improve'))]
}

/** 開始訓練前的檢查（服務層用）：回傳不能開始的原因，可以就是 null */
export function trainingBlock(clubSeed: number, record: PlayerRecord, trait: TraitId, kind: TrainingKind, ctx: { active: ActiveTraining | null; assets: Resources }): TrainingBlock | null {
  const option = trainingOptions(clubSeed, record, ctx).find((o) => o.trait === trait && o.kind === kind)
  return option ? option.block : 'not-eligible'
}

/** 套用完成的訓練（不改輸入） */
export function applyTraining(record: PlayerRecord, trait: TraitId, kind: TrainingKind): PlayerRecord {
  const dev = { learned: [...(record.dev?.learned ?? [])], removed: [...(record.dev?.removed ?? [])] }
  if (kind === 'learn') {
    if (!dev.learned.includes(trait)) dev.learned.push(trait)
  } else if (!dev.removed.includes(trait)) dev.removed.push(trait)
  return { ...record, dev }
}

/**
 * 養成資料合法嗎（存檔驗證用）：回傳問題清單。
 * 習得的一定是同角色的正面特性、不是原生、不重複；改善的一定是原生的負面特性；有效特性之間不能互斥；
 * 正面特性不能超過上限（原生就超過的舊資料不算錯，但不能再學）
 */
export function developmentIssues(record: PlayerRecord): string[] {
  const out: string[] = []
  const dev = record.dev
  if (!dev) return out
  const p = record.player
  const seen = new Set<string>()
  for (const t of dev.learned) {
    if (!(t in TRAITS)) out.push(`不認識的特性：${String(t)}`)
    else if (TRAITS[t].role !== p.role) out.push(`${t} 不是${p.role === 'batter' ? '打者' : '投手'}的特性`)
    else if (!isPositive(t)) out.push(`${t} 是負面特性，不能習得`)
    else if (p.traits.includes(t)) out.push(`${t} 是原生特性，不能再習得`)
    if (seen.has(`l:${t}`)) out.push(`${t} 重複習得`)
    seen.add(`l:${t}`)
  }
  for (const t of dev.removed) {
    if (!p.traits.includes(t) || !(t in TRAITS) || !isNegative(t)) out.push(`${String(t)} 不是這位球員原生的負面特性`)
    if (seen.has(`r:${t}`)) out.push(`${t} 重複改善`)
    seen.add(`r:${t}`)
  }
  const eff = effectiveTraits(record)
  for (const a of eff) for (const b of eff) if (a < b && conflicts(a, b)) out.push(`${a} 與 ${b} 互斥`)
  const nativePositive = p.traits.filter(isPositive).length
  if (dev.learned.length > 0 && positiveCount(record) > Math.max(MAX_POSITIVE_TRAITS, nativePositive)) out.push(`正面特性超過 ${MAX_POSITIVE_TRAITS} 個`)
  return out
}

// ---- 結算時的進度（application/settlementService 呼叫） ----

/** 這場的出場名單（Phase 8 的 MatchLines：打者、投手，含代打、代跑、守備替補、後援） */
export interface Appearances {
  bat: readonly (readonly [string, ...unknown[]])[]
  pit: readonly (readonly [string, ...unknown[]])[]
}

/**
 * 正式一般比賽結算後呼叫一次（直接改 club，給 settleOutcomes 在它自己的複本上用）：
 * 訓練中的球員有出場（出現在這場的 lines）就 +1；同一場不會算兩次、開始訓練之前的比賽不算。
 * 達到所需場數就把結果寫進球員的 dev、清空訓練槽、記一筆完成紀錄，回傳那筆紀錄（從下一場起生效）
 */
export function advanceTraining(
  club: { training: TrainingState; players: PlayerRecord[] },
  matchIndex: number,
  lines: Appearances,
): CompletedTraining | null {
  const a = club.training.active
  if (!a) return null
  if (matchIndex < a.startedAtMatch) return null
  if (a.lastCountedMatch !== null && matchIndex <= a.lastCountedMatch) return null
  const appeared = lines.bat.some((r) => r[0] === a.playerId) || lines.pit.some((r) => r[0] === a.playerId)
  if (!appeared) return null
  a.progress++
  a.lastCountedMatch = matchIndex
  if (a.progress < a.need) return null
  const i = club.players.findIndex((r) => r.player.id === a.playerId)
  // 訓練中的球員不能釋出（服務層擋下），所以一定找得到；找不到就只清掉訓練槽
  if (i >= 0) club.players[i] = applyTraining(club.players[i], a.trait, a.kind)
  const done: CompletedTraining = {
    playerId: a.playerId,
    playerName: i >= 0 ? club.players[i].player.name : '',
    trait: a.trait,
    kind: a.kind,
    completedAtMatch: matchIndex,
    effectiveFromMatch: matchIndex + 1,
  }
  club.training.active = null
  club.training.recent = [...club.training.recent, done].slice(-TRAINING_RECENT_LIMIT)
  return done
}

/**
 * 從現在起，最多再結算幾場「訓練一定還沒完成」：一場最多 +1，所以至少還要 need − progress 場。
 * 訓練中的球員不在這批比賽會用到的陣容裡（不在配置、也不在固定的進行中比賽），這批比賽不可能出場，就是 Infinity
 */
export function matchesBeforePossibleTrainingCompletion(club: { training: TrainingState }, canAppear: (playerId: string) => boolean): number {
  const a = club.training.active
  if (!a || !canAppear(a.playerId)) return Number.POSITIVE_INFINITY
  return Math.max(1, a.need - a.progress)
}
