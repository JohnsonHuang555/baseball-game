// 經濟支出與名單操作：升級球員、招募球員、釋出球員共用同一套操作序號（釋出的成本是 0、不退款）。
//
// 冪等：每個請求帶上讀到的 economy.nextOpSeq 與請求內容。
// - 序號等於目前值：檢查、扣款、改球員資料，序號加 1
// - 序號是上一個、而且請求內容跟最近一筆支出相同：這是重送，回傳原本的結果，不再扣款
// - 其他（序號已經被別的操作用掉、或比目前大）：拒絕，請呼叫端重新讀取
// 所以重複點擊、重送、多分頁同時操作都不會重複扣款，也不會用過期的畫面資料去花錢。
//
// 一致性：服務層在 ClubLock 裡「讀最新存檔 → 先用舊能力結算到期的比賽 → 支出 → 存檔」。
// 先結算到期的比賽，所以不能先升級、再用新能力回頭打完離線那段時間的比賽。三種失敗分開處理：
// - 結算失敗（模擬錯誤）：失敗前打完的場次照樣存檔，丟 SettlementError，不支出
// - 支出被拒絕（資源不足、滿級、名單已滿、請求過期……）：到期的比賽照樣存檔（不扣款、不改球員資料），
//   再丟 EconomyError（帶上存好的球團）。比賽是合法的進度，不能因為按錯一個按鈕就被丟掉
// - 存檔寫入失敗：丟 ClubSaveError，什麼都沒變；就算原本是支出被拒絕，也回報寫入失敗，不會被當成「已存檔」
// 成功時，結算、扣款、球員資料在同一次存檔裡寫入，寫入失敗就全部都沒變
import type { ClubSave, PlayerRecord, Resources, SpendRecord } from '../domain/club'
import { MAX_LEVEL, upgradeCost } from '../domain/progression'
import { SPEND_LOG_LIMIT } from '../domain/progressionConfig'
import { recruitCandidate, recruitCost, rosterFull, type RecruitRole } from '../domain/recruitment'
import { assignedIds, recordOf } from '../domain/roster'
import { SettlementError, settleDueUnsaved, type SettlementDeps } from './settlementService'

export type EconomyErrorCode =
  | 'bad-request'
  | 'stale-request'
  | 'no-player'
  | 'level-mismatch'
  | 'max-level'
  | 'insufficient'
  | 'roster-full'
  /** 要釋出的球員目前在先發、板凳或投手名單上（例如別的分頁剛把他排進陣容） */
  | 'not-reserve'

export class EconomyError extends Error {
  override name = 'EconomyError'
  /**
   * 支出被拒絕之前，到期的比賽已經結算並存檔（沒有扣款、沒有改球員資料）：這是存好的球團。
   * 沒有到期的比賽時是 undefined
   */
  settled?: { club: ClubSave; matches: number }
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

export interface ReleaseRequest {
  opSeq: number
  playerId: string
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

/**
 * 釋出一位預備球員：從永久名單移除，不退款、不換資源。先發、板凳、先發投手、後援都不能直接釋出（要先在陣容裡換下來）。
 * 用的是存檔裡最新的陣容判斷，所以別的分頁剛把他排進陣容，這裡會拒絕。
 * 陣容只會引用已上場的球員，所以移除預備球員不會留下懸空的引用；replay 與戰報存的是當時的完整資料，不依賴目前名單
 */
export function releasePlayer(club: ClubSave, req: ReleaseRequest, now: number): SpendOutcome {
  if (typeof req.playerId !== 'string' || !req.playerId) throw new EconomyError('bad-request', '要釋出的球員不合法')
  const requestKey = `release:${req.playerId}`
  const dup = checkSeq(club, req.opSeq, requestKey)
  if (dup) return { club, op: dup, duplicate: true }
  const record = recordOf(club, req.playerId)
  if (!record) throw new EconomyError('no-player', `球員不存在：${req.playerId}`)
  if (assignedIds(club.roster).has(req.playerId)) {
    throw new EconomyError('not-reserve', `${record.player.name} 目前在陣容裡，請先在陣容中換下來，才能釋出`)
  }
  const out = spend(club, { kind: 'release', playerId: req.playerId, cost: { funds: 0, experience: 0 }, at: now, requestKey })
  out.club.players = out.club.players.filter((r) => r.player.id !== req.playerId)
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
    const hasSettled = next.settled.length > 0
    if (batch.status !== 'completed') {
      // 結算失敗：打完的前幾場照樣存檔（跟 settleDue 一樣），不支出
      if (hasSettled) deps.store.saveClub(next.club, club.revision)
      throw new SettlementError('simulation-failed', `支出前的結算沒有完成：${batch.failedMatchId ?? batch.status}`, undefined, { cause: batch.error })
    }
    let out: SpendOutcome
    try {
      out = apply(next.club, now)
    } catch (e) {
      if (!(e instanceof EconomyError) || !hasSettled) throw e
      // 支出被拒絕：只存結算（沒有扣款、沒有改球員資料）。寫入失敗會丟 ClubSaveError，蓋過這個 EconomyError
      e.settled = { club: deps.store.saveClub(next.club, club.revision), matches: next.settled.length }
      throw e
    }
    // 重送且沒有新結算：什麼都沒變，不用存檔
    if (out.duplicate && !hasSettled) return { ...out, club }
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

/** 釋出預備球員（冪等）：先結算到期的比賽，再釋出，一次存檔 */
export function release(deps: SettlementDeps, req: ReleaseRequest): Promise<SpendOutcome> {
  return spendSafely(deps, (club, now) => releasePlayer(club, req, now))
}
