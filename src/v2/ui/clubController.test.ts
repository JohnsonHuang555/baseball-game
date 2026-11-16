// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { MatchPlan } from '../application/batchRunner'
import { runMatch } from '../application/matchRunner'
import { substitute } from '../domain/lineup'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, MINUTE, ManualClock, tab } from '../testkit'
import { ClubController } from './clubController'
import { V2T } from './strings'
import { createWriterGuard, type StorageEventSource } from './writerGuard'

/** 一個「分頁」的控制器：共用儲存與時鐘；locks 給了就是支援 Web Locks 的瀏覽器 */
function controllerFor(storage = new MemoryStorage(), clock = new ManualClock(), locks: FakeLockManager | null = new FakeLockManager(), events?: StorageEventSource, tabId = 'tab-a') {
  const deps = tab(storage, clock, locks ?? undefined)
  const guard = createWriterGuard({ crossTab: deps.lock.crossTab, storage, events, tabId })
  return { deps, clock, storage, guard, c: new ClubController(deps, guard, events) }
}

async function readyClub(opts: Parameters<typeof controllerFor> = []) {
  const ctx = controllerFor(...opts)
  await ctx.c.start()
  expect((await ctx.c.createClub('測試貓熊隊')).ok).toBe(true)
  return ctx
}

/** 模擬瀏覽器的 storage 事件：只通知「其他」分頁 */
class StorageBus {
  private readonly tabs: { listeners: Set<(e: { key: string | null; newValue: string | null }) => void> }[] = []
  source(): StorageEventSource & { emitOthers: (key: string, value: string | null) => void } {
    const me = { listeners: new Set<(e: { key: string | null; newValue: string | null }) => void>() }
    this.tabs.push(me)
    return {
      addEventListener: (_t, l) => me.listeners.add(l),
      removeEventListener: (_t, l) => me.listeners.delete(l),
      emitOthers: (key, newValue) => this.tabs.filter((t) => t !== me).forEach((t) => t.listeners.forEach((l) => l({ key, newValue }))),
    }
  }
}

/** 寫入時會通知其他分頁的儲存（瀏覽器的 localStorage 行為） */
class BroadcastStorage extends MemoryStorage {
  constructor(private readonly onWrite: (key: string, value: string | null) => void) {
    super()
  }
  override setItem(key: string, value: string): void {
    super.setItem(key, value)
    this.onWrite(key, value)
  }
}

describe('建立球團', () => {
  it('第一次進入 V2：沒有球團，建立後直接進入首頁', async () => {
    const { c } = controllerFor()
    await c.start()
    expect(c.state.status.kind).toBe('no-club')
    const res = await c.createClub('  台北貓熊隊 ')
    expect(res.ok).toBe(true)
    expect(c.state.status.kind).toBe('ready')
    expect(c.state.club!.clubName).toBe('台北貓熊隊')
    expect(c.state.club!.roster.lineup).toHaveLength(9)
  })

  it('名稱不能空、不能太長', async () => {
    const { c } = controllerFor()
    await c.start()
    expect(await c.createClub('   ')).toEqual({ ok: false, message: V2T.nameRequired })
    expect((await c.createClub('一二三四五六七八九十十一十二')).ok).toBe(false)
    expect(c.state.status.kind).toBe('no-club')
  })

  it('連續點擊只會建立一份', async () => {
    const { c, storage, deps } = controllerFor()
    await c.start()
    const results = await Promise.all([c.createClub('A隊'), c.createClub('B隊'), c.createClub('C隊')])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(deps.store.loadClub()!.clubName).toBe('A隊')
    expect(deps.store.loadClub()!.revision).toBe(0)
    expect(storage.keys().filter((k) => k === CLUB_STORAGE_KEY)).toHaveLength(1)
  })

  it('建立後重新整理可以正確恢復', async () => {
    const { c, storage, clock } = await readyClub()
    const club = c.state.club
    c.dispose()
    const again = controllerFor(storage, clock)
    await again.c.start()
    expect(again.c.state.status.kind).toBe('ready')
    expect(again.c.state.club).toEqual(club)
  })

  it('兩個分頁同時建立：一個建立、另一個讀進同一個球團', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const a = controllerFor(storage, clock, locks)
    const b = controllerFor(storage, clock, locks, undefined, 'tab-b')
    await Promise.all([a.c.start(), b.c.start()])
    const [ra, rb] = await Promise.all([a.c.createClub('甲隊'), b.c.createClub('乙隊')])
    expect(ra.ok && rb.ok).toBe(true)
    expect(rb.message).toBe(V2T.createdElsewhere)
    expect(a.c.state.club!.clubId).toBe(b.c.state.club!.clubId)
  })
})

