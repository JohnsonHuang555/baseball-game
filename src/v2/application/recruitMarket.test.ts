// @vitest-environment node
// 招募市場的簽約：確認才扣款、只傳角色與候選位置（服務層重建球員）、過期名單拒絕、重送冪等、多分頁、存檔失敗、舊存檔
import { describe, expect, it } from 'vitest'
import { economyViolations, validateClub, type ClubSave } from '../domain/club'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCandidates, recruitCost } from '../domain/recruitment'
import { recordOf, reserves } from '../domain/roster'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, MINUTE, ManualClock, T0, tab } from '../testkit'
import { createClubSafely } from './clubLifecycle'
import { EconomyError, recruit, recruitPlayer } from './economyService'
import { planFor } from './liveMatch'

async function setup(funds = 50_000, storage: MemoryStorage | FlakyStorage = new MemoryStorage(), locks: FakeLockManager | null = new FakeLockManager(), clock = new ManualClock()) {
  const deps = tab(storage, clock, locks ?? undefined)
  await createClubSafely(deps, { clubName: '市場', clubSeed: 2024, clubId: 'club-market' })
  const c = deps.store.loadClub()!
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { funds, experience: 0 }, earned: { funds, experience: 0 } } }, c.revision)
  return { deps, clock, storage }
}
const load = (d: ReturnType<typeof tab>) => d.store.loadClub()!
const req = (c: ClubSave, role: 'batter' | 'pitcher', candidateIndex: number) => ({ opSeq: c.economy.nextOpSeq, role, candidateIndex, expectedCount: c.recruitment.count })

