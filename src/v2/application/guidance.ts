// 首頁的「目前建議」（Phase 6A）：用固定的規則挑出「現在最值得做、而且真的做得到」的一件事。
// 純函式：只看球團存檔與這個分頁能不能寫入，不碰時間、儲存或畫面；同一份輸入永遠得到同一個建議。
//
// 優先序（第一個成立的就是建議，同一時間只有一個）：
// 1. 領取收益：有未領取的資金或經驗。先領才能花，而且領取不花資源、冪等
// 2. 挑戰下一聯盟：符合晉級資格（用 domain/league.ts 的 eligibility，不另外寫一套條件）
// 3. 培養球員：現有資產付得起某位上場球員的下一級（先看先發打者與先發投手，再看板凳與後援；等級低的優先，同級看能力高的）
// 4. 檢查陣容：招募來、還在預備名單的球員，比同類型（打者／投手）上場球員裡最弱的那位能力高
// 5. 觀看目前比賽：沒有其他可以做的事
// 1～4 都要寫入存檔，這個分頁不能寫入（唯讀分頁）時一律不建議，只剩 5。
// 建議只負責「帶玩家過去」：升級、挑戰仍要玩家在原本的畫面按下確認，這裡不替玩家執行需要資源或確認的操作
import { overall } from '../../sim/generate'
import type { ClubSave, Resources } from '../domain/club'
import { eligibility, leagueOf } from '../domain/league'
import { upgradeCost } from '../domain/progression'
import { assignedIds, effectivePlayer } from '../domain/roster'
import { canAfford } from './economyService'

export type Suggestion =
  | { kind: 'claim'; unclaimed: Resources }
  | { kind: 'challenge'; fromTier: number; toLeague: string }
  | { kind: 'upgrade'; playerId: string; name: string; level: number; cost: Resources }
  | { kind: 'lineup'; playerId: string; name: string; replaceName: string }
  | { kind: 'watch'; goal: UpgradeGoal | null }

/** 最接近的一次升級還差多少（已經付得起就不是「目標」） */
export interface UpgradeGoal {
  playerId: string
  name: string
  level: number
  short: Resources
}

export type SuggestionKind = Suggestion['kind']

export interface SuggestionContext {
  /** 這個分頁現在能不能寫入（沒有 Web Locks 時只有一個分頁可寫） */
  canWrite: boolean
}

export function suggestNextAction(club: ClubSave, ctx: SuggestionContext): Suggestion {
  if (!ctx.canWrite) return { kind: 'watch', goal: nearestUpgrade(club) }
  const { unclaimed } = club.economy
  if (unclaimed.funds > 0 || unclaimed.experience > 0) return { kind: 'claim', unclaimed: { ...unclaimed } }
  const e = eligibility(club.league, club.idle.nextMatchIndex)
  if (e.ok) return { kind: 'challenge', fromTier: club.league.tier, toLeague: leagueOf(club.league.tier + 1).name }
  const up = upgradeCandidate(club)
  if (up) return up
  const swap = lineupCandidate(club)
  if (swap) return swap
  return { kind: 'watch', goal: nearestUpgrade(club) }
}

/** 付得起下一級的上場球員裡，最值得先升的那位 */
export function upgradeCandidate(club: ClubSave): Extract<Suggestion, { kind: 'upgrade' }> | null {
  const a = club.roster
  const core = new Set([...a.lineup.map((s) => s.playerId), a.starter])
  const active = assignedIds(a)
  const options = club.players
    .filter((r) => active.has(r.player.id))
    .map((r) => ({ r, cost: upgradeCost(r.level) }))
    .filter((x): x is { r: (typeof club.players)[number]; cost: Resources } => x.cost !== null && canAfford(club, x.cost))
    .map((x) => ({ ...x, core: core.has(x.r.player.id), power: overall(effectivePlayer(x.r)) }))
    .sort((p, q) => Number(q.core) - Number(p.core) || p.r.level - q.r.level || q.power - p.power || p.r.player.id.localeCompare(q.r.player.id))
  const best = options[0]
  return best ? { kind: 'upgrade', playerId: best.r.player.id, name: best.r.player.name, level: best.r.level, cost: best.cost } : null
}

/** 招募來、還在預備名單、而且比同類型上場球員裡最弱的那位強的球員（最強的那位） */
export function lineupCandidate(club: ClubSave): Extract<Suggestion, { kind: 'lineup' }> | null {
  const active = assignedIds(club.roster)
  const rated = club.players.map((r) => ({ r, power: overall(effectivePlayer(r)), active: active.has(r.player.id) }))
  let best: { name: string; id: string; power: number; replaceName: string } | null = null
  for (const role of ['batter', 'pitcher'] as const) {
    const weakest = rated.filter((x) => x.active && x.r.player.role === role).sort((p, q) => p.power - q.power)[0]
    if (!weakest) continue
    for (const x of rated) {
      if (x.active || x.r.origin !== 'recruit' || x.r.player.role !== role || x.power <= weakest.power) continue
      if (!best || x.power > best.power) best = { id: x.r.player.id, name: x.r.player.name, power: x.power, replaceName: weakest.r.player.name }
    }
  }
  return best ? { kind: 'lineup', playerId: best.id, name: best.name, replaceName: best.replaceName } : null
}

/**
 * 上場球員裡「最快能升級」的那一次還差多少資源（先看經驗缺口，再看資金缺口）。
 * 已經有人付得起就回傳 null（那是建議，不是目標）；全部滿級也是 null
 */
export function nearestUpgrade(club: ClubSave): UpgradeGoal | null {
  const active = assignedIds(club.roster)
  const { assets } = club.economy
  let best: UpgradeGoal | null = null
  for (const r of club.players) {
    if (!active.has(r.player.id)) continue
    const cost = upgradeCost(r.level)
    if (!cost) continue
    const short = { funds: Math.max(0, cost.funds - assets.funds), experience: Math.max(0, cost.experience - assets.experience) }
    if (short.funds === 0 && short.experience === 0) return null
    if (!best || short.experience < best.short.experience || (short.experience === best.short.experience && short.funds < best.short.funds)) {
      best = { playerId: r.player.id, name: r.player.name, level: r.level, short }
    }
  }
  return best
}
