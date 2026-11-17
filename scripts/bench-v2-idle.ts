// V2 放置結算的效能量測：npm run bench:v2:idle
// 量 1、10、96、1,000 場「做計畫 → 批次模擬 → 記帳 → 存檔」各段的耗時，以及存檔大小
import { planMatches, runBatch, yieldToMain } from '../src/v2/application/batchRunner'
import { settleOutcomes } from '../src/v2/application/settlementService'
import { ClubRepository, MemoryStorage, CLUB_STORAGE_KEY } from '../src/v2/infrastructure/clubRepository'
import { T0 } from '../src/v2/testkit'
import { MATCH_INTERVAL_MS } from '../src/v2/application/idleEngine'

const ms = (t: number) => `${t.toFixed(1)} ms`

async function measure(n: number, yieldControl: () => Promise<void> = () => Promise.resolve()) {
  const storage = new MemoryStorage()
  const repo = new ClubRepository(storage)
  const club = repo.createClub({ clubName: '效能測試', clubSeed: 1, clubId: 'bench', now: T0 })
  let t = performance.now()
  const plans = planMatches(club, 0, n)
  const tPlan = performance.now() - t
  t = performance.now()
  // 每 8 場讓出一次；表格用微任務代替，量的是模擬本身，最後一列用正式的 yieldToMain
  const batch = await runBatch(plans, { chunkSize: 8, yieldControl })
  const tSim = performance.now() - t
  t = performance.now()
  // 1,000 場超過放置一次 96 場的上限，這裡跳過時間錨點、只量記帳本身
  const settled = settleOutcomes(club, batch.outcomes, T0 + n * MATCH_INTERVAL_MS).club
  const tSettle = performance.now() - t
  t = performance.now()
  repo.saveClub(settled, club.revision)
  const tSave = performance.now() - t
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  return { n, tPlan, tSim, tSettle, tSave, size, total: tPlan + tSim + tSettle + tSave }
}

await measure(200) // 暖機
console.log('場數 | 總耗時 | 每場 | 計畫 | 模擬 | 記帳 | 存檔 | 存檔大小')
for (const n of [1, 10, 96, 1000]) {
  const r = await measure(n)
  console.log(`${n} | ${ms(r.total)} | ${(r.total / n).toFixed(2)} ms | ${ms(r.tPlan)} | ${ms(r.tSim)} | ${ms(r.tSettle)} | ${ms(r.tSave)} | ${(r.size / 1024).toFixed(1)} KB`)
}

const real = await measure(96, yieldToMain)
console.log(`96（yieldToMain）| ${ms(real.total)} | ${(real.total / 96).toFixed(2)} ms | 模擬含讓出 ${ms(real.tSim)}`)

// ---- Phase 4：滿員 30 人的存檔大小、升級與招募耗時 ----
{
  const { createClubSafely } = await import('../src/v2/application/clubLifecycle')
  const { recruit, upgrade } = await import('../src/v2/application/economyService')
  const { settleDue } = await import('../src/v2/application/settlementService')
  const { FakeLockManager, HOUR, ManualClock, tab } = await import('../src/v2/testkit')
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, new FakeLockManager())
  deps.batch.yieldControl = null
  await createClubSafely(deps, { clubName: '滿員', clubSeed: 9, clubId: 'full' })
  const c0 = deps.store.loadClub()!
  const rich = { funds: 1e9, experience: 1e8 }
  deps.store.saveClub({ ...c0, economy: { ...c0.economy, assets: rich, earned: rich } }, c0.revision)
  let t = performance.now()
  for (let i = 0; i < 16; i++) await recruit(deps, { opSeq: deps.store.loadClub()!.economy.nextOpSeq, role: i % 3 === 2 ? 'pitcher' : 'batter' })
  const tRecruit = (performance.now() - t) / 16
  t = performance.now()
  let ups = 0
  for (const r of deps.store.loadClub()!.players) {
    for (let lv = 1; lv < 8; lv++) {
      await upgrade(deps, { opSeq: deps.store.loadClub()!.economy.nextOpSeq, playerId: r.player.id, expectedLevel: lv })
      ups++
    }
  }
  const tUpgrade = (performance.now() - t) / ups
  for (let day = 0; day < 3; day++) {
    clock.advance(8 * HOUR)
    await settleDue(deps)
  }
  clock.advance(8 * HOUR)
  t = performance.now()
  await settleDue(deps)
  const tSettle = performance.now() - t
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  console.log(`\n滿員 30 人（${ups} 次升級、16 次招募、${deps.store.loadClub()!.idle.nextMatchIndex} 場）`)
  console.log(`招募每次 ${ms(tRecruit)}、升級每次 ${ms(tUpgrade)}（含讀檔、驗證、存檔）；結算 96 場 ${ms(tSettle)}；存檔大小 ${(size / 1024).toFixed(1)} KB`)
}

