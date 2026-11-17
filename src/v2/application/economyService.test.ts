// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { economyViolations, type ClubSave } from '../domain/club'
import { substitute, swapWithReserve } from '../domain/lineup'
import { leveled, upgradeCost } from '../domain/progression'
import { MAX_LEVEL, RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCost } from '../domain/recruitment'
import { recordOf, reserves, resolveRoster, toAssignment } from '../domain/roster'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, MINUTE, ManualClock, T0, tab } from '../testkit'
import { planMatch } from './batchRunner'
import { createClubSafely } from './clubLifecycle'
import { EconomyError, recruit, recruitPlayer, upgrade, upgradePlayer } from './economyService'
import { SettlementError, claim, settleDue, updateSettings } from './settlementService'
import { runMatch } from './matchRunner'

const rich = { funds: 10_000_000, experience: 1_000_000 }

/** 建立球團；給了 assets 就直接改成那麼多資產（同時算進收入，帳才對得起來） */
async function setup(assets?: { funds: number; experience: number }, storage: MemoryStorage | FlakyStorage = new MemoryStorage(), locks: FakeLockManager | null = new FakeLockManager()) {
  const clock = new ManualClock()
  const deps = tab(storage, clock, locks ?? undefined)
  await createClubSafely(deps, { clubName: '經濟測試', clubSeed: 42, clubId: 'club-econ' })
  if (assets) {
    const c = deps.store.loadClub()!
    deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { ...assets }, earned: { ...assets } } }, c.revision)
  }
  return { deps, clock, storage }
}
const load = (d: ReturnType<typeof tab>) => d.store.loadClub()!
const firstStarter = (c: ClubSave) => c.roster.lineup[0].playerId

