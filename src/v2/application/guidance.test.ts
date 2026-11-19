// @vitest-environment node
// Phase 6A：新手任務的推導、目前建議的規則、onboarding 旗標的寫入，以及「不改任何比賽結果」
import { describe, expect, it } from 'vitest'
import fixtureV7 from '../domain/__fixtures__/club-v7-phase5b.json'
import type { ClubSave } from '../domain/club'
import { CLUB_SCHEMA_VERSION } from '../domain/club'
import { eligibility } from '../domain/league'
import { PROMOTION_CONFIG } from '../domain/leagueConfig'
import { migrateToLatest, sourceVersion } from '../domain/migration'
import { onboardingProgress } from '../domain/onboarding'
import { upgradeCost } from '../domain/progression'
import { assignedIds } from '../domain/roster'
import { CLUB_BACKUP_KEY_V7, CLUB_STORAGE_KEY, ClubSaveError, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab, v8League } from '../testkit'
import { createClubSafely, openClubSafely } from './clubLifecycle'
import { recruit, release, upgrade } from './economyService'
import { lineupCandidate, nearestUpgrade, suggestNextAction, upgradeCandidate } from './guidance'
import { markWatchedLive, setOnboarding } from './onboardingService'
import { claim, settleDue, updateSettings } from './settlementService'

async function fresh(seed = 7) {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const deps = tab(storage, clock, new FakeLockManager())
  await createClubSafely(deps, { clubName: '引導隊', clubSeed: seed, clubId: 'club-guide' })
  return { storage, clock, deps, load: () => deps.store.loadClub()! }
}

const tasks = (c: ClubSave) => Object.fromEntries(onboardingProgress(c).tasks.map((t) => [t.id, t.done]))
/** 直接加資產（帳務保持平衡：assets + unclaimed + spent = earned） */
const give = (c: ClubSave, funds: number, experience: number, where: 'assets' | 'unclaimed' = 'assets'): ClubSave => {
  const n = structuredClone(c)
  n.economy[where].funds += funds
  n.economy[where].experience += experience
  n.economy.earned.funds += funds
  n.economy.earned.experience += experience
  return n
}
const swapOrder = (c: ClubSave) => {
  const roster = structuredClone(c.roster)
  ;[roster.lineup[0], roster.lineup[1]] = [roster.lineup[1], roster.lineup[0]]
  return roster
}

