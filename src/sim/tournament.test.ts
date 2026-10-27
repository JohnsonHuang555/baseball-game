import { describe, expect, it } from 'vitest'
import { RULES_VERSION } from './game'
import { allPlayers, teamAverage } from './generate'
import { PITCH_TYPES, repertoire } from './pitches'
import { RELICS } from './items'
import { STARTING_FUNDS, gameFunds, priceOf, releaseValue } from './prices'
import { EVENTS, buy, canChoose, enterRest, eventTargets, leaveShop, rerollShop, resolveEvent, train, upgrade, type EventId } from './rest'
import { rerollTeam, swapSlots } from './setup'
import {
  SEASON_GAMES,
  beginGame,
  canLearnPitch,
  canLearnPitchTrait,
  chooseStartingRelic,
  createTournament,
  equipFromBag,
  finishGame,
  opponentMean,
  pickEquipment,
  pickNewPitch,
  pickPitchTrait,
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

/** 遇到休息站就訓練第一棒的打擊 */
function passRest(t: Tournament): Tournament {
  return t.phase === 'rest' ? train(enterRest(t, 'training'), t.setup.team.roster.lineup[0].player.id, 'contact') : t
}

/** 打一場，有獎勵就放棄 */
function play(t: Tournament, score: { home: number; away: number }): Tournament {
  const next = finishGame(beginGame(t), score)
  return passRest(next.phase === 'reward' ? skipReward(next) : next)
}

function playMany(t: Tournament, results: { home: number; away: number }[]): Tournament {
  return results.reduce(play, t)
}

/** 換掉獎勵卡，方便測試各種卡 */
function withCard(t: Tournament, card: RewardCard): Tournament {
  return { ...finishGame(beginGame(passRest(t)), WIN), rewards: [card] }
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
        t = passRest(relic >= 0 ? pickRelic(t, relic) : skipReward(t))
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
    t = passRest(pickEquipment(withCard(t, { kind: 'equipment', id: 'gripBag' }), 0, null))
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

describe('休息站', () => {
  /** 打兩場後到休息站 */
  function atRest(seed: number): Tournament {
    let t = started(seed)
    t = skipReward(finishGame(beginGame(t), WIN))
    expect(t.phase).toBe('ready')
    t = skipReward(finishGame(beginGame(t), LOSS))
    expect(t.phase).toBe('rest')
    return t
  }

  it('例行賽每兩場一站，季後賽沒有', () => {
    const t = playMany(started(20), Array(SEASON_GAMES).fill(WIN))
    expect(t.round).toBe('qf')
    expect(skipReward(finishGame(beginGame(t), WIN)).phase).toBe('ready')
  })

  it('資金：開局固定，每場依勝負與得分增加', () => {
    const t = started(21)
    expect(t.funds).toBe(STARTING_FUNDS)
    expect(finishGame(beginGame(t), WIN).funds).toBe(STARTING_FUNDS + gameFunds(true, WIN.home))
    expect(gameFunds(true, 3)).toBeGreaterThan(gameFunds(false, 3))
  })

  it('訓練：免費讓一項能力 +1，之後回到下一場', () => {
    const t = enterRest(atRest(22), 'training')
    const p = t.setup.team.roster.starter
    const after = train(t, p.id, 'control')
    expect(after.setup.team.roster.starter.ratings.control).toBe(Math.min(10, p.ratings.control + 1))
    expect(after.phase).toBe('ready')
    expect(after.funds).toBe(t.funds)
  })

  it('商店：6 格商品，買了扣錢、標成售出；錢不夠不能買', () => {
    let t = enterRest(atRest(23), 'shop')
    expect(t.shop).toHaveLength(6)
    t = { ...t, funds: 1000 }
    const relic = t.shop.findIndex((x) => x.card.kind === 'relic')
    const bought = buy(t, relic)
    expect(bought.funds).toBe(1000 - t.shop[relic].price)
    expect(bought.shop[relic].sold).toBe(true)
    expect(() => buy(bought, relic)).toThrow()
    expect(() => buy({ ...t, funds: 0 }, relic)).toThrow()
  })

  it('交易：買球員要換掉同角色的人，被換下的人換回一些資金', () => {
    let t = { ...enterRest(atRest(24), 'shop'), funds: 1000 }
    const i = t.shop.findIndex((x) => x.card.kind === 'player')
    const card = t.shop[i].card as Extract<RewardCard, { kind: 'player' }>
    const slot = card.player.role === 'pitcher' ? ({ kind: 'starter' } as const) : ({ kind: 'lineup', index: 0 } as const)
    const out = card.player.role === 'pitcher' ? t.setup.team.roster.starter : t.setup.team.roster.lineup[0].player
    t = buy(t, i, { release: slot })
    expect(t.funds).toBe(1000 - priceOf(card) + releaseValue(out))
  })

  it('付費強化越來越貴；重骰換一批商品', () => {
    let t = { ...enterRest(atRest(25), 'shop'), funds: 1000 }
    const id = t.setup.team.roster.lineup[0].player.id
    const first = upgrade(t, id, 'power')
    const second = upgrade(first, id, 'power')
    expect(t.funds - first.funds).toBeLessThan(first.funds - second.funds)
    const rerolled = rerollShop(t)
    expect(rerolled.funds).toBeLessThan(t.funds)
    expect(rerolled.shop).not.toEqual(t.shop)
    expect(leaveShop(t).phase).toBe('ready')
  })

  it('每個事件的每個選項都能結算（需要對象就給第一位符合的）', () => {
    for (const event of Object.keys(EVENTS) as EventId[]) {
      for (const option of [0, 1]) {
        const t: Tournament = { ...enterRest(atRest(26), 'event'), event, funds: 500 }
        if (!canChoose(t, event, option)) continue
        const who = eventTargets(t, event, option)?.[0]?.id
        const { t: after } = resolveEvent(t, option, who)
        expect(after.phase).toBe('ready')
      }
    }
  })

  it('錢不夠的事件選項不能選', () => {
    const t: Tournament = { ...enterRest(atRest(27), 'event'), event: 'mysteriousElder', funds: 0 }
    expect(canChoose(t, 'mysteriousElder', 0)).toBe(false)
    expect(() => resolveEvent(t, 0)).toThrow()
  })
})

describe('潛能與球種卡', () => {
  it('獎勵的球種卡一定有投手用得上', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let t = started(seed)
      for (let g = 0; g < 4; g++) {
        t = finishGame(beginGame(t), WIN)
        const pitchers = allPlayers(t.setup.team.roster)
        for (const c of t.rewards) {
          if (c.kind === 'pitchTrait') expect(pitchers.some((p) => canLearnPitchTrait(p, c.pitch))).toBe(true)
          if (c.kind === 'newPitch') expect(pitchers.some((p) => canLearnPitch(p, c.pitch))).toBe(true)
        }
        t = passRest(skipReward(t))
      }
    }
  })

  it('開局有 3 位球員帶潛能，整隊重骰後重新分配', () => {
    const t = createTournament(30)
    expect(allPlayers(t.setup.team.roster).filter((p) => p.potential)).toHaveLength(3)
    const rerolled = updateSetup(t, rerollTeam(t.setup))
    expect(allPlayers(rerolled.setup.team.roster).filter((p) => p.potential)).toHaveLength(3)
  })

  it('比賽紀錄累積進度，達成就覺醒成特性', () => {
    const t = started(31)
    const p = allPlayers(t.setup.team.roster).find((x) => x.potential)!
    const pot = p.potential!
    const line = { pa: 0, hits: 0, hr: 0, rbi: 0, so: 0, outs: 0, runs: 0, k: 0, [pot.stat]: pot.need - 1 }
    const almost = finishGame(beginGame(t), WIN, [], { [p.id]: line })
    const mid = allPlayers(almost.setup.team.roster).find((x) => x.id === p.id)!
    expect(mid.potential!.progress).toBe(pot.need - 1)
    expect(almost.awakened).toEqual([])
    const done = finishGame(beginGame(skipReward(almost)), WIN, [], { [p.id]: { ...line, [pot.stat]: 1 } })
    const after = allPlayers(done.setup.team.roster).find((x) => x.id === p.id)!
    expect(after.potential).toBeUndefined()
    expect(after.traits).toContain(pot.trait)
    expect(done.awakened).toEqual([{ playerId: p.id, trait: pot.trait }])
  })

  it('訓練推進潛能', () => {
    let t = started(32)
    t = passRest(skipReward(finishGame(beginGame(t), WIN)))
    t = skipReward(finishGame(beginGame(t), WIN))
    const p = allPlayers(t.setup.team.roster).find((x) => x.potential && x.role === 'batter') ?? allPlayers(t.setup.team.roster).find((x) => x.potential)!
    const rating = p.role === 'batter' ? 'contact' : 'control'
    const after = train(enterRest(t, 'training'), p.id, rating)
    const q = allPlayers(after.setup.team.roster).find((x) => x.id === p.id)!
    expect(q.potential?.progress ?? Infinity).toBeGreaterThan(p.potential!.progress)
  })

  it('新球種卡讓投手多一個球種；已經會的不能學', () => {
    const t = started(33)
    const pitcher = t.setup.team.roster.starter
    const missing = PITCH_TYPES.find((x) => !repertoire(pitcher).includes(x))!
    const has = repertoire(pitcher)[1]
    const after = pickNewPitch(withCard(t, { kind: 'newPitch', pitch: missing }), 0, pitcher.id)
    expect(repertoire(after.setup.team.roster.starter)).toContain(missing)
    expect(() => pickNewPitch(withCard(t, { kind: 'newPitch', pitch: has }), 0, pitcher.id)).toThrow()
    expect(canLearnPitch(t.setup.team.roster.lineup[0].player, missing)).toBe(false)
  })

  it('球種特性卡加在會的球種上，每個球種最多一個', () => {
    const t = started(34)
    const pitcher = t.setup.team.roster.starter
    const after = pickPitchTrait(withCard(t, { kind: 'pitchTrait', pitch: 'fastball', id: 'sharp' }), 0, pitcher.id)
    expect(after.setup.team.roster.starter.pitchTraits).toEqual({ fastball: 'sharp' })
    expect(canLearnPitchTrait(after.setup.team.roster.starter, 'fastball')).toBe(false)
    const missing = PITCH_TYPES.find((x) => !repertoire(pitcher).includes(x))!
    expect(canLearnPitchTrait(pitcher, missing)).toBe(false)
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
