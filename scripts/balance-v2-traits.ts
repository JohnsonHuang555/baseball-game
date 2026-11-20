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
import { MAX_POSITIVE_TRAITS, TRAINING_CONFIG, positiveCount, trainingOptions, type TrainingOption } from '../src/v2/domain/traitTraining'
import { MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../src/v2/testkit'

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const GAMES = arg('games', 1000)
const DAYS = arg('days', 45)
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
  trainings: { kind: string; started: number; done: number | null; matchesTaken: number | null }[]
  trainFunds: number
  trainExp: number
  upgradeFunds: number
  positives: number
  capped: number
  settleMs: number[]
}

async function longRun(seed: number, perDay: number, train: boolean, value: Map<TraitId, number>): Promise<RunLog> {
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'balance', clubSeed: seed, clubId: `bal-${seed}` })
  const log: RunLog = { matches: 0, legendDay: null, last7: { w: 0, g: 0 }, trainings: [], trainFunds: 0, trainExp: 0, upgradeFunds: 0, positives: 0, capped: 0, settleMs: [] }
  const step = (24 * HOUR) / perDay
  for (let s = 0; s < DAYS * perDay; s++) {
    clock.advance(step)
    const day = (s + 1) / perDay
    const t0 = performance.now()
    const r = await settleDue(d)
    log.settleMs.push(performance.now() - t0)
    log.matches += r.settled.length
    if (day > DAYS - 7) for (const m of r.settled) (log.last7.g++, m.result.won && log.last7.w++)
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
  }
  const c = load(d)
  const active = [...assignedIds(c.roster)].map((id) => recordOf(c, id)!)
  log.positives = active.reduce((n, r) => n + positiveCount(r), 0) / active.length
  log.capped = active.filter((r) => positiveCount(r) >= MAX_POSITIVE_TRAITS).length
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

const value = partA()
if (!process.argv.includes('--onlyA')) await partB(value)
console.log(`\n訓練設定：${Object.entries(TRAINING_CONFIG).map(([k, v]) => `${k} ${v.cost.funds}／${v.cost.experience}／${v.appearances} 場`).join('、')}`)
