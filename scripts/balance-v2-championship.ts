// Phase 10 PR 1：傳奇總冠軍賽的平衡模擬。npm run balance:v2:championship [-- --seeds=6 --days=120 --series=400]
//
// A. 基準（不打冠軍賽）：新球團每天上線 2 次（結算 → 領取 → 特性訓練 → 平均升級 → 有資格就挑戰晉級），
//    記錄到傳奇的天數、到傳奇後第一次符合冠軍資格的天數（積分門檻 0／60／70／80 的對照）、傳奇期間有資格的比例、降級。
//    MVP 成長開／關各跑一次，看 MVP +0.3 會不會過度縮短資格時間。
// B. 冠軍對手強度：用 A 裡「第一次符合資格（積分 ≥ 70）那一刻」的真實球團當「普通球隊」，再做出各種隊伍變化，
//    對 6.6（傳奇一般）、6.85（傳奇的晉級挑戰強度）、6.9、7.1、7.3 的冠軍對手，四種戰術，量單場勝率與七戰四勝奪冠率
// C. 完整遊玩（正式冠軍賽服務）：同樣的新球團一路玩到奪冠，有資格就開始系列賽、一次把七場打完；
//    冠軍隊強度 6.9／7.1／7.3 各跑一次，看第一次奪冠要幾天、要挑戰幾次、有沒有人打不贏
// 全部用固定種子，重跑結果相同
import { RULES_VERSION, type Side } from '../src/sim/game'
import { generateTeam } from '../src/sim/generate'
import { Rng } from '../src/sim/rng'
import { TRAITS, conflicts, type TraitId } from '../src/sim/traits'
import type { Player, Team } from '../src/sim/types'
import { equippedTeam } from '../src/sim/items'
import { COACH_STYLES, type CoachStyle } from '../src/v2/application/autoCoach'
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { startTraining, upgrade } from '../src/v2/application/economyService'
import { challengeNextLeague } from '../src/v2/application/leagueService'
import { runMatch, type MatchAi } from '../src/v2/application/matchRunner'
import { claim, settleDue } from '../src/v2/application/settlementService'
import type { ClubSave } from '../src/v2/domain/club'
import { eligibility, recentWinRate } from '../src/v2/domain/league'
import { MVP_RULES } from '../src/v2/domain/mvp'
import { CHAMPIONSHIP_CONFIG, championshipView } from '../src/v2/domain/championship'
import { playSeriesGame, startSeries } from '../src/v2/application/championshipService'
import { upgradeCost } from '../src/v2/domain/progression'
import { MAX_LEVEL } from '../src/v2/domain/progressionConfig'
import { assignedIds, recordOf, resolveRoster } from '../src/v2/domain/roster'
import { trainingOptions } from '../src/v2/domain/traitTraining'
import { MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../src/v2/testkit'

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const SEEDS = arg('seeds', 6)
const DAYS = arg('days', 120)
const SERIES = arg('series', 400)
const SEED_BASE = arg('seedBase', 701)
const COOLDOWN = arg('cooldown', NaN)
const C_STRENGTHS = process.argv.find((a) => a.startsWith('--strengths='))?.split('=')[1]?.split(',').map(Number)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
type Deps = ReturnType<typeof tab>

// ---------------- 共用：一天兩次上線的經營策略（跟 balance-v2-mvp 相同） ----------------

async function upgradeEvenly(d: Deps): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const c = d.store.loadClub()!
    const rec = [...assignedIds(c.roster)].map((id) => recordOf(c, id)!).filter((r) => r.level < MAX_LEVEL).sort((a, b) => a.level - b.level)[0]
    if (!rec) return
    const cost = upgradeCost(rec.level)!
    if (c.economy.assets.funds < cost.funds || c.economy.assets.experience < cost.experience) return
    await upgrade(d, { opSeq: c.economy.nextOpSeq, playerId: rec.player.id, expectedLevel: rec.level })
  }
}
async function trainSomething(d: Deps): Promise<void> {
  const c = d.store.loadClub()!
  if (c.training.active) return
  for (const id of [...c.roster.lineup.map((x) => x.playerId), c.roster.starter]) {
    const o = trainingOptions(c.clubSeed, recordOf(c, id)!, { active: null, assets: c.economy.assets }).find((x) => x.block === null && x.cls !== 'rare')
    if (o) {
      await startTraining(d, { opSeq: c.economy.nextOpSeq, playerId: id, trait: o.trait, kind: o.kind })
      return
    }
  }
}
/** 一次上線：結算、領取、訓練、升級、有資格就挑戰晉級 */
async function login(d: Deps, clock: ManualClock, hours: number): Promise<void> {
  clock.advance(hours * HOUR)
  await settleDue(d)
  await claim(d, d.store.loadClub()!.economy.nextClaimSeq)
  await trainSomething(d)
  await upgradeEvenly(d)
  const c = d.store.loadClub()!
  if (eligibility(c.league, c.idle.nextMatchIndex).ok) await challengeNextLeague(d, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
}

// ---------------- A. 基準 ----------------

const POINT_GATES = [0, 60, 70, 80]
/** 傳奇、本聯盟 ≥ 100 場、最近 60 場 ≥ 60%、積分 ≥ gate（冠軍資格的候選規則；不含冷卻） */
const qualifies = (c: ClubSave, gate: number) => c.league.tier === 4 && c.league.matches >= 100 && c.league.recent.length >= 60 && recentWinRate(c.league) >= 0.6 && (c.league.points ?? 0) >= gate

interface BaseRun {
  seed: number
  legendDay: number | null
  firstEligible: Record<number, number | null>
  /** 到傳奇之後，每次上線時符合資格（積分 ≥ 70）的比例 */
  eligibleShare: number
  relegationsAfterLegend: number
  /** 第一次符合資格（積分 ≥ 70）那一刻的球團 */
  snapshot: ClubSave | null
  /** 是否在剛晉級傳奇時就符合（不可能：本聯盟場次歸零） */
  eligibleAtPromotion: boolean
}

async function baseRun(seed: number, growth: boolean, days: number): Promise<BaseRun> {
  MVP_RULES.growth = growth
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: '基準隊', clubSeed: seed, clubId: `base-${seed}` })
  const run: BaseRun = { seed, legendDay: null, firstEligible: Object.fromEntries(POINT_GATES.map((g) => [g, null])), eligibleShare: 0, relegationsAfterLegend: 0, snapshot: null, eligibleAtPromotion: false }
  let legendLogins = 0
  let eligibleLogins = 0
  let relegationsAtLegend = 0
  for (let s = 0; s < days * 2; s++) {
    await login(d, clock, 12)
    const day = (s + 1) / 2
    const c = d.store.loadClub()!
    if (run.legendDay === null && c.league.tier === 4) {
      run.legendDay = day
      relegationsAtLegend = c.league.relegations
      run.eligibleAtPromotion = qualifies(c, 70)
    }
    if (run.legendDay !== null) {
      legendLogins++
      if (qualifies(c, 70)) eligibleLogins++
      for (const g of POINT_GATES) if (run.firstEligible[g] === null && qualifies(c, g)) run.firstEligible[g] = day
      if (!run.snapshot && qualifies(c, 70)) run.snapshot = structuredClone(c)
    }
  }
  const c = d.store.loadClub()!
  run.eligibleShare = legendLogins ? eligibleLogins / legendLogins : 0
  run.relegationsAfterLegend = run.legendDay === null ? 0 : c.league.relegations - relegationsAtLegend
  MVP_RULES.growth = true
  return run
}