// ---- Phase 5：最高聯盟、30 人、長期遊玩（挑戰紀錄、支出紀錄都滿）的存檔大小與耗時 ----
{
  const { createClubSafely } = await import('../src/v2/application/clubLifecycle')
  const { recruit, release } = await import('../src/v2/application/economyService')
  const { challengeNextLeague } = await import('../src/v2/application/leagueService')
  const { settleDue } = await import('../src/v2/application/settlementService')
  const { reserves } = await import('../src/v2/domain/roster')
  const { MAX_TIER, PROMOTION_CONFIG } = await import('../src/v2/domain/leagueConfig')
  const { FakeLockManager, HOUR, ManualClock, tab } = await import('../src/v2/testkit')
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, new FakeLockManager())
  deps.batch.yieldControl = null
  await createClubSafely(deps, { clubName: '傳奇', clubSeed: 11, clubId: 'legend' })
  const load = () => deps.store.loadClub()!
  const c0 = load()
  const rich = { funds: 1e9, experience: 1e8 }
  // 長期遊玩的狀態：已經打了很多場、挑戰過很多次（紀錄有上限），在倒數第二級、資格達標
  const challenges = Array.from({ length: PROMOTION_CONFIG.historyLimit }, (_, i) => ({ seq: 40 + i, fromTier: MAX_TIER - 1, toTier: MAX_TIER, won: false, runsFor: 2, runsAgainst: 5, opponentName: '強敵', innings: 9, at: T0, matchIndexAt: 5000, reward: { funds: 0, experience: 0 }, requestKey: `challenge:${MAX_TIER - 1}` }))
  const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
  deps.store.saveClub(
    {
      ...c0,
      economy: { ...c0.economy, assets: rich, earned: rich },
      idle: { ...c0.idle, nextMatchIndex: 20_000 },
      record: { wins: 11_000, losses: 9_000, runsFor: 90_000, runsAgainst: 85_000 },
      league: { ...c0.league, tier: MAX_TIER - 1, highestTier: MAX_TIER - 1, promotions: MAX_TIER - 1, rewardedTiers: [1, 2, 3], matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window), nextChallengeSeq: 50, challenges },
    },
    c0.revision,
  )
  for (let i = 0; i < 16; i++) await recruit(deps, { opSeq: load().economy.nextOpSeq, role: i % 3 === 2 ? 'pitcher' : 'batter' })
  // 挑戰 10 次（失敗就補回資格，量的是挑戰本身：讀檔、驗證、模擬、存檔）
  let tChallenge = 0
  let tries = 0
  for (let i = 0; i < 10 && load().league.tier < MAX_TIER; i++) {
    const c = load()
    const t0 = performance.now()
    await challengeNextLeague(deps, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
    tChallenge += performance.now() - t0
    tries++
    const after = load()
    if (after.league.tier < MAX_TIER) deps.store.saveClub({ ...after, league: { ...after.league, challengeReadyAt: 0 } }, after.revision)
  }
  // 還沒晉級就直接放到最高聯盟（只為了量最高聯盟的結算與存檔大小）
  {
    const c = load()
    if (c.league.tier < MAX_TIER) deps.store.saveClub({ ...c, league: { ...c.league, tier: MAX_TIER, highestTier: MAX_TIER, promotions: MAX_TIER, rewardedTiers: [1, 2, 3, 4], matches: 0, wins: 0, losses: 0, recent: '' } }, c.revision)
  }
  let t = performance.now()
  t = performance.now()
  const victims = reserves(load()).slice(0, 5)
  for (const v of victims) await release(deps, { opSeq: load().economy.nextOpSeq, playerId: v.id })
  const tRelease = (performance.now() - t) / victims.length
  for (let i = 0; i < 5; i++) await recruit(deps, { opSeq: load().economy.nextOpSeq, role: 'batter' })
  clock.advance(8 * HOUR)
  t = performance.now()
  const report = await settleDue(deps)
  const tSettle = performance.now() - t
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  const c = load()
  console.log(`\n最高聯盟、${c.players.length} 人、${c.idle.nextMatchIndex} 場、挑戰紀錄 ${c.league.challenges.length} 筆（上限）、支出紀錄 ${c.economy.recentOps.length} 筆`)
  console.log(`挑戰每次 ${ms(tChallenge / tries)}（${tries} 次，含讀檔、驗證、模擬、存檔）；釋出每次 ${ms(tRelease)}；最高聯盟結算 ${report.settled.length} 場 ${ms(tSettle)}；存檔大小 ${(size / 1024).toFixed(1)} KB`)
}

// ---- Phase 5B：Replay 大小與建立觀戰時間軸的耗時 ----
{
  const { buildTimeline } = await import('../src/v2/application/replayPlayer')
  const storage = new MemoryStorage()
  const repo = new ClubRepository(storage)
  const club = repo.createClub({ clubName: '觀戰', clubSeed: 5, clubId: 'replay-bench', now: T0 })
  const batch = await runBatch(planMatches(club, 0, 96), { chunkSize: 8, yieldControl: () => Promise.resolve() })
  const sizes = batch.outcomes.map((o) => JSON.stringify(o.result.replay).length)
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
  const settled = settleOutcomes(club, batch.outcomes, T0 + 96 * MATCH_INTERVAL_MS).club
  const replaysBytes = JSON.stringify(settled.replays).length
  const total = JSON.stringify(settled).length
  let t = performance.now()
  let frames = 0
  for (const o of batch.outcomes.slice(0, 20)) frames += buildTimeline(o.result.replay).frames.length
  const tTimeline = (performance.now() - t) / 20
  console.log(`\n單場 Replay JSON 平均 ${(avg / 1024).toFixed(1)} KB（最小 ${(Math.min(...sizes) / 1024).toFixed(1)}、最大 ${(Math.max(...sizes) / 1024).toFixed(1)} KB）`)
  console.log(`存檔保留 ${settled.replays.length} 場完整 Replay，共 ${(replaysBytes / 1024).toFixed(1)} KB（占存檔 ${(total / 1024).toFixed(1)} KB 的 ${((replaysBytes / total) * 100).toFixed(0)}%）`)
  console.log(`建立觀戰時間軸每場 ${ms(tTimeline)}（平均 ${(frames / 20).toFixed(0)} 格）`)
}