describe('自動比賽', () => {
  it('時間不到不會新增場次；30 分鐘結算 6 場；重新整理不重複結算', async () => {
    const { c, clock, storage } = await readyClub()
    clock.advance(4 * MINUTE)
    await c.settle('manual')
    expect(c.state.club!.idle.nextMatchIndex).toBe(0)
    clock.advance(26 * MINUTE)
    await c.settle('manual')
    expect(c.state.club!.idle.nextMatchIndex).toBe(6)
    expect(c.state.club!.record.wins + c.state.club!.record.losses).toBe(6)
    // 重新整理：新的控制器進入首頁，不會再結算同樣的場次
    const again = controllerFor(storage, clock)
    await again.c.start()
    expect(again.c.state.club!.idle.nextMatchIndex).toBe(6)
    expect(again.c.state.welcome).toBeNull()
  })

  it('離線 8 小時以上最多結算 96 場，並顯示一次回歸摘要', async () => {
    const { c, clock, storage } = await readyClub()
    c.dispose()
    clock.advance(20 * HOUR)
    const back = controllerFor(storage, clock)
    await back.c.start()
    const club = back.c.state.club!
    expect(club.idle.nextMatchIndex).toBe(96)
    const w = back.c.state.welcome!
    expect(w.matches).toBe(96)
    expect(w.wins + w.losses).toBe(96)
    expect(w.wins).toBe(club.record.wins)
    expect(w.funds).toBe(club.economy.unclaimed.funds)
    expect(w.experience).toBe(club.economy.unclaimed.experience)
    // 摘要關掉後，重繪、再次結算（沒有新比賽）都不會再跳出
    back.c.dismissWelcome()
    await back.c.settle('resume')
    expect(back.c.state.welcome).toBeNull()
  })

  it('沒有新比賽時不顯示回歸摘要；在畫面上等到的比賽只給提示', async () => {
    const { c, clock } = await readyClub()
    await c.settle('resume')
    expect(c.state.welcome).toBeNull()
    clock.advance(5 * MINUTE)
    await c.settle('tick')
    expect(c.state.welcome).toBeNull()
    expect(c.state.notice).toBe(V2T.matchesFinished(1))
  })

  it('同一時間只跑一個結算：重複呼叫拿到同一個流程，畫面重繪不會多結算', async () => {
    const { c, clock, deps } = await readyClub()
    clock.advance(HOUR)
    const p1 = c.settle('enter')
    const p2 = c.settle('resume')
    const p3 = c.settle('tick')
    expect(p2).toBe(p1)
    expect(p3).toBe(p1)
    expect(c.state.settling).toBe(true)
    await p1
    expect(c.state.settling).toBe(false)
    expect(deps.store.loadClub()!.idle.nextMatchIndex).toBe(12)
    expect(deps.store.loadClub()!.revision).toBe(1)
  })

  it('結算失敗：顯示可重試的錯誤，已完成的場次保留；重試後恢復', async () => {
    const storage = new FlakyStorage()
    const { c, clock } = await readyClub([storage as unknown as MemoryStorage])
    clock.advance(HOUR)
    storage.failWrites = true
    await c.settle('manual')
    expect(c.state.error).toEqual({ message: V2T.writeFailed, retry: 'settle' })
    expect(c.state.club!.idle.nextMatchIndex).toBe(0)
    storage.failWrites = false
    await c.settle('manual')
    expect(c.state.error).toBeNull()
    expect(c.state.club!.idle.nextMatchIndex).toBe(12)
  })

  it('模擬失敗：失敗前的場次保存並顯示，可以重試', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const deps = tab(storage, clock, new FakeLockManager())
    let broken = true
    deps.batch.simulate = (p: MatchPlan) => {
      if (broken && p.matchIndex === 3) throw new Error('壞掉')
      return runMatch(p.setup, p.ai)
    }
    const c = new ClubController(deps, createWriterGuard({ crossTab: true, storage, tabId: 'x' }))
    await c.start()
    await c.createClub('測試隊')
    clock.advance(HOUR)
    await c.settle('manual')
    expect(c.state.error?.retry).toBe('settle')
    expect(c.state.club!.idle.nextMatchIndex).toBe(3)
    broken = false
    await c.settle('manual')
    expect(c.state.club!.idle.nextMatchIndex).toBe(12)
  })

  it('離開畫面時中斷結算：已打完的場次照樣保存，之後不再更新畫面', async () => {
    const { c, clock, storage } = await readyClub()
    clock.advance(8 * HOUR)
    let updates = 0
    c.subscribe(() => updates++)
    const p = c.settle('enter')
    c.dispose()
    await p
    expect(updates).toBe(1) // 只有開始結算時那一次
    const after = controllerFor(storage, clock)
    after.c.reload()
    const settled = after.c.state.club!.idle.nextMatchIndex
    expect(settled).toBeLessThan(96)
    // 下次進入把剩下的打完
    await after.c.start()
    expect(after.c.state.club!.idle.nextMatchIndex).toBe(96)
  })
})

