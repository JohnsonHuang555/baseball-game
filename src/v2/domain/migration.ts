// 存檔遷移：schemaVersion 3 → 4 → 5 → 6（目前格式）。
// - 3 → 4：陣容裡內嵌的球員搬進永久名單（players），陣容只存 ID，加上等級、支出帳務
// - 4 → 5：加上聯盟進度（league）；其他欄位一個字都不動
// - 5 → 6：加上最近一次晉級挑戰的 Replay（challengeReplay），舊存檔沒有挑戰 Replay，一律是 null；其他欄位一個字都不動
// - 6 → 7：加上進行中比賽的固定計畫（liveMatch = null）；還保留完整 Replay 的近期比賽，用 Replay 確定性重算出 Box Score，
//   其他舊比賽維持只有摘要（不猜數據）。比賽、獎勵、游標、錨點都不動
// 遷移是純函式、確定性（不讀時間、不抽亂數）：同一份舊存檔不管遷移幾次、在哪個分頁遷移，結果都一模一樣。
// 舊版本串接各段升到目前版本，中間版本不單獨驗證，只驗證最後的結果
import type { ClubSave } from './club'
import { CLUB_SCHEMA_VERSION, splitRoster, validateClub } from './club'
import { newLeagueState, type LeagueState } from './league'
import { PROMOTION_CONFIG } from './leagueConfig'
import { validateClubV3, type ClubSaveV3 } from './legacyV3'
import type { ClubSaveV4 } from './legacyV4'
import type { ClubSaveV5 } from './legacyV5'
import type { ClubSaveV6 } from './legacyV6'
import { replay as replayGame } from '../../sim/game'
import { boxScoreOf } from './boxScore'
import { isObj } from './validation'

export class MigrationError extends Error {
  override name = 'MigrationError'
}

/** 可以遷移的舊版本 */
export const MIGRATABLE_VERSIONS = [3, 4, 5, 6] as const
export type MigratableVersion = (typeof MIGRATABLE_VERSIONS)[number]

/** 讀進來的存檔需要遷移嗎：只看 schemaVersion */
export function needsMigration(value: unknown): boolean {
  return sourceVersion(value) !== null
}

/** 舊存檔的版本（3～6）；不是可遷移的舊版本就是 null */
export function sourceVersion(value: unknown): MigratableVersion | null {
  if (!isObj(value)) return null
  return (MIGRATABLE_VERSIONS as readonly unknown[]).includes(value.schemaVersion) ? (value.schemaVersion as MigratableVersion) : null
}

/** 任何可遷移的舊存檔 → 目前格式（驗證過）。任何一步失敗都丟 MigrationError，呼叫端不能寫入 */
export function migrateToLatest(value: unknown): ClubSave {
  const version = sourceVersion(value)
  if (version === null) throw new MigrationError('不是可以遷移的舊版存檔')
  const original = value as { revision: number }
  const origin = { schemaVersion: version, revision: original.revision }
  try {
    // 中間版本沒有單獨驗證：缺欄位時這裡可能丟 TypeError，一樣當成遷移失敗
    const v6 =
      version === 6
        ? (value as ClubSaveV6)
        : toV6(version === 5 ? (value as ClubSaveV5) : toV5(version === 3 ? migrateV3ToV4(value) : (value as ClubSaveV4)))
    return validateClub(toV7(v6, origin))
  } catch (e) {
    if (e instanceof MigrationError) throw e
    throw new MigrationError(`遷移後的存檔驗證失敗：${(e as Error).message}`, { cause: e })
  }
}

/**
 * V3 → V4（不驗證，給 migrateToLatest 串接用）：
 * - 既有球員一律 Lv.1，ID、能力、特性、流派、陣容（先發、守位、棒次、板凳、投手、隊長）全部照舊
 * - 資金、經驗、勝敗、結算游標、時間錨點、近期比賽、replay 全部照舊；不重新產生球員、不重新結算
 * - 帳務：V3 沒有支出，所以 earned = 原本的 lifetime、spent = 0
 * - revision 接著原本的往上加
 */
export function migrateV3ToV4(value: unknown): ClubSaveV4 {
  let v3: ClubSaveV3
  try {
    v3 = validateClubV3(value)
  } catch (e) {
    throw new MigrationError(`V3 存檔本身不合法，無法遷移：${(e as Error).message}`, { cause: e })
  }
  const { players, roster } = splitRoster(v3.roster, 'migrated', 0)
  return {
    schemaVersion: 4,
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
}

/**
 * V4 → V5：只加上 league，其他欄位照搬（深拷貝）。
 * 既有球團一律從新秀聯盟開始；舊比賽都是新秀聯盟強度（5.0，跟 Phase 4 的對手一樣），
 * 所以本聯盟戰績 = 總戰績，最近戰績取自近期比賽紀錄。不發任何獎勵、不重新結算
 */
function toV5(v4: ClubSaveV4): ClubSaveV5 {
  const { migratedFrom: _old, ...rest } = structuredClone(v4)
  return { ...rest, schemaVersion: 5, league: seededLeague(v4) }
}

/** V5 → V6：只加上 challengeReplay（null），其他欄位照搬（深拷貝） */
function toV6(v5: ClubSaveV5): ClubSaveV6 {
  const { migratedFrom: _old, ...rest } = structuredClone(v5)
  return { ...rest, schemaVersion: 6, challengeReplay: null }
}

/**
 * V6 → V7：加上 liveMatch（null）；還保留完整 Replay 的近期比賽補上 Box Score（用 V1 的 replay() 確定性重算，算不出來就不補）。
 * revision 接著原始存檔加 1（從儲存的角度只是一次寫入），migratedFrom 記原始版本
 */
function toV7(v6: ClubSaveV6, origin: { schemaVersion: MigratableVersion; revision: number }): ClubSave {
  const { migratedFrom: _old, ...rest } = structuredClone(v6)
  const kept = new Map(rest.replays.map((r) => [r.matchId, r.replay]))
  const recentMatches = rest.recentMatches.map((m) => {
    const rep = kept.get(m.matchId)
    if (!rep || m.box) return m
    try {
      const game = replayGame(structuredClone(rep.setup), rep.commands)
      const players = (['home', 'away'] as const).flatMap((side) =>
        [...game.rosterIds(side)].flatMap((id) => {
          const p = game.player(id)
          const line = game.box[id]
          return p && line ? [{ playerId: id, name: p.name, side, role: p.role, line }] : []
        }),
      )
      // 重算的比分一定要跟戰報一致，否則不補（不放不可信的數據）
      const side = rep.setup.userSide
      const other = side === 'home' ? 'away' : 'home'
      if (game.score[side] !== m.result.runsFor || game.score[other] !== m.result.runsAgainst) return m
      return { ...m, box: boxScoreOf({ linescore: game.linescore, hits: game.hits, errors: game.errors, players }, side) }
    } catch {
      return m
    }
  })
  return { ...rest, recentMatches, schemaVersion: CLUB_SCHEMA_VERSION, liveMatch: null, migratedFrom: origin, revision: origin.revision + 1 }
}

function seededLeague(v4: ClubSaveV4): LeagueState {
  const recent = v4.recentMatches
    .map((m) => (m.result.won ? 'W' : 'L'))
    .join('')
    .slice(-PROMOTION_CONFIG.window)
  return { ...newLeagueState(), matches: v4.record.wins + v4.record.losses, wins: v4.record.wins, losses: v4.record.losses, recent }
}
