// Box Score：結算時從比賽結果抽出的精簡數據（每局比分、安打、失誤、我方打者與投手成績），
// 存在每一場的戰報裡，看歷史戰報時不用重新模擬整場比賽。名字當下存一份（球員之後被釋出也看得到），用陣列省空間
import type { PlayerLine, Side } from '../../sim/game'
import type { ScoreLine } from '../../sim/scoring'
import type { BoxBatter, BoxPitcher, BoxScore } from './club'
import { matchLinesOf, type MatchLines } from './stats'

export interface BoxSource {
  linescore: Record<Side, readonly number[]>
  hits: Record<Side, number>
  errors: Record<Side, number>
  players: readonly { playerId: string; name: string; side: Side; role: 'batter' | 'pitcher'; line: PlayerLine; stats?: ScoreLine }[]
}

/**
 * Phase 8 起的格式：Box Score 只留每局比分、安打、失誤，個人成績改存在 lines（以 playerId 為 key，完整原始數據）。
 * 舊比賽（遷移前）沒有 lines，仍用 boxScoreOf 的名字陣列
 */
export function matchRecordOf(src: BoxSource, userSide: Side): { box: BoxScore; lines: MatchLines } {
  const ours = src.players.filter((p) => p.side === userSide)
  const stats: Record<string, ScoreLine> = {}
  for (const p of ours) if (p.stats) stats[p.playerId] = p.stats
  return {
    box: { linescore: { home: [...src.linescore.home], away: [...src.linescore.away] }, hits: { ...src.hits }, errors: { ...src.errors }, batters: [], pitchers: [] },
    lines: matchLinesOf(stats, ours.map((p) => p.playerId)),
  }
}

/** 只留我方有出場的打者（有打席）與投手（有抓到出局或失分） */
export function boxScoreOf(src: BoxSource, userSide: Side): BoxScore {
  const ours = src.players.filter((p) => p.side === userSide)
  return {
    linescore: { home: [...src.linescore.home], away: [...src.linescore.away] },
    hits: { ...src.hits },
    errors: { ...src.errors },
    batters: ours
      .filter((p) => p.role === 'batter' && p.line.pa > 0)
      .map((p): BoxBatter => [p.name, p.line.pa, p.line.hits, p.line.hr, p.line.rbi, p.line.so]),
    pitchers: ours
      .filter((p) => p.role === 'pitcher' && p.line.outs + p.line.runs > 0)
      .map((p): BoxPitcher => [p.name, p.line.outs, p.line.runs, p.line.k]),
  }
}
