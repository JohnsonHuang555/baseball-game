// 經濟支出：升級球員、招募球員共用同一套支出機制。
//
// 冪等：每個請求帶上讀到的 economy.nextOpSeq 與請求內容。
// - 序號等於目前值：檢查、扣款、改球員資料，序號加 1
// - 序號是上一個、而且請求內容跟最近一筆支出相同：這是重送，回傳原本的結果，不再扣款
// - 其他（序號已經被別的操作用掉、或比目前大）：拒絕，請呼叫端重新讀取
// 所以重複點擊、重送、多分頁同時操作都不會重複扣款，也不會用過期的畫面資料去花錢。
//
// 一致性：服務層在 ClubLock 裡「讀最新存檔 → 先用舊能力結算到期的比賽 → 支出 → 一次存檔」。
// 資源與球員資料在同一份存檔裡一起寫入，寫入失敗就什麼都沒變（不會只扣款沒升級）。
// 先結算到期的比賽，所以不能先升級、再用新能力回頭打完離線那段時間的比賽
import type { ClubSave, PlayerRecord, Resources, SpendRecord } from '../domain/club'
import { MAX_LEVEL, upgradeCost } from '../domain/progression'
import { SPEND_LOG_LIMIT } from '../domain/progressionConfig'
import { recruitCandidate, recruitCost, rosterFull, type RecruitRole } from '../domain/recruitment'
import { recordOf } from '../domain/roster'
import { SettlementError, settleDueUnsaved, type SettlementDeps } from './settlementService'

export type EconomyErrorCode = 'bad-request' | 'stale-request' | 'no-player' | 'level-mismatch' | 'max-level' | 'insufficient' | 'roster-full'

