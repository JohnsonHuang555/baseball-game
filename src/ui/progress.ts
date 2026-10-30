// 跨輪的累積進度：冠軍紀錄與奪冠回顧、傳奇館、每一輪的歷程、通過的最高難度、解鎖的裝扮。
// 跟錦標賽存檔分開放：錦標賽結束就清掉，這些要一直留著
import { allPlayers, overall } from '../sim/generate'
import type { RelicId } from '../sim/items'
import { TIERS, seasonRecord, type AwakenLog, type GameRecord, type Round, type Tier, type Tournament } from '../sim/tournament'
import type { TraitId } from '../sim/traits'
import type { Player, Roster } from '../sim/types'
import { addMissingFields } from './save'

const KEY = 'dice-baseball.progress'

/** 一座獎盃：哪支隊伍、哪個難度、每場比分，連同奪冠時的陣容 */
export interface Trophy {
  /** 避免同一屆記兩次 */
  key: string
  /** 奪冠時間（ISO 字串） */
  at: string
  tier: Tier
  teamName: string
  history: GameRecord[]
  roster: Roster
  /** 這一座獎盃解鎖的裝扮（第一次通過這個難度才有） */
  unlocked: Outfit | null
  /** 奪冠回顧；改版前的獎盃沒有 */
  recap?: Recap
  /** 送進傳奇館的球員編號（每座冠軍一位） */
  legendId?: string
}

/** 奪冠回顧：這一輪的秘寶、覺醒、每位球員從開打（或加入）到奪冠的總評變化 */
export interface Recap {
  relics: RelicId[]
  awakenings: AwakenLog[]
  growth: { id: string; name: string; role: Player['role']; from: number; to: number; traits: TraitId[] }[]
}

/** 傳奇館的一位球員：奪冠時的樣子，加入新的一輪時才打折 */
export interface Legend {
  player: Player
  teamName: string
  tier: Tier
  at: string
  /** 來自哪一座獎盃 */
  trophyKey: string
}

/** 每一輪的紀錄，包含被淘汰的 */
export interface RunRecord {
  key: string
  at: string
  tier: Tier
  teamName: string
  /** 奪冠，或止步在哪個階段 */
  outcome: 'champion' | Round
  wins: number
  losses: number
  relics: RelicId[]
}

interface Progress {
  trophies: Trophy[]
  /** 通過的最高難度，0 代表還沒拿過冠軍 */
  cleared: number
  legends: Legend[]
  runs: RunRecord[]
}

/** 球員頭像的裝扮：通過各難度依序解鎖，只套用在我方球員 */
export const OUTFITS = ['standard', 'stripes', 'goldCap', 'shades', 'crown', 'gold'] as const
export type Outfit = (typeof OUTFITS)[number]
/** 要通過哪個難度才解鎖 */
export const OUTFIT_UNLOCK: Record<Outfit, number> = { standard: 0, stripes: 1, goldCap: 2, shades: 3, crown: 4, gold: 5 }

function load(): Progress {
  const empty: Progress = { trophies: [], cleared: 0, legends: [], runs: [] }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty
    const p = addMissingFields(JSON.parse(raw)) as Partial<Progress>
    return {
      trophies: Array.isArray(p.trophies) ? p.trophies : [],
      cleared: typeof p.cleared === 'number' ? p.cleared : 0,
      legends: Array.isArray(p.legends) ? p.legends : [],
      runs: Array.isArray(p.runs) ? p.runs : [],
    }
  } catch {
    return empty
  }
}

function save(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 記不住就算了
  }
}

/** 獎盃，新的在前 */
export function trophies(): Trophy[] {
  return [...load().trophies].reverse()
}

/** 傳奇館，新的在前 */
export function legends(): Legend[] {
  return [...load().legends].reverse()
}

/** 每一輪的歷程，新的在前 */
export function runs(): RunRecord[] {
  return [...load().runs].reverse()
}

export function clearedTier(): number {
  return load().cleared
}

/** 可以選的難度：通過的下一級為止 */
export function availableTiers(): Tier[] {
  const cleared = clearedTier()
  return TIERS.filter((tier) => tier <= cleared + 1)
}

export function isUnlocked(outfit: Outfit): boolean {
  return clearedTier() >= OUTFIT_UNLOCK[outfit]
}

/** 這個難度第一次通過時解鎖的裝扮 */
export function outfitForTier(tier: number): Outfit | null {
  return OUTFITS.find((o) => OUTFIT_UNLOCK[o] === tier) ?? null
}

/** 同一輪的識別：隊名加亂數狀態（結束後就不會再變） */
function runKey(t: Tournament): string {
  return `${t.setup.team.name}:${t.rngState}`
}

function recapOf(t: Tournament): Recap {
  const start = t.startOverall ?? {}
  return {
    relics: [...(t.setup.team.relics ?? [])],
    awakenings: t.awakenLog ?? [],
    growth: allPlayers(t.setup.team.roster).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      from: start[p.id] ?? overall(p),
      to: overall(p),
      traits: [...p.traits],
    })),
  }
}

/**
 * 記下一座冠軍獎盃與奪冠回顧，回傳這座獎盃（同一屆重複呼叫會拿到同一座，不會多記）。
 * 第一次通過這個難度時解鎖對應的裝扮，也開放下一級難度
 */
export function recordChampion(t: Tournament): Trophy {
  const p = load()
  const key = runKey(t)
  const existing = p.trophies.find((x) => x.key === key)
  if (existing) return existing
  const tier = t.tier
  const firstClear = tier > p.cleared
  const trophy: Trophy = {
    key,
    at: new Date().toISOString(),
    tier,
    teamName: t.setup.team.name,
    history: t.history,
    roster: t.setup.team.roster,
    unlocked: firstClear ? outfitForTier(tier) : null,
    recap: recapOf(t),
  }
  save({ ...p, trophies: [...p.trophies, trophy], cleared: Math.max(p.cleared, tier) })
  return trophy
}

/** 一輪結束（奪冠或淘汰）時記進歷程；同一輪只記一次 */
export function recordRun(t: Tournament): void {
  const p = load()
  const key = runKey(t)
  if (p.runs.some((r) => r.key === key)) return
  const { wins, losses } = seasonRecord(t)
  const playoffWins = t.history.filter((g) => g.round !== 'season' && g.won).length
  const playoffLosses = t.history.filter((g) => g.round !== 'season' && !g.won).length
  const run: RunRecord = {
    key,
    at: new Date().toISOString(),
    tier: t.tier,
    teamName: t.setup.team.name,
    outcome: t.phase === 'champion' ? 'champion' : t.round,
    wins: wins + playoffWins,
    losses: losses + playoffLosses,
    relics: [...(t.setup.team.relics ?? [])],
  }
  save({ ...p, runs: [...p.runs, run] })
}

/** 把一座冠軍的一位球員送進傳奇館（每座冠軍一位，已經選過就不能再選） */
export function induct(trophyKey: string, player: Player): boolean {
  const p = load()
  const trophy = p.trophies.find((x) => x.key === trophyKey)
  if (!trophy || trophy.legendId) return false
  const legend: Legend = { player, teamName: trophy.teamName, tier: trophy.tier, at: new Date().toISOString(), trophyKey }
  save({ ...p, trophies: p.trophies.map((x) => (x.key === trophyKey ? { ...x, legendId: player.id } : x)), legends: [...p.legends, legend] })
  return true
}
