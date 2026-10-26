import { describe, expect, it } from 'vitest'
import { RULES_VERSION } from './game'
import { teamAverage } from './generate'
import { rerollTeam, swapSlots } from './setup'
import {
  ROUNDS,
  beginGame,
  bracket,
  createTournament,
  draftPick,
  finishGame,
  saveProgress,
  skipDraft,
  startTournament,
  updateRoster,
  updateSetup,
  type Tournament,
} from './tournament'

const WIN = { home: 5, away: 2 }
const LOSS = { home: 1, away: 3 }

function play(t: Tournament, score: { home: number; away: number }): Tournament {
  return finishGame(beginGame(t), score)
}

describe('錦標賽開打前', () => {
  it('16 隊，隊名不重複，玩家是第 0 隊', () => {
    const t = createTournament(1)
    expect(t.teamNames).toHaveLength(16)
    expect(new Set(t.teamNames).size).toBe(16)
    expect(t.teamNames[0]).toBe(t.setup.team.name)
    expect(t.phase).toBe('pregame')
  })

  it('開打前可以重骰，開打後就不行', () => {
    let t = createTournament(2)
    t = updateSetup(t, rerollTeam(t.setup))
    expect(t.setup.teamRerollsLeft).toBe(2)
    t = startTournament(t)
    expect(() => updateSetup(t, rerollTeam(t.setup))).toThrow()
  })

  it('自訂隊名撞到 AI 隊伍時，AI 隊伍改名，隊名仍不重複', () => {
    const t = createTournament(1)
    const taken = t.teamNames[t.opponents[0]]
    const next = updateSetup(t, { ...t.setup, team: { ...t.setup.team, name: taken } })
    expect(next.teamNames[0]).toBe(taken)
    expect(new Set(next.teamNames).size).toBe(16)
    expect(next.opponent.name).toBe(next.teamNames[next.opponents[0]])
    expect(next.opponent.name).not.toBe(taken)
  })

  it('開打後仍可以調整陣容', () => {
    const t = startTournament(createTournament(3))
    const swapped = swapSlots(t.setup.team.roster, { kind: 'lineup', index: 0 }, { kind: 'lineup', index: 1 })!
    expect(updateRoster(t, swapped).setup.team.roster).toBe(swapped)
  })

  it('同一個種子產生同樣的賽程和對手', () => {
    expect(createTournament(9)).toEqual(createTournament(9))
  })
})

describe('晉級流程', () => {
  it('十六強、八強、四強各贏一場後都有選秀，決賽三戰兩勝奪冠', () => {
    let t = startTournament(createTournament(4))
    for (const round of ['r16', 'qf', 'sf'] as const) {
      expect(ROUNDS[t.roundIndex]).toBe(round)
      t = play(t, WIN)
      expect(t.phase).toBe('draft')
      expect(t.draftOptions).toHaveLength(3)
      t = skipDraft(t)
    }
    expect(ROUNDS[t.roundIndex]).toBe('final')
    t = play(t, WIN)
    expect(t.phase).toBe('ready')
    expect(t.series).toEqual({ user: 1, opponent: 0 })
    t = play(t, LOSS)
    expect(t.phase).toBe('ready')
    t = play(t, WIN)
    expect(t.phase).toBe('champion')
    expect(t.history).toHaveLength(6)
  })

  it('單場輸了就淘汰', () => {
    const t = play(startTournament(createTournament(5)), LOSS)
    expect(t.phase).toBe('eliminated')
  })

  it('決賽輸兩場就淘汰', () => {
    let t = startTournament(createTournament(6))
    for (let i = 0; i < 3; i++) t = skipDraft(play(t, WIN))
    t = play(play(t, LOSS), LOSS)
    expect(t.phase).toBe('eliminated')
  })

  it('決賽系列賽中沒有選秀', () => {
    let t = startTournament(createTournament(7))
    for (let i = 0; i < 3; i++) t = skipDraft(play(t, WIN))
    t = play(t, WIN)
    expect(t.draftOptions).toHaveLength(0)
  })

  it('對手越後面越強', () => {
    const avg = [0, 0, 0, 0]
    for (let seed = 1; seed <= 60; seed++) {
      let t = startTournament(createTournament(seed))
      for (let r = 0; r < 4; r++) {
        avg[r] += teamAverage(t.opponent.roster) / 60
        if (r < 3) t = skipDraft(play(t, WIN))
      }
    }
    expect(avg[1]).toBeGreaterThan(avg[0])
    expect(avg[2]).toBeGreaterThan(avg[1])
    expect(avg[3]).toBeGreaterThan(avg[2])
  })

  it('每一輪的對手都是賽程樹中另一側晉級上來的隊伍', () => {
    let t = startTournament(createTournament(8))
    for (let r = 0; r < 4; r++) {
      expect(t.opponent.name).toBe(t.teamNames[t.opponents[r]])
      expect(t.opponents[r]).toBeGreaterThanOrEqual(2 ** r)
      expect(t.opponents[r]).toBeLessThan(2 ** (r + 1))
      if (r < 3) t = skipDraft(play(t, WIN))
    }
  })
})