async function partA(): Promise<BaseRun[]> {
  console.log(`\n# A. 基準：到傳奇與冠軍資格的時間（${SEEDS} 個球團種子 ${SEED_BASE}～、每天上線 2 次、${DAYS} 天、有特性訓練）\n`)
  console.log('資格候選：傳奇、本聯盟 ≥ 100 場、最近 60 場勝率 ≥ 60%、積分 ≥ 門檻。「到資格」是到傳奇之後再過幾天。\n')
  console.log('| MVP 成長 | 種子 | 到傳奇（天） | 到資格：積分 ≥ 0 | ≥ 60 | **≥ 70** | ≥ 80 | 傳奇期間有資格的比例（≥ 70） | 到傳奇後降級 | 晉級當下就有資格 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  const keep: BaseRun[] = []
  for (const growth of [false, true]) {
    const runs: BaseRun[] = []
    for (let i = 0; i < SEEDS; i++) runs.push(await baseRun(SEED_BASE + i * 97, growth, DAYS))
    for (const r of runs) {
      const after = (g: number) => (r.legendDay !== null && r.firstEligible[g] !== null ? f1(r.firstEligible[g]! - r.legendDay) : '—')
      console.log(`| ${growth ? '+0.3' : '關'} | ${r.seed} | ${r.legendDay ?? '—'} | ${after(0)} | ${after(60)} | ${after(70)} | ${after(80)} | ${r.legendDay !== null ? pct(r.eligibleShare) : '—'} | ${r.relegationsAfterLegend} | ${r.eligibleAtPromotion ? '是' : '否'} |`)
    }
    const reached = runs.filter((r) => r.legendDay !== null)
    const gap = (g: number) => reached.filter((r) => r.firstEligible[g] !== null).map((r) => r.firstEligible[g]! - r.legendDay!)
    console.log(
      `| ${growth ? '+0.3' : '關'} | **平均** | ${f1(avg(reached.map((r) => r.legendDay!)))}（${reached.length}/${runs.length}） | ${f1(avg(gap(0)))} | ${f1(avg(gap(60)))} | **${f1(avg(gap(70)))}**（${gap(70).length}/${reached.length}） | ${f1(avg(gap(80)))}（${gap(80).length}/${reached.length}） | ${pct(avg(reached.map((r) => r.eligibleShare)))} | ${reached.reduce((a, r) => a + r.relegationsAfterLegend, 0)} | ${reached.some((r) => r.eligibleAtPromotion) ? '有' : '沒有'} |`,
    )
    if (growth) keep.push(...runs)
  }
  return keep
}

// ---------------- B. 冠軍對手強度 ----------------

const batters = (t: Team) => [...t.roster.lineup.map((s) => s.player), ...t.roster.bench]
const bump = (ps: Player[], keys: string[], add: number) => {
  for (const p of ps) for (const k of keys) (p.ratings as unknown as Record<string, number>)[k] = Math.min(10, (p.ratings as unknown as Record<string, number>)[k] + add)
}
const BEST: Record<'batter' | 'pitcher', TraitId[]> = { batter: ['slugger', 'eye', 'lineDrive', 'clutch', 'baserunner', 'stealer'], pitcher: ['escapeArtist', 'strikeoutArtist', 'groundballer', 'closer'] }

/** 隊伍變化：從真實球團（第一次有資格時）出發 */
type Variant = { name: string; club: (c: ClubSave) => ClubSave; team?: (t: Team) => void }
const VARIANTS: Variant[] = [
  { name: '普通（第一次有資格時的真實球團）', club: (c) => c },
  { name: '高長打（打者力量 +1）', club: (c) => c, team: (t) => bump(batters(t), ['power'], 1) },
  { name: '高速度（打者速度 +1）', club: (c) => c, team: (t) => bump(batters(t), ['speed'], 1) },
  { name: '強先發（球威、控球 +1）', club: (c) => c, team: (t) => bump([t.roster.starter], ['stuff', 'control'], 1) },
  { name: '強後援（後援球威、控球 +1）', club: (c) => c, team: (t) => bump(t.roster.relievers, ['stuff', 'control'], 1) },
  { name: 'Lv.20（全員滿級）', club: (c) => ({ ...c, players: c.players.map((r) => ({ ...r, level: MAX_LEVEL })) }) },
  {
    name: '三個正面特性（先發都練滿）',
    club: (c) => c,
    team: (t) => {
      for (const p of [...t.roster.lineup.map((s) => s.player), t.roster.starter]) {
        const picked: TraitId[] = p.traits.filter((x) => TRAITS[x].tier !== 'red').slice(0, 3)
        for (const tr of BEST[p.role]) if (picked.length < 3 && !picked.includes(tr) && !picked.some((x) => conflicts(x, tr)) && TRAITS[tr].role === p.role) picked.push(tr)
        p.traits = picked
      }
    },
  },
  // 第一次有資格時大家幾乎都已經有 +0.3（見下表），所以反過來量：拿掉 MVP 加成差多少
  { name: '沒有 MVP 加成（拿掉 +0.3）', club: (c) => ({ ...c, players: c.players.map((r) => ({ ...r, mvp: undefined })) }) },
]
const STRENGTHS = [6.6, 6.85, 6.9, 7.1, 7.3]

/** 一場冠軍級比賽：我方是球團的有效陣容（＋變化），對手是給定強度的生成球隊 */
function play(club: ClubSave, v: Variant, oppMean: number, style: CoachStyle, i: number): boolean {
  const c = v.club(club)
  const ours = equippedTeam({ name: c.clubName, roster: structuredClone(resolveRoster(c)) })
  v.team?.(ours)
  const opp = generateTeam(new Rng(880_000 + (i % 25)), oppMean)
  const userSide: Side = i % 2 ? 'away' : 'home'
  const other: Side = userSide === 'home' ? 'away' : 'home'
  const setup = { home: userSide === 'home' ? ours : opp, away: userSide === 'away' ? ours : opp, seed: 990_000 + i, userSide, rules: RULES_VERSION }
  return runMatch(setup, { [userSide]: { kind: 'autoCoach', style }, [other]: { kind: 'builtin' } } as MatchAi).winner === userSide
}

/** 單場勝率 p 的七戰四勝奪冠機率（每場獨立） */
function seriesWin(p: number): number {
  let total = 0
  // 在第 4+k 場拿到第 4 勝：前 3+k 場剛好 3 勝 k 敗，第 4+k 場贏
  const C = (n: number, k: number) => {
    let r = 1
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
    return r
  }
  for (let k = 0; k <= 3; k++) total += C(3 + k, k) * p ** 4 * (1 - p) ** k
  return total
}

function partB(snaps: ClubSave[]): void {
  const n = SERIES
  console.log(`\n# B. 冠軍對手強度（我方：${snaps.length} 個種子第一次有資格時的真實球團；每格 ${n} 場 × 種子；對手 25 種固定陣容輪替）\n`)
  console.log('七戰四勝奪冠率由單場勝率換算（每場獨立）。6.6 是傳奇一般對手，6.85 是傳奇的晉級挑戰強度（職業 → 傳奇）。\n')
  console.log(`| 隊伍 | ${STRENGTHS.map((s) => `${s} 單場／系列`).join(' | ')} |`)
  console.log(`|---|${STRENGTHS.map(() => '---|').join('')}`)
  for (const v of VARIANTS) {
    const cells: string[] = []
    for (const s of STRENGTHS) {
      let w = 0
      let g = 0
      for (const club of snaps) for (let i = 0; i < Math.round(n / snaps.length); i++) (w += play(club, v, s, club.strategy.coach.style, i) ? 1 : 0, g++)
      const p = w / g
      cells.push(`${pct(p)}／${pct(seriesWin(p))}`)
    }
    console.log(`| ${v.name} | ${cells.join(' | ')} |`)
  }
  console.log('\n## 四種戰術（普通球隊）\n')
  console.log(`| 戰術 | ${STRENGTHS.map((s) => `${s} 單場／系列`).join(' | ')} |`)
  console.log(`|---|${STRENGTHS.map(() => '---|').join('')}`)
  for (const style of COACH_STYLES) {
    const cells: string[] = []
    for (const s of STRENGTHS) {
      let w = 0
      let g = 0
      for (const club of snaps) for (let i = 0; i < Math.round(n / snaps.length); i++) (w += play(club, VARIANTS[0], s, style, i) ? 1 : 0, g++)
      cells.push(`${pct(w / g)}／${pct(seriesWin(w / g))}`)
    }
    console.log(`| ${style} | ${cells.join(' | ')} |`)
  }
  console.log('\n## 第一次有資格時的球團\n')
  console.log('| 種子 | 天（建立後） | 平均等級 | 上場平均能力 | 正面特性（先發） | MVP 加成（上場平均） | 戰術 |')
  console.log('|---|---|---|---|---|---|---|')
  for (const c of snaps) {
    const act = [...assignedIds(c.roster)].map((id) => recordOf(c, id)!)
    const roster = resolveRoster(c)
    const all = [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]
    const ovr = avg(all.map((p) => avg(Object.values(p.ratings as unknown as Record<string, number>))))
    const pos = [...roster.lineup.map((s) => s.player), roster.starter].reduce((a, p) => a + p.traits.filter((t) => TRAITS[t].tier !== 'red').length, 0)
    console.log(`| ${c.clubSeed} | ${(c.idle.nextMatchIndex / 288).toFixed(1)} | ${f1(avg(act.map((r) => r.level)))} | ${ovr.toFixed(2)} | ${pos}／10 人 | +${(avg(act.map((r) => r.mvp?.grants.length ?? 0)) / 10).toFixed(2)} | ${c.strategy.coach.style} |`)
  }
}

// ---------------- C. 完整遊玩 ----------------

interface FullRun {
  seed: number
  legendDay: number | null
  eligibleDay: number | null
  titleDay: number | null
  attempts: number
  series: string[]
  titles: number
}

async function fullRun(seed: number, days: number): Promise<FullRun> {
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: '冠軍隊', clubSeed: seed, clubId: `full-${seed}` })
  const run: FullRun = { seed, legendDay: null, eligibleDay: null, titleDay: null, attempts: 0, series: [], titles: 0 }
  for (let s = 0; s < days * 2; s++) {
    await login(d, clock, 12)
    const day = (s + 1) / 2
    let c = d.store.loadClub()!
    if (run.legendDay === null && c.league.tier === 4) run.legendDay = day
    const v = championshipView(c)
    if (v.status !== 'eligible') continue
    run.eligibleDay ??= day
    const seq = v.nextSeriesSeq
    await startSeries(d, { seriesSeq: seq, requestId: `s${seq}` })
    run.attempts++
    while ((c = d.store.loadClub()!).championship.active) {
      const out = await playSeriesGame(d, { seriesSeq: seq, game: c.championship.active.games.length + 1, requestId: `g${seq}` })
      if (out.completed) run.series.push(`${out.completed.wins}:${out.completed.losses}`)
    }
    if (run.titleDay === null && d.store.loadClub()!.championship.titles > 0) run.titleDay = day
  }
  run.titles = d.store.loadClub()!.championship.titles
  return run
}

