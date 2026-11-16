// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { claim, settleDue, settleIdle } from '../application/settlementService'
import { planMatches, runBatch } from '../application/batchRunner'
import { CLUB_SCHEMA_VERSION } from '../domain/club'
import { RETENTION_CONFIG } from '../domain/config'
import { FakeLockManager, FlakyStorage, HOUR, ManualClock, T0, tab } from '../testkit'
import { CLUB_STORAGE_KEY, ClubRepository, ClubSaveError, InProcessLock, MemoryStorage, WebLocksClubLock, createClubLock } from './clubRepository'

const create = (repo: ClubRepository) => repo.createClub({ clubName: '測試球團', clubSeed: 11, clubId: 'club-x', now: T0 })

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ClubSaveError)
    expect((e as ClubSaveError).code).toBe(code)
    return
  }
  throw new Error(`沒有丟出 ${code}`)
}

describe('存檔讀寫', () => {
  it('空存檔讀到 null；建立後可以讀回一模一樣的球團', () => {
    const repo = new ClubRepository(new MemoryStorage())
    expect(repo.loadClub()).toBeNull()
    const club = create(repo)
    expect(club.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(club.revision).toBe(0)
    expect(club.roster.lineup).toHaveLength(9)
    expect(repo.loadClub()).toEqual(club)
    expectCode(() => create(repo), 'already-exists')
  })

  it('正常存檔與恢復：revision 每存一次加 1，用舊的 revision 存會被拒絕', () => {
    const storage = new MemoryStorage()
    const repo = new ClubRepository(storage)
    const club = create(repo)
    const saved = repo.saveClub({ ...club, clubName: '新名字' }, club.revision)
    expect(saved.revision).toBe(1)
    expect(new ClubRepository(storage).loadClub()).toEqual(saved)
    expectCode(() => repo.saveClub({ ...club, clubName: '舊的' }, club.revision), 'conflict')
    expect(repo.loadClub()!.clubName).toBe('新名字')
  })

  it('不合法的 JSON：明確報錯，也不會被新球團蓋掉', () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, '{oops')
    const repo = new ClubRepository(storage)
    expectCode(() => repo.loadClub(), 'invalid-json')
    expectCode(() => create(repo), 'already-exists')
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe('{oops')
    repo.resetClub()
    expect(create(repo).clubName).toBe('測試球團')
  })

  it('不支援的 schemaVersion：舊版、未來版本、沒有版本都明確報錯', () => {
    for (const schemaVersion of [1, 2, 4, undefined, '3']) {
      const storage = new MemoryStorage()
      const club = create(new ClubRepository(new MemoryStorage()))
      storage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ ...club, schemaVersion }))
      expectCode(() => new ClubRepository(storage).loadClub(), 'unsupported-version')
    }
  })

  it('結構錯誤：缺欄位、型別不對、先發不是 9 人', () => {
    const club = create(new ClubRepository(new MemoryStorage()))
    const broken = [
      { ...club, clubId: '' },
      { ...club, economy: { ...club.economy, unclaimed: { funds: -1, experience: 0 } } },
      { ...club, idle: { ...club.idle, nextMatchIndex: 1.5 } },
      { ...club, roster: { ...club.roster, lineup: club.roster.lineup.slice(1) } },
      { ...club, roster: { ...club.roster, starter: club.roster.lineup[0].player } },
      { ...club, recentMatches: [{ matchId: 'x' }] },
      { ...club, strategy: { coach: { style: 'yolo' }, effectiveFromMatch: 0 } },
      // 帳務對不起來：資產 + 未領取 ≠ 總收益、領取序號跟上一次領取不符
      { ...club, economy: { ...club.economy, assets: { funds: 999, experience: 0 } } },
      { ...club, economy: { ...club.economy, nextClaimSeq: 3, lastClaim: null } },
      { ...club, economy: { ...club.economy, recentClaimIds: [] as string[], nextClaimSeq: undefined } },
      [],
      null,
    ]
    for (const value of broken) {
      const storage = new MemoryStorage()
      storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(value))
      expectCode(() => new ClubRepository(storage).loadClub(), 'invalid-schema')
    }
  })

  it('寫入失敗：丟 write-failed，原本的存檔不變', () => {
    const storage = new FlakyStorage()
    const repo = new ClubRepository(storage)
    const club = create(repo)
    storage.failWrites = true
    expectCode(() => repo.saveClub({ ...club, clubName: '寫不進去' }, club.revision), 'write-failed')
    expect(repo.loadClub()).toEqual(club)
  })

  it('瀏覽器儲存被停用：明確報錯', () => {
    const repo = new ClubRepository(null)
    expectCode(() => repo.loadClub(), 'storage-unavailable')
    expectCode(() => create(repo), 'storage-unavailable')
  })

  it('V1 存檔不受影響：建立、存檔、重設都只動自己的 key', async () => {
    const storage = new MemoryStorage()
    const v1 = {
      'dice-baseball.tournament.v2': '{"version":2,"phase":"playing"}',
      'dice-baseball.tournament.v1': '{"old":true}',
      'dice-baseball.progress': '{"trophies":[]}',
      'dice-baseball.teamName': '老虎隊',
    }
    for (const [k, v] of Object.entries(v1)) storage.setItem(k, v)
    const clock = new ManualClock()
    const deps = tab(storage, clock)
    create(deps.store)
    clock.advance(HOUR)
    await settleDue(deps)
    await claim(deps, 0)
    deps.store.resetClub()
    for (const [k, v] of Object.entries(v1)) expect(storage.getItem(k)).toBe(v)
    expect(storage.keys().sort()).toEqual(Object.keys(v1).sort())
  })
})

