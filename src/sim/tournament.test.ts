import { describe, expect, it } from 'vitest'
import { RULES_VERSION } from './game'
import { teamAverage } from './generate'
import { RELICS } from './items'
import { rerollTeam, swapSlots } from './setup'
import {
  SEASON_GAMES,
  beginGame,
  chooseStartingRelic,
  createTournament,
  equipFromBag,
  finishGame,
  opponentMean,
  pickEquipment,
  pickPlayer,
  pickRelic,
  pickTrait,
  playoffSeed,
  relicsOf,
  saveProgress,
  skipReward,
  startTournament,
  unequip,
  updateRoster,
  updateSetup,
  type RewardCard,
  type Tournament,
} from './tournament'

const WIN = { home: 5, away: 2 }
const LOSS = { home: 1, away: 3 }

/** 開打並選第一個起始秘寶 */
function started(seed: number, tier: 1 | 2 | 3 | 4 | 5 = 1): Tournament {
  return chooseStartingRelic(startTournament(createTournament(seed, tier)), 0)
}

/** 打一場，有獎勵就放棄 */
function play(t: Tournament, score: { home: number; away: number }): Tournament {
  const next = finishGame(beginGame(t), score)
  return next.phase === 'reward' ? skipReward(next) : next
}

function playMany(t: Tournament, results: { home: number; away: number }[]): Tournament {
  return results.reduce(play, t)
}

/** 換掉獎勵卡，方便測試各種卡 */
function withCard(t: Tournament, card: RewardCard): Tournament {
  return { ...finishGame(beginGame(t), WIN), rewards: [card] }
}

describe('錦標賽開打前', () => {
  it('12 隊，隊名不重複，玩家是第 0 隊；例行賽 8 場對手不重複', () => {
    const t = createTournament(1)
    expect(t.teamNames).toHaveLength(12)
    expect(new Set(t.teamNames).size).toBe(12)
    expect(t.teamNames[0]).toBe(t.setup.team.name)
    expect(new Set(t.schedule).size).toBe(SEASON_GAMES)
    expect(t.schedule).not.toContain(0)
    expect(t.phase).toBe('pregame')
  })

  it('整隊只能重骰一次，沒有單人重骰；開打後就不行', () => {
    let t = createTournament(2)
    expect(t.setup.teamRerollsLeft).toBe(1)
    expect(t.setup.playerRerollsLeft).toBe(0)
    t = updateSetup(t, rerollTeam(t.setup))
    expect(t.setup.teamRerollsLeft).toBe(0)
    t = startTournament(t)
    expect(() => updateSetup(t, rerollTeam(t.setup))).toThrow()
  })

  it('自訂隊名撞到 AI 隊伍時，AI 隊伍改名', () => {
    const t = createTournament(1)
    const taken = t.opponent.name
    const next = updateSetup(t, { ...t.setup, team: { ...t.setup.team, name: taken } })
    expect(next.teamNames[0]).toBe(taken)
    expect(new Set(next.teamNames).size).toBe(12)
    expect(next.opponent.name).not.toBe(taken)
  })

  it('開打後先從 3 個非彩虹秘寶選 1 個', () => {
    const t = startTournament(createTournament(3))
    expect(t.phase).toBe('relic')
    expect(t.relicOptions).toHaveLength(3)
    expect(t.relicOptions.every((id) => RELICS[id].tier !== 'rainbow')).toBe(true)
    const picked = chooseStartingRelic(t, 1)
    expect(picked.phase).toBe('ready')
    expect(relicsOf(picked)).toEqual([t.relicOptions[1]])
  })

  it('開打後仍可以調整陣容', () => {
    const t = started(3)
    const swapped = swapSlots(t.setup.team.roster, { kind: 'lineup', index: 0 }, { kind: 'lineup', index: 1 })!
    expect(updateRoster(t, swapped).setup.team.roster).toBe(swapped)
  })
})