describe('新手任務', () => {
  it('新球團：只有「建立球隊」完成，區塊展開', async () => {
    const { load } = await fresh()
    const p = onboardingProgress(load())
    expect(p.done).toBe(1)
    expect(p.total).toBe(6)
    expect(p.collapsed).toBe(false)
    expect(tasks(load())).toEqual({ club: true, watch: false, firstMatch: false, claim: false, upgrade: false, lineup: false })
  })

  it('不照順序完成也可以：先換陣容、再升級，最後才觀戰與領取', async () => {
    const { deps, clock, load } = await fresh()
    await updateSettings(deps, { roster: swapOrder(load()) })
    expect(tasks(load()).lineup).toBe(true)
    expect(tasks(load()).firstMatch).toBe(false)
    const rich = give(load(), 10_000, 1_000)
    deps.store.saveClub(rich, rich.revision)
    await upgrade(deps, { opSeq: load().economy.nextOpSeq, playerId: load().roster.lineup[0].playerId, expectedLevel: 1 })
    expect(tasks(load()).upgrade).toBe(true)
    clock.advance(HOUR)
    await settleDue(deps)
    expect(tasks(load()).firstMatch).toBe(true)
    expect(tasks(load()).claim).toBe(false)
    await claim(deps, load().economy.nextClaimSeq)
    await markWatchedLive(deps)
    expect(onboardingProgress(load()).allDone).toBe(true)
  })

  it('領取收益：有資產但沒領過不算；領到 0（只可能是直接呼叫服務）也不算；領到收益才算', async () => {
    const { deps, clock, load } = await fresh()
    // 初始資源（例如之後的獎勵直接進資產）不算領取
    const seeded = give(load(), 500, 50)
    deps.store.saveClub(seeded, seeded.revision)
    expect(tasks(load()).claim).toBe(false)
    await claim(deps, load().economy.nextClaimSeq)
    expect(load().economy.nextClaimSeq).toBe(1)
    expect(tasks(load()).claim).toBe(false)
    clock.advance(10 * MINUTE)
    await settleDue(deps)
    expect(tasks(load()).claim).toBe(false)
    await claim(deps, load().economy.nextClaimSeq)
    expect(tasks(load()).claim).toBe(true)
  })

  it('培養球員：只有升級算；招募、釋出不算', async () => {
    const { deps, load } = await fresh()
    const rich = give(load(), 50_000, 0)
    deps.store.saveClub(rich, rich.revision)
    const out = await recruit(deps, { opSeq: load().economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: load().recruitment.count })
    await release(deps, { opSeq: load().economy.nextOpSeq, playerId: out.op.playerId })
    expect(tasks(load()).upgrade).toBe(false)
    const more = give(load(), 0, 100)
    deps.store.saveClub(more, more.revision)
    await upgrade(deps, { opSeq: load().economy.nextOpSeq, playerId: load().roster.starter, expectedLevel: 1 })
    expect(tasks(load()).upgrade).toBe(true)
  })

  it('調整陣容：原樣再存一次、只改戰術都不算；真的改了配置才算，之後改回來也不會變回未完成', async () => {
    const { deps, load } = await fresh()
    const original = structuredClone(load().roster)
    await updateSettings(deps, { roster: structuredClone(original) })
    await updateSettings(deps, { coach: { style: 'balanced', params: { latePlatoon: false } } })
    expect(tasks(load()).lineup).toBe(false)
    await updateSettings(deps, { roster: swapOrder(load()) })
    expect(tasks(load()).lineup).toBe(true)
    await updateSettings(deps, { roster: original })
    expect(tasks(load()).lineup).toBe(true)
  })

  it('沒有預備球員也做得到：初始球隊交換棒次就是合法的陣容變更', async () => {
    const { deps, load } = await fresh(99)
    expect(load().players.every((r) => assignedIds(load().roster).has(r.player.id))).toBe(true)
    await expect(updateSettings(deps, { roster: swapOrder(load()) })).resolves.toBeTruthy()
    expect(tasks(load()).lineup).toBe(true)
  })
})

describe('onboarding 旗標的寫入', () => {
  it('已經是想要的值就不寫入（revision 不變）；收合狀態存在存檔，重新讀取還在', async () => {
    const { deps, load } = await fresh()
    const r0 = load().revision
    expect((await markWatchedLive(deps)).changed).toBe(true)
    expect(load().revision).toBe(r0 + 1)
    expect((await markWatchedLive(deps)).changed).toBe(false)
    expect((await setOnboarding(deps, { collapsed: false })).changed).toBe(false)
    expect(load().revision).toBe(r0 + 1)
    await setOnboarding(deps, { collapsed: true })
    expect(load().onboarding).toEqual({ watchedLive: true, claimedRewards: false, lineupChanged: false, collapsed: true })
  })

  it('多分頁：旗標寫入在鎖內讀最新存檔，不會用舊的資料蓋掉別的分頁剛領的收益', async () => {
    const { storage, clock, deps, load } = await fresh()
    const other = tab(storage, clock, new FakeLockManager())
    clock.advance(HOUR)
    await settleDue(other)
    await claim(other, load().economy.nextClaimSeq)
    const claimed = load().economy
    await markWatchedLive(deps)
    expect(load().economy).toEqual(claimed)
    expect(load().onboarding.watchedLive).toBe(true)
  })

  it('revision 衝突（沒有 Web Locks、兩個分頁同時寫）會被拒絕，不會靜默覆蓋', async () => {
    const { storage, load } = await fresh()
    const club = load()
    const raw = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ ...raw, revision: raw.revision + 1 }))
    const repo = tab(storage, new ManualClock(), undefined).store
    expect(() => repo.saveClub({ ...club, onboarding: { ...club.onboarding, watchedLive: true } }, club.revision)).toThrow(ClubSaveError)
  })

  it('寫入旗標不改變任何一場比賽：觀戰、收合後，結算出來的比賽與完全不碰的球團一模一樣', async () => {
    const a = await fresh(1234)
    const b = await fresh(1234)
    a.clock.advance(3 * MINUTE)
    await markWatchedLive(a.deps)
    await setOnboarding(a.deps, { collapsed: true })
    for (const x of [a, b]) {
      x.clock.set(T0 + 2 * HOUR)
      await settleDue(x.deps)
    }
    expect(a.load().recentMatches).toEqual(b.load().recentMatches)
    expect(a.load().economy).toEqual(b.load().economy)
    expect(a.load().league).toEqual(b.load().league)
  })
})

