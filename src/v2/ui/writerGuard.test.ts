// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../infrastructure/clubRepository'
import { WRITER_KEY, createWriterGuard } from './writerGuard'

describe('單一可寫分頁', () => {
  it('有跨分頁鎖：每個分頁都可寫', () => {
    const storage = new MemoryStorage()
    const a = createWriterGuard({ crossTab: true, storage, tabId: 'a' })
    const b = createWriterGuard({ crossTab: true, storage, tabId: 'b' })
    expect(a.mode).toBe('shared')
    expect(a.canWrite() && b.canWrite()).toBe(true)
    expect(storage.getItem(WRITER_KEY)).toBeNull()
  })

  it('沒有跨分頁鎖：同一時間只有一個分頁可寫，以最後接手的為準', () => {
    const storage = new MemoryStorage()
    const a = createWriterGuard({ crossTab: false, storage, tabId: 'a' })
    expect(a.canWrite()).toBe(true)
    const b = createWriterGuard({ crossTab: false, storage, tabId: 'b' })
    expect([a.canWrite(), b.canWrite()]).toEqual([false, true])
    a.takeOver()
    expect([a.canWrite(), b.canWrite()]).toEqual([true, false])
  })

  it('兩個分頁幾乎同時接手：不管通知的先後，最後寫入的那個可寫，另一個唯讀', () => {
    const storage = new MemoryStorage()
    const a = createWriterGuard({ crossTab: false, storage, tabId: 'a' })
    const b = createWriterGuard({ crossTab: false, storage, tabId: 'b' })
    a.takeOver()
    b.takeOver()
    expect([a.canWrite(), b.canWrite()].filter(Boolean)).toHaveLength(1)
    expect(b.canWrite()).toBe(true)
  })

  it('其他分頁接手時通知訂閱者', () => {
    const storage = new MemoryStorage()
    const listeners: ((e: { key: string | null; newValue: string | null }) => void)[] = []
    const events = { addEventListener: (_: 'storage', l: (typeof listeners)[number]) => void listeners.push(l), removeEventListener: () => undefined }
    const a = createWriterGuard({ crossTab: false, storage, events, tabId: 'a' })
    let notified = 0
    a.subscribe(() => notified++)
    storage.setItem(WRITER_KEY, 'b')
    listeners.forEach((l) => l({ key: WRITER_KEY, newValue: 'b' }))
    expect(notified).toBe(1)
    expect(a.canWrite()).toBe(false)
    // 其他 key 的事件不通知
    listeners.forEach((l) => l({ key: 'dice-baseball.progress', newValue: '{}' }))
    expect(notified).toBe(1)
  })
})

describe('寫入前確認身分', () => {
  it('不是可寫分頁時，存檔、建立、刪除都丟 read-only，什麼都不寫；讀取照常', async () => {
    const { ClubRepository, ClubSaveError, CLUB_STORAGE_KEY } = await import('../infrastructure/clubRepository')
    const { guardStore } = await import('./writerGuard')
    const storage = new MemoryStorage()
    const repo = new ClubRepository(storage)
    const a = createWriterGuard({ crossTab: false, storage, tabId: 'a' })
    const store = guardStore(repo, a)
    const club = store.createClub({ clubName: '甲', clubSeed: 1, clubId: 'c', now: 0 })
    createWriterGuard({ crossTab: false, storage, tabId: 'b' })
    const raw = storage.getItem(CLUB_STORAGE_KEY)
    for (const op of [() => store.saveClub({ ...club, clubName: '乙' }, club.revision), () => store.resetClub(), () => store.createClub({ clubName: '丙', now: 0 })]) {
      try {
        op()
        throw new Error('應該被擋下')
      } catch (e) {
        expect(e).toBeInstanceOf(ClubSaveError)
        expect((e as InstanceType<typeof ClubSaveError>).code).toBe('read-only')
      }
    }
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
    expect(store.loadClub()).toEqual(club)
  })
})