describe('跨分頁', () => {
  it('有 Web Locks：兩個分頁同時結算，比賽只結算一次、收益只算一次', async () => {
    const storage = new MemoryStorage()
    const locks = new FakeLockManager()
    const clock = new ManualClock()
    const a = tab(storage, clock, locks)
    const b = tab(storage, clock, locks)
    create(a.store)
    clock.advance(2 * HOUR)
    const [ra, rb] = await Promise.all([settleDue(a), settleDue(b)])
    expect(ra.settled.length + rb.settled.length).toBe(24)
    expect([ra.status, rb.status].sort()).toEqual(['nothing-due', 'settled'])
    expect(ra.crossTab && rb.crossTab).toBe(true)
    const club = a.store.loadClub()!
    expect(club.idle.nextMatchIndex).toBe(24)
    expect(club.record.wins + club.record.losses).toBe(24)
    expect(club.economy.lifetime.funds).toBe(club.recentMatches.reduce((s, m) => s + m.earnedFunds, 0))
    // 兩個分頁看到同一個序號、同時領取：只入帳一次
    const seq = club.economy.nextClaimSeq
    const claims = await Promise.all([claim(a, seq), claim(b, seq)])
    expect(claims.filter((c) => !c.duplicate)).toHaveLength(1)
    expect(a.store.loadClub()!.economy.assets.funds).toBe(club.economy.lifetime.funds)
  })

  it('沒有 Web Locks（降級）：兩個分頁交錯結算時，後存的那個會被 revision 檢查擋下，不會重複發獎', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const a = tab(storage, clock)
    const b = tab(storage, clock)
    expect(a.lock.crossTab).toBe(false)
    create(a.store)
    clock.advance(2 * HOUR)
    const results = await Promise.allSettled([settleDue(a), settleDue(b)])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toBeInstanceOf(ClubSaveError)
    expect(failed[0].reason.code).toBe('conflict')
    const club = a.store.loadClub()!
    expect(club.idle.nextMatchIndex).toBe(24)
    expect(club.record.wins + club.record.losses).toBe(24)
    // 衝突的分頁重試：讀到最新存檔，沒有東西可以再結算
    expect((await settleDue(b)).status).toBe('nothing-due')
  })

  it('createClubLock：有 navigator.locks 用 Web Locks，沒有就降級並標明不保證跨分頁', () => {
    expect(createClubLock({ locks: new FakeLockManager() })).toBeInstanceOf(WebLocksClubLock)
    const fallback = createClubLock({})
    expect(fallback).toBeInstanceOf(InProcessLock)
    expect(fallback.crossTab).toBe(false)
    expect(createClubLock(undefined).crossTab).toBe(false)
  })

  it('分頁內的鎖：前一個失敗也不會卡住後面的', async () => {
    const lock = new InProcessLock()
    const order: number[] = []
    const p1 = lock.run(async () => {
      order.push(1)
      throw new Error('x')
    })
    const p2 = lock.run(async () => void order.push(2))
    await expect(p1).rejects.toThrow('x')
    await p2
    expect(order).toEqual([1, 2])
  })
})

describe('存檔大小', () => {
  it('近期比賽、replay 達上限後仍能正確保存，存檔大小不隨場次成長', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const deps = tab(storage, clock)
    create(deps.store)
    const sizes: number[] = []
    for (let day = 0; day < 11; day++) {
      clock.advance(8 * HOUR)
      await settleDue(deps)
      sizes.push(storage.getItem(CLUB_STORAGE_KEY)!.length)
    }
    const club = deps.store.loadClub()!
    expect(club.idle.nextMatchIndex).toBe(11 * 96)
    expect(club.record.wins + club.record.losses).toBe(11 * 96)
    expect(club.recentMatches).toHaveLength(RETENTION_CONFIG.recentMatches)
    expect(club.recentMatches.at(-1)!.matchIndex).toBe(11 * 96 - 1)
    expect(club.replays).toHaveLength(RETENTION_CONFIG.replays)
    // 第 2 次之後近期比賽已滿：之後只會因為內容（精彩事件、replay 長短）上下浮動，不會隨場次成長
    const settledSizes = sizes.slice(1)
    expect(Math.max(...settledSizes)).toBeLessThan(settledSizes[0] * 1.1)
    expect(Math.max(...sizes)).toBeLessThan(150_000)
  }, 60_000)

  it('一次塞進超過上限的場次，也只留最近的', async () => {
    const repo = new ClubRepository(new MemoryStorage())
    const club = create(repo)
    const { outcomes } = await runBatch(planMatches(club, 0, RETENTION_CONFIG.recentMatches + 20))
    const next = settleIdle(club, outcomes, T0 + 12 * HOUR).club
    expect(next.recentMatches).toHaveLength(RETENTION_CONFIG.recentMatches)
    expect(next.recentMatches[0].matchIndex).toBe(20)
    expect(repo.saveClub(next, club.revision).revision).toBe(1)
  })
})
