// 招募：成本、三選一的候選球員。候選人只由「球團種子 + 招募次數 + 打者／投手 + 候選位置」決定（確定性），
// 所以關閉視窗、重新整理、重試都是同一批人，不會「重抽」；簽約時服務層用同樣的資料重建，不信任畫面傳來的球員資料
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

/** 每次招募給玩家挑選的候選人數 */
export const RECRUIT_CANDIDATES = 3

const ROLE_SALT: Record<RecruitRole, number> = { batter: 0, pitcher: 0x9e3779b9 }

/**
 * 第 count 次招募、某個角色、第 index 位候選人的亂數種子。
 * 由「球團種子 + 招募次數 + 角色 + 候選位置」穩定推導：關閉視窗、重新整理、切換角色或分頁都不會變；
 * 三個位置各用一條獨立的亂數，彼此不影響
 */
export function recruitCandidateSeed(clubSeed: number, count: number, role: RecruitRole, index: number): number {
  const base = (deriveSeed(clubSeed, count, SEED_SALT.recruit) ^ ROLE_SALT[role]) >>> 0
  return deriveSeed(base, index, SEED_SALT.recruitCandidate)
}

function isCandidateIndex(index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < RECRUIT_CANDIDATES
}

/**
 * 這一次招募的三位候選人（Lv.1，都是同一個角色）。純函式：不改球團、不花錢、不加招募次數，也不需要存檔，
 * 同樣的「球團種子、招募次數、角色」永遠得到同樣三個人。
 * 用既有的球員產生器與能力分布（RECRUIT_CONFIG.mean），編號改成「r<招募次數>-<產生器的編號>」：
 * 招募次數只增不減（釋出球員也不會減），歷史上用過的編號不會再被分配給另一位球員。
 * 跟既有球員或前面的候選人撞號時，由同一條亂數再產生一次（仍然是確定性的）
 */
export function recruitCandidates(club: Pick<ClubSave, 'clubSeed' | 'players' | 'recruitment'>, role: RecruitRole): Player[] {
  if (role !== 'batter' && role !== 'pitcher') throw new RangeError(`招募類型不合法：${String(role)}`)
  const taken = new Set(club.players.map((r) => r.player.id))
  const prefix = recruitIdPrefix(club.recruitment.count)
  const out: Player[] = []
  for (let index = 0; index < RECRUIT_CANDIDATES; index++) {
    const rng = new Rng(recruitCandidateSeed(club.clubSeed, club.recruitment.count, role, index))
    let player: Player | null = null
    for (let i = 0; i < 100 && !player; i++) {
      const p = role === 'batter' ? generateBatter(rng, RECRUIT_CONFIG.mean) : generatePitcher(rng, RECRUIT_CONFIG.mean)
      const candidate = { ...p, id: prefix + p.id }
      if (!taken.has(candidate.id)) player = candidate
    }
    if (!player) throw new Error('無法產生不重複的球員編號')
    taken.add(player.id)
    out.push(player)
  }
  return out
}

/** 第 index 位候選人；index 不合法丟 RangeError */
export function recruitCandidateAt(club: Pick<ClubSave, 'clubSeed' | 'players' | 'recruitment'>, role: RecruitRole, index: number): Player {
  if (!isCandidateIndex(index)) throw new RangeError(`候選位置不合法：${index}`)
  return recruitCandidates(club, role)[index]
}

export { isCandidateIndex }
