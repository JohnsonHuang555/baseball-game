// 長期遊玩的模擬工具（只給測試與效能量測用）：正式結算一段比賽、招募新人換上第九棒、把被換下來的人釋出。
// 全部走正式的純函式（planMatches → runBatch → settleOutcomes、recruitPlayer、releasePlayer），
// 被釋出的人都真的打過正式比賽，所以生涯紀錄是真的資料
import { planMatches, runBatch } from './application/batchRunner'
import { recruitPlayer, releasePlayer } from './application/economyService'
import { settleOutcomes } from './application/settlementService'
import type { ClubSave } from './domain/club'

/** 給球團用不完的資金、經驗（只為了能一直招募） */
export function richClub(club: ClubSave): ClubSave {
  const big = { funds: 1e12, experience: 1e11 }
  return { ...club, economy: { ...club.economy, assets: big, earned: { funds: club.economy.earned.funds + 1e12, experience: club.economy.earned.experience + 1e11 } } }
}

/** 正式結算接下來的 n 場（每次最多 96 場一批） */
export async function settleMatches(club: ClubSave, n: number, now: number): Promise<ClubSave> {
  let c = club
  let left = n
  while (left > 0) {
    const k = Math.min(96, left)
    const batch = await runBatch(planMatches(c, c.idle.nextMatchIndex, k), { yieldControl: null })
    c = settleOutcomes(c, batch.outcomes, now).club
    left -= k
  }
  return c
}

/** 招募一位打者換上第九棒（同一個守位），把原本的第九棒釋出；回傳新球團與被釋出的人 */
export function rotateNinth(club: ClubSave, now: number): { club: ClubSave; releasedId: string } {
  const recruited = recruitPlayer(club, { opSeq: club.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: club.recruitment.count }, now).club
  const newId = recruited.players.at(-1)!.player.id
  const outId = recruited.roster.lineup[8].playerId
  const swapped: ClubSave = { ...recruited, roster: { ...recruited.roster, lineup: recruited.roster.lineup.map((s, i) => (i === 8 ? { ...s, playerId: newId } : s)) } }
  const released = releasePlayer(swapped, { opSeq: swapped.economy.nextOpSeq, playerId: outId }, now).club
  return { club: released, releasedId: outId }
}