export class EconomyError extends Error {
  override name = 'EconomyError'
  constructor(
    readonly code: EconomyErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface UpgradeRequest {
  /** 讀到的 economy.nextOpSeq */
  opSeq: number
  playerId: string
  /** 畫面上看到的目前等級：跟存檔不同（別的分頁剛升過）就拒絕，避免一個請求升兩級 */
  expectedLevel: number
}

export interface RecruitRequest {
  opSeq: number
  role: RecruitRole
}

export interface SpendOutcome {
  club: ClubSave
  op: SpendRecord
  /** 這是重送的請求：沒有再扣款，op 是原本那一筆 */
  duplicate: boolean
}

// ---- 純函式 ----

/** 資產夠不夠付這筆錢 */
export function canAfford(club: Pick<ClubSave, 'economy'>, cost: Resources): boolean {
  return club.economy.assets.funds >= cost.funds && club.economy.assets.experience >= cost.experience
}

/** 檢查序號：可以執行回傳 null；是重送回傳原本那一筆 */
function checkSeq(club: ClubSave, opSeq: number, requestKey: string): SpendRecord | null {
  if (!Number.isSafeInteger(opSeq) || opSeq < 0) throw new EconomyError('bad-request', `操作序號不合法：${opSeq}`)
  const next = club.economy.nextOpSeq
  if (opSeq === next) return null
  const last = club.economy.recentOps.at(-1)
  if (opSeq === next - 1 && last && last.seq === opSeq && last.requestKey === requestKey) return last
  throw new EconomyError('stale-request', '這個操作根據的是舊的資料（可能其他分頁剛完成了別的操作），請重新讀取後再試一次')
}

/** 扣款並記一筆支出（不改輸入） */
function spend(club: ClubSave, op: Omit<SpendRecord, 'seq'>): { club: ClubSave; op: SpendRecord } {
  if (!canAfford(club, op.cost)) throw new EconomyError('insufficient', '資金或經驗不足')
  const next = structuredClone(club)
  const record: SpendRecord = { ...op, seq: next.economy.nextOpSeq }
  const e = next.economy
  e.assets = { funds: e.assets.funds - op.cost.funds, experience: e.assets.experience - op.cost.experience }
  e.spent = { funds: e.spent.funds + op.cost.funds, experience: e.spent.experience + op.cost.experience }
  e.nextOpSeq++
  e.recentOps = [...e.recentOps, record].slice(-SPEND_LOG_LIMIT)
  return { club: next, op: record }
}

/** 升級一位球員一級 */
export function upgradePlayer(club: ClubSave, req: UpgradeRequest, now: number): SpendOutcome {
  const requestKey = `upgrade:${req.playerId}:${req.expectedLevel}`
  const dup = checkSeq(club, req.opSeq, requestKey)
  if (dup) return { club, op: dup, duplicate: true }
  const record = recordOf(club, req.playerId)
  if (!record) throw new EconomyError('no-player', `球員不存在：${req.playerId}`)
  if (record.level !== req.expectedLevel) throw new EconomyError('level-mismatch', `${record.player.name} 目前是 Lv.${record.level}，畫面上的資料已經過期，請重新讀取`)
  if (record.level >= MAX_LEVEL) throw new EconomyError('max-level', `${record.player.name} 已經是最高等級 Lv.${MAX_LEVEL}`)
  const cost = upgradeCost(record.level)!
  const out = spend(club, { kind: 'upgrade', playerId: req.playerId, cost, at: now, requestKey, fromLevel: record.level, toLevel: record.level + 1 })
  recordOf(out.club, req.playerId)!.level++
  return { ...out, duplicate: false }
}

/** 招募一位球員：加入永久名單（預備名單），不自動上場 */
export function recruitPlayer(club: ClubSave, req: RecruitRequest, now: number): SpendOutcome {
  if (req.role !== 'batter' && req.role !== 'pitcher') throw new EconomyError('bad-request', `招募類型不合法：${String(req.role)}`)
  const requestKey = `recruit:${req.role}`
  const dup = checkSeq(club, req.opSeq, requestKey)
  if (dup) return { club, op: dup, duplicate: true }
  if (rosterFull(club)) throw new EconomyError('roster-full', '球團人數已滿，無法再招募')
  const index = club.recruitment.count
  const player = recruitCandidate(club, req.role)
  const out = spend(club, { kind: 'recruit', playerId: player.id, cost: recruitCost(index), at: now, requestKey, recruitIndex: index })
  const record: PlayerRecord = { player, level: 1, origin: 'recruit', joinedAtMatch: club.idle.nextMatchIndex }
  out.club.players.push(record)
  out.club.recruitment.count++
  return { ...out, duplicate: false }
}

// ---- 服務（上鎖、先結算、一次存檔） ----

async function spendSafely(deps: SettlementDeps, apply: (club: ClubSave, now: number) => SpendOutcome): Promise<SpendOutcome> {
  return deps.lock.run(async () => {
    const club = deps.store.loadClub()
    if (!club) throw new SettlementError('no-club', '還沒有球團存檔')
    const now = deps.clock.now()
    // 已經到期的比賽先用目前（舊）的能力打完
    const { next, batch } = await settleDueUnsaved(club, now, deps)
    if (batch.status !== 'completed') {
      throw new SettlementError('simulation-failed', `支出前的結算沒有完成：${batch.failedMatchId ?? batch.status}`, undefined, { cause: batch.error })
    }
    const out = apply(next.club, now)
    // 重送且沒有新結算：什麼都沒變，不用存檔
    if (out.duplicate && next.settled.length === 0) return { ...out, club }
    return { ...out, club: deps.store.saveClub(out.club, club.revision) }
  })
}

/** 升級球員（冪等）：先結算到期的比賽，再升級，一次存檔 */
export function upgrade(deps: SettlementDeps, req: UpgradeRequest): Promise<SpendOutcome> {
  return spendSafely(deps, (club, now) => upgradePlayer(club, req, now))
}

/** 招募球員（冪等）：先結算到期的比賽，再招募，一次存檔 */
export function recruit(deps: SettlementDeps, req: RecruitRequest): Promise<SpendOutcome> {
  return spendSafely(deps, (club, now) => recruitPlayer(club, req, now))
}
