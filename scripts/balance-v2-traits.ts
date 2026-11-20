// Phase 9 PR 3：特性訓練的平衡模擬。npm run balance:v2:traits [-- --games=1000 --days=45 --seeds=3]
//
// A. 特性的效益（同種子對照）：同一支球隊、同一組對手與比賽種子，只讓一位球員多一個特性（或去掉一個負面特性），
//    看勝率與得失分的差。打者放在第 3 棒（每場 4～5 個打席），投手是先發投手；另外比較 Lv.1 與 Lv.20 球員、四種戰術風格。
// B. 長期遊玩（正式服務：結算 → 領取 → 開始訓練 → 升級 → 晉級挑戰）：每天上線 1／2／6 次（每次離線最多算 8 小時），
//    比較「只升級」與「升級＋特性訓練」：訓練完成所需的真實時間、資金與經驗的去向、到達傳奇聯盟的天數、最後 7 天勝率、
//    正面特性數、碰到上限的人數、累積場數（500～1,000 場以上）。
import { generateTeam } from '../src/sim/generate'
import { RULES_VERSION, type Side } from '../src/sim/game'
import { Rng } from '../src/sim/rng'
import { TRAITS, type TraitId } from '../src/sim/traits'
import type { Batter, Pitcher, Team } from '../src/sim/types'
import { COACH_STYLES, type CoachStyle } from '../src/v2/application/autoCoach'
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { canAfford, startTraining, upgrade } from '../src/v2/application/economyService'
import { challengeNextLeague } from '../src/v2/application/leagueService'
import { runMatch, type MatchAi } from '../src/v2/application/matchRunner'
import { claim, settleDue } from '../src/v2/application/settlementService'
import type { ClubSave } from '../src/v2/domain/club'
import { eligibility } from '../src/v2/domain/league'
import { leveled, upgradeCost } from '../src/v2/domain/progression'
import { MAX_LEVEL } from '../src/v2/domain/progressionConfig'
import { assignedIds, recordOf } from '../src/v2/domain/roster'
import { TRAINING_CONFIG, TRAINING_RULES, effectiveTraits, positiveCount, trainingOptions, type TrainingOption } from '../src/v2/domain/traitTraining'
import { conflicts } from '../src/sim/traits'
import { MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../src/v2/testkit'

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const GAMES = arg('games', 1000)
const DAYS_DEFAULT = arg('days', 45)
const DAYS = DAYS_DEFAULT
const SEEDS = arg('seeds', 3)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const sgn = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`

// ---------------- A. 特性的效益 ----------------

interface Cell {
  wins: number
  rs: number
  ra: number
  games: number
}
function play(mutate: (t: Team) => void, style: CoachStyle = 'balanced', games = GAMES): Cell {
  const c: Cell = { wins: 0, rs: 0, ra: 0, games: 0 }
  for (let i = 0; i < games; i++) {
    const ours = generateTeam(new Rng(7000 + (i % 50)), 5.8)
    mutate(ours)
    const opp = generateTeam(new Rng(90_000 + i), 5.8)
    const userSide: Side = i % 2 ? 'away' : 'home'
    const other: Side = userSide === 'home' ? 'away' : 'home'
    const setup = { home: userSide === 'home' ? ours : opp, away: userSide === 'away' ? ours : opp, seed: 50_000 + i, userSide, rules: RULES_VERSION }
    const r = runMatch(setup, { [userSide]: { kind: 'autoCoach', style }, [other]: { kind: 'builtin' } } as MatchAi)
    c.games++
    c.rs += r.score[userSide]
    c.ra += r.score[other]
    if (r.winner === userSide) c.wins++
  }
  return c
}
/** 第 3 棒（或先發投手）：換成「沒有任何特性」的版本，再依需要加上要測的特性 */
const third = (t: Team) => t.roster.lineup[2].player
const clean = (t: Team) => {
  third(t).traits = []
  t.roster.starter.traits = []
}
const withTrait = (trait: TraitId, level = 1) => (t: Team) => {
  // 跟基準一樣：第 3 棒與先發投手都升到同一級，只差在特性
  plain(level)(t)
  const p = TRAITS[trait].role === 'batter' ? third(t) : t.roster.starter
  p.traits = [trait]
}
const plain = (level = 1) => (t: Team) => {
  clean(t)
  if (level > 1) {
    Object.assign(third(t), { ratings: leveled(third(t) as Batter, level).ratings })
    Object.assign(t.roster.starter, { ratings: leveled(t.roster.starter as Pitcher, level).ratings })
  }
}

function partA(): Map<TraitId, number> {
  const base = play(plain())
  const value = new Map<TraitId, number>()
  console.log(`# A. 特性的效益（每格 ${GAMES} 場，同一組種子；第 3 棒或先發投手多一個特性，其他人不變）\n`)
  console.log(`基準（沒有特性）：勝率 ${pct(base.wins / base.games)}、得分 ${(base.rs / base.games).toFixed(2)}、失分 ${(base.ra / base.games).toFixed(2)}\n`)
  console.log('| 特性 | 等級 | 角色 | 訓練類別 | 勝率差 | 得分差／場 | 失分差／場 | 負面特性：改善＝勝率差取反 |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const t of Object.keys(TRAITS) as TraitId[]) {
    const c = play(withTrait(t))
    const dw = (c.wins - base.wins) / base.games
    value.set(t, TRAITS[t].tier === 'red' ? -dw : dw)
    const cls = TRAITS[t].tier === 'red' ? '改善' : TRAITS[t].tier === 'gold' ? '稀有' : '一般'
    console.log(`| ${t} | ${TRAITS[t].tier} | ${TRAITS[t].role === 'batter' ? '打者' : '投手'} | ${cls} | ${sgn(dw * 100)} | ${sgn((c.rs - base.rs) / base.games, 3)} | ${sgn((c.ra - base.ra) / base.games, 3)} | ${TRAITS[t].tier === 'red' ? sgn(-dw * 100) : ''} |`)
  }
  // Lv.1 與 Lv.20：同一個特性加在不同強度的球員身上
  console.log('\n## Lv.1 與 Lv.20 球員的同一個特性（勝率差；訓練成本相同）\n')
  console.log('| 特性 | Lv.1 | Lv.20 |')
  console.log('|---|---|---|')
  const b20 = play(plain(20))
  for (const t of ['slugger', 'stealer', 'eye', 'strikeoutArtist', 'ironArm'] as TraitId[]) {
    const a = (play(withTrait(t)).wins - base.wins) / base.games
    const b = (play(withTrait(t, 20)).wins - b20.wins) / b20.games
    console.log(`| ${t} | ${sgn(a * 100)} | ${sgn(b * 100)} |`)
  }
  // 戰術風格：跑壘、長打相關的特性在不同風格下的效益
  console.log('\n## 四種戰術風格下的效益（勝率差）\n')
  console.log(`| 特性 | ${COACH_STYLES.join(' | ')} |`)
  console.log(`|---|${COACH_STYLES.map(() => '---').join('|')}|`)
  const baseByStyle = new Map(COACH_STYLES.map((s) => [s, play(plain(), s, GAMES / 2)]))
  for (const t of ['stealer', 'baserunner', 'bunter', 'slugger', 'ironArm'] as TraitId[]) {
    const cells = COACH_STYLES.map((s) => {
      const b = baseByStyle.get(s)!
      return sgn(((play(withTrait(t), s, GAMES / 2).wins - b.wins) / b.games) * 100)
    })
    console.log(`| ${t} | ${cells.join(' | ')} |`)
  }
  return value
}

