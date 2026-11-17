// 招募：成本、候選球員。第幾次招募的結果只由「球團種子 + 招募次數 + 打者／投手」決定（確定性），
// 所以同一個請求失敗後重試，抽到的一定是同一位球員，不會「重抽」
import { generateBatter, generatePitcher } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { Player } from '../../sim/types'
import { SEED_SALT, deriveSeed, type ClubSave, type Resources } from './club'
import { RECRUIT_CONFIG } from './progressionConfig'

export type RecruitRole = Player['role']

/** 第 count 次招募（從 0 起算）的成本：只花資金 */
export function recruitCost(count: number): Resources {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`招募次數不合法：${count}`)
  return { funds: RECRUIT_CONFIG.baseFunds + count * RECRUIT_CONFIG.stepFunds, experience: 0 }
}

export function rosterFull(club: Pick<ClubSave, 'players'>): boolean {
  return club.players.length >= RECRUIT_CONFIG.maxPlayers
}

/**
 * 這一次招募會得到的球員（Lv.1）。用既有的球員產生器；編號跟現有球員撞到時，用同一個亂數來源繼續產生下一位，
 * 結果仍然是確定性的。不用名單長度當編號，所以重新整理、遷移、之後刪除球員都不會撞號
 */
export function recruitCandidate(club: Pick<ClubSave, 'clubSeed' | 'players' | 'recruitment'>, role: RecruitRole): Player {
  const salt = role === 'batter' ? 0 : 0x9e3779b9
  const rng = new Rng((deriveSeed(club.clubSeed, club.recruitment.count, SEED_SALT.recruit) ^ salt) >>> 0)
  const taken = new Set(club.players.map((r) => r.player.id))
  for (let i = 0; i < 100; i++) {
    const p = role === 'batter' ? generateBatter(rng, RECRUIT_CONFIG.mean) : generatePitcher(rng, RECRUIT_CONFIG.mean)
    if (!taken.has(p.id)) return p
  }
  throw new Error('無法產生不重複的球員編號')
}