describe('升級', () => {
  it('Lv.1 升到 Lv.2：扣資金與經驗、支出累計增加、帳務不變量成立', async () => {
    const { deps } = await setup({ funds: 5000, experience: 500 })
    const id = firstStarter(load(deps))
    const cost = upgradeCost(1)!
    const out = await upgrade(deps, { opSeq: 0, playerId: id, expectedLevel: 1 })
    const c = load(deps)
    expect(out.duplicate).toBe(false)
    expect(recordOf(c, id)!.level).toBe(2)
    expect(c.economy.assets).toEqual({ funds: 5000 - cost.funds, experience: 500 - cost.experience })
    expect(c.economy.spent).toEqual(cost)
    expect(c.economy.nextOpSeq).toBe(1)
    expect(c.economy.recentOps).toEqual([expect.objectContaining({ seq: 0, kind: 'upgrade', playerId: id, cost, fromLevel: 1, toLevel: 2 })])
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('Lv.20 不能再升', async () => {
    const { deps } = await setup(rich)
    const id = firstStarter(load(deps))
    for (let lv = 1; lv < MAX_LEVEL; lv++) await upgrade(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id, expectedLevel: lv })
    expect(recordOf(load(deps), id)!.level).toBe(MAX_LEVEL)
    const error = await upgrade(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id, expectedLevel: MAX_LEVEL }).catch((e) => e)
    expect(error).toBeInstanceOf(EconomyError)
    expect(error.code).toBe('max-level')
  })

  it('資源不足：拒絕，不扣款', async () => {
    const { deps } = await setup({ funds: 100, experience: 10 })
    const before = load(deps)
    const error = await upgrade(deps, { opSeq: 0, playerId: firstStarter(before), expectedLevel: 1 }).catch((e) => e)
    expect(error.code).toBe('insufficient')
    expect(load(deps)).toEqual(before)
  })

  it('同一個請求重送：不會連升兩級，回傳原本那一筆', async () => {
    const { deps } = await setup(rich)
    const id = firstStarter(load(deps))
    const req = { opSeq: 0, playerId: id, expectedLevel: 1 }
    const first = await upgrade(deps, req)
    for (let i = 0; i < 10; i++) {
      const again = await upgrade(deps, req)
      expect(again.duplicate).toBe(true)
      expect(again.op).toEqual(first.op)
    }
    const c = load(deps)
    expect(recordOf(c, id)!.level).toBe(2)
    expect(c.economy.spent).toEqual(upgradeCost(1))
    expect(c.economy.nextOpSeq).toBe(1)
  })

  it('不存在的球員、等級對不上（畫面過期）、序號被別的操作用掉：都拒絕', async () => {
    const { deps } = await setup(rich)
    const c = load(deps)
    expect((await upgrade(deps, { opSeq: 0, playerId: 'nobody', expectedLevel: 1 }).catch((e) => e)).code).toBe('no-player')
    expect((await upgrade(deps, { opSeq: 0, playerId: firstStarter(c), expectedLevel: 3 }).catch((e) => e)).code).toBe('level-mismatch')
    await upgrade(deps, { opSeq: 0, playerId: firstStarter(c), expectedLevel: 1 })
    // 同一個序號，但是是別的請求：拒絕（不能當作重送）
    expect((await upgrade(deps, { opSeq: 0, playerId: c.roster.lineup[1].playerId, expectedLevel: 1 }).catch((e) => e)).code).toBe('stale-request')
    expect((await upgrade(deps, { opSeq: 9, playerId: firstStarter(c), expectedLevel: 2 }).catch((e) => e)).code).toBe('stale-request')
    expect((await upgrade(deps, { opSeq: -1, playerId: firstStarter(c), expectedLevel: 2 }).catch((e) => e)).code).toBe('bad-request')
  })

  it('改陣容（換下板凳、換回來）等級都不會流失', async () => {
    const { deps } = await setup(rich)
    const c = load(deps)
    const id = firstStarter(c)
    await upgrade(deps, { opSeq: 0, playerId: id, expectedLevel: 1 })
    const benched = substitute(resolveRoster(load(deps)), 0, 0)
    await updateSettings(deps, { roster: toAssignment(benched) })
    expect(load(deps).roster.bench).toContain(id)
    expect(recordOf(load(deps), id)!.level).toBe(2)
    await updateSettings(deps, { roster: c.roster })
    expect(recordOf(load(deps), id)!.level).toBe(2)
    expect(resolveRoster(load(deps)).lineup[0].player.ratings).toEqual(leveled(recordOf(c, id)!.player, 2).ratings)
  })

  it('升級影響之後的比賽：下一場的計畫用新能力；已經打完的比賽與 replay 不變', async () => {
    const { deps, clock } = await setup(rich)
    clock.advance(30 * MINUTE)
    await settleDue(deps)
    const before = load(deps)
    const replaysBefore = structuredClone(before.replays)
    const id = firstStarter(before)
    const base = recordOf(before, id)!.player
    for (let lv = 1; lv < 10; lv++) await upgrade(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id, expectedLevel: lv })
    const after = load(deps)
    expect(after.replays).toEqual(replaysBefore)
    expect(after.recentMatches).toEqual(before.recentMatches)
    // 進行中那一場已經固定（升級前的能力）；下一場才用 Lv.10 的能力
    expect(after.liveMatch?.matchIndex).toBe(after.idle.nextMatchIndex)
    const plan = planMatch(after, after.idle.nextMatchIndex + 1)
    const ours = plan.setup[plan.userSide].roster.lineup[0].player
    expect(ours.ratings).toEqual(leveled(base, 10).ratings)
    expect(ours.ratings).not.toEqual(base.ratings)
    // 實際打完：進行中那一場是舊能力，下一場的 replay 裡是新能力
    clock.advance(10 * MINUTE)
    const report = await settleDue(deps)
    const inProgress = report.club.replays.at(-2)!.replay
    expect(inProgress.setup[inProgress.setup.userSide].roster.lineup[0].player.ratings).toEqual(base.ratings)
    const rep = report.club.replays.at(-1)!.replay
    expect(rep.setup[rep.setup.userSide].roster.lineup[0].player.ratings).toEqual(leveled(base, 10).ratings)
  })

  it('離線 8 小時後升級：到期的 96 場先用舊能力打完，不能回頭用新能力', async () => {
    const { deps, clock } = await setup(rich)
    const before = load(deps)
    const id = firstStarter(before)
    const base = recordOf(before, id)!.player
    clock.advance(8 * HOUR)
    const out = await upgrade(deps, { opSeq: 0, playerId: id, expectedLevel: 1 })
    expect(out.club.idle.nextMatchIndex).toBe(96)
    for (const { replay } of out.club.replays) expect(replay.setup[replay.setup.userSide].roster.lineup[0].player.ratings).toEqual(base.ratings)
    expect(recordOf(out.club, id)!.level).toBe(2)
  })

  it('兩個分頁同時升級同一位：只升一級', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const a = tab(storage, clock, locks)
    const b = tab(storage, clock, locks)
    await createClubSafely(a, { clubName: '多分頁', clubSeed: 1, clubId: 'mt' })
    const c = a.store.loadClub()!
    a.store.saveClub({ ...c, economy: { ...c.economy, assets: rich, earned: rich } }, c.revision)
    const id = firstStarter(c)
    // 兩個分頁都根據同一份畫面（序號 0、Lv.1）送出
    const results = await Promise.allSettled([upgrade(a, { opSeq: 0, playerId: id, expectedLevel: 1 }), upgrade(b, { opSeq: 0, playerId: id, expectedLevel: 1 })])
    const club = a.store.loadClub()!
    expect(recordOf(club, id)!.level).toBe(2)
    expect(club.economy.spent).toEqual(upgradeCost(1))
    // 第二個收到的是重送（同一個請求），不是第二次扣款
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    expect(results.filter((r) => r.status === 'fulfilled' && r.value.duplicate)).toHaveLength(1)
  })

  it('兩個分頁同時升級不同球員，資金只夠一次：不會變成負數', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const a = tab(storage, clock, locks)
    const b = tab(storage, clock, locks)
    await createClubSafely(a, { clubName: '多分頁', clubSeed: 1, clubId: 'mt' })
    const c = a.store.loadClub()!
    const cost = upgradeCost(1)!
    const once = { funds: cost.funds + 10, experience: cost.experience + 10 }
    a.store.saveClub({ ...c, economy: { ...c.economy, assets: once, earned: once } }, c.revision)
    const results = await Promise.allSettled([
      upgrade(a, { opSeq: 0, playerId: c.roster.lineup[0].playerId, expectedLevel: 1 }),
      upgrade(b, { opSeq: 0, playerId: c.roster.lineup[1].playerId, expectedLevel: 1 }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const club = a.store.loadClub()!
    expect(club.economy.assets.funds).toBe(10)
    expect(economyViolations(club.economy)).toEqual([])
  })

  it('沒有 Web Locks 的兩個分頁交錯操作：後存的被 revision 檢查擋下，不會重複扣款', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const a = tab(storage, clock)
    const b = tab(storage, clock)
    await createClubSafely(a, { clubName: '降級', clubSeed: 1, clubId: 'nolock' })
    const c = a.store.loadClub()!
    a.store.saveClub({ ...c, economy: { ...c.economy, assets: rich, earned: rich } }, c.revision)
    clock.advance(HOUR) // 有到期的比賽，結算時會讓出主執行緒，兩個分頁交錯
    const results = await Promise.allSettled([
      upgrade(a, { opSeq: 0, playerId: c.roster.lineup[0].playerId, expectedLevel: 1 }),
      recruit(b, { opSeq: 0, role: 'batter' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(failed.reason).toBeInstanceOf(ClubSaveError)
    expect(failed.reason.code).toBe('conflict')
    const club = a.store.loadClub()!
    expect(club.economy.nextOpSeq).toBe(1)
    expect(economyViolations(club.economy)).toEqual([])
  })

  it('存檔失敗：不扣款、等級不變，重試結果跟沒失敗過一樣', async () => {
    const storage = new FlakyStorage()
    const { deps } = await setup(rich, storage)
    const before = load(deps)
    storage.failWrites = true
    const req = { opSeq: 0, playerId: firstStarter(before), expectedLevel: 1 }
    await expect(upgrade(deps, req)).rejects.toThrow(ClubSaveError)
    expect(load(deps)).toEqual(before)
    storage.failWrites = false
    await upgrade(deps, req)
    expect(recordOf(load(deps), req.playerId)!.level).toBe(2)
    expect(load(deps).economy.spent).toEqual(upgradeCost(1))
  })
})

describe('招募', () => {
  it('資金足夠：招募到 Lv.1 的新球員，放進預備名單，不自動上場', async () => {
    const { deps } = await setup({ funds: 50_000, experience: 0 })
    const before = load(deps)
    const out = await recruit(deps, { opSeq: 0, role: 'batter' })
    const c = load(deps)
    const rec = recordOf(c, out.op.playerId)!
    expect(rec.level).toBe(1)
    expect(rec.origin).toBe('recruit')
    expect(rec.player.role).toBe('batter')
    expect(c.players).toHaveLength(15)
    expect(c.roster).toEqual(before.roster)
    expect(reserves(c).map((p) => p.id)).toEqual([rec.player.id])
    expect(c.economy.assets.funds).toBe(50_000 - recruitCost(0).funds)
    expect(c.recruitment.count).toBe(1)
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('資金不足：拒絕，不扣款', async () => {
    const { deps } = await setup({ funds: recruitCost(0).funds - 1, experience: 0 })
    const before = load(deps)
    expect((await recruit(deps, { opSeq: 0, role: 'pitcher' }).catch((e) => e)).code).toBe('insufficient')
    expect(load(deps)).toEqual(before)
  })

  it('招募到上限：拒絕，不扣款；每位球員編號唯一', async () => {
    const { deps } = await setup(rich)
    const roles = ['batter', 'pitcher'] as const
    for (let i = 0; i < RECRUIT_CONFIG.maxPlayers - 14; i++) await recruit(deps, { opSeq: load(deps).economy.nextOpSeq, role: roles[i % 2] })
    const full = load(deps)
    expect(full.players).toHaveLength(RECRUIT_CONFIG.maxPlayers)
    expect(new Set(full.players.map((r) => r.player.id)).size).toBe(RECRUIT_CONFIG.maxPlayers)
    const error = await recruit(deps, { opSeq: full.economy.nextOpSeq, role: 'batter' }).catch((e) => e)
    expect(error.code).toBe('roster-full')
    expect(load(deps)).toEqual(full)
  })

  it('滿員 30 人、近期比賽與 replay 都滿：存檔大小有上限，不隨場次成長', async () => {
    const storage = new MemoryStorage()
    const { deps, clock } = await setup(rich, storage)
    for (let i = 0; i < RECRUIT_CONFIG.maxPlayers - 14; i++) await recruit(deps, { opSeq: load(deps).economy.nextOpSeq, role: i % 2 ? 'pitcher' : 'batter' })
    for (let i = 0; i < 40; i++) {
      const c = load(deps)
      const r = c.players[i % c.players.length]
      await upgrade(deps, { opSeq: c.economy.nextOpSeq, playerId: r.player.id, expectedLevel: r.level })
    }
    const sizes: number[] = []
    for (let day = 0; day < 4; day++) {
      clock.advance(8 * HOUR)
      await settleDue(deps)
      sizes.push(storage.getItem('dice-baseball.club.v3')!.length)
    }
    expect(Math.max(...sizes)).toBeLessThan(100_000)
    expect(sizes[3]).toBeLessThan(sizes[1] * 1.1)
    expect(load(deps).economy.recentOps.length).toBe(30)
  })

  it('存檔失敗後重試：抽到同一位球員，只扣一次款', async () => {
    const storage = new FlakyStorage()
    const { deps } = await setup({ funds: 50_000, experience: 0 }, storage)
    const preview = recruitPlayer(load(deps), { opSeq: 0, role: 'batter' }, T0)
    storage.failWrites = true
    await expect(recruit(deps, { opSeq: 0, role: 'batter' })).rejects.toThrow(ClubSaveError)
    expect(load(deps).players).toHaveLength(14)
    storage.failWrites = false
    const out = await recruit(deps, { opSeq: 0, role: 'batter' })
    expect(out.op.playerId).toBe(preview.op.playerId)
    // 成功後再重送同一個請求：重送，不會再招募或扣款
    const again = await recruit(deps, { opSeq: 0, role: 'batter' })
    expect(again.duplicate).toBe(true)
    const c = load(deps)
    expect(c.players).toHaveLength(15)
    expect(c.economy.spent.funds).toBe(recruitCost(0).funds)
  })

  it('招募後可以放進先發，比賽計畫裡就有他', async () => {
    const { deps, clock } = await setup(rich)
    const out = await recruit(deps, { opSeq: 0, role: 'batter' })
    const c = load(deps)
    const draft = swapWithReserve({ roster: resolveRoster(c), reserves: reserves(c) }, { kind: 'lineup', index: 8 }, 0)
    await updateSettings(deps, { roster: toAssignment(draft.roster) })
    const saved = load(deps)
    expect(saved.roster.lineup[8].playerId).toBe(out.op.playerId)
    expect(reserves(saved).map((p) => p.id)).toEqual([c.roster.lineup[8].playerId])
    // 進行中那一場已經固定；下一場才有他
    clock.advance(10 * MINUTE)
    const report = await settleDue(deps)
    const rep = report.club.replays.at(-1)!.replay
    expect(rep.setup[rep.setup.userSide].roster.lineup[8].player.id).toBe(out.op.playerId)
  })

  it('純函式不改輸入', async () => {
    const { deps } = await setup(rich)
    const c = load(deps)
    const before = JSON.stringify(c)
    recruitPlayer(c, { opSeq: 0, role: 'batter' }, T0)
    upgradePlayer(c, { opSeq: 0, playerId: firstStarter(c), expectedLevel: 1 }, T0)
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe('經濟帳務', () => {
  it('結算、領取、升級、招募、重送交錯進行：不變量一直成立，支出紀錄有上限', async () => {
    const { deps, clock } = await setup()
    for (let round = 0; round < 40; round++) {
      clock.advance(37 * MINUTE)
      await settleDue(deps)
      if (round % 2 === 0) await claim(deps, load(deps).economy.nextClaimSeq)
      const c = load(deps)
      const target = c.players.find((r) => r.level < MAX_LEVEL)!
      const req = { opSeq: c.economy.nextOpSeq, playerId: target.player.id, expectedLevel: target.level }
      try {
        await upgrade(deps, req)
        await upgrade(deps, req) // 重送
      } catch (e) {
        expect((e as EconomyError).code).toBe('insufficient')
      }
      if (round % 5 === 0) await recruit(deps, { opSeq: load(deps).economy.nextOpSeq, role: 'pitcher' }).catch(() => undefined)
      const now = load(deps)
      expect(economyViolations(now.economy)).toEqual([])
      expect(now.economy.assets.funds).toBeGreaterThanOrEqual(0)
      expect(now.economy.assets.experience).toBeGreaterThanOrEqual(0)
    }
    const final = load(deps)
    expect(final.economy.recentOps.length).toBeLessThanOrEqual(30)
    expect(final.economy.nextOpSeq).toBeGreaterThan(0)
  })
})

describe('支出失敗時，到期的比賽照樣保存', () => {
  /** 資產固定為 assets；回傳之後「只有比賽相關欄位會變」的檢查 */
  const spendState = (c: ClubSave) => ({ players: c.players, roster: c.roster, assets: c.economy.assets, spent: c.economy.spent, nextOpSeq: c.economy.nextOpSeq, recruitment: c.recruitment })

  it('1. 離線 8 小時後資金不足而招募失敗：96 場保存、不扣款、名單不變', async () => {
    const { deps, clock } = await setup({ funds: 100, experience: 0 })
    const before = load(deps)
    clock.advance(8 * HOUR)
    const error = await recruit(deps, { opSeq: 0, role: 'batter' }).catch((e) => e)
    expect(error).toBeInstanceOf(EconomyError)
    expect(error.code).toBe('insufficient')
    expect(error.settled.matches).toBe(96)
    const after = load(deps)
    expect(after.idle.nextMatchIndex).toBe(96)
    expect(after.record.wins + after.record.losses).toBe(96)
    expect(after.economy.unclaimed.funds).toBeGreaterThan(0)
    expect(spendState(after)).toEqual(spendState(before))
    expect(error.settled.club).toEqual(after)
    expect(economyViolations(after.economy)).toEqual([])
  })

  it('2. 離線 8 小時後球員已滿級而升級失敗：96 場保存、等級與資產不變', async () => {
    const { deps, clock } = await setup(rich)
    const id = firstStarter(load(deps))
    for (let lv = 1; lv < MAX_LEVEL; lv++) await upgrade(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id, expectedLevel: lv })
    const before = load(deps)
    clock.advance(8 * HOUR)
    const error = await upgrade(deps, { opSeq: before.economy.nextOpSeq, playerId: id, expectedLevel: MAX_LEVEL }).catch((e) => e)
    expect(error.code).toBe('max-level')
    expect(error.settled.matches).toBe(96)
    const after = load(deps)
    expect(after.idle.nextMatchIndex).toBe(96)
    expect(recordOf(after, id)!.level).toBe(MAX_LEVEL)
    expect(spendState(after)).toEqual(spendState(before))
  })

  it('3. 離線後用過期的操作序號：拒絕支出，但比賽保存', async () => {
    const { deps, clock } = await setup(rich)
    const c = load(deps)
    await upgrade(deps, { opSeq: 0, playerId: firstStarter(c), expectedLevel: 1 })
    const before = load(deps)
    clock.advance(2 * HOUR)
    // 序號 0 已經被上一次升級用掉，這次是不同的請求
    const error = await upgrade(deps, { opSeq: 0, playerId: c.roster.lineup[1].playerId, expectedLevel: 1 }).catch((e) => e)
    expect(error.code).toBe('stale-request')
    expect(error.settled.matches).toBe(24)
    expect(load(deps).idle.nextMatchIndex).toBe(24)
    expect(spendState(load(deps))).toEqual(spendState(before))
  })

  it('4. 失敗後重試：不會重複結算或扣款；資源夠了之後重試只扣一次', async () => {
    const { deps, clock } = await setup({ funds: 100, experience: 0 })
    clock.advance(8 * HOUR)
    await recruit(deps, { opSeq: 0, role: 'pitcher' }).catch(() => undefined)
    const afterFirst = load(deps)
    // 同一個時間點重試：沒有新的比賽可以結算，也沒有扣款
    const again = await recruit(deps, { opSeq: 0, role: 'pitcher' }).catch((e) => e)
    expect(again.code).toBe('insufficient')
    expect(again.settled).toBeUndefined()
    expect(load(deps)).toEqual(afterFirst)
    // 領取收益之後重試：成功，只扣一次
    await claim(deps, afterFirst.economy.nextClaimSeq)
    const funds = load(deps).economy.assets.funds
    expect(funds).toBeGreaterThanOrEqual(recruitCost(0).funds)
    await recruit(deps, { opSeq: 0, role: 'pitcher' })
    await recruit(deps, { opSeq: 0, role: 'pitcher' }) // 重送
    const final = load(deps)
    expect(final.idle.nextMatchIndex).toBe(96)
    expect(final.economy.assets.funds).toBe(funds - recruitCost(0).funds)
    expect(final.players).toHaveLength(15)
    expect(economyViolations(final.economy)).toEqual([])
  })

  it('5. 離線上限邊界：剛好 8 小時、超過 8 小時時操作失敗，之後的時間照樣累積，比賽不會被多丟掉', async () => {
    for (const offline of [8 * HOUR, 8 * HOUR + 4 * MINUTE, 10 * HOUR]) {
      const { deps, clock } = await setup({ funds: 0, experience: 0 })
      clock.advance(offline)
      const error = await upgrade(deps, { opSeq: 0, playerId: firstStarter(load(deps)), expectedLevel: 1 }).catch((e) => e)
      expect(error.code).toBe('insufficient')
      expect(load(deps).idle.nextMatchIndex).toBe(96)
      // 失敗的那一刻起算：再過 1 小時就有 12 場。如果失敗時沒有存檔，
      // 錨點會停在原處，1 小時後離線時間超過 8 小時，這 12 場就會被上限吃掉
      clock.advance(HOUR)
      expect((await settleDue(deps)).settled).toHaveLength(12)
      expect(load(deps).idle.nextMatchIndex).toBe(108)
    }
  })

  it('支出被拒絕、而且保存比賽時寫入失敗：回報寫入失敗，什麼都沒變', async () => {
    const storage = new FlakyStorage()
    const { deps, clock } = await setup({ funds: 100, experience: 0 }, storage)
    const before = load(deps)
    clock.advance(8 * HOUR)
    storage.failWrites = true
    const error = await recruit(deps, { opSeq: 0, role: 'batter' }).catch((e) => e)
    expect(error).toBeInstanceOf(ClubSaveError)
    expect(error.code).toBe('write-failed')
    expect(load(deps)).toEqual(before)
  })

  it('支出前的結算失敗：失敗前的場次保存，不支出，回報結算失敗', async () => {
    const { deps, clock } = await setup(rich)
    const before = load(deps)
    deps.batch.simulate = (p) => {
      if (p.matchIndex === 10) throw new Error('模擬壞掉')
      return runMatch(p.setup, p.ai)
    }
    clock.advance(HOUR)
    const error = await upgrade(deps, { opSeq: 0, playerId: firstStarter(before), expectedLevel: 1 }).catch((e) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect(error.code).toBe('simulation-failed')
    const after = load(deps)
    expect(after.idle.nextMatchIndex).toBe(10)
    expect(spendState(after)).toEqual(spendState(before))
  })
})
