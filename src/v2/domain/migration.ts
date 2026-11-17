// 存檔遷移：schemaVersion 3 → 4。
// 3 的陣容直接內嵌球員物件；4 把球員搬進永久名單（players），陣容只存 ID，並加上等級、支出帳務。
// 遷移是純函式、確定性（不讀時間、不抽亂數）：同一份 V3 不管遷移幾次、在哪個分頁遷移，結果都一模一樣
import type { ClubSave } from './club'
import { CLUB_SCHEMA_VERSION, splitRoster, validateClub } from './club'
import { validateClubV3, type ClubSaveV3 } from './legacyV3'
import { isObj } from './validation'

export class MigrationError extends Error {
  override name = 'MigrationError'
}

/** 讀進來的存檔需要遷移嗎：只看 schemaVersion */
export function needsMigration(value: unknown): boolean {
  return isObj(value) && value.schemaVersion === 3
}

/**
 * V3 → V4：
 * - 既有球員一律 Lv.1，ID、能力、特性、流派、陣容（先發、守位、棒次、板凳、投手、隊長）全部照舊
 * - 資金、經驗、勝敗、結算游標、時間錨點、近期比賽、replay 全部照舊；不重新產生球員、不重新結算
 * - 帳務：V3 沒有支出，所以 earned = 原本的 lifetime、spent = 0
 * - revision 接著原本的往上加，遷移後的版本一定比遷移前大
 * 結果會再用 V4 的驗證檢查一次；任何一步失敗都丟 MigrationError，呼叫端不能寫入
 */
export function migrateV3ToV4(value: unknown): ClubSave {
  let v3: ClubSaveV3
  try {
    v3 = validateClubV3(value)
  } catch (e) {
    throw new MigrationError(`V3 存檔本身不合法，無法遷移：${(e as Error).message}`, { cause: e })
  }
  const { players, roster } = splitRoster(v3.roster, 'migrated', 0)
  const club: ClubSave = {
    schemaVersion: CLUB_SCHEMA_VERSION,
    clubId: v3.clubId,
    clubName: v3.clubName,
    clubSeed: v3.clubSeed,
    createdAt: v3.createdAt,
    players,
    roster,
    recruitment: { count: 0 },
    strategy: structuredClone(v3.strategy),
    economy: {
      assets: { ...v3.economy.assets },
      unclaimed: { ...v3.economy.unclaimed },
      earned: { ...v3.economy.lifetime },
      spent: { funds: 0, experience: 0 },
      nextClaimSeq: v3.economy.nextClaimSeq,
      lastClaim: v3.economy.lastClaim ? structuredClone(v3.economy.lastClaim) : null,
      nextOpSeq: 0,
      recentOps: [],
    },
    idle: { ...v3.idle },
    record: { ...v3.record },
    recentMatches: structuredClone(v3.recentMatches),
    replays: structuredClone(v3.replays),
    migratedFrom: { schemaVersion: 3, revision: v3.revision },
    revision: v3.revision + 1,
  }
  try {
    return validateClub(club)
  } catch (e) {
    throw new MigrationError(`遷移後的存檔驗證失敗：${(e as Error).message}`, { cause: e })
  }
}