async function partC(): Promise<void> {
  console.log(`\n# C. 完整遊玩：新球團到第一次奪冠（${SEEDS} 個種子 ${SEED_BASE}～、每天上線 2 次、${DAYS} 天、MVP 成長開、有資格就打完整個系列賽）\n`)
  console.log(`冷卻：系列賽結束後 ${Number.isFinite(COOLDOWN) ? COOLDOWN : CHAMPIONSHIP_CONFIG.retryAfterMatches} 場一般比賽。\n`)
  const mutable = CHAMPIONSHIP_CONFIG as { opponentMean: number; retryAfterMatches: number }
  const original = mutable.opponentMean
  if (Number.isFinite(COOLDOWN)) mutable.retryAfterMatches = COOLDOWN
  const summary: string[] = []
  for (const mean of C_STRENGTHS ?? STRENGTHS.filter((x) => x >= 6.9)) {
    mutable.opponentMean = mean
    console.log(`\n## 冠軍隊 ${mean}\n`)
    console.log('| 種子 | 到傳奇 | 第一次有資格 | 第一次奪冠 | 奪冠前挑戰次數 | 系列賽比分 | 冠軍次數 |')
    console.log('|---|---|---|---|---|---|---|')
    const runs: FullRun[] = []
    for (let i = 0; i < SEEDS; i++) {
      const r = await fullRun(SEED_BASE + i * 97, DAYS)
      runs.push(r)
      const before = r.titleDay === null ? r.attempts : r.series.findIndex((x) => x.startsWith('4:')) + 1
      console.log(`| ${r.seed} | ${r.legendDay ?? '—'} | ${r.eligibleDay ?? '—'} | ${r.titleDay ?? '—'} | ${before} | ${r.series.join('、') || '—'} | ${r.titles} |`)
    }
    const within = (n: number) => runs.filter((r) => r.titleDay !== null && r.titleDay <= n).length
    const won = runs.filter((r) => r.titleDay !== null)
    const all = runs.flatMap((r) => r.series)
    const seriesWins = all.filter((x) => x.startsWith('4:')).length
    summary.push(
      `| ${mean} | ${f1(avg(won.map((r) => r.titleDay!)))}（${won.length}/${runs.length}） | ${within(30)}／${within(60)}／${within(90)}／${within(DAYS)} | ${f1(avg(won.map((r) => r.series.findIndex((x) => x.startsWith('4:')) + 1)))} | ${pct(all.length ? seriesWins / all.length : NaN)}（${seriesWins}/${all.length}） | ${f1(avg(won.map((r) => r.titleDay! - r.eligibleDay!)))} |`,
    )
  }
  mutable.opponentMean = original
  console.log('\n## 總結\n')
  console.log(`| 冠軍隊 | 第一次奪冠（天，平均） | 30／60／90／${DAYS} 天內奪冠的球團 | 奪冠前挑戰次數（平均） | 系列賽勝率 | 第一次有資格 → 奪冠（天） |`)
  console.log('|---|---|---|---|---|---|')
  for (const l of summary) console.log(l)
}