// ---------------- B. 長期遊玩 ----------------

type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!

async function upgradeEvenly(d: Deps): Promise<number> {
  let spent = 0
  for (let guard = 0; guard < 500; guard++) {
    const c = load(d)
    const ids = assignedIds(c.roster)
    const target = c.players.filter((r) => ids.has(r.player.id) && r.level < MAX_LEVEL).sort((a, b) => a.level - b.level)[0]
    if (!target) return spent
    const cost = upgradeCost(target.level)!
    if (!canAfford(c, cost)) return spent
    await upgrade(d, { opSeq: c.economy.nextOpSeq, playerId: target.player.id, expectedLevel: target.level })
    spent += cost.funds
  }
  return spent
}

/** 選訓練：上場的先發（第 1～9 棒、先發投手）能訓練的項目裡，A 的效益最高的那一項 */
function pickTraining(c: ClubSave, value: Map<TraitId, number>): { id: string; option: TrainingOption } | null {
  const regulars = [...c.roster.lineup.map((s) => s.playerId), c.roster.starter]
  let best: { id: string; option: TrainingOption; v: number } | null = null
  for (const id of regulars) {
    for (const o of trainingOptions(c.clubSeed, recordOf(c, id)!, { active: c.training.active, assets: c.economy.assets })) {
      if (o.block) continue
      const v = (value.get(o.trait) ?? 0) / (o.cost.funds + o.cost.experience * 8)
      if (!best || v > best.v) best = { id, option: o, v }
    }
  }
  return best
}

