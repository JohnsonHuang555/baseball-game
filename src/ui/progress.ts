// 錦標賽的累積進度：冠軍紀錄（獎盃櫃）、通過的最高難度、解鎖的裝扮。
// 跟錦標賽存檔分開放：錦標賽結束就清掉，這些要一直留著
import { TIERS, tierOf, type GameRecord, type Tier, type Tournament } from '../sim/tournament'
import type { Roster } from '../sim/types'

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
}

interface Progress {
  trophies: Trophy[]
  /** 通過的最高難度，0 代表還沒拿過冠軍 */
  cleared: number
}

/** 球員頭像的裝扮：通過各難度依序解鎖，只套用在我方球員 */
export const OUTFITS = ['standard', 'stripes', 'goldCap', 'shades', 'crown', 'gold'] as const
export type Outfit = (typeof OUTFITS)[number]
/** 要通過哪個難度才解鎖 */
export const OUTFIT_UNLOCK: Record<Outfit, number> = { standard: 0, stripes: 1, goldCap: 2, shades: 3, crown: 4, gold: 5 }

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { trophies: [], cleared: 0 }
    const p = JSON.parse(raw) as Partial<Progress>
    return { trophies: Array.isArray(p.trophies) ? p.trophies : [], cleared: typeof p.cleared === 'number' ? p.cleared : 0 }
  } catch {
    return { trophies: [], cleared: 0 }
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

/**
 * 記下一座冠軍獎盃，回傳這座獎盃（同一屆重複呼叫會拿到同一座，不會多記）。
 * 第一次通過這個難度時解鎖對應的裝扮，也開放下一級難度
 */
export function recordChampion(t: Tournament): Trophy {
  const p = load()
  const key = `${t.setup.team.name}:${t.rngState}`
  const existing = p.trophies.find((x) => x.key === key)
  if (existing) return existing
  const tier = tierOf(t)
  const firstClear = tier > p.cleared
  const trophy: Trophy = {
    key,
    at: new Date().toISOString(),
    tier,
    teamName: t.setup.team.name,
    history: t.history,
    roster: t.setup.team.roster,
    unlocked: firstClear ? outfitForTier(tier) : null,
  }
  save({ trophies: [...p.trophies, trophy], cleared: Math.max(p.cleared, tier) })
  return trophy
}
