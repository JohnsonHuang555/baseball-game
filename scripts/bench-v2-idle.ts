// V2 放置結算的效能量測：npm run bench:v2:idle
// 量 1、10、96、1,000 場「做計畫 → 批次模擬 → 記帳 → 存檔」各段的耗時，以及存檔大小
import { leagueAtTier } from '../src/v2/domain/league'
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
  for (let i = 0; i < 16; i++) await recruit(deps, { opSeq: deps.store.loadClub()!.economy.nextOpSeq, role: i % 3 === 2 ? 'pitcher' : 'batter', candidateIndex: 0, expectedCount: deps.store.loadClub()!.recruitment.count })
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
      // 從舊版本遷移上來的長期存檔：球員數據從這裡開始記錄
      stats: { ...c0.stats, sinceMatch: 20_000, throughMatch: 20_000 },
      record: { wins: 11_000, losses: 9_000, runsFor: 90_000, runsAgainst: 85_000 },
      league: leagueAtTier(c0.league, MAX_TIER - 1, { matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window), nextChallengeSeq: 50, challenges }),
    },
    c0.revision,
  )
  for (let i = 0; i < 16; i++) await recruit(deps, { opSeq: load().economy.nextOpSeq, role: i % 3 === 2 ? 'pitcher' : 'batter', candidateIndex: 0, expectedCount: load().recruitment.count })
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
    if (c.league.tier < MAX_TIER) deps.store.saveClub({ ...c, league: leagueAtTier(c.league, MAX_TIER, { matches: 0, wins: 0, losses: 0, recent: '', nextChallengeSeq: c.league.nextChallengeSeq, challenges: c.league.challenges }) }, c.revision)
  }
  let t = performance.now()
  t = performance.now()
  const victims = reserves(load()).slice(0, 5)
  for (const v of victims) await release(deps, { opSeq: load().economy.nextOpSeq, playerId: v.id })
  const tRelease = (performance.now() - t) / victims.length
  for (let i = 0; i < 5; i++) await recruit(deps, { opSeq: load().economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: load().recruitment.count })
  clock.advance(8 * HOUR)
  t = performance.now()
  const report = await settleDue(deps)
  const tSettle = performance.now() - t
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  const c = load()
  console.log(`\n最高聯盟、${c.players.length} 人、${c.idle.nextMatchIndex} 場、挑戰紀錄 ${c.league.challenges.length} 筆（上限）、支出紀錄 ${c.economy.recentOps.length} 筆`)
  console.log(`挑戰每次 ${ms(tChallenge / tries)}（${tries} 次，含讀檔、驗證、模擬、存檔）；釋出每次 ${ms(tRelease)}；最高聯盟結算 ${report.settled.length} 場 ${ms(tSettle)}；存檔大小 ${(size / 1024).toFixed(1)} KB`)
}

// ---- Phase 5B：Box Score、Replay 大小、直播時間軸與固定計畫的耗時 ----
{
  const { liveTimeline, freezeLiveMatch } = await import('../src/v2/application/liveMatch')
  const storage = new MemoryStorage()
  const repo = new ClubRepository(storage)
  const club = repo.createClub({ clubName: '觀戰', clubSeed: 5, clubId: 'replay-bench', now: T0 })
  const batch = await runBatch(planMatches(club, 0, 96), { chunkSize: 8, yieldControl: () => Promise.resolve() })
  const sizes = batch.outcomes.map((o) => JSON.stringify(o.result.replay).length)
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length
  const settled = settleOutcomes(club, batch.outcomes, T0 + 96 * MATCH_INTERVAL_MS).club
  const replaysBytes = JSON.stringify(settled.replays).length
  const boxBytes = settled.recentMatches.reduce((a, m) => a + JSON.stringify(m.box ?? null).length, 0)
  const total = JSON.stringify(settled).length
  let t = performance.now()
  let frames = 0
  for (let i = 0; i < 20; i++) frames += liveTimeline(batch.outcomes[i].plan).timeline.frames.length
  const tLive = (performance.now() - t) / 20
  t = performance.now()
  for (let i = 0; i < 100; i++) freezeLiveMatch({ ...settled, liveMatch: null })
  const tFreeze = (performance.now() - t) / 100
  const frozen = freezeLiveMatch(settled)
  const liveBytes = JSON.stringify(frozen.liveMatch).length
  console.log(`\n${settled.recentMatches.length} 場戰報的 Box Score 共 ${(boxBytes / 1024).toFixed(1)} KB（每場平均 ${(boxBytes / settled.recentMatches.length / 1024).toFixed(2)} KB）`)
  console.log(`單場 Replay JSON 平均 ${(avg / 1024).toFixed(1)} KB；存檔保留 ${settled.replays.length} 場，共 ${(replaysBytes / 1024).toFixed(1)} KB；96 場後存檔 ${(total / 1024).toFixed(1)} KB`)
  console.log(`固定進行中比賽的計畫：每次 ${ms(tFreeze)}，存檔多 ${(liveBytes / 1024).toFixed(1)} KB（只在比賽進行中修改球團時才有，結算後清掉）`)
  console.log(`建立直播時間軸（模擬＋逐格狀態）每場 ${ms(tLive)}（平均 ${(frames / 20).toFixed(0)} 格）`)
}