describe('領取收益', () => {
  it('正常領取：資產立即更新；重新整理後不會重複增加', async () => {
    const { c, clock, storage } = await readyClub()
    clock.advance(HOUR)
    await c.settle('manual')
    const unclaimed = c.state.club!.economy.unclaimed
    const res = await c.claim()
    expect(res.ok).toBe(true)
    expect(c.state.club!.economy.assets).toEqual(unclaimed)
    expect(c.state.club!.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    const again = controllerFor(storage, clock)
    await again.c.start()
    expect((await again.c.claim()).ok).toBe(false)
    expect(again.c.state.club!.economy.assets).toEqual(unclaimed)
  })

  it('重複點擊不會重複發獎', async () => {
    const { c, clock } = await readyClub()
    clock.advance(HOUR)
    await c.settle('manual')
    const unclaimed = c.state.club!.economy.unclaimed
    const results = await Promise.all([c.claim(), c.claim(), c.claim()])
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect(c.state.club!.economy.assets).toEqual(unclaimed)
    expect(c.state.club!.economy.nextClaimSeq).toBe(1)
    expect((await c.claim()).message).toBe(V2T.nothingToClaim)
  })

  it('另一個分頁已經領取：不重複發獎，畫面更新為最新資產', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    const locks = new FakeLockManager()
    const a = await readyClub([storage, clock, locks])
    clock.advance(HOUR)
    await a.c.settle('manual')
    const b = controllerFor(storage, clock, locks, undefined, 'tab-b')
    await b.c.start()
    const unclaimed = b.c.state.club!.economy.unclaimed
    expect((await b.c.claim()).ok).toBe(true)
    // A 的畫面還是舊的（顯示有收益），按下領取
    expect(a.c.state.club!.economy.unclaimed).toEqual(unclaimed)
    const res = await a.c.claim()
    expect(res).toEqual({ ok: false, message: V2T.claimedElsewhere })
    expect(a.c.state.club!.economy.assets).toEqual(unclaimed)
    expect(a.c.state.club!.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
  })

  it('寫入失敗不顯示成功，收益仍在', async () => {
    const storage = new FlakyStorage()
    const { c, clock } = await readyClub([storage as unknown as MemoryStorage])
    clock.advance(HOUR)
    await c.settle('manual')
    const before = c.state.club!.economy
    storage.failWrites = true
    const res = await c.claim()
    expect(res).toEqual({ ok: false, message: V2T.writeFailed })
    expect(c.state.error?.retry).toBe('claim')
    expect(c.state.club!.economy).toEqual(before)
    storage.failWrites = false
    expect((await c.claim()).ok).toBe(true)
  })
})

describe('陣容與戰術', () => {
  it('修改前到期的比賽用舊陣容，新陣容從下一場生效', async () => {
    const { c, clock } = await readyClub()
    const oldStarter = c.state.club!.roster.lineup[0].player.id
    clock.advance(17 * MINUTE)
    const roster = substitute(c.state.club!.roster, 0, 0)
    const res = await c.saveRoster(roster)
    expect(res.ok).toBe(true)
    expect(res.message).toBe(V2T.settingsSaved(4))
    const club = c.state.club!
    expect(club.idle.nextMatchIndex).toBe(3)
    expect(club.strategy.effectiveFromMatch).toBe(3)
    const ourLineup = (r: (typeof club.replays)[number]) => r.replay.setup[r.replay.setup.userSide].roster.lineup.map((s) => s.player.id)
    for (const r of club.replays) expect(ourLineup(r)).toContain(oldStarter)
    clock.advance(5 * MINUTE)
    await c.settle('manual')
    expect(ourLineup(c.state.club!.replays.at(-1)!)).not.toContain(oldStarter)
  })

  it('不合法的陣容不能儲存', async () => {
    const { c } = await readyClub()
    const r = c.state.club!.roster
    const bad = { ...r, lineup: r.lineup.map((s, i) => (i === 1 ? { ...s, position: r.lineup[0].position } : s)) }
    const res = await c.saveRoster(bad)
    expect(res.ok).toBe(false)
    expect(c.state.club!.roster).toEqual(r)
    const other = generateRoster(new Rng(1))
    expect((await c.saveRoster({ ...r, bench: [other.lineup[0].player, r.lineup[0].player] })).ok).toBe(false)
  })

  it('戰術設定儲存成合法的參數；不合法的設定被擋下', async () => {
    const { c } = await readyClub()
    const res = await c.saveTactics({ baserunning: 'aggressive', latePlatoon: false, sacBunt: false })
    expect(res.ok).toBe(true)
    expect(c.state.club!.strategy.coach.params).toEqual({ stealMin: 0.65, latePlatoon: false, sacBunt: false })
    const bad = await c.saveTactics({ baserunning: 'reckless' as never, latePlatoon: true, sacBunt: true })
    expect(bad.ok).toBe(false)
    expect(c.state.club!.strategy.coach.params!.stealMin).toBe(0.65)
  })
})

describe('多分頁與存檔錯誤', () => {
  it('不支援 Web Locks：最後開啟的分頁可寫，舊分頁變唯讀、寫入一律拒絕；按「在此分頁繼續」接手', async () => {
    const bus = new StorageBus()
    const ea = bus.source()
    const eb = bus.source()
    const storage = new BroadcastStorage((key, value) => {
      ea.emitOthers(key, value)
      eb.emitOthers(key, value)
    })
    const clock = new ManualClock()
    const a = await readyClub([storage, clock, null, ea, 'tab-a'])
    expect(a.c.state.crossTab).toBe(false)
    expect(a.c.state.canWrite).toBe(true)
    const b = controllerFor(storage, clock, null, eb, 'tab-b')
    await b.c.start()
    expect(b.c.state.canWrite).toBe(true)
    expect(a.c.state.canWrite).toBe(false)
    clock.advance(HOUR)
    // 唯讀分頁：結算、領取、改設定都不會寫入
    await a.c.settle('manual')
    expect(b.deps.store.loadClub()!.idle.nextMatchIndex).toBe(0)
    expect((await a.c.claim()).message).toBe(V2T.readOnly)
    expect((await a.c.saveTactics({ baserunning: 'conservative', latePlatoon: true, sacBunt: true })).message).toBe(V2T.readOnly)
    // 可寫分頁結算，唯讀分頁從 storage 事件重新讀取
    await b.c.settle('manual')
    expect(a.c.state.club!.idle.nextMatchIndex).toBe(12)
    // A 接手：B 變唯讀
    a.c.takeOver()
    expect(a.c.state.canWrite).toBe(true)
    expect(b.c.state.canWrite).toBe(false)
  })

  it('有 Web Locks：每個分頁都可寫', async () => {
    const storage = new MemoryStorage()
    const locks = new FakeLockManager()
    const a = await readyClub([storage, new ManualClock(), locks])
    const b = controllerFor(storage, new ManualClock(), locks, undefined, 'tab-b')
    await b.c.start()
    expect(a.c.state.crossTab && a.c.state.canWrite && b.c.state.canWrite).toBe(true)
  })

  it('存檔損壞或版本不相容：顯示錯誤，不會清除存檔', async () => {
    for (const raw of ['{broken', JSON.stringify({ schemaVersion: 9 })]) {
      const storage = new MemoryStorage()
      storage.setItem(CLUB_STORAGE_KEY, raw)
      const { c } = controllerFor(storage)
      await c.start()
      expect(c.state.status.kind).toBe('broken')
      expect((await c.createClub('新隊')).ok).toBe(false)
      expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
    }
  })

  it('玩家明確確認後，可以用上鎖的入口刪除損壞的存檔重新開始，V1 存檔不受影響', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, '{broken')
    storage.setItem('dice-baseball.tournament.v2', '{"version":2}')
    const { c } = controllerFor(storage)
    await c.start()
    expect((await c.resetClub()).ok).toBe(true)
    expect(c.state.status.kind).toBe('no-club')
    expect(storage.getItem('dice-baseball.tournament.v2')).toBe('{"version":2}')
  })

  it('瀏覽器儲存不能用：顯示可理解的錯誤', async () => {
    const { c } = controllerFor(null as never)
    await c.start()
    expect(c.state.status).toEqual({ kind: 'broken', reason: 'storage-unavailable', message: V2T.storageUnavailable })
  })

  it('revision 衝突：重新讀取並提示，不會靜默覆蓋', async () => {
    const storage = new MemoryStorage()
    const clock = new ManualClock()
    // 沒有 Web Locks 的兩個分頁，而且都以為自己可寫（模擬接手的瞬間）
    const a = await readyClub([storage, clock, null, undefined, 'tab-a'])
    const b = controllerFor(storage, clock, null, undefined, 'tab-b')
    await b.c.start()
    storage.setItem('dice-baseball.club.v3.writer', 'tab-a')
    clock.advance(HOUR)
    const deps = b.deps
    // B 偷偷寫入（等於別的分頁在 A 讀取之後存檔）
    const club = deps.store.loadClub()!
    deps.store.saveClub({ ...club, clubName: '被改名' }, club.revision)
    expect(a.c.state.club!.clubName).toBe('測試貓熊隊')
    const res = await a.c.saveTactics({ baserunning: 'aggressive', latePlatoon: true, sacBunt: true })
    expect(res.ok).toBe(true)
    // updateSettings 在鎖內重新讀取，所以拿到的是最新版（名稱沒被蓋回去）
    expect(a.c.state.club!.clubName).toBe('被改名')
  })
})