describe('目前建議（規則與優先序）', () => {
  it('新球團沒有任何可執行的操作：建議觀戰，並給出最近的升級目標', async () => {
    const { load } = await fresh()
    const s = suggestNextAction(load(), { canWrite: true })
    expect(s.kind).toBe('watch')
    const cheapest = upgradeCost(1)!
    expect(s.kind === 'watch' && s.goal?.short).toEqual({ funds: cheapest.funds, experience: cheapest.experience })
  })

  it('優先序：領取 > 挑戰 > 培養 > 陣容 > 觀戰（逐一拿掉較高的條件）', async () => {
    const { load } = await fresh()
    const n = Math.max(PROMOTION_CONFIG.window, PROMOTION_CONFIG.minMatches)
    let club = give(load(), 100_000, 5_000)
    club = give(club, 0, 0)
    club = { ...club, league: { ...club.league, matches: n, wins: n, recent: 'W'.repeat(PROMOTION_CONFIG.window) }, idle: { ...club.idle, nextMatchIndex: n } }
    const withUnclaimed = give(club, 10, 1, 'unclaimed')
    expect(eligibility(withUnclaimed.league, withUnclaimed.idle.nextMatchIndex).ok).toBe(true)
    expect(suggestNextAction(withUnclaimed, { canWrite: true }).kind).toBe('claim')
    expect(suggestNextAction(club, { canWrite: true }).kind).toBe('challenge')
    const notEligible = { ...club, league: { ...club.league, challengeReadyAt: n + 3 } }
    expect(suggestNextAction(notEligible, { canWrite: true }).kind).toBe('upgrade')
    const poor = { ...notEligible, economy: { ...notEligible.economy, assets: { funds: 0, experience: 0 } } }
    expect(suggestNextAction(poor, { canWrite: true }).kind).toBe('watch')
  })

  it('不顯示做不到的事：唯讀分頁一律只建議觀戰；資源差一點也不建議升級', async () => {
    const { load } = await fresh()
    const rich = give(give(load(), 100_000, 5_000), 10, 10, 'unclaimed')
    expect(suggestNextAction(rich, { canWrite: false }).kind).toBe('watch')
    const cost = upgradeCost(1)!
    const almost = give(load(), cost.funds, cost.experience - 1)
    expect(upgradeCandidate(almost)).toBeNull()
    expect(suggestNextAction(almost, { canWrite: true }).kind).toBe('watch')
    expect(nearestUpgrade(almost)?.short).toEqual({ funds: 0, experience: 1 })
    expect(upgradeCandidate(give(almost, 0, 1))).not.toBeNull()
  })

  it('培養建議：先發打者與先發投手優先，同組裡等級低的優先', async () => {
    const { load } = await fresh()
    const club = give(load(), 1_000_000, 100_000)
    const pick = upgradeCandidate(club)!
    const core = new Set([...club.roster.lineup.map((s) => s.playerId), club.roster.starter])
    expect(core.has(pick.playerId)).toBe(true)
    const bumped = structuredClone(club)
    for (const r of bumped.players) if (core.has(r.player.id) && r.player.id !== club.roster.starter) r.level = 5
    expect(upgradeCandidate(bumped)!.playerId).toBe(club.roster.starter)
  })

  it('陣容建議：招募來、在預備名單、比上場同類型最弱的人強才建議；換上場後就消失', async () => {
    const { deps, load } = await fresh()
    expect(lineupCandidate(load())).toBeNull()
    const rich = give(load(), 50_000, 0)
    deps.store.saveClub(rich, rich.revision)
    const out = await recruit(deps, { opSeq: load().economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: load().recruitment.count })
    let club = load()
    const strong = structuredClone(club)
    strong.players.find((r) => r.player.id === out.op.playerId)!.level = 20
    const s = lineupCandidate(strong)
    expect(s?.playerId).toBe(out.op.playerId)
    expect(suggestNextAction({ ...strong, economy: { ...strong.economy, assets: { funds: 0, experience: 0 } } }, { canWrite: true }).kind).toBe('lineup')
    // 換上場（替掉一位板凳）之後不再建議
    club = structuredClone(strong)
    club.roster.bench[0] = out.op.playerId
    expect(lineupCandidate(club)).toBeNull()
  })

  it('純函式：不改輸入，同樣的輸入同樣的結果', async () => {
    const { load } = await fresh()
    const club = give(load(), 1_000_000, 100_000)
    const before = JSON.stringify(club)
    expect(suggestNextAction(club, { canWrite: true })).toEqual(suggestNextAction(structuredClone(club), { canWrite: true }))
    expect(JSON.stringify(club)).toBe(before)
  })
})