// ---- Phase 6A：首頁每次重繪都會算一次「目前建議」與新手任務 ----
{
  const { suggestNextAction } = await import('../src/v2/application/guidance')
  const { onboardingProgress } = await import('../src/v2/domain/onboarding')
  const storage = new MemoryStorage()
  const repo = new ClubRepository(storage)
  const club = repo.createClub({ clubName: '引導', clubSeed: 6, clubId: 'guide-bench', now: T0 })
  const rich = { ...club, economy: { ...club.economy, assets: { funds: 1e7, experience: 1e6 } } }
  const t = performance.now()
  for (let i = 0; i < 1000; i++) {
    suggestNextAction(rich, { canWrite: true })
    onboardingProgress(rich)
  }
  const bytes = JSON.stringify(club.onboarding).length
  console.log(`\n目前建議＋新手任務（首頁每次重繪）：每次 ${ms((performance.now() - t) / 1000)}；新手任務旗標在存檔裡 ${bytes} bytes`)
}

// ---- Phase 6B：直播的精彩時刻判定（每一格揭曉時算一次）與排程 ----
{
  const { liveTimeline } = await import('../src/v2/application/liveMatch')
  const { frameMoment, clutchSituation } = await import('../src/v2/application/matchMoments')
  const repo = new ClubRepository(new MemoryStorage())
  const club = repo.createClub({ clubName: '精彩', clubSeed: 66, clubId: 'moments-bench', now: T0 })
  const lives = planMatches(club, 0, 20).map((p) => liveTimeline(p))
  let frames = 0
  const t = performance.now()
  for (const { timeline } of lives) {
    let prev = timeline.initial
    for (const f of timeline.frames) {
      frameMoment(prev, f, timeline.userSide)
      clutchSituation(prev, timeline.userSide)
      prev = f.after
      frames++
    }
  }
  const per = (performance.now() - t) / frames
  console.log(`\n精彩時刻判定＋關鍵打席：每格 ${(per * 1000).toFixed(1)} µs（${frames} 格）；一場約 ${ms(per * (frames / 20))}`)
}

// ---- Phase 7B：分段結算的成本（降級可能發生時，一批 96 場會切成好幾段規劃） ----
{
  const { settleDueUnsaved, settleIdle } = await import('../src/v2/application/settlementService')
  const { matchesBeforePossibleRelegation } = await import('../src/v2/domain/league')
  const { FakeLockManager, HOUR, ManualClock, tab } = await import('../src/v2/testkit')
  const scenario = async (label: string, tier: number, points: number | null, weak: boolean) => {
    const storage = new MemoryStorage()
    const clock = new ManualClock(T0)
    const deps = tab(storage, clock, new FakeLockManager())
    deps.batch.yieldControl = null
    const c0 = deps.store.createClub({ clubName: '分段', clubSeed: 5, clubId: `seg-${label}`, now: T0 })
    let club = { ...c0, league: leagueAtTier(c0.league, tier, points === null ? {} : { points }) }
    if (weak) club = { ...club, players: club.players.map((r) => ({ ...r, player: { ...r.player, ratings: Object.fromEntries(Object.keys(r.player.ratings).map((k) => [k, 1])) } as unknown as typeof r.player })) }
    club = deps.store.saveClub(club, c0.revision)
    clock.advance(8 * HOUR)
    const now = clock.now()
    const runs = 5
    let tNew = 0
    let tOld = 0
    let segments = 0
    let relegations = 0
    for (let i = 0; i < runs; i++) {
      let t = performance.now()
      const { next } = await settleDueUnsaved(club, now, deps)
      tNew += performance.now() - t
      relegations = next.club.league.relegations
      // 數段數：照同樣的規則重走一次
      let s = 0
      let c = club
      let left = 96
      while (left > 0) {
        const k = Math.min(left, matchesBeforePossibleRelegation(c.league))
        const seg = next.settled.slice(96 - left, 96 - left + k)
        left -= seg.length
        s++
        if (!seg.length) break
        c = { ...c, league: { ...c.league, ...(seg.at(-1)!.ranked?.relegatedTo != null ? { tier: seg.at(-1)!.ranked!.relegatedTo!, points: 50, protectionRemaining: 0 } : { points: seg.at(-1)!.ranked?.after ?? c.league.points }) } }
      }
      segments = s
      // 對照：加入競技系統前的做法（一次規劃整批 96 場，同一個聯盟打完）
      t = performance.now()
      settleIdle(club, (await runBatch(planMatches(club, 0, 96), { yieldControl: null })).outcomes, now)
      tOld += performance.now() - t
    }
    console.log(`${label} | ${ms(tNew / runs)} | ${ms(tOld / runs)} | ${((tNew / tOld - 1) * 100).toFixed(1)}% | ${segments} | ${relegations}`)
  }
  console.log('\nPhase 7B 分段結算（一次結算 96 場，平均 5 次）')
  console.log('情境 | 分段結算 | 一次規劃整批（7A 以前的做法） | 差異 | 段數 | 降級次數')
  await scenario('新秀（不會降級）', 0, null, false)
  await scenario('挑戰者（保底）', 2, 50, false)
  await scenario('職業 50 分、一般球隊', 3, 50, false)
  await scenario('傳奇 10 分、全隊能力 1（中途降級）', 4, 10, true)
}

