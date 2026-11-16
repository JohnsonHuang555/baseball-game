// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { yieldToMain } from '../application/batchRunner'
import { createClubSafely } from '../application/clubLifecycle'
import { settleDue } from '../application/settlementService'
import { BATCH_CONFIG } from '../domain/config'
import { FakeLockManager, HOUR, ManualClock } from '../testkit'
import { InProcessLock, MemoryStorage, WebLocksClubLock } from './clubRepository'
import { createV2Deps } from './composition'
import { systemClock } from './systemClock'

describe('依賴組裝入口', () => {
  it('正式環境的預設：Web Locks、系統時間、每 BATCH_CONFIG.chunkSize 場用 yieldToMain 讓出', () => {
    const deps = createV2Deps({ storage: new MemoryStorage(), navigator: { locks: new FakeLockManager() } })
    expect(deps.lock).toBeInstanceOf(WebLocksClubLock)
    expect(deps.lock.crossTab).toBe(true)
    expect(deps.clock).toBe(systemClock)
    expect(deps.batch.yieldControl).toBe(yieldToMain)
    expect(deps.batch.chunkSize).toBe(BATCH_CONFIG.chunkSize)
  })

  it('沒有 Web Locks：降級成分頁內互斥，標明 crossTab: false', () => {
    const deps = createV2Deps({ storage: new MemoryStorage(), navigator: {} })
    expect(deps.lock).toBeInstanceOf(InProcessLock)
    expect(deps.lock.crossTab).toBe(false)
  })

  it('Node 環境（沒有 localStorage、沒有 navigator.locks）也能組起來，存取時明確報錯', () => {
    const deps = createV2Deps({ storage: null })
    expect(() => deps.store.loadClub()).toThrow(/儲存無法使用/)
  })

  it('測試可以只覆寫讓出方式，其他維持預設', async () => {
    let yields = 0
    const clock = new ManualClock()
    const deps = createV2Deps({ storage: new MemoryStorage(), clock, navigator: {}, batch: { yieldControl: async () => void yields++ } })
    expect(deps.batch.chunkSize).toBe(BATCH_CONFIG.chunkSize)
    await createClubSafely(deps, { clubName: '組裝測試', clubSeed: 3 })
    clock.advance(2 * HOUR)
    const report = await settleDue(deps)
    expect(report.settled).toHaveLength(24)
    expect(yields).toBe(24 / BATCH_CONFIG.chunkSize)
  })
})