describe('選秀', () => {
  function atDraft(seed: number): Tournament {
    return play(startTournament(createTournament(seed)), WIN)
  }

  it('選到的球員取代同角色的位置，被替換的人釋出', () => {
    for (let seed = 1; seed < 30; seed++) {
      const t = atDraft(seed)
      const index = t.draftOptions.findIndex((p) => p.role === 'batter')
      if (index < 0) continue
      const pick = t.draftOptions[index]
      const released = t.setup.team.roster.lineup[4].player
      const next = draftPick(t, index, { kind: 'lineup', index: 4 })
      expect(next.setup.team.roster.lineup[4].player).toBe(pick)
      expect(next.setup.team.roster.lineup[4].position).toBe(t.setup.team.roster.lineup[4].position)
      expect(JSON.stringify(next.setup.team.roster)).not.toContain(released.id)
      expect(next.phase).toBe('ready')
      expect(next.roundIndex).toBe(1)
      return
    }
    throw new Error('找不到打者選項')
  })

  it('角色不符不能替換', () => {
    for (let seed = 1; seed < 30; seed++) {
      const t = atDraft(seed)
      const index = t.draftOptions.findIndex((p) => p.role === 'pitcher')
      if (index < 0) continue
      expect(() => draftPick(t, index, { kind: 'lineup', index: 0 })).toThrow()
      return
    }
    throw new Error('找不到投手選項')
  })

  it('放棄選秀，名單不變', () => {
    const t = atDraft(11)
    expect(skipDraft(t).setup.team.roster).toEqual(t.setup.team.roster)
  })
})

describe('存檔', () => {
  it('狀態可以轉成 JSON 再還原，繼續往下打', () => {
    let t = startTournament(createTournament(12))
    t = skipDraft(play(t, WIN))
    const restored: Tournament = JSON.parse(JSON.stringify(t))
    expect(restored).toEqual(t)
    expect(play(restored, WIN)).toEqual(play(t, WIN))
  })

  it('比賽進行中會記住種子和指令紀錄', () => {
    let t = beginGame(startTournament(createTournament(13)))
    expect(t.phase).toBe('playing')
    expect(t.currentGame?.setup.home.name).toBe(t.setup.team.name)
    t = saveProgress(t, [{ stepIndex: 3, tactic: { type: 'bunt' } }], 10)
    expect(t.currentGame?.stepIndex).toBe(10)
    expect(t.currentGame?.commands).toHaveLength(1)
    expect(finishGame(t, WIN).currentGame).toBeNull()
  })
})

describe('賽程樹', () => {
  it('每一輪的場次數正確：8、4、2、1', () => {
    let t = startTournament(createTournament(14))
    for (let i = 0; i < 3; i++) t = skipDraft(play(t, WIN))
    t = play(play(t, WIN), WIN)
    const rounds = bracket(t)
    expect(rounds.map((r) => r.length)).toEqual([8, 4, 2, 1])
    expect(rounds[3][0].winner).toBe(0)
  })
})

describe('錦標賽成長', () => {
  it('比賽結束時把成長套用到自己的陣容，而且新開的比賽記下規則版本', () => {
    const t = beginGame(startTournament(createTournament(5)))
    expect(t.currentGame!.setup.rules).toBe(RULES_VERSION)
    const batter = t.setup.team.roster.lineup[2].player
    const after = finishGame(t, WIN, [{ playerId: batter.id, rating: 'power', amount: 1, mvp: true }])
    expect(after.setup.team.roster.lineup[2].player.ratings.power).toBe(Math.min(10, batter.ratings.power + 1))
  })
})
