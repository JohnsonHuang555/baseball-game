// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { economyViolations, matchIdFor, type ClubSaveV3 } from '../domain/club'
import { ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FlakyStorage, HOUR, MINUTE, ManualClock, T0, tab } from '../testkit'
import { planMatches, runBatch, type MatchPlan } from './batchRunner'
import { runMatch } from './matchRunner'
import { SettlementError, applySettingsChange, claim, claimRewards, settleDue, settleOutcomes, updateSettings } from './settlementService'

function createIn(storage = new MemoryStorage(), clock = new ManualClock()) {
  const deps = tab(storage, clock)
  const club = deps.store.createClub({ clubName: '測試球團', clubSeed: 2026, clubId: 'club-1', now: clock.now() })
  return { storage, clock, deps, club }
}

const withoutRevision = (c: ClubSaveV3) => ({ ...c, revision: 0 })

describe('冪等結算（純函式）', () => {
  it('同一個 matchId 重複提交 10 次，戰績與收益只增加一次', async () => {
    const { club } = createIn()
    const [outcome] = (await runBatch(planMatches(club, 0, 1))).outcomes
    let c = club
    for (let i = 0; i < 10; i++) c = settleOutcomes(c, [outcome], T0 + 5 * MINUTE).club
    expect(c.record.wins + c.record.losses).toBe(1)
    expect(c.idle.nextMatchIndex).toBe(1)
    expect(c.recentMatches).toHaveLength(1)
    expect(c.economy.unclaimed).toEqual({ funds: c.recentMatches[0].earnedFunds, experience: c.recentMatches[0].earnedExperience })
    expect(c.economy.lifetime).toEqual(c.economy.unclaimed)
  })

  it('不修改輸入的球團', async () => {
    const { club } = createIn()
    const before = JSON.stringify(club)
    const { outcomes } = await runBatch(planMatches(club, 0, 3))
    settleOutcomes(club, outcomes, T0)
    claimRewards(club, 0)
    applySettingsChange(club, { coach: { style: 'balanced', params: { stealMin: 0.9 } } })
    expect(JSON.stringify(club)).toBe(before)
  })

  it('跳號或不屬於這個球團的比賽，整批都不算', async () => {
    const { club } = createIn()
    const { outcomes } = await runBatch(planMatches(club, 0, 3))
    expect(() => settleOutcomes(club, [outcomes[1]], T0)).toThrow(SettlementError)
    const foreign = { ...club, clubSeed: 1 }
    expect(() => settleOutcomes(foreign, outcomes, T0)).toThrow(SettlementError)
  })

  it('每場紀錄都有 matchId、序號、種子、結果、收益與結算時間', async () => {
    const { club } = createIn()
    const { outcomes } = await runBatch(planMatches(club, 0, 2))
    const { settled } = settleOutcomes(club, outcomes, T0 + 10 * MINUTE)
    expect(settled.map((m) => m.matchId)).toEqual([matchIdFor(club, 0), matchIdFor(club, 1)])
    for (const m of settled) {
      expect(m.seed).toBe(outcomes[m.matchIndex].plan.seed)
      expect(m.earnedFunds).toBeGreaterThan(0)
      expect(m.earnedExperience).toBeGreaterThan(0)
      expect(m.settledAt).toBe(T0 + 10 * MINUTE)
      expect(m.result.runsFor).toBe(outcomes[m.matchIndex].result.score[m.result.userSide])
    }
  })
})