describe('例行賽與季後賽', () => {
  it('例行賽 5 勝 3 敗晉級，之後八強、四強各一場，決賽三戰兩勝奪冠', () => {
    let t = playMany(started(4), [WIN, LOSS, WIN, LOSS, WIN, LOSS, WIN, WIN])
    expect(t.round).toBe('qf')
    expect(t.phase).toBe('ready')
    t = play(t, WIN)
    expect(t.round).toBe('sf')
    t = play(t, WIN)
    expect(t.round).toBe('final')
    t = play(t, WIN)
    expect(t.phase).toBe('ready')
    t = finishGame(beginGame(t), WIN)
    expect(t.phase).toBe('champion')
    expect(t.history).toHaveLength(SEASON_GAMES + 4)
  })

  it('例行賽第 4 敗就淘汰', () => {
    const t = playMany(started(5), [LOSS, LOSS, LOSS])
    expect(t.phase).toBe('ready')
    expect(play(t, LOSS).phase).toBe('eliminated')
  })

  it('季後賽輸一場就淘汰；決賽輸兩場淘汰', () => {
    const playoffs = playMany(started(6), Array(SEASON_GAMES).fill(WIN))
    expect(play(playoffs, LOSS).phase).toBe('eliminated')
    const final = playMany(playoffs, [WIN, WIN, LOSS])
    expect(final.phase).toBe('ready')
    expect(play(final, LOSS).phase).toBe('eliminated')
  })

  it('每場（除了奪冠那場）之後都有獎勵選擇：贏 3 張、輸 2 張', () => {
    const t = started(7)
    expect(finishGame(beginGame(t), WIN).rewards).toHaveLength(3)
    expect(finishGame(beginGame(t), LOSS).rewards).toHaveLength(2)
  })

  it('對手隨場次變強，難度越高越強；例行賽勝場越多，季後賽對手越弱', () => {
    const t = started(8)
    expect(opponentMean(playMany(t, [WIN, WIN, WIN]))).toBeGreaterThan(opponentMean(t))
    expect(opponentMean(started(8, 5))).toBeGreaterThan(opponentMean(started(8, 1)))
    const perfect = playMany(t, Array(8).fill(WIN))
    const barely = playMany(t, [WIN, WIN, WIN, WIN, WIN, LOSS, LOSS, LOSS])
    expect(playoffSeed(perfect)).toBe(1)
    expect(playoffSeed(barely)).toBe(4)
    expect(opponentMean(perfect)).toBeLessThan(opponentMean(barely))
  })

  it('對手的實際能力跟著曲線走', () => {
    const early = started(9, 1)
    const late = playMany(started(9, 5), Array(7).fill(WIN))
    expect(teamAverage(late.opponent.roster)).toBeGreaterThan(teamAverage(early.opponent.roster))
  })
})