// ---------------- P. 效能與存檔大小 ----------------

async function partP(): Promise<void> {
  const { default: fixture } = await import('../src/v2/domain/__fixtures__/club-v13-phase9.json')
  const { migrateToLatest } = await import('../src/v2/domain/migration')
  const { CLUB_STORAGE_KEY } = await import('../src/v2/infrastructure/clubRepository')
  const raw13 = JSON.stringify(fixture)
  const v14 = migrateToLatest(JSON.parse(raw13))
  const single: number[] = []
  const series: number[] = []
  let maxSize = 0
  let size14 = 0
  for (let rep = 0; rep < 10; rep++) {
    const storage = new MemoryStorage()
    storage.setItem(CLUB_STORAGE_KEY, JSON.stringify({ ...v14, championship: { ...v14.championship, nextSeriesSeq: rep } }))
    size14 = storage.getItem(CLUB_STORAGE_KEY)!.length
    const d = tab(storage, new ManualClock(v14.idle.anchorMs), new FakeLockManager())
    const t0 = performance.now()
    await startSeries(d, { seriesSeq: rep })
    let n = 0
    while (d.store.loadClub()!.championship.active) {
      const t = performance.now()
      await playSeriesGame(d, { seriesSeq: rep, game: ++n })
      single.push(performance.now() - t)
      maxSize = Math.max(maxSize, storage.getItem(CLUB_STORAGE_KEY)!.length)
    }
    series.push(performance.now() - t0)
  }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
  console.log('\n# P. 效能與存檔大小（V13 fixture 遷移後：傳奇、3,167 場、13 位有 MVP、訓練中；10 個系列賽）\n')
  console.log('| 項目 | 數值 |')
  console.log('|---|---|')
  console.log(`| 單場冠軍賽（含鎖、結算檢查、模擬、存檔），中位數／最大 | ${med(single).toFixed(1)} ms／${Math.max(...single).toFixed(1)} ms（${single.length} 場） |`)
  console.log(`| 一個系列賽（開始 + 打到分出勝負），中位數 | ${med(series).toFixed(1)} ms |`)
  console.log(`| V13 存檔 | ${(raw13.length / 1024).toFixed(1)} KB |`)
  console.log(`| V14 存檔（遷移後，沒有冠軍賽） | ${(size14 / 1024).toFixed(1)} KB（+${size14 - raw13.length} bytes） |`)
  console.log(`| V14 存檔（系列賽中，最大） | ${(maxSize / 1024).toFixed(1)} KB（+${((maxSize - size14) / 1024).toFixed(1)} KB：冠軍隊 + 最近一場 Replay） |`)
}

async function baseline(): Promise<void> {
  const runs = await partA()
  const snaps = runs.map((r) => r.snapshot).filter((x): x is ClubSave => x !== null)
  if (!process.argv.includes('--skipB')) partB(snaps)
}

const only = process.argv.find((a) => a.startsWith('--part='))?.split('=')[1] ?? 'ABC'
if (process.argv.includes('--baseline')) await baseline()
else {
  console.log(`規則版本 ${RULES_VERSION}；冠軍隊目前設定 ${CHAMPIONSHIP_CONFIG.opponentMean}`)
  if (only.includes('A') || only.includes('B')) {
    const runs = only.includes('A') || only.includes('B') ? await partA() : []
    if (only.includes('B')) partB(runs.map((r) => r.snapshot).filter((x): x is ClubSave => x !== null))
  }
  if (only.includes('C')) await partC()
  if (only.includes('P')) await partP()
}