describe('領取收益', () => {
  const seq = (deps: ReturnType<typeof tab>) => deps.store.loadClub()!.economy.nextClaimSeq

  it('結算一次、領取一次只算一次；同一個序號重送不會增加資源', async () => {
    const { deps, clock } = createIn()
    clock.advance(HOUR)
    const report = await settleDue(deps)
    const earned = report.settled.reduce((s, m) => s + m.earnedFunds, 0)
    expect(report.club.economy.assets.funds).toBe(0)
    expect(report.club.economy.unclaimed.funds).toBe(earned)

    const first = await claim(deps, 0)
    expect(first.claimed.funds).toBe(earned)
    for (let i = 0; i < 5; i++) {
      const again = await claim(deps, 0)
      expect(again.duplicate).toBe(true)
      // 重送回傳原本那次領到的數字，方便呼叫端顯示
      expect(again.claimed.funds).toBe(earned)
    }
    // 下一個序號：沒有新收益，領到 0
    expect((await claim(deps, 1)).claimed).toEqual({ funds: 0, experience: 0 })

    const c = deps.store.loadClub()!
    expect(c.economy.assets.funds).toBe(earned)
    expect(c.economy.unclaimed).toEqual({ funds: 0, experience: 0 })
    expect(c.economy.lifetime.funds).toBe(earned)
    expect(c.economy.nextClaimSeq).toBe(2)
  })

  it('領取超過 20 次之後，重送任何一個舊請求都不會再入帳', async () => {
    const { deps, clock } = createIn()
    const sent: number[] = []
    for (let i = 0; i < 30; i++) {
      clock.advance(7 * MINUTE)
      await settleDue(deps)
      const s = seq(deps)
      sent.push(s)
      await claim(deps, s)
    }
    clock.advance(20 * MINUTE)
    await settleDue(deps)
    const before = deps.store.loadClub()!
    expect(before.economy.unclaimed.funds).toBeGreaterThan(0)
    // 最舊的請求（第 0 號）到最新的都重送一遍：未領取的收益原封不動，資產不變
    for (const s of sent) expect((await claim(deps, s)).duplicate).toBe(true)
    const after = deps.store.loadClub()!
    expect(after.economy).toEqual(before.economy)
    expect(after.revision).toBe(before.revision)
    // 存檔裡領取相關的資料不隨次數成長
    expect(JSON.stringify(after.economy).length).toBeLessThan(400)
  })

  it('序號比目前大：拒絕，不入帳', async () => {
    const { deps, clock } = createIn()
    clock.advance(HOUR)
    await settleDue(deps)
    await expect(claim(deps, 5)).rejects.toThrow(SettlementError)
    expect(() => claimRewards(deps.store.loadClub()!, -1)).toThrow(RangeError)
    expect(deps.store.loadClub()!.economy.assets.funds).toBe(0)
  })

  it('資產 + 未領取 永遠等於總收益', async () => {
    const { deps, clock } = createIn()
    for (let i = 0; i < 12; i++) {
      clock.advance(23 * MINUTE)
      await settleDue(deps)
      if (i % 2) await claim(deps, seq(deps))
      // 偶爾重送舊序號
      if (i % 3 === 0) await claim(deps, Math.max(0, seq(deps) - 1)).catch(() => undefined)
      const club = deps.store.loadClub()!
      expect(economyViolations(club.economy)).toEqual([])
    }
  })
})

