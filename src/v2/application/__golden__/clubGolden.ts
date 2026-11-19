// 球團層級的 Golden：從新球團開始連續結算，記下每一場的勝負、比分、收益、競技積分與聯盟進度。
// Phase 8 加入球員統計前後必須完全一樣（統計只多記錄，不改比賽、收益、積分）。
import { generateRoster } from '../../../sim/generate'
import { Rng } from '../../../sim/rng'
import { newClub, type ClubSave } from '../../domain/club'
import { leagueAtTier } from '../../domain/league'
import { planMatches, runBatch } from '../batchRunner'
import { settleOutcomes } from '../settlementService'

const T0 = Date.UTC(2026, 0, 1)

export async function clubGolden(seed: number, tier: number, matches: number): Promise<{ rows: string[]; final: string }> {
  let club: ClubSave = newClub({ clubId: `g${seed}`, clubName: 'golden', clubSeed: seed, roster: generateRoster(new Rng(seed)), now: T0 })
  club = { ...club, league: leagueAtTier(club.league, tier) }
  const rows: string[] = []
  let at = T0
  while (club.idle.nextMatchIndex < matches) {
    const from = club.idle.nextMatchIndex
    const plans = planMatches(club, from, Math.min(12, matches - from))
    const batch = await runBatch(plans, { yieldControl: null })
    at += 3_600_000
    const out = settleOutcomes(club, batch.outcomes, at)
    club = out.club
    for (const m of out.settled) {
      const r = m.result
      rows.push([m.matchIndex, r.runsFor, r.runsAgainst, r.innings, r.won ? 'W' : 'L', m.earnedFunds, m.earnedExperience, m.ranked ? `${m.ranked.before}>${m.ranked.after}${m.ranked.relegatedTo ?? ''}` : '-'].join(' '))
    }
  }
  const l = club.league
  const final = JSON.stringify({ record: club.record, earned: club.economy.earned, tier: l.tier, points: l.points, relegations: l.relegations, recent: l.recent })
  return { rows, final }
}

/** [球團種子, 起始聯盟階級, 場數]：新秀從頭打、挑戰者與職業會碰到競技積分（含可能的降級） */
export const GOLDEN_CLUBS: readonly (readonly [number, number, number])[] = [
  [11, 0, 120],
  [23, 2, 120],
  [37, 3, 96],
]
