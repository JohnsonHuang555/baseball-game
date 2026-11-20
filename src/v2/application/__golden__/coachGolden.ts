// 自動教練（均衡型）的逐指令 Golden：Phase 9 PR 2 重構 CoachPolicy 前，用 main 的程式產生。
// 每一場記下「我方下過的所有指令」與比分的雜湊；均衡型（含玩家改過的進階設定）重構後必須逐指令相同
import { createHash } from 'node:crypto'
import { generateTeam } from '../../../sim/generate'
import { RULES_VERSION, type Side } from '../../../sim/game'
import { Rng } from '../../../sim/rng'
import type { CoachParams } from '../autoCoach'
import { runMatch, type MatchAi } from '../matchRunner'

/** 均衡型的幾組參數：預設、三檔跑壘、關掉後段調度／觸擊 */
export const BALANCED_VARIANTS: Record<string, Partial<CoachParams> | undefined> = {
  default: undefined,
  aggressive: { stealMin: 0.65, latePlatoon: true, sacBunt: true },
  conservative: { stealMin: 0.85, latePlatoon: false, sacBunt: true },
  noBunt: { stealMin: 0.75, latePlatoon: true, sacBunt: false },
}

export function coachGolden(variant: string, games = 100): string[] {
  const rows: string[] = []
  for (let i = 0; i < games; i++) {
    const seed = 9000 + i
    const userSide: Side = i % 2 ? 'away' : 'home'
    const other: Side = userSide === 'home' ? 'away' : 'home'
    const ours = generateTeam(new Rng(seed * 3 + 1), 5 + (i % 5) * 0.4)
    const opp = generateTeam(new Rng(seed * 3 + 2), 5.4)
    const setup = { home: userSide === 'home' ? ours : opp, away: userSide === 'away' ? ours : opp, seed, userSide, rules: RULES_VERSION }
    const ai = { [userSide]: { kind: 'autoCoach', style: 'balanced', params: BALANCED_VARIANTS[variant] }, [other]: { kind: 'builtin' } } as MatchAi
    const r = runMatch(setup, ai)
    const h = createHash('sha1').update(JSON.stringify(r.replay.commands)).digest('hex').slice(0, 12)
    rows.push(`${i} ${r.score.home}-${r.score.away} ${r.replay.commands.length} ${h}`)
  }
  return rows
}