interface RunLog {
  matches: number
  legendDay: number | null
  last7: { w: number; g: number }
  all: { w: number; g: number }
  trainings: { kind: string; started: number; done: number | null; matchesTaken: number | null }[]
  trainFunds: number
  trainExp: number
  upgradeFunds: number
  positives: number
  capped: number
  settleMs: number[]
}

async function longRun(seed: number, perDay: number, train: boolean, value: Map<TraitId, number>, opts: { days?: number; style?: CoachStyle; snapshots?: number[]; onSnap?: (day: number, c: ClubSave, log: RunLog) => void } = {}): Promise<RunLog> {
  const DAYS = opts.days ?? DAYS_DEFAULT
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'balance', clubSeed: seed, clubId: `bal-${seed}` })
  if (opts.style && opts.style !== 'balanced') {
    const c = load(d)
    d.store.saveClub({ ...c, strategy: { ...c.strategy, coach: { style: opts.style } } }, c.revision)
  }
  const log: RunLog = { matches: 0, legendDay: null, last7: { w: 0, g: 0 }, all: { w: 0, g: 0 }, trainings: [], trainFunds: 0, trainExp: 0, upgradeFunds: 0, positives: 0, capped: 0, settleMs: [] }
  const step = (24 * HOUR) / perDay
  for (let s = 0; s < DAYS * perDay; s++) {
    clock.advance(step)
    const day = (s + 1) / perDay
    const t0 = performance.now()
    const r = await settleDue(d)
    log.settleMs.push(performance.now() - t0)
    log.matches += r.settled.length
    if (day > DAYS - 7) for (const m of r.settled) (log.last7.g++, m.result.won && log.last7.w++)
    for (const m of r.settled) (log.all.g++, m.result.won && log.all.w++)
    // 完成的訓練
    for (const t of log.trainings) {
      if (t.done === null) {
        const recent = load(d).training.recent.find((x) => x.completedAtMatch >= t.started && !log.trainings.some((y) => y !== t && y.done === x.completedAtMatch))
        if (recent && !load(d).training.active) {
          t.done = recent.completedAtMatch
          t.matchesTaken = recent.completedAtMatch - t.started + 1
        }
      }
    }
    await claim(d, load(d).economy.nextClaimSeq)
    if (train && !load(d).training.active) {
      const c = load(d)
      const pick = pickTraining(c, value)
      if (pick) {
        await startTraining(d, { opSeq: c.economy.nextOpSeq, playerId: pick.id, trait: pick.option.trait, kind: pick.option.kind })
        log.trainFunds += pick.option.cost.funds
        log.trainExp += pick.option.cost.experience
        log.trainings.push({ kind: pick.option.cls, started: load(d).training.active!.startedAtMatch, done: null, matchesTaken: null })
      }
    }
    log.upgradeFunds += await upgradeEvenly(d)
    const c = load(d)
    if (eligibility(c.league, c.idle.nextMatchIndex).ok) await challengeNextLeague(d, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
    if (log.legendDay === null && load(d).league.tier === 4) log.legendDay = day
    if (opts.onSnap && Number.isInteger(day) && opts.snapshots?.includes(day)) opts.onSnap(day, load(d), log)
  }
  const c = load(d)
  const active = [...assignedIds(c.roster)].map((id) => recordOf(c, id)!)
  log.positives = active.reduce((n, r) => n + positiveCount(r), 0) / active.length
  log.capped = active.filter((r) => positiveCount(r) >= TRAINING_RULES.maxPositive).length
  return log
}

