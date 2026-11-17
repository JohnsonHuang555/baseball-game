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

/** 第 index 次招募的球員編號前綴：招募次數只增不減，所以這個前綴永遠不會被第二位球員用到 */
export function recruitIdPrefix(index: number): string {
  return `r${index}-`
}

/**
 * 這一次招募會得到的球員（Lv.1）。用既有的球員產生器，編號改成「r<招募次數>-<產生器的編號>」：
 * 招募次數只增不減（釋出球員也不會減），所以就算原本的球員被釋出，歷史上用過的編號也不會再被分配給另一位球員
 * （replay、戰報、支出紀錄裡的編號永遠只指向同一個人）。結果只由球團種子與招募次數決定，仍然是確定性的。
 * 編號在產生之後才換，能力、流派、打擊方向這些由產生器編號推導的屬性都已經存進球員資料，不受影響
 */
export function recruitCandidate(club: Pick<ClubSave, 'clubSeed' | 'players' | 'recruitment'>, role: RecruitRole): Player {
  const salt = role === 'batter' ? 0 : 0x9e3779b9
  const rng = new Rng((deriveSeed(club.clubSeed, club.recruitment.count, SEED_SALT.recruit) ^ salt) >>> 0)
  const taken = new Set(club.players.map((r) => r.player.id))
  const prefix = recruitIdPrefix(club.recruitment.count)
  for (let i = 0; i < 100; i++) {
    const p = role === 'batter' ? generateBatter(rng, RECRUIT_CONFIG.mean) : generatePitcher(rng, RECRUIT_CONFIG.mean)
    const player = { ...p, id: prefix + p.id }
    if (!taken.has(player.id)) return player
  }
  throw new Error('無法產生不重複的球員編號')
}
