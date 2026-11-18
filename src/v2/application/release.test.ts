// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { economyViolations, validateClub } from '../domain/club'
import { swapWithReserve } from '../domain/lineup'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCandidates } from '../domain/recruitment'
import { assignedIds, reserves, resolveRoster, toAssignment } from '../domain/roster'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage as Flaky, HOUR, ManualClock, tab } from '../testkit'
import { createClubSafely } from './clubLifecycle'
import { EconomyError, recruit, release, releasePlayer } from './economyService'
import { settleDue, updateSettings } from './settlementService'

type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!
const rich = { funds: 50_000_000, experience: 1_000_000 }

async function setup(storage: MemoryStorage | Flaky = new MemoryStorage(), locks: FakeLockManager | null = new FakeLockManager()) {
  const clock = new ManualClock()
  const deps = tab(storage, clock, locks ?? undefined)
  await createClubSafely(deps, { clubName: '釋出測試', clubSeed: 99, clubId: 'club-release' })
  const c = load(deps)
  deps.store.saveClub({ ...c, economy: { ...c.economy, assets: { ...rich }, earned: { ...rich } } }, c.revision)
  return { deps, clock, storage }
}

/** 把一位預備打者換進先發第一棒 */
function intoLineup(c: ReturnType<Deps['store']['loadClub']> & object, playerId: string) {
  const pool = reserves(c)
  return swapWithReserve({ roster: resolveRoster(c), reserves: pool }, { kind: 'lineup', index: 0 }, pool.findIndex((p) => p.id === playerId)).roster
}

async function recruitOne(deps: Deps, role: 'batter' | 'pitcher' = 'batter') {
  return recruit(deps, { opSeq: load(deps).economy.nextOpSeq, role, candidateIndex: 0, expectedCount: load(deps).recruitment.count })
}

