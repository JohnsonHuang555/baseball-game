// @vitest-environment node
// Phase 4 的控制器與完整遊玩流程：建立 → 結算 → 領取 → 升級 → 看能力 → 招募 → 上場 → 再比賽 → 確認進入模擬 → 重新整理
import { describe, expect, it } from 'vitest'
import fixture from '../domain/__fixtures__/club-v3-phase3.json'
import { CLUB_SCHEMA_VERSION } from '../domain/club'
import { swapWithReserve } from '../domain/lineup'
import { leveled } from '../domain/progression'
import { recruitCost } from '../domain/recruitment'
import { recordOf, reserves, resolveRoster } from '../domain/roster'
import { CLUB_BACKUP_KEY_V3, CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, MINUTE, ManualClock, tab } from '../testkit'
import { ClubController } from './clubController'
import { V2T } from './strings'
import { WRITER_KEY, createWriterGuard } from './writerGuard'

function controllerFor(storage = new MemoryStorage(), clock = new ManualClock(), locks: FakeLockManager | null = new FakeLockManager(), tabId = 'tab-a') {
  const deps = tab(storage, clock, locks ?? undefined)
  const guard = createWriterGuard({ crossTab: deps.lock.crossTab, storage, tabId })
  return { deps, storage, clock, c: new ClubController(deps, guard) }
}

describe('完整遊玩流程', () => {
  it('建立 → 結算 30 分鐘 → 領取 → 升級 → 招募 → 上場 → 再比賽：升級與新球員都進入模擬，重新整理後一致', async () => {
    const { c, storage, clock } = controllerFor()
    // 1. 建立球團
    await c.start()
    expect((await c.createClub('流程測試隊')).ok).toBe(true)
    // 2. 離線結算 30 分鐘
    clock.advance(30 * MINUTE)
    await c.settle('resume')
    expect(c.state.club!.idle.nextMatchIndex).toBe(6)
    // 3. 領取資源
    expect((await c.claim()).ok).toBe(true)
    const assets = c.state.club!.economy.assets
    expect(assets.funds).toBeGreaterThan(0)
    // 4. 升級一名球員（第一棒）
    const club = c.state.club!
    const id = club.roster.lineup[0].playerId
    const base = recordOf(club, id)!.player
    const up = await c.upgrade(id, 1)
    expect(up.ok).toBe(true)
    expect(up.message).toBe(V2T.upgraded(base.name, 2))
    // 5. 能力變化：陣容換算出來的能力就是 Lv.2
    expect(resolveRoster(c.state.club!).lineup[0].player.ratings).toEqual(leveled(base, 2).ratings)
    expect(leveled(base, 2).ratings).not.toEqual(base.ratings)
    // 6. 招募新球員：第一次招募要 4,000 資金（約 45 場的收入）。球團種子是隨機的，收入會有差異，
    //    所以一小時一小時地打，直到資金夠為止（最多 12 小時）
    for (let h = 0; h < 12 && c.state.club!.economy.assets.funds < recruitCost(0).funds; h++) {
      clock.advance(60 * MINUTE)
      await c.settle('manual')
      await c.claim()
    }
    expect(c.state.club!.economy.assets.funds).toBeGreaterThanOrEqual(recruitCost(0).funds)
    const rec = await c.recruit('batter')
    expect(rec.ok).toBe(true)
    const newId = rec.outcome!.op.playerId
    expect(reserves(c.state.club!).map((p) => p.id)).toContain(newId)
    // 7. 加入陣容（第 9 棒）
    const now = c.state.club!
    const draft = swapWithReserve({ roster: resolveRoster(now), reserves: reserves(now) }, { kind: 'lineup', index: 8 }, reserves(now).findIndex((p) => p.id === newId))
    expect((await c.saveRoster(draft.roster, c.settingsVersions()!.roster)).ok).toBe(true)
    // 8. 再進行自動比賽
    clock.advance(5 * MINUTE)
    await c.settle('tick')
    // 9. 新球員與升級後的能力都在剛打完的比賽裡
    const rep = c.state.club!.replays.at(-1)!.replay
    const ours = rep.setup[rep.setup.userSide].roster
    expect(ours.lineup[8].player.id).toBe(newId)
    expect(ours.lineup[0].player.ratings).toEqual(leveled(base, 2).ratings)
    // 10. 重新整理：等級、名單、資產、戰績都一樣
    const before = c.state.club
    c.dispose()
    const again = controllerFor(storage, clock)
    await again.c.start()
    expect(again.c.state.club).toEqual(before)
  })
})