describe('簽約', () => {
  it('瀏覽候選人不寫存檔；確認簽約才扣款、加入預備名單、招募次數 +1', async () => {
    const { deps, storage } = await setup()
    const raw = storage.getItem('dice-baseball.club.v3')
    const before = load(deps)
    recruitCandidates(before, 'batter')
    recruitCandidates(before, 'pitcher')
    expect(storage.getItem('dice-baseball.club.v3')).toBe(raw)
    const pick = recruitCandidates(before, 'pitcher')[2]
    const out = await recruit(deps, req(before, 'pitcher', 2))
    const c = load(deps)
    expect(out.op).toMatchObject({ kind: 'recruit', playerId: pick.id, cost: { funds: 2000, experience: 0 }, recruitIndex: 0, candidateIndex: 2 })
    expect(recordOf(c, pick.id)).toMatchObject({ level: 1, origin: 'recruit', player: pick })
    expect(c.players).toHaveLength(before.players.length + 1)
    expect(reserves(c).map((p) => p.id)).toEqual([pick.id])
    expect(c.roster).toEqual(before.roster)
    expect(c.recruitment.count).toBe(1)
    expect(c.economy.assets.funds).toBe(50_000 - 2000)
    expect(c.economy.spent.funds).toBe(2000)
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('選不同的候選人得到對應的球員；下一次的價格是 2,200、2,400', async () => {
    const { deps } = await setup()
    const got: string[] = []
    for (const index of [0, 1, 2]) {
      const c = load(deps)
      const expected = recruitCandidates(c, 'batter')[index]
      const out = await recruit(deps, req(c, 'batter', index))
      expect(out.op.playerId).toBe(expected.id)
      expect(out.op.cost.funds).toBe([2000, 2200, 2400][index])
      got.push(out.op.playerId)
    }
    expect(new Set(got).size).toBe(3)
    expect(load(deps).economy.spent.funds).toBe(2000 + 2200 + 2400)
  })

  it('不相信畫面傳來的球員資料：請求裡沒有球員，候選位置超出範圍就拒絕', async () => {
    const { deps } = await setup()
    const c = load(deps)
    for (const candidateIndex of [3, -1, 0.5, Number.NaN]) {
      const e = await recruit(deps, { ...req(c, 'batter', 0), candidateIndex }).catch((x) => x)
      expect(e).toBeInstanceOf(EconomyError)
      expect(e.code).toBe('bad-request')
    }
    const e = await recruit(deps, { ...req(c, 'batter', 0), role: 'coach' as never }).catch((x) => x)
    expect(e.code).toBe('bad-request')
    expect(load(deps).economy.spent.funds).toBe(0)
  })

  it('重送同一個請求（連點、重試）：不再扣款、不再加人、招募次數只加一次', async () => {
    const { deps } = await setup()
    const c = load(deps)
    const r = req(c, 'batter', 1)
    const first = await recruit(deps, r)
    const again = await recruit(deps, r)
    const third = await recruit(deps, r)
    expect(again.duplicate).toBe(true)
    expect(third.duplicate).toBe(true)
    expect(again.op).toEqual(first.op)
    const after = load(deps)
    expect(after.players).toHaveLength(c.players.length + 1)
    expect(after.recruitment.count).toBe(1)
    expect(after.economy.spent.funds).toBe(2000)
  })

  it('不同候選人的請求不會被當成重送：同一個序號換一位會被拒絕（序號已經用掉）', async () => {
    const { deps } = await setup()
    const c = load(deps)
    await recruit(deps, req(c, 'batter', 0))
    const e = await recruit(deps, req(c, 'batter', 1)).catch((x) => x)
    expect(e).toBeInstanceOf(EconomyError)
    expect(e.code).toBe('stale-request')
    const e2 = await recruit(deps, req(c, 'pitcher', 0)).catch((x) => x)
    expect(e2.code).toBe('stale-request')
    expect(load(deps).recruitment.count).toBe(1)
    expect(load(deps).economy.spent.funds).toBe(2000)
  })

  it('A 分頁簽約後，B 分頁用舊候選名單（最新序號、舊的招募次數）簽約：拒絕並要求重新選擇', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const { deps: a } = await setup(50_000, storage, locks, clock)
    const b = tab(storage, clock, locks)
    const shownToB = load(b)
    await recruit(a, req(load(a), 'batter', 0))
    // B 的畫面還是舊名單：序號從最新存檔取（跟 ClubController 一樣），招募次數是畫面上的
    const e = await recruit(b, { opSeq: load(b).economy.nextOpSeq, role: 'batter', candidateIndex: 2, expectedCount: shownToB.recruitment.count }).catch((x) => x)
    expect(e).toBeInstanceOf(EconomyError)
    expect(e.code).toBe('stale-candidates')
    const c = load(a)
    expect(c.recruitment.count).toBe(1)
    expect(c.players).toHaveLength(15)
    expect(c.economy.spent.funds).toBe(2000)
  })

  it('兩個分頁同時簽不同的候選人：只有一個成功，只扣一次款', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const { deps: a } = await setup(50_000, storage, locks, clock)
    const b = tab(storage, clock, locks)
    clock.advance(30 * MINUTE) // 有到期的比賽，結算時兩個分頁會交錯
    const shown = load(a)
    const results = await Promise.allSettled([recruit(a, req(shown, 'batter', 0)), recruit(b, req(shown, 'batter', 2))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(failed.reason).toBeInstanceOf(EconomyError)
    const c = load(a)
    expect(c.recruitment.count).toBe(1)
    expect(c.players).toHaveLength(15)
    expect(c.economy.spent.funds).toBe(2000)
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('沒有 Web Locks（降級）時兩個分頁同時簽約：revision 檢查讓其中一個失敗，不會重複扣款', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const { deps: a } = await setup(50_000, storage, null, clock)
    const b = tab(storage, clock)
    clock.advance(30 * MINUTE)
    const shown = load(a)
    const results = await Promise.allSettled([recruit(a, req(shown, 'batter', 0)), recruit(b, req(shown, 'batter', 1))])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const c = load(a)
    expect(c.recruitment.count).toBe(1)
    expect(c.economy.spent.funds).toBe(2000)
  })

  it('資金不足：拒絕、不扣款、不加人', async () => {
    const { deps } = await setup(1999)
    const c = load(deps)
    const e = await recruit(deps, req(c, 'batter', 0)).catch((x) => x)
    expect(e.code).toBe('insufficient')
    expect(load(deps).players).toHaveLength(14)
    expect(load(deps).recruitment.count).toBe(0)
    expect(load(deps).economy.spent.funds).toBe(0)
  })

  it('名單已滿：拒絕', async () => {
    const { deps } = await setup(10_000_000)
    while (load(deps).players.length < RECRUIT_CONFIG.maxPlayers) await recruit(deps, req(load(deps), 'pitcher', 0))
    const before = load(deps)
    const e = await recruit(deps, req(before, 'batter', 1)).catch((x) => x)
    expect(e.code).toBe('roster-full')
    expect(load(deps).recruitment.count).toBe(before.recruitment.count)
    expect(load(deps).economy.spent).toEqual(before.economy.spent)
  })

  it('存檔失敗：沒有部分簽約（不扣款、不加人、招募次數不變）；重試簽到同一位', async () => {
    const storage = new FlakyStorage()
    const { deps } = await setup(50_000, storage)
    const before = load(deps)
    const r = req(before, 'pitcher', 1)
    storage.failWrites = true
    await expect(recruit(deps, r)).rejects.toThrow(ClubSaveError)
    expect(load(deps)).toEqual(before)
    storage.failWrites = false
    const out = await recruit(deps, r)
    expect(out.op.playerId).toBe(recruitCandidates(before, 'pitcher')[1].id)
    expect(load(deps).economy.spent.funds).toBe(2000)
  })

  it('進行中的比賽先固定：簽約不改變已經開始那一場的計畫；到期的比賽先用舊名單結算', async () => {
    const { deps, clock } = await setup()
    clock.advance(17 * MINUTE) // 3 場到期，第 4 場進行中
    const before = load(deps)
    const livePlan = planFor(before, 3)
    await recruit(deps, req(before, 'batter', 0))
    const c = load(deps)
    expect(c.idle.nextMatchIndex).toBe(3)
    expect(c.liveMatch?.matchIndex).toBe(3)
    expect(c.liveMatch?.plan).toEqual(livePlan)
  })

  it('純函式：不改輸入的球團', async () => {
    const { deps } = await setup()
    const c = load(deps)
    const before = JSON.stringify(c)
    recruitPlayer(c, req(c, 'batter', 2), T0)
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe('既有存檔相容', () => {
  /** 模擬舊版：已經用舊制招募過 3 次（4,000、4,800、5,600），支出紀錄是舊的 requestKey、沒有 candidateIndex */
  async function oldClub() {
    const { deps } = await setup(100_000)
    let c = load(deps)
    for (let i = 0; i < 3; i++) {
      const p = recruitCandidates({ ...c, recruitment: { count: i } }, 'batter')[0]
      const cost = 4000 + 800 * i
      c = structuredClone(c)
      c.players.push({ player: p, level: 1, origin: 'recruit', joinedAtMatch: 0 })
      c.economy.assets.funds -= cost
      c.economy.spent.funds += cost
      c.economy.recentOps.push({ seq: c.economy.nextOpSeq, kind: 'recruit', playerId: p.id, cost: { funds: cost, experience: 0 }, at: T0, requestKey: 'recruit:batter', recruitIndex: i })
      c.economy.nextOpSeq++
      c.recruitment.count++
    }
    c = deps.store.saveClub(c, load(deps).revision)
    return { deps, old: c }
  }

  it('舊存檔可以載入；招募次數接著算、價格用新公式、舊的招募球員與支出紀錄不變', async () => {
    const { deps, old } = await oldClub()
    expect(() => validateClub(JSON.parse(JSON.stringify(old)))).not.toThrow()
    const oldPlayers = structuredClone(old.players)
    const oldOps = structuredClone(old.economy.recentOps)
    const out = await recruit(deps, req(old, 'pitcher', 1))
    const c = load(deps)
    expect(out.op.recruitIndex).toBe(3)
    expect(out.op.cost.funds).toBe(recruitCost(3).funds)
    expect(out.op.cost.funds).toBe(2000 + 3 * 200)
    expect(c.recruitment.count).toBe(4)
    expect(c.players.slice(0, oldPlayers.length)).toEqual(oldPlayers)
    expect(c.economy.recentOps.slice(0, oldOps.length)).toEqual(oldOps)
    // 沒有退款、沒有補扣：支出 = 舊的三次 + 這一次
    expect(c.economy.spent.funds).toBe(4000 + 4800 + 5600 + 2600)
    expect(economyViolations(c.economy)).toEqual([])
  })

  it('舊版的重送（舊格式的 requestKey）不會被當成新的簽約', async () => {
    const { deps, old } = await oldClub()
    const e = await recruit(deps, { opSeq: old.economy.nextOpSeq - 1, role: 'batter', candidateIndex: 0, expectedCount: 2 }).catch((x) => x)
    expect(e).toBeInstanceOf(EconomyError)
    expect(e.code).toBe('stale-request')
    expect(load(deps).recruitment.count).toBe(3)
  })

  it('candidateIndex 欄位：0～2 才合法（存檔驗證）', async () => {
    const { deps } = await setup()
    await recruit(deps, req(load(deps), 'batter', 2))
    const raw = JSON.parse(JSON.stringify(load(deps)))
    expect(() => validateClub(raw)).not.toThrow()
    raw.economy.recentOps.at(-1).candidateIndex = 5
    expect(() => validateClub(raw)).toThrow()
  })
})

describe('Phase 9：簽約金改成每次 +200', () => {
  it('已經招募過幾次的球團：次數不重設、已付的簽約金不退，下一次用新公式；畫面的價格跟實際扣款一致', async () => {
    const { deps } = await setup(100_000)
    let c = load(deps)
    // 用舊價格（+400）付過 2 次：2,000、2,400
    c = structuredClone(c)
    for (let i = 0; i < 2; i++) {
      const p = recruitCandidates({ ...c, recruitment: { count: i } }, 'batter')[0]
      const cost = 2000 + 400 * i
      c.players.push({ player: p, level: 1, origin: 'recruit', joinedAtMatch: 0 })
      c.economy.assets.funds -= cost
      c.economy.spent.funds += cost
      c.economy.recentOps.push({ seq: c.economy.nextOpSeq, kind: 'recruit', playerId: p.id, cost: { funds: cost, experience: 0 }, at: T0, requestKey: `recruit:batter:${i}:0`, recruitIndex: i, candidateIndex: 0 })
      c.economy.nextOpSeq++
      c.recruitment.count++
    }
    c = deps.store.saveClub(c, load(deps).revision)
    const spentBefore = c.economy.spent.funds
    const opsBefore = structuredClone(c.economy.recentOps)
    expect(recruitCost(c.recruitment.count).funds).toBe(2000 + 2 * 200)
    const out = await recruit(deps, { opSeq: c.economy.nextOpSeq, role: 'pitcher', candidateIndex: 1, expectedCount: 2 })
    const after = load(deps)
    expect(out.op.cost.funds).toBe(2400)
    expect(after.recruitment.count).toBe(3)
    expect(after.economy.spent.funds).toBe(spentBefore + 2400)
    // 舊紀錄原樣（不退款、不改寫）
    expect(after.economy.recentOps.slice(0, opsBefore.length)).toEqual(opsBefore)
    expect(economyViolations(after.economy)).toEqual([])
  })
})
