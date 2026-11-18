// @vitest-environment node
// 招募市場的候選名單（純函式）：三位、確定性、角色正確、編號不重複、不改球團
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { ManualClock, tab } from '../testkit'
import type { ClubSave } from './club'
import { RECRUIT_CANDIDATES, recruitCandidateAt, recruitCandidateSeed, recruitCandidates, recruitCost } from './recruitment'

function club(seed = 7): ClubSave {
  const d = tab(new MemoryStorage(), new ManualClock())
  return d.store.createClub({ clubName: '市場', clubSeed: seed, clubId: `c-${seed}`, now: 0 })
}
const ids = (ps: { id: string }[]) => ps.map((p) => p.id)

describe('候選名單', () => {
  it('每次固定三人，同一個角色', () => {
    const c = club()
    expect(RECRUIT_CANDIDATES).toBe(3)
    const b = recruitCandidates(c, 'batter')
    const p = recruitCandidates(c, 'pitcher')
    expect(b).toHaveLength(3)
    expect(p).toHaveLength(3)
    expect(b.every((x) => x.role === 'batter')).toBe(true)
    expect(p.every((x) => x.role === 'pitcher')).toBe(true)
  })

  it('同樣的球團種子、招募次數、角色：結果完全相同（關閉、重開、重新整理、切換角色都一樣）', () => {
    const c = club()
    const first = recruitCandidates(c, 'batter')
    recruitCandidates(c, 'pitcher')
    expect(recruitCandidates(c, 'batter')).toEqual(first)
    // 存檔序列化再讀回來（重新整理）
    expect(recruitCandidates(JSON.parse(JSON.stringify(c)), 'batter')).toEqual(first)
    expect(recruitCandidateAt(c, 'batter', 2)).toEqual(first[2])
  })

  it('三個候選位置是不同的人，各自的種子也不同', () => {
    const c = club()
    for (const role of ['batter', 'pitcher'] as const) {
      const list = recruitCandidates(c, role)
      expect(new Set(ids(list)).size).toBe(3)
      expect(new Set(list.map((p) => JSON.stringify(p.ratings))).size).toBe(3)
      const seeds = [0, 1, 2].map((i) => recruitCandidateSeed(c.clubSeed, c.recruitment.count, role, i))
      expect(new Set(seeds).size).toBe(3)
    }
  })

  it('招募次數或球團種子不同：換一批人', () => {
    const c = club()
    const a = ids(recruitCandidates(c, 'batter'))
    expect(ids(recruitCandidates({ ...c, recruitment: { count: 1 } }, 'batter'))).not.toEqual(a)
    expect(ids(recruitCandidates(club(8), 'batter'))).not.toEqual(a)
  })

  it('編號帶招募次數的前綴，不跟既有球員或其他候選人重複', () => {
    const c = club()
    const existing = new Set(c.players.map((r) => r.player.id))
    for (let count = 0; count < 40; count++) {
      const x = { ...c, recruitment: { count } }
      const all = [...recruitCandidates(x, 'batter'), ...recruitCandidates(x, 'pitcher')]
      for (const p of all) {
        expect(p.id.startsWith(`r${count}-`)).toBe(true)
        expect(existing.has(p.id)).toBe(false)
      }
      expect(new Set(ids(recruitCandidates(x, 'batter'))).size).toBe(3)
    }
  })

  it('跟既有球員撞號時，用同一條亂數換一位（仍然是確定性的）', () => {
    const c = club()
    const normal = recruitCandidates(c, 'batter')
    // 假裝第 1 位的編號已經被用掉
    const taken = { ...c, players: [...c.players, { ...c.players[0], player: { ...c.players[0].player, id: normal[1].id } }] }
    const again = recruitCandidates(taken, 'batter')
    expect(again[0]).toEqual(normal[0])
    expect(again[1].id).not.toBe(normal[1].id)
    expect(recruitCandidates(taken, 'batter')).toEqual(again)
  })

  it('不改球團：資金、招募次數、revision、陣容、進行中的比賽都不變', () => {
    const c = club()
    const before = JSON.stringify(c)
    recruitCandidates(c, 'batter')
    recruitCandidates(c, 'pitcher')
    recruitCandidateAt(c, 'pitcher', 1)
    expect(JSON.stringify(c)).toBe(before)
  })

  it('候選位置與角色不合法就丟錯', () => {
    const c = club()
    expect(() => recruitCandidateAt(c, 'batter', 3)).toThrow(RangeError)
    expect(() => recruitCandidateAt(c, 'batter', -1)).toThrow(RangeError)
    expect(() => recruitCandidateAt(c, 'batter', 1.5)).toThrow(RangeError)
    expect(() => recruitCandidates(c, 'coach' as never)).toThrow(RangeError)
  })

  it('價格：2,000、2,400、2,800，之後每次 +400', () => {
    expect([0, 1, 2, 3, 10].map((i) => recruitCost(i).funds)).toEqual([2000, 2400, 2800, 3200, 6000])
  })
})
