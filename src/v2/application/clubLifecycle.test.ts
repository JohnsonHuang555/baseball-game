// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, tab } from '../testkit'
import { createClubSafely, resetClubSafely } from './clubLifecycle'
import { SettlementError, claim, settleDue } from './settlementService'

const request = { clubName: '測試球團', clubSeed: 5, clubId: 'club-life' }

/** 兩個共用儲存的分頁；shared 為 true 時共用 Web Locks，否則是不支援 Web Locks 的瀏覽器 */
function tabs(shared: boolean) {
  const storage = new MemoryStorage()
  const clock = new ManualClock()
  const locks = shared ? new FakeLockManager() : undefined
  return { storage, clock, a: tab(storage, clock, locks), b: tab(storage, clock, locks) }
}

describe('安全建立球團', () => {
  it('兩個分頁同時建立：只有一個成功，另一個收到 already-exists', async () => {
    for (const shared of [true, false]) {
      const { a, b } = tabs(shared)
      const results = await Promise.allSettled([createClubSafely(a, request), createClubSafely(b, { ...request, clubId: 'other' })])
      const ok = results.filter((r) => r.status === 'fulfilled')
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(ok).toHaveLength(1)
      expect(failed[0].reason).toBeInstanceOf(ClubSaveError)
      expect(failed[0].reason.code).toBe('already-exists')
      expect(a.store.loadClub()!.clubId).toBe('club-life')
    }
  })

  it('回傳值照實標明有沒有跨分頁保證', async () => {
    const withLocks = tabs(true)
    expect((await createClubSafely(withLocks.a, request)).crossTab).toBe(true)
    expect((await resetClubSafely(withLocks.a)).crossTab).toBe(true)
    const without = tabs(false)
    expect((await createClubSafely(without.a, request)).crossTab).toBe(false)
    expect((await resetClubSafely(without.a)).crossTab).toBe(false)
  })

  it('建立時間用注入的時鐘', async () => {
    const { a, clock } = tabs(true)
    clock.advance(HOUR)
    const { value } = await createClubSafely(a, request)
    expect(value.createdAt).toBe(clock.now())
    expect(value.idle.anchorMs).toBe(clock.now())
  })
})

describe('安全重設球團', () => {
  it('有 Web Locks：結算進行到一半時重設，會等結算存完才刪，刪掉的球團不會被寫回來', async () => {
    const { a, b, clock } = tabs(true)
    await createClubSafely(a, request)
    clock.advance(2 * HOUR)
    const settling = settleDue(a)
    const resetting = resetClubSafely(b)
    const report = await settling
    await resetting
    expect(report.settled).toHaveLength(24)
    expect(a.store.loadClub()).toBeNull()
    // 重設之後再結算、領取：明確告知沒有球團
    await expect(settleDue(a)).rejects.toThrow(SettlementError)
    await expect(claim(b, 0)).rejects.toThrow(SettlementError)
  })

  it('有 Web Locks：先重設再結算，結算收到 no-club，不會建立出半個球團', async () => {
    const { a, b, clock } = tabs(true)
    await createClubSafely(a, request)
    clock.advance(HOUR)
    const resetting = resetClubSafely(b)
    const settling = settleDue(a).catch((e) => e)
    await resetting
    const error = await settling
    expect(error).toBeInstanceOf(SettlementError)
    expect(error.code).toBe('no-club')
    expect(a.store.loadClub()).toBeNull()
  })

  it('重設與建立交錯：最後留下的是新建立的球團，不會被舊球團的結算覆蓋', async () => {
    const { a, b, clock } = tabs(true)
    await createClubSafely(a, request)
    clock.advance(HOUR)
    const settling = settleDue(a)
    const resetting = resetClubSafely(b)
    const creating = createClubSafely(b, { ...request, clubId: 'fresh', clubName: '新球團' })
    await Promise.all([settling, resetting, creating])
    const club = a.store.loadClub()!
    expect(club.clubId).toBe('fresh')
    expect(club.idle.nextMatchIndex).toBe(0)
    expect(club.record.wins + club.record.losses).toBe(0)
  })

  it('沒有 Web Locks（降級）：結算中被別的分頁重設，存檔時被 revision 檢查擋下，不會把舊球團寫回去', async () => {
    const { a, b, clock } = tabs(false)
    await createClubSafely(a, request)
    clock.advance(2 * HOUR)
    const settling = settleDue(a).catch((e) => e)
    await resetClubSafely(b)
    const error = await settling
    expect(error).toBeInstanceOf(ClubSaveError)
    expect(error.code).toBe('conflict')
    expect(a.store.loadClub()).toBeNull()
  })
})