describe('結算服務', () => {
  it('時間不到 5 分鐘：沒有結算，也不存檔', async () => {
    const { deps, clock, club } = createIn()
    clock.advance(4 * MINUTE)
    const report = await settleDue(deps)
    expect(report.status).toBe('nothing-due')
    expect(deps.store.loadClub()!.revision).toBe(club.revision)
  })

  it('重新載入存檔後，已結算的場次不會重複', async () => {
    const { storage, clock, deps } = createIn()
    clock.advance(2 * HOUR)
    const first = await settleDue(deps)
    expect(first.settled).toHaveLength(24)
    // 重新整理：新的 repository 讀同一份存檔
    const reloaded = tab(storage, clock)
    const again = await settleDue(reloaded)
    expect(again.status).toBe('nothing-due')
    const c = reloaded.store.loadClub()!
    expect(c.record.wins + c.record.losses).toBe(24)
    expect(c.idle.nextMatchIndex).toBe(24)
  })

  it('中斷後重新執行，最終結果與一次完成相同', async () => {
    const a = createIn()
    const b = createIn()
    a.clock.advance(5 * HOUR)
    b.clock.advance(5 * HOUR)
    const controller = new AbortController()
    const interrupted = await settleDue(
      { ...a.deps, batch: { ...a.deps.batch, onProgress: (done) => done === 25 && controller.abort() } },
      { signal: controller.signal },
    )
    expect(interrupted.status).toBe('aborted')
    expect(interrupted.settled).toHaveLength(25)
    // 中斷時已經打完的場次有存檔
    expect(a.deps.store.loadClub()!.idle.nextMatchIndex).toBe(25)
    const resumed = await settleDue(a.deps)
    expect(resumed.settled).toHaveLength(35)
    await settleDue(b.deps)
    expect(withoutRevision(a.deps.store.loadClub()!)).toEqual(withoutRevision(b.deps.store.loadClub()!))
  })

  it('同一初始存檔、時間、規則版本與戰術配置，產生相同結果', async () => {
    const results = await Promise.all(
      [1, 2].map(async () => {
        const { deps, clock } = createIn()
        clock.advance(3 * HOUR + 7 * MINUTE)
        await settleDue(deps)
        clock.advance(11 * MINUTE)
        await settleDue(deps)
        return deps.store.loadClub()!
      }),
    )
    expect(results[0]).toEqual(results[1])
    expect(results[0].recentMatches.every((m) => m.result.rulesVersion === results[0].recentMatches[0].result.rulesVersion)).toBe(true)
  })

  it('模擬失敗：失敗之前的場次完整結算，失敗的那場沒有任何紀錄或收益', async () => {
    const { deps, clock } = createIn()
    clock.advance(HOUR)
    const failing = {
      ...deps,
      batch: {
        ...deps.batch,
        simulate: (p: MatchPlan) => {
          if (p.matchIndex === 5) throw new Error('模擬壞掉')
          return runMatch(p.setup, p.ai)
        },
      },
    }
    const error = await settleDue(failing).catch((e) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect(error.code).toBe('simulation-failed')
    const c = deps.store.loadClub()!
    expect(c.idle.nextMatchIndex).toBe(5)
    expect(c.record.wins + c.record.losses).toBe(5)
    expect(c.recentMatches.map((m) => m.matchIndex)).toEqual([0, 1, 2, 3, 4])
    expect(c.economy.unclaimed.funds).toBe(c.recentMatches.reduce((s, m) => s + m.earnedFunds, 0))
    // 錨點只推進 5 場：修好之後剩下的 7 場照樣會打
    expect(c.idle.anchorMs).toBe(T0 + 25 * MINUTE)
    const fixed = await settleDue(deps)
    expect(fixed.settled).toHaveLength(7)
  })

  it('第一場就模擬失敗：完全不存檔', async () => {
    const { deps, clock, club } = createIn()
    clock.advance(HOUR)
    const failing = { ...deps, batch: { simulate: () => { throw new Error('壞掉') } } }
    await expect(settleDue(failing)).rejects.toThrow(SettlementError)
    expect(deps.store.loadClub()).toEqual(club)
  })

  it('存檔失敗：丟錯、不回報成功，存檔維持原樣', async () => {
    const storage = new FlakyStorage()
    const { deps, clock, club } = createIn(storage as unknown as MemoryStorage)
    clock.advance(HOUR)
    storage.failWrites = true
    const error = await settleDue(deps).catch((e) => e)
    expect(error).toBeInstanceOf(ClubSaveError)
    expect(error.code).toBe('write-failed')
    expect(deps.store.loadClub()).toEqual(club)
    // 恢復之後重試：結果跟沒失敗過一樣
    storage.failWrites = false
    expect((await settleDue(deps)).settled).toHaveLength(12)
  })

  it('時間倒退：不產生負數或重複場次', async () => {
    const { deps, clock } = createIn()
    clock.advance(30 * MINUTE)
    await settleDue(deps)
    clock.advance(-5 * HOUR)
    const report = await settleDue(deps)
    expect(report.status).toBe('nothing-due')
    expect(report.due.rewound).toBe(true)
    clock.advance(5 * HOUR)
    expect((await settleDue(deps)).status).toBe('nothing-due')
    const c = deps.store.loadClub()!
    expect(c.idle.nextMatchIndex).toBe(6)
    expect(c.record.wins + c.record.losses).toBe(6)
  })

  it('沒有球團存檔就丟錯', async () => {
    await expect(settleDue(tab(new MemoryStorage(), new ManualClock()))).rejects.toThrow(SettlementError)
  })
})

describe('換陣容、戰術', () => {
  it('到期的比賽用舊設定打完，新設定從下一場開始生效，已結算的比賽不變', async () => {
    const { deps, clock } = createIn()
    clock.advance(17 * MINUTE)
    const newRoster = generateRoster(new Rng(424242))
    const saved = await updateSettings(deps, { roster: newRoster })
    expect(saved.idle.nextMatchIndex).toBe(3)
    expect(saved.strategy.effectiveFromMatch).toBe(3)
    expect(saved.roster).toEqual(newRoster)
    // 前 3 場的 replay 用的是舊陣容
    const oldId = createIn().club.roster.starter.id
    for (const { replay } of saved.replays) {
      const ours = replay.setup[replay.setup.userSide]
      expect(ours.roster.starter.id).toBe(oldId)
    }
    clock.advance(3 * MINUTE)
    const next = await settleDue(deps)
    const replay = next.club.replays.at(-1)!.replay
    expect(replay.setup[replay.setup.userSide].roster.starter.id).toBe(newRoster.starter.id)
  })
})