describe('控制器：升級與招募', () => {
  async function ready(funds = 1_000_000) {
    const ctx = controllerFor()
    await ctx.c.start()
    await ctx.c.createClub('測試隊')
    const club = ctx.deps.store.loadClub()!
    ctx.deps.store.saveClub({ ...club, economy: { ...club.economy, assets: { funds, experience: funds }, earned: { funds, experience: funds } } }, club.revision)
    ctx.c.reload()
    return ctx
  }

  it('連點升級只會升一級；連點招募只會招募一位', async () => {
    const { c } = await ready()
    const id = c.state.club!.roster.lineup[0].playerId
    const results = await Promise.all([c.upgrade(id, 1), c.upgrade(id, 1), c.upgrade(id, 1)])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(recordOf(c.state.club!, id)!.level).toBe(2)
    await Promise.all([c.recruit('pitcher'), c.recruit('pitcher')])
    expect(c.state.club!.players).toHaveLength(15)
  })

  it('畫面上的等級過期（別的分頁剛升過）：拒絕並重新讀取', async () => {
    const { c, deps } = await ready()
    const id = c.state.club!.roster.lineup[0].playerId
    const { upgrade } = await import('../application/economyService')
    await upgrade(deps, { opSeq: 0, playerId: id, expectedLevel: 1 })
    expect(recordOf(c.state.club!, id)!.level).toBe(1) // 畫面還沒更新
    const res = await c.upgrade(id, 1)
    expect(res.ok).toBe(false)
    expect(recordOf(c.state.club!, id)!.level).toBe(2) // 已重新讀取
    expect(c.state.club!.economy.nextOpSeq).toBe(1)
  })

  it('資源不足：顯示原因，不扣款', async () => {
    const { c } = await ready(0)
    const before = c.state.club
    const res = await c.upgrade(before!.roster.lineup[0].playerId, 1)
    expect(res).toEqual({ ok: false, message: '資金或經驗不足' })
    expect(c.state.club).toEqual(before)
  })
})

describe('控制器：進入時遷移', () => {
  it('Phase 3 的存檔：進入 V2 時自動升級並提示，原本的進度都在', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(fixture))
    const { c } = controllerFor(storage, new ManualClock(fixture.idle.anchorMs))
    const notices: string[] = []
    c.subscribe((s) => s.notice && notices.push(s.notice))
    await c.start()
    expect(c.state.status.kind).toBe('ready')
    expect(notices).toContain(V2T.migrated)
    expect(c.state.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(c.state.club!.record).toEqual(fixture.record)
    expect(storage.getItem(CLUB_BACKUP_KEY_V3)).toBe(JSON.stringify(fixture))
  })

  it('遷移失敗：顯示錯誤，原本的存檔不變', async () => {
    const storage = new MemoryStorage()
    const raw = JSON.stringify({ ...fixture, roster: { ...fixture.roster, lineup: fixture.roster.lineup.slice(1) } })
    storage.setItem(CLUB_STORAGE_KEY, raw)
    const { c } = controllerFor(storage)
    await c.start()
    expect(c.state.status).toEqual(expect.objectContaining({ kind: 'broken', reason: 'migration-failed' }))
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(raw)
  })

  it('沒有 Web Locks 的唯讀分頁：不會自己遷移，提示到可寫分頁完成', async () => {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(fixture))
    const { c } = controllerFor(storage, new ManualClock(), null, 'tab-a')
    storage.setItem(WRITER_KEY, 'tab-b')
    await c.start()
    expect(c.state.status).toEqual(expect.objectContaining({ kind: 'broken', reason: 'migration-blocked' }))
    expect(JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!).schemaVersion).toBe(3)
  })
})
