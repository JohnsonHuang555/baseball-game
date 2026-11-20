// 永久球員名單 ↔ 陣容配置 ↔ 模擬用的 Roster。
// 存檔只存球員 ID 的配置；要比賽或顯示時，由這裡把 ID 換成「養成後能力」的球員物件。
// 所以比賽用的能力、畫面顯示的能力、存檔裡的等級永遠是同一套
import { withMvpBonus } from './mvp'
import { withDevelopment } from './traitTraining'
import type { Batter, Pitcher, Player, Roster } from '../../sim/types'
import type { ClubSave, PlayerRecord, RosterAssignment } from './club'
import { leveled } from './progression'

type ClubPlayers = Pick<ClubSave, 'players' | 'roster'>

/** 球員編號 → 永久資料 */
export function recordOf(club: Pick<ClubSave, 'players'>, playerId: string): PlayerRecord | undefined {
  return club.players.find((r) => r.player.id === playerId)
}

/** 某位球員目前的養成後樣子（比賽實際用的能力） */
export function effectivePlayer(record: PlayerRecord): Player {
  // 層次：原生（Lv.1）→ 等級成長 → MVP 永久加成（Phase 9 PR 4，上限 10）→ 特性（原生去掉已改善的＋訓練習得，Phase 9 PR 3）。
  // 每一層只讀原始資料，不重複套用；原始資料 record.player 不改
  return withDevelopment(withMvpBonus(leveled(record.player, record.level), record), record)
}

/** 把配置換算成模擬用的 Roster：每個人都是養成後的能力。ID 不存在或身分不對就丟錯 */
export function resolveRoster(club: ClubPlayers): Roster {
  const get = (id: string, role: Player['role'], where: string): Player => {
    const r = recordOf(club, id)
    if (!r) throw new RangeError(`${where}的球員不存在：${id}`)
    if (r.player.role !== role) throw new RangeError(`${where}必須是${role === 'batter' ? '打者' : '投手'}：${id}`)
    return effectivePlayer(r)
  }
  const a = club.roster
  return {
    lineup: a.lineup.map((s, i) => ({ player: get(s.playerId, 'batter', `第 ${i + 1} 棒`) as Batter, position: s.position })),
    bench: a.bench.map((id) => get(id, 'batter', '板凳') as Batter),
    starter: get(a.starter, 'pitcher', '先發投手') as Pitcher,
    relievers: a.relievers.map((id) => get(id, 'pitcher', '後援') as Pitcher),
    ...(a.captain ? { captain: a.captain } : {}),
  }
}

/** 完整陣容 → 只存 ID 的配置 */
export function toAssignment(roster: Roster): RosterAssignment {
  return {
    lineup: roster.lineup.map((s) => ({ playerId: s.player.id, position: s.position })),
    bench: roster.bench.map((p) => p.id),
    starter: roster.starter.id,
    relievers: roster.relievers.map((p) => p.id),
    ...(roster.captain ? { captain: roster.captain } : {}),
  }
}

/** 配置裡用到的球員編號 */
export function assignedIds(a: RosterAssignment): Set<string> {
  return new Set([...a.lineup.map((s) => s.playerId), ...a.bench, a.starter, ...a.relievers])
}

/** 預備名單：不在配置裡的球員（養成後的樣子），依加入順序 */
export function reserves(club: ClubPlayers): Player[] {
  const used = assignedIds(club.roster)
  return club.players.filter((r) => !used.has(r.player.id)).map(effectivePlayer)
}

/** 配置的問題（ID 不存在、重複、身分不對）；空陣列就是合法（守位、人數交給 lineupIssues） */
export function assignmentIssues(club: ClubPlayers): string[] {
  const a = club.roster
  const ids = [...a.lineup.map((s) => s.playerId), ...a.bench, a.starter, ...a.relievers]
  const issues: string[] = []
  if (new Set(ids).size !== ids.length) issues.push('同一名球員不能出現在兩個位置')
  try {
    resolveRoster(club)
  } catch (e) {
    issues.push((e as Error).message)
  }
  return issues
}