async function partB(value: Map<TraitId, number>): Promise<void> {
  console.log(`\n# B. 長期遊玩（${DAYS} 天、${SEEDS} 個球團種子取平均；每次上線：結算 → 領取 →（開始訓練）→ 平均升級上場球員 → 有資格就挑戰）\n`)
  console.log('訓練策略：訓練槽空著就挑「A 的勝率效益 ÷ 成本」最高、而且付得起的一項，只訓練每天上場的先發（第 1～9 棒、先發投手）。\n')
  console.log('| 每天上線 | 策略 | 場數 | 到傳奇（天） | 最後 7 天勝率 | 完成訓練 | 一般／稀有／改善 平均場數（真實時間） | 訓練花費（資金／經驗） | 升級花費（資金） | 上場球員平均正面特性 | 正面特性已滿的人 | 單次結算 P50／P90／最大（ms） |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const perDay of [1, 2, 6]) {
    for (const train of [false, true]) {
      const logs: RunLog[] = []
      for (let s = 0; s < SEEDS; s++) logs.push(await longRun(301 + s * 101, perDay, train, value))
      const avg = (f: (l: RunLog) => number) => logs.reduce((n, l) => n + f(l), 0) / logs.length
      const legend = logs.map((l) => l.legendDay).filter((x): x is number => x !== null)
      const all = logs.flatMap((l) => l.trainings)
      const done = all.filter((t) => t.matchesTaken !== null)
      const byKind = (k: string) => {
        const xs = done.filter((t) => t.kind === k).map((t) => t.matchesTaken!)
        return xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)} 場（${((xs.reduce((a, b) => a + b, 0) / xs.length) / 12).toFixed(1)} h）` : '—'
      }
      const ms = logs.flatMap((l) => l.settleMs).sort((a, b) => a - b)
      const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))].toFixed(0)
      console.log(
        `| ${perDay} | ${train ? '升級＋訓練' : '只升級'} | ${avg((l) => l.matches).toFixed(0)} | ${legend.length ? `${(legend.reduce((a, b) => a + b, 0) / legend.length).toFixed(1)}（${legend.length}/${SEEDS}）` : '—'} | ${pct(avg((l) => l.last7.w / Math.max(1, l.last7.g)))} | ${(done.length / SEEDS).toFixed(1)} | ${byKind('common')}／${byKind('rare')}／${byKind('improve')} | ${avg((l) => l.trainFunds).toFixed(0)}／${avg((l) => l.trainExp).toFixed(0)} | ${avg((l) => l.upgradeFunds).toFixed(0)} | ${avg((l) => l.positives).toFixed(2)} | ${avg((l) => l.capped).toFixed(1)} | ${q(0.5)}／${q(0.9)}／${ms.at(-1)!.toFixed(0)} |`,
      )
    }
  }
}

// ---------------- C. 正面特性上限的方案比較（PR #22 review） ----------------

interface Scenario {
  name: string
  cap: number
  config: typeof TRAINING_CONFIG
}
const BASE_CONFIG = structuredClone(TRAINING_CONFIG)
const SCENARIOS: Scenario[] = [
  { name: 'A：上限 2、現行成本', cap: 2, config: structuredClone(BASE_CONFIG) },
  { name: 'B：上限 3、現行成本', cap: 3, config: structuredClone(BASE_CONFIG) },
  { name: 'C：上限 3、稀有成本提高', cap: 3, config: { ...structuredClone(BASE_CONFIG), rare: { cost: { funds: 24000, experience: 4000 }, appearances: 700 } } },
]
function applyScenario(sc: Scenario | null): void {
  const cfg = sc?.config ?? BASE_CONFIG
  for (const k of Object.keys(cfg) as (keyof typeof TRAINING_CONFIG)[]) TRAINING_CONFIG[k] = structuredClone(cfg[k])
  TRAINING_RULES.maxPositive = sc?.cap ?? 3
}

interface Snap {
  positives: number
  native2: number
  native2Grew: number
  capped: number
  winLast7: number
  trainFunds: number
  trainExp: number
  upgradeFunds: number
  done: Record<string, number>
}
function snapOf(c: ClubSave, log: RunLog, w7: { w: number; g: number }): Snap {
  const active = [...assignedIds(c.roster)].map((id) => recordOf(c, id)!)
  const nativePos = (r: (typeof active)[number]) => r.player.traits.filter((t) => TRAITS[t].tier !== 'red').length
  const n2 = active.filter((r) => nativePos(r) >= 2)
  const done: Record<string, number> = { common: 0, rare: 0, improve: 0 }
  for (const t of log.trainings) if (t.done !== null) done[t.kind]++
  return {
    positives: active.reduce((n, r) => n + positiveCount(r), 0) / active.length,
    native2: n2.length,
    native2Grew: n2.filter((r) => positiveCount(r) > nativePos(r)).length,
    capped: active.filter((r) => positiveCount(r) >= TRAINING_RULES.maxPositive).length,
    winLast7: w7.w / Math.max(1, w7.g),
    trainFunds: log.trainFunds,
    trainExp: log.trainExp,
    upgradeFunds: log.upgradeFunds,
    done,
  }
}

/** 一次長期遊玩，記 30／60 天的快照（各自最後 7 天勝率） */
async function runWithSnaps(seed: number, perDay: number, train: boolean, value: Map<TraitId, number>, style: CoachStyle, days: number) {
  const snaps = new Map<number, Snap>()
  const marks = [30, 60].filter((x) => x <= days)
  const win: { day: number; w: number; g: number }[] = []
  let prev = { w: 0, g: 0 }
  const log = await longRun(seed, perDay, train, value, {
    days,
    style,
    snapshots: Array.from({ length: days }, (_, i) => i + 1),
    onSnap: (day, c, l) => {
      // 每天記一次累計勝場，快照時取最後 7 天
      win.push({ day, w: l.all.w - prev.w, g: l.all.g - prev.g })
      prev = { ...l.all }
      if (marks.includes(day)) {
        const recent = win.filter((x) => x.day > day - 7)
        snaps.set(day, snapOf(c, l, recent.reduce((a, x) => ({ w: a.w + x.w, g: a.g + x.g }), { w: 0, g: 0 })))
      }
    },
  })
  return { log, snaps }
}

async function partC(value: Map<TraitId, number>): Promise<void> {
  const DAYS_C = arg('compareDays', 60)
  const styles = (process.argv.find((a) => a.startsWith('--styles='))?.split('=')[1]?.split(',') ?? ['balanced']) as CoachStyle[]
  const logins = (process.argv.find((a) => a.startsWith('--logins='))?.split('=')[1]?.split(',').map(Number) ?? [1, 2, 6])
  console.log(`\n# C. 正面特性上限：方案 A／B／C（${DAYS_C} 天、${SEEDS} 個球團種子 301/402/503…；30 與 60 天快照）\n`)
  console.log('勝率是「最後 7 天」，所有跑法都跟相同種子的「只升級」比較。\n')
  console.log('| 風格 | 每天上線 | 方案 | 天 | 勝率（只升級→訓練，差） | 到傳奇（天） | 上場平均正面 | 原生 2 正面的人：多練到第 3 個 | 已達上限 | 完成 一般／稀有／改善 | 訓練花費 資金／經驗 | 升級花費 資金 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const style of styles) {
    for (const perDay of logins) {
      applyScenario(null)
      const base = [] as Awaited<ReturnType<typeof runWithSnaps>>[]
      for (let s = 0; s < SEEDS; s++) base.push(await runWithSnaps(301 + s * 101, perDay, false, value, style, DAYS_C))
      for (const sc of SCENARIOS) {
        applyScenario(sc)
        const runs = [] as Awaited<ReturnType<typeof runWithSnaps>>[]
        for (let s = 0; s < SEEDS; s++) runs.push(await runWithSnaps(301 + s * 101, perDay, true, value, style, DAYS_C))
        for (const day of [30, 60].filter((x) => x <= DAYS_C)) {
          const avg = (xs: Snap[], f: (x: Snap) => number) => xs.reduce((n, x) => n + f(x), 0) / xs.length
          const S = runs.map((r) => r.snaps.get(day)!)
          const B = base.map((r) => r.snaps.get(day)!)
          const legend = runs.map((r) => r.log.legendDay).filter((x): x is number => x !== null && x <= day)
          const bLegend = base.map((r) => r.log.legendDay).filter((x): x is number => x !== null && x <= day)
          const L = (xs: number[]) => (xs.length ? `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}（${xs.length}/${SEEDS}）` : '—')
          const n2 = S.reduce((n, x) => n + x.native2, 0)
          const n2g = S.reduce((n, x) => n + x.native2Grew, 0)
          console.log(
            `| ${style} | ${perDay} | ${sc.name} | ${day} | ${pct(avg(B, (x) => x.winLast7))}→${pct(avg(S, (x) => x.winLast7))}（${sgn((avg(S, (x) => x.winLast7) - avg(B, (x) => x.winLast7)) * 100)}pp） | ${L(bLegend)}→${L(legend)} | ${avg(S, (x) => x.positives).toFixed(2)} | ${n2g}/${n2} | ${avg(S, (x) => x.capped).toFixed(1)} | ${avg(S, (x) => x.done.common).toFixed(1)}／${avg(S, (x) => x.done.rare).toFixed(1)}／${avg(S, (x) => x.done.improve).toFixed(1)} | ${avg(S, (x) => x.trainFunds).toFixed(0)}／${avg(S, (x) => x.trainExp).toFixed(0)} | ${avg(S, (x) => x.upgradeFunds).toFixed(0)}（只升級 ${avg(B, (x) => x.upgradeFunds).toFixed(0)}） |`,
          )
        }
      }
    }
  }
  applyScenario(null)
}

/**
 * 四種戰術風格在「先發都練滿」時的勝率：同一支球隊的 9 棒＋先發，各自從自己的潛能池挑效益最高、不互斥的正面特性，
 * 加到 k 個（0／2／3），對同一組對手。看第 3 個特性對各風格的影響是否一致（長期膨脹的上限）
 */
function partStyles(value: Map<TraitId, number>): void {
  const games = arg('styleGames', 600)
  console.log(`\n# D. 先發都練滿時四種風格的勝率（每格 ${games} 場、同種子）\n`)
  console.log('| 風格 | 正面 0 個 | 2 個 | 3 個 | 2→3 的差 |')
  console.log('|---|---|---|---|---|')
  const ranked = [...value.entries()].filter(([t]) => TRAITS[t].tier !== 'red').sort((a, b) => b[1] - a[1]).map(([t]) => t)
  const fill = (k: number) => (t: Team) => {
    const players = [...t.roster.lineup.map((s) => s.player), t.roster.starter]
    for (const p of players) {
      const picked: TraitId[] = []
      for (const tr of ranked) {
        if (picked.length >= k) break
        if (TRAITS[tr].role !== p.role) continue
        if (picked.some((x) => conflicts(x, tr))) continue
        picked.push(tr)
      }
      p.traits = picked
    }
  }
  for (const style of COACH_STYLES) {
    const r = [0, 2, 3].map((k) => play(fill(k), style, games))
    const w = r.map((c) => c.wins / c.games)
    console.log(`| ${style} | ${pct(w[0])} | ${pct(w[1])} | ${pct(w[2])} | ${sgn((w[2] - w[1]) * 100)}pp |`)
  }
}

const value = partA()
if (process.argv.includes('--compare')) {
  partStyles(value)
  await partC(value)
} else if (!process.argv.includes('--onlyA')) await partB(value)
console.log(`\n訓練設定：${Object.entries(TRAINING_CONFIG).map(([k, v]) => `${k} ${v.cost.funds}／${v.cost.experience}／${v.appearances} 場`).join('、')}`)