describe('釋出球員', () => {
  it('釋出預備球員：從名單移除、空出名額、不退款；帳務不變量成立', async () => {
    const { deps } = await setup()
    const { op } = await recruitOne(deps)
    const before = load(deps)
    const out = await release(deps, { opSeq: before.economy.nextOpSeq, playerId: op.playerId })
    const c = load(deps)
    expect(out.op).toMatchObject({ kind: 'release', playerId: op.playerId, cost: { funds: 0, experience: 0 } })
    expect(c.players.find((r) => r.player.id === op.playerId)).toBeUndefined()
    expect(c.players).toHaveLength(before.players.length - 1)
    expect(c.economy.assets).toEqual(before.economy.assets)
    expect(c.economy.spent).toEqual(before.economy.spent)
    expect(c.recruitment.count).toBe(before.recruitment.count)
    expect(economyViolations(c.economy)).toEqual([])
    expect(validateClub(structuredClone(c))).toEqual(c)
  })

  it('先發、板凳、先發投手、後援都不能直接釋出', async () => {
    const { deps } = await setup()
    const c = load(deps)
    for (const id of assignedIds(c.roster)) {
      const error = await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: id }).catch((e) => e)
      expect(error).toBeInstanceOf(EconomyError)
      expect(error.code).toBe('not-reserve')
    }
    expect(load(deps).players).toHaveLength(c.players.length)
    const missing = await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: 'nobody' }).catch((e) => e)
    expect(missing.code).toBe('no-player')
  })

  it('重送、連點：只釋出一次', async () => {
    const { deps } = await setup()
    const { op } = await recruitOne(deps)
    const seq = load(deps).economy.nextOpSeq
    const [a, b] = await Promise.all([release(deps, { opSeq: seq, playerId: op.playerId }), release(deps, { opSeq: seq, playerId: op.playerId })])
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(load(deps).economy.nextOpSeq).toBe(seq + 1)
  })

  it('多分頁：另一個分頁剛把這位預備球員排進陣容，釋出會被拒絕', async () => {
    const storage = new MemoryStorage()
    const { deps } = await setup(storage)
    const { op } = await recruitOne(deps)
    const viewSeq = load(deps).economy.nextOpSeq
    // 另一個分頁：把他換進先發第一棒
    const other = tab(storage, new ManualClock(), new FakeLockManager())
    const c = load(other)
    await updateSettings(other, { roster: toAssignment(intoLineup(c, op.playerId)) })
    const error = await release(deps, { opSeq: viewSeq, playerId: op.playerId }).catch((e) => e)
    expect(error).toBeInstanceOf(EconomyError)
    expect(error.code).toBe('not-reserve')
    expect(load(deps).players.some((r) => r.player.id === op.playerId)).toBe(true)
  })

  it('釋出後重新招募：新球員的編號不會跟任何歷史球員相同', async () => {
    const { deps } = await setup()
    const seen = new Set(load(deps).players.map((r) => r.player.id))
    for (let i = 0; i < 6; i++) {
      const { op } = await recruitOne(deps, i % 2 ? 'pitcher' : 'batter')
      expect(seen.has(op.playerId)).toBe(false)
      seen.add(op.playerId)
      await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: op.playerId })
    }
    expect(load(deps).recruitment.count).toBe(6)
    // 就算名單裡已經沒有那些人，第 i 次招募的編號也帶著招募次數，不會撞到之前的人
    const c = load(deps)
    for (let i = 0; i < 6; i++) expect(recruitCandidates({ ...c, recruitment: { count: i } }, 'batter')[0].id.startsWith(`r${i}-`)).toBe(true)
  })

  it('名單滿了：釋出一位預備球員後就能再招募', async () => {
    const { deps } = await setup()
    while (load(deps).players.length < RECRUIT_CONFIG.maxPlayers) await recruitOne(deps)
    const full = await recruitOne(deps).catch((e) => e)
    expect(full.code).toBe('roster-full')
    const reserve = reserves(load(deps))[0]
    await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: reserve.id })
    const again = await recruitOne(deps)
    expect(again.duplicate).toBe(false)
    expect(load(deps).players).toHaveLength(RECRUIT_CONFIG.maxPlayers)
  })

  it('已經完成的比賽紀錄與 replay 不依賴目前名單：釋出上過場的球員後還能讀', async () => {
    const { deps, clock } = await setup()
    const { op } = await recruitOne(deps)
    // 讓他上場打幾場，再換下來、釋出
    let c = load(deps)
    const original = c.roster
    await updateSettings(deps, { roster: toAssignment(intoLineup(c, op.playerId)) })
    clock.advance(HOUR)
    await settleDue(deps)
    await updateSettings(deps, { roster: original })
    await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: op.playerId })
    c = load(deps)
    expect(c.players.some((r) => r.player.id === op.playerId)).toBe(false)
    const replay = c.replays.at(-1)!.replay as unknown as { setup: { home: { roster: { lineup: { player: { id: string } }[] } }; away: { roster: { lineup: { player: { id: string } }[] } } } }
    const ids = [...replay.setup.home.roster.lineup, ...replay.setup.away.roster.lineup].map((s) => s.player.id)
    expect(ids).toContain(op.playerId)
    expect(validateClub(structuredClone(c))).toEqual(c)
  })

  it('別的分頁的舊草稿把已經釋出的球員排進陣容：存不進去，不會留下懸空的引用', async () => {
    const { deps } = await setup()
    const { op } = await recruitOne(deps)
    const staleDraft = toAssignment(intoLineup(load(deps), op.playerId))
    await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: op.playerId })
    const error = await updateSettings(deps, { roster: staleDraft }).catch((e) => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('LineupError')
    const c = load(deps)
    expect(assignedIds(c.roster).has(op.playerId)).toBe(false)
    expect(validateClub(structuredClone(c))).toEqual(c)
  })

  it('存檔寫入失敗：不回報成功，球員還在', async () => {
    const storage = new Flaky()
    const { deps } = await setup(storage)
    const { op } = await recruitOne(deps)
    storage.failWrites = true
    const error = await release(deps, { opSeq: load(deps).economy.nextOpSeq, playerId: op.playerId }).catch((e) => e)
    expect(error).toBeInstanceOf(ClubSaveError)
    storage.failWrites = false
    expect(load(deps).players.some((r) => r.player.id === op.playerId)).toBe(true)
  })

  it('純函式：不改輸入', async () => {
    const { deps } = await setup()
    await recruitOne(deps)
    const c = load(deps)
    const before = JSON.stringify(c)
    releasePlayer(c, { opSeq: c.economy.nextOpSeq, playerId: reserves(c)[0].id }, 0)
    expect(JSON.stringify(c)).toBe(before)
  })
})