/** Phase 5B 的程式實際產生的 V7 存檔：168 場、多次領取、升級、招募、換過棒次 */
const v7 = () => structuredClone(fixtureV7) as unknown as Record<string, unknown> & typeof fixtureV7

describe('V7 → V8 遷移', () => {
  it('只加上 onboarding；其他欄位一個字都不動；推導得出的任務直接算完成；打過比賽的球團預設收起', () => {
    const old = v7()
    expect(sourceVersion(old)).toBe(7)
    const club = migrateToLatest(old)
    const { schemaVersion, revision, migratedFrom, onboarding, ...rest } = club
    const { schemaVersion: _s, revision: oldRevision, ...oldRest } = old
    expect({ ...rest, league: v8League(rest.league) }).toEqual(oldRest)
    expect(schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(revision).toBe(oldRevision + 1)
    expect(migratedFrom).toEqual({ schemaVersion: 7, revision: oldRevision })
    expect(onboarding).toEqual({ watchedLive: false, claimedRewards: true, lineupChanged: false, collapsed: true })
    expect(tasks(club)).toEqual({ club: true, watch: false, firstMatch: true, claim: true, upgrade: true, lineup: false })
  })

  it('還沒打過比賽的 V7 球團不收起', () => {
    const old = v7()
    old.idle = { ...old.idle, nextMatchIndex: 0 }
    old.liveMatch = null as never
    old.recentMatches = []
    old.replays = []
    old.record = { wins: 0, losses: 0, runsFor: 0, runsAgainst: 0 }
    old.league = { ...old.league, matches: 0, wins: 0, losses: 0, recent: '' }
    const e = old.economy
    old.economy = { ...e, assets: { funds: 0, experience: 0 }, unclaimed: { funds: 0, experience: 0 }, earned: { funds: 0, experience: 0 }, spent: { funds: 0, experience: 0 }, nextClaimSeq: 0, lastClaim: null as never, nextOpSeq: 0, recentOps: [] }
    old.players = old.players.map((r) => ({ ...r, level: 1 }))
    const club = migrateToLatest(old)
    expect(club.onboarding).toEqual({ watchedLive: false, claimedRewards: false, lineupChanged: false, collapsed: false })
  })

  it('自動遷移：備份到 backup-schema7，之後的比賽照常結算；V1 不受影響（只動 V2 的 key）', async () => {
    const storage = new MemoryStorage()
    const raw = JSON.stringify(fixtureV7)
    storage.setItem(CLUB_STORAGE_KEY, raw)
    storage.setItem('dice-baseball.save', 'v1-untouched')
    const clock = new ManualClock(fixtureV7.idle.anchorMs)
    const deps = tab(storage, clock, new FakeLockManager())
    const { value } = await openClubSafely(deps)
    expect(value.migrated).toBe(true)
    expect(value.club!.schemaVersion).toBe(CLUB_SCHEMA_VERSION)
    expect(storage.getItem(CLUB_BACKUP_KEY_V7)).toBe(raw)
    expect(storage.getItem('dice-baseball.save')).toBe('v1-untouched')
    clock.advance(HOUR)
    const report = await settleDue(deps)
    expect(report.settled[0].matchIndex).toBe(fixtureV7.idle.nextMatchIndex)
  })
})