// ---- Phase 8：球員數據的存檔大小與耗時 ----
{
  const { createClubSafely } = await import('../src/v2/application/clubLifecycle')
  const { recruit, release } = await import('../src/v2/application/economyService')
  const { settleDue } = await import('../src/v2/application/settlementService')
  const { leaderboard, periodTotals } = await import('../src/v2/application/statsQuery')
  const { reserves } = await import('../src/v2/domain/roster')
  const { FakeLockManager, HOUR, ManualClock, tab } = await import('../src/v2/testkit')
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, new FakeLockManager())
  deps.batch.yieldControl = null
  await createClubSafely(deps, { clubName: '長期', clubSeed: 88, clubId: 'stats-bench' })
  const load = () => deps.store.loadClub()!
  const c0 = load()
  const rich = { funds: 1e12, experience: 1e11 }
  deps.store.saveClub({ ...c0, economy: { ...c0.economy, assets: rich, earned: rich } }, c0.revision)
  // 3,000 場：每 96 場招募 2 位、把預備名單的人釋出（只有上場過的人才有生涯紀錄；大量釋出的容量見 npm run bench:v2:stats）
  let settleMs = 0
  let batches = 0
  while (load().idle.nextMatchIndex < 3000) {
    clock.advance(8 * HOUR)
    const t = performance.now()
    await settleDue(deps)
    settleMs += performance.now() - t
    batches++
    for (let i = 0; i < 2; i++) {
      const c = load()
      if (c.players.length >= 30) break
      await recruit(deps, { opSeq: c.economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: c.recruitment.count })
    }
    for (const v of reserves(load()).slice(0, 2)) await release(deps, { opSeq: load().economy.nextOpSeq, playerId: v.id })
  }
  const c = load()
  const lineBytes = c.recentMatches.reduce((a, m) => a + JSON.stringify(m.lines ?? null).length, 0)
  const careerBytes = JSON.stringify(c.stats).length
  const released = Object.values(c.stats.players).filter((r) => r.releasedAt !== undefined).length
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  let t = performance.now()
  for (let i = 0; i < 200; i++) {
    periodTotals(c, 'last30')
    leaderboard(c, 'batter', 'last30', 'ops')
  }
  const tQuery = (performance.now() - t) / 200
  console.log(`\nPhase 8 球員數據（${c.idle.nextMatchIndex} 場、${batches} 次離線結算，每次 96 場）`)
  console.log(`近期 ${c.recentMatches.length} 場的 lines 共 ${(lineBytes / 1024).toFixed(1)} KB（每場 ${(lineBytes / c.recentMatches.length).toFixed(0)} bytes）`)
  console.log(`生涯紀錄 ${Object.keys(c.stats.players).length} 位（其中已釋出 ${released} 位，全部保留），共 ${(careerBytes / 1024).toFixed(1)} KB`)
  console.log(`存檔大小 ${(size / 1024).toFixed(1)} KB；每次 96 場結算平均 ${ms(settleMs / batches)}；最近 30 場聚合＋排行每次 ${ms(tQuery)}`)
}
