// V2 陣容：合法性檢查與玩家能做的基本調整。
// 交換的細節重用模擬引擎（sim/setup.ts）的 swapSlots / swapPositions（隊長離開先發會自動清掉），這裡只負責檢查與 V2 的操作名稱
import { bestArrangement, type Arrangement } from '../../sim/arrange'
import { getSlot, setSlot, swapPositions, swapSlots, type Slot } from '../../sim/setup'
import { POSITIONS, type Player, type Roster } from '../../sim/types'

export class LineupError extends Error {
  override name = 'LineupError'
  constructor(readonly issues: string[]) {
    super(`陣容不合法：${issues.join('；')}`)
  }
}

/** 引擎要求的陣容：9 名先發打者、9 個守位各一人、板凳是打者、投手是投手、同一名球員只出現一次。回傳問題清單，空的就是合法 */
export function lineupIssues(roster: Roster): string[] {
  const issues: string[] = []
  if (roster.lineup.length !== 9) issues.push('先發必須剛好 9 人')
  if (roster.lineup.some((s) => s.player.role !== 'batter')) issues.push('先發只能放打者')
  if (roster.bench.some((p) => p.role !== 'batter')) issues.push('板凳只能放打者')
  if (roster.starter.role !== 'pitcher') issues.push('先發投手必須是投手')
  if (roster.relievers.some((p) => p.role !== 'pitcher')) issues.push('後援只能放投手')
  const positions = roster.lineup.map((s) => s.position)
  const missing = POSITIONS.filter((p) => !positions.includes(p))
  if (missing.length || new Set(positions).size !== positions.length) issues.push(`每個守位都要剛好一人（缺少：${missing.join('、') || '無'}）`)
  const ids = [...roster.lineup.map((s) => s.player.id), ...roster.bench.map((p) => p.id), roster.starter.id, ...roster.relievers.map((p) => p.id)]
  if (new Set(ids).size !== ids.length) issues.push('同一名球員不能出現在兩個位置')
  if (roster.captain && !roster.lineup.some((s) => s.player.id === roster.captain)) issues.push('隊長必須是先發打者')
  return issues
}

export function assertValidLineup(roster: Roster): void {
  const issues = lineupIssues(roster)
  if (issues.length) throw new LineupError(issues)
}

/** 板凳換上先發：接手原本的守位與棒次 */
export function substitute(roster: Roster, lineupIndex: number, benchIndex: number): Roster {
  checkIndex(roster.lineup.length, lineupIndex)
  checkIndex(roster.bench.length, benchIndex)
  return swapSlots(roster, { kind: 'lineup', index: lineupIndex }, { kind: 'bench', index: benchIndex })!
}

/** 兩名先發交換守位，棒次不變 */
export function swapFieldPositions(roster: Roster, a: number, b: number): Roster {
  checkIndex(roster.lineup.length, a)
  checkIndex(roster.lineup.length, b)
  return swapPositions(roster, a, b)
}

/** 兩名先發交換棒次，各自的守位不變 */
export function swapBattingOrder(roster: Roster, a: number, b: number): Roster {
  checkIndex(roster.lineup.length, a)
  checkIndex(roster.lineup.length, b)
  return swapSlots(roster, { kind: 'lineup', index: a }, { kind: 'lineup', index: b })!
}

/** 換先發投手：跟某位後援對調 */
export function setStartingPitcher(roster: Roster, relieverIndex: number): Roster {
  checkIndex(roster.relievers.length, relieverIndex)
  return swapSlots(roster, { kind: 'starter' }, { kind: 'reliever', index: relieverIndex })!
}

/**
 * 自動排陣：重用 sim/arrange.ts 的「最多羈絆排法」。它先比羈絆階級、再比守非本職、最後比改動最少，
 * 不看能力值高低，所以 UI 要先列出會改哪些人讓玩家確認。已經是最好的排法就回傳 null
 */
export function autoArrange(roster: Roster): Arrangement | null {
  return bestArrangement(roster, [])
}

function checkIndex(length: number, i: number): void {
  if (!Number.isInteger(i) || i < 0 || i >= length) throw new RangeError(`位置不存在：${i}`)
}

// ---- 預備名單（Phase 4）----

/** 陣容草稿：上場的配置（養成後的球員物件）加上預備名單 */
export interface LineupDraft {
  roster: Roster
  reserves: Player[]
}

/** 陣容上的位置，或預備名單的第幾位 */
export type DraftSlot = Slot | { kind: 'reserve'; index: number }

/**
 * 預備名單的球員跟陣容上的某一格交換：打者可以換先發（接手守位與棒次）或板凳，投手可以換先發投手或後援。
 * 被換下的人回到預備名單同一個位置，所以不會有人消失或重複
 */
export function swapWithReserve(draft: LineupDraft, slot: Slot, reserveIndex: number): LineupDraft {
  checkIndex(draft.reserves.length, reserveIndex)
  const incoming = draft.reserves[reserveIndex]
  const wantsPitcher = slot.kind === 'starter' || slot.kind === 'reliever'
  if ((incoming.role === 'pitcher') !== wantsPitcher) throw new RangeError(wantsPitcher ? '這個位置只能放投手' : '這個位置只能放打者')
  const outgoing = getSlot(draft.roster, slot)
  const reserves = draft.reserves.map((p, i) => (i === reserveIndex ? outgoing : p))
  return { roster: setSlot(draft.roster, slot, incoming), reserves }
}