describe('獎勵卡', () => {
  it('不會出現已經擁有的秘寶', () => {
    for (let seed = 1; seed <= 30; seed++) {
      let t = started(seed)
      for (let g = 0; g < 6; g++) {
        t = finishGame(beginGame(t), WIN)
        for (const c of t.rewards) if (c.kind === 'relic') expect(relicsOf(t)).not.toContain(c.id)
        const relic = t.rewards.findIndex((c) => c.kind === 'relic')
        t = relic >= 0 ? pickRelic(t, relic) : skipReward(t)
      }
    }
  })

  it('球員卡取代同角色的一格，被換下的人的裝備回到背包', () => {
    let t = started(10)
    t = { ...t, bag: ['trainingBat'] }
    const first = t.setup.team.roster.lineup[0].player
    t = equipFromBag(t, 0, first.id)
    const rookie = { ...t.setup.team.roster.bench[0], id: 'rookie' }
    t = pickPlayer(withCard(t, { kind: 'player', player: rookie }), 0, { kind: 'lineup', index: 0 })
    expect(t.setup.team.roster.lineup[0].player.id).toBe('rookie')
    expect(t.bag).toEqual(['trainingBat'])
    expect(() => pickPlayer(withCard(t, { kind: 'player', player: rookie }), 0, { kind: 'starter' })).toThrow()
  })

  it('裝備卡可以裝上或放進背包；裝滿要指定換下哪一件', () => {
    let t = started(11)
    const id = t.setup.team.roster.lineup[2].player.id
    t = pickEquipment(withCard(t, { kind: 'equipment', id: 'spikes' }), 0, id)
    t = pickEquipment(withCard(t, { kind: 'equipment', id: 'masterBat' }), 0, id)
    expect(t.setup.team.roster.lineup[2].player.equipment).toEqual(['spikes', 'masterBat'])
    expect(() => pickEquipment(withCard(t, { kind: 'equipment', id: 'weightedBat' }), 0, id)).toThrow()
    t = pickEquipment(withCard(t, { kind: 'equipment', id: 'weightedBat' }), 0, id, 0)
    expect(t.setup.team.roster.lineup[2].player.equipment).toEqual(['weightedBat', 'masterBat'])
    expect(t.bag).toEqual(['spikes'])
    t = pickEquipment(withCard(t, { kind: 'equipment', id: 'gripBag' }), 0, null)
    expect(t.bag).toEqual(['spikes', 'gripBag'])
    // 投手的裝備不能給打者
    expect(() => equipFromBag(t, 1, id)).toThrow()
    t = unequip(t, id, 1)
    expect(t.bag).toEqual(['spikes', 'gripBag', 'masterBat'])
  })

  it('特性卡取代互斥的舊特性，角色不符不能學', () => {
    let t = started(12)
    const target = t.setup.team.roster.lineup[0].player
    t = { ...t, setup: { ...t.setup, team: { ...t.setup.team, roster: { ...t.setup.team.roster, lineup: t.setup.team.roster.lineup.map((s, i) => (i === 0 ? { ...s, player: { ...s.player, traits: ['errorProne'] } } : s)) } } } }
    t = pickTrait(withCard(t, { kind: 'trait', id: 'goodGlove' }), 0, target.id)
    expect(t.setup.team.roster.lineup[0].player.traits).toEqual(['goodGlove'])
    expect(() => pickTrait(withCard(t, { kind: 'trait', id: 'closer' }), 0, target.id)).toThrow()
  })
})

describe('上場比賽', () => {
  it('比賽用的隊伍含裝備加成與秘寶，錦標賽存的能力不變；新比賽記下規則版本', () => {
    let t: Tournament = { ...started(13), bag: ['compressedBat'] }
    const p = t.setup.team.roster.lineup[0].player
    t = equipFromBag(t, 0, p.id)
    const game = beginGame(t).currentGame!.setup
    expect(game.home.roster.lineup[0].player.ratings.power).toBe(Math.min(10, p.ratings.power + 2))
    expect(game.home.relics).toEqual(relicsOf(t))
    expect(game.rules).toBe(RULES_VERSION)
    expect(t.setup.team.roster.lineup[0].player.ratings.power).toBe(p.ratings.power)
  })

  it('比賽結束時把成長套用到陣容', () => {
    const t = started(14)
    const p = t.setup.team.roster.lineup[0].player
    const grown = finishGame(beginGame(t), WIN, [{ playerId: p.id, rating: 'contact', amount: 1, mvp: true }])
    expect(grown.setup.team.roster.lineup[0].player.ratings.contact).toBe(Math.min(10, p.ratings.contact + 1))
  })

  it('狀態可以轉成 JSON 再還原，比賽進行中記住指令紀錄', () => {
    const t = saveProgress(beginGame(started(15)), [{ stepIndex: 3, tactic: { type: 'intentionalWalk' } }], 5)
    const restored = JSON.parse(JSON.stringify(t)) as Tournament
    expect(restored.currentGame!.commands).toHaveLength(1)
    expect(finishGame(restored, WIN).phase).toBe('reward')
  })
})
