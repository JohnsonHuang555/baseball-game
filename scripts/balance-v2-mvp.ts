// Phase 9 PR 4：單場 MVP 的平衡模擬。npm run balance:v2:mvp [-- --games=600 --seeds=3 --days=30,60,90 --skipLong]
//
// A. 分數尺度校正：同一組比賽（固定種子、八種隊伍、四種戰術），只改投手分數的尺度，看打者／投手得獎比例與先發壟斷程度
// B. 得獎分布（定案參數）：隊伍類型 × 比賽類型（一般、低比分、高比分、延長賽、大敗、完封、替補關鍵）× 棒次／先發／後援
// C. 長期（正式服務：結算 → 領取 → 升級 → 晉級挑戰）30／60／90 天，每天上線 2 次：有／沒有 MVP 成長，
//    平均加成、最快到 +0.5、全隊成長、到傳奇的天數、勝率、集中度（同一位球員是否越拿越多）、跟等級與特性訓練疊加
// 所有比賽用固定種子，結果可重現；MVP 只看結算後的數據，不影響比賽本身
import { generateTeam } from '../src/sim/generate'
import { RULES_VERSION, type Side } from '../src/sim/game'
import { Rng } from '../src/sim/rng'
import { TRAITS, conflicts, type TraitId } from '../src/sim/traits'
import type { Batter, Pitcher, Player, Team } from '../src/sim/types'
import { COACH_STYLES, type CoachStyle } from '../src/v2/application/autoCoach'
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { startTraining, upgrade } from '../src/v2/application/economyService'
import { challengeNextLeague } from '../src/v2/application/leagueService'
import { runMatch, type MatchAi, type MatchResult } from '../src/v2/application/matchRunner'
import { claim, settleDue } from '../src/v2/application/settlementService'
import { matchRecordOf } from '../src/v2/domain/boxScore'
import { eligibility } from '../src/v2/domain/league'
import { MVP_CONFIG, MVP_RULES, mvpCandidates, compareCandidates, mvpUnits, unpackMvp, type MvpCandidate } from '../src/v2/domain/mvp'
import { leveled, upgradeCost } from '../src/v2/domain/progression'
import { MAX_LEVEL } from '../src/v2/domain/progressionConfig'
import { assignedIds, effectivePlayer, recordOf } from '../src/v2/domain/roster'
import { batOf, pitOf, type MatchLines } from '../src/v2/domain/stats'
import { trainingOptions } from '../src/v2/domain/traitTraining'
import { MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../src/v2/testkit'

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const list = (name: string, fallback: number[]) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]?.split(',').map(Number) ?? fallback
const GAMES = arg('games', 600)
const SEEDS = arg('seeds', 3)
const DAYS = list('days', [30, 60, 90])
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const mutable = MVP_CONFIG as unknown as { pitcher: { runsPerOut: number; scale: number; strikeout: number }; perGrowth: number }
if (process.argv.some((a) => a.startsWith('--perGrowth='))) mutable.perGrowth = arg('perGrowth', 10)

// ---------------- 隊伍類型 ----------------

const plain = (t: Team) => t
const boost = (keys: string[], add: number, who: (t: Team) => Player[]) => (t: Team) => {
  for (const p of who(t)) for (const k of keys) (p.ratings as unknown as Record<string, number>)[k] = Math.min(10, (p.ratings as unknown as Record<string, number>)[k] + add)
  return t
}
const batters = (t: Team) => [...t.roster.lineup.map((s) => s.player), ...t.roster.bench]
const starterOf = (t: Team) => [t.roster.starter]
const pen = (t: Team) => t.roster.relievers
const allOf = (t: Team) => [...batters(t), t.roster.starter, ...t.roster.relievers]
/** 每位先發（9 棒＋先發投手）從效益表挑 3 個不互斥的正面特性 */
const BEST: Record<'batter' | 'pitcher', TraitId[]> = { batter: ['slugger', 'eye', 'lineDrive', 'clutch', 'baserunner', 'stealer'], pitcher: ['escapeArtist', 'strikeoutArtist', 'groundballer', 'closer'] }
const threeTraits = (t: Team) => {
  for (const p of [...t.roster.lineup.map((s) => s.player), t.roster.starter]) {
    const picked: TraitId[] = []
    for (const tr of BEST[p.role]) if (picked.length < 3 && !picked.some((x) => conflicts(x, tr)) && TRAITS[tr].role === p.role) picked.push(tr)
    p.traits = picked
  }
  return t
}
const level20 = (t: Team) => {
  for (const p of allOf(t)) Object.assign(p, { ratings: leveled(p as Batter | Pitcher, MAX_LEVEL).ratings })
  return t
}

interface TeamType {
  name: string
  mean: number
  edit: (t: Team) => Team
}
const TEAM_TYPES: TeamType[] = [
  { name: '新手弱隊', mean: 4.6, edit: plain },
  { name: '平均球隊', mean: 5.8, edit: plain },
  { name: '高長打', mean: 5.8, edit: boost(['power'], 1.5, batters) },
  { name: '高速度', mean: 5.8, edit: boost(['speed'], 1.5, batters) },
  { name: '強先發', mean: 5.8, edit: boost(['stuff', 'control'], 1.5, starterOf) },
  { name: '強牛棚', mean: 5.8, edit: boost(['stuff', 'control'], 1.5, pen) },
  { name: '高等級（Lv.20）', mean: 5.8, edit: level20 },
  { name: '三個正面特性', mean: 5.8, edit: threeTraits },
]

// ---------------- 比賽資料（可以換參數重新評分） ----------------

interface Game {
  type: string
  style: CoachStyle
  lines: MatchLines
  facts: MatchResult['mvpFacts'] | null
  /** 我方先發投手、打序（lineup 的 9 人）、板凳 */
  starter: string
  lineup: string[]
  runsFor: number
  runsAgainst: number
  innings: number
  won: boolean
}

function playGames(tt: TeamType, style: CoachStyle, n: number, seed0: number): Game[] {
  const out: Game[] = []
  for (let i = 0; i < n; i++) {
    const ours = tt.edit(generateTeam(new Rng(seed0 + (i % 40)), tt.mean))
    const opp = generateTeam(new Rng(900_000 + seed0 + i), 5.8)
    const userSide: Side = i % 2 ? 'away' : 'home'
    const other: Side = userSide === 'home' ? 'away' : 'home'
    const setup = { home: userSide === 'home' ? ours : opp, away: userSide === 'away' ? ours : opp, seed: 70_000 + seed0 + i, userSide, rules: RULES_VERSION }
    const r = runMatch(setup, { [userSide]: { kind: 'autoCoach', style }, [other]: { kind: 'builtin' } } as MatchAi)
    out.push({
      type: tt.name,
      style,
      lines: matchRecordOf(r, userSide).lines,
      facts: r.mvpFacts ?? null,
      starter: ours.roster.starter.id,
      lineup: ours.roster.lineup.map((s) => s.player.id),
      runsFor: r.score[userSide],
      runsAgainst: r.score[other],
      innings: r.innings,
      won: r.winner === userSide,
    })
  }
  return out
}

const pick = (g: Game): MvpCandidate => mvpCandidates(g.lines, g.facts ?? null).sort(compareCandidates)[0]

interface Dist {
  n: number
  pitcher: number
  starter: number
  reliever: number
  top: number
  bottom: number
  bench: number
  /** 同一場比賽：MVP 是誰的分布集中度（每隊每位球員得獎數的 Gini 用不到，這裡用「得獎最多的 1 人占比」） */
  byPlayer: Map<string, number>
}
function dist(games: readonly Game[]): Dist {
  const d: Dist = { n: 0, pitcher: 0, starter: 0, reliever: 0, top: 0, bottom: 0, bench: 0, byPlayer: new Map() }
  for (const g of games) {
    const m = pick(g)
    d.n++
    d.byPlayer.set(`${g.type}:${m.id}`, (d.byPlayer.get(`${g.type}:${m.id}`) ?? 0) + 1)
    if (m.role === 'pitcher') {
      d.pitcher++
      if (m.id === g.starter) d.starter++
      else d.reliever++
    } else {
      const slot = g.lineup.indexOf(m.id)
      if (slot < 0) d.bench++
      else if (slot < 5) d.top++
      else d.bottom++
    }
  }
  return d
}
const row = (label: string, d: Dist) =>
  `| ${label} | ${d.n} | ${pct((d.n - d.pitcher) / d.n)} | ${pct(d.pitcher / d.n)} | ${pct(d.starter / d.n)} | ${pct(d.reliever / d.n)} | ${pct(d.top / d.n)} | ${pct(d.bottom / d.n)} | ${pct(d.bench / d.n)} |`
const HEAD = '| 情境 | 場數 | 打者 | 投手 | 先發投手 | 後援投手 | 1～5 棒 | 6～9 棒 | 替補（代打、代跑、守備） |\n|---|---|---|---|---|---|---|---|---|'

// ---------------- A. 尺度校正 ----------------

function leagueRunsPerOut(games: readonly Game[]): number {
  let runs = 0
  let outs = 0
  for (const g of games)
    for (const [, ...c] of g.lines.pit) {
      const p = pitOf(c)
      runs += p.er
      outs += p.outs
    }
  return runs / outs
}

/** 打者評分的「每一分值幾分」：每場我方打者評分加總，對我方得分做最小平方法回歸的斜率 */
function batterPointsPerRun(games: readonly Game[]): { slope: number; intercept: number; r2: number } {
  const xs: number[] = []
  const ys: number[] = []
  for (const g of games) {
    let sum = 0
    for (const c of mvpCandidates({ bat: g.lines.bat, pit: [] }, g.facts ?? null)) sum += c.score
    xs.push(g.runsFor)
    ys.push(sum / 1000)
  }
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (ys[i] - my) ** 2
  }
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, r2: (sxy * sxy) / (sxx * syy) }
}

function partA(games: readonly Game[]): void {
  const rpo = leagueRunsPerOut(games)
  const fit = batterPointsPerRun(games)
  console.log(`\n# A. 投手分數尺度校正（${games.length} 場：八種隊伍 × 四種戰術，同一組比賽只改參數）\n`)
  console.log(`量到的每出局自責分：${rpo.toFixed(4)}（每 9 局 ${(rpo * 27).toFixed(2)} 分）`)
  console.log(`打者評分 ↔ 得分：每場我方打者評分加總 = ${fit.intercept.toFixed(2)} + ${fit.slope.toFixed(3)} × 得分（R² ${fit.r2.toFixed(2)}）→ 打者每 1 分值 ${fit.slope.toFixed(2)} 評分`)
  console.log(`投手評分 = (出局 × 每出局失分 − 自責分) × scale：scale = ${fit.slope.toFixed(2)} 時，「多得一分」與「少失一分」等值\n`)
  console.log('| runsPerOut | scale | 三振 | 打者 | 投手 | 先發投手 | 後援投手 | 先發投手平均分 | 打者 MVP 平均分 |')
  console.log('|---|---|---|---|---|---|---|---|---|')
  const save = { ...mutable.pitcher }
  for (const runsPerOut of [Math.round(rpo * 1000), 140]) {
    for (const scale of [1000, 1200, Math.round(fit.slope * 1000), 1500, 1800]) {
      for (const strikeout of [0, 50]) {
        Object.assign(mutable.pitcher, { runsPerOut, scale, strikeout })
        const d = dist(games)
        let sp = 0
        let spN = 0
        let bm = 0
        let bmN = 0
        for (const g of games) {
          const c = mvpCandidates(g.lines, g.facts ?? null)
          const s = c.find((x) => x.id === g.starter && x.role === 'pitcher')
          if (s) (sp += s.score, spN++)
          const m = c.sort(compareCandidates)[0]
          if (m.role === 'batter') (bm += m.score, bmN++)
        }
        console.log(`| ${runsPerOut} | ${scale} | ${strikeout} | ${pct((d.n - d.pitcher) / d.n)} | ${pct(d.pitcher / d.n)} | ${pct(d.starter / d.n)} | ${pct(d.reliever / d.n)} | ${(sp / spN / 1000).toFixed(2)} | ${(bm / bmN / 1000).toFixed(2)} |`)
      }
    }
  }
  Object.assign(mutable.pitcher, save)
}

// ---------------- B. 得獎分布 ----------------

function partB(games: readonly Game[]): void {
  console.log(`\n# B. 得獎分布（定案參數：runsPerOut ${MVP_CONFIG.pitcher.runsPerOut}、scale ${MVP_CONFIG.pitcher.scale}、三振 ${MVP_CONFIG.pitcher.strikeout}）\n`)
  console.log('## 隊伍類型\n')
  console.log(HEAD)
  console.log(row('全部', dist(games)))
  for (const tt of TEAM_TYPES) console.log(row(tt.name, dist(games.filter((g) => g.type === tt.name))))
  console.log('\n## 戰術風格\n')
  console.log(HEAD)
  for (const s of COACH_STYLES) console.log(row(s, dist(games.filter((g) => g.style === s))))
  console.log('\n## 比賽類型\n')
  console.log(HEAD)
  const types: [string, (g: Game) => boolean][] = [
    ['低比分（雙方合計 ≤ 4）', (g) => g.runsFor + g.runsAgainst <= 4],
    ['高比分（雙方合計 ≥ 14）', (g) => g.runsFor + g.runsAgainst >= 14],
    ['延長賽', (g) => g.innings > 9],
    ['大敗（輸 6 分以上）', (g) => g.runsAgainst - g.runsFor >= 6],
    ['我方被完封', (g) => g.runsFor === 0],
    ['我方完封對手', (g) => g.runsAgainst === 0],
    ['勝場', (g) => g.won],
    ['敗場', (g) => !g.won],
  ]
  for (const [label, f] of types) {
    const sub = games.filter(f)
    if (sub.length) console.log(row(label, dist(sub)))
  }
  // 替補關鍵：替補得獎的場次裡，替補的數據
  const benchWins = games.filter((g) => {
    const m = pick(g)
    return m.role === 'batter' && !g.lineup.includes(m.id)
  })
  console.log(`\n替補得獎 ${benchWins.length} 場（${pct(benchWins.length / games.length)}）；例：`)
  for (const g of benchWins.slice(0, 3)) {
    const m = pick(g)
    const b = batOf(g.lines.bat.find((r) => r[0] === m.id)!.slice(1) as number[])
    console.log(`- ${g.type}／${g.style}：${b.ab} 打數 ${b.h} 安打、${b.hr} 全壘打、${b.rbi} 打點、${b.bb} 保送（評分 ${(m.score / 1000).toFixed(2)}）`)
  }
  // 沒有突出表現：MVP 分數 ≤ 0.5
  const flat = games.filter((g) => pick(g).score <= 500)
  console.log(`\n沒有突出表現（MVP 評分 ≤ 0.5）的比賽 ${flat.length} 場（${pct(flat.length / games.length)}），照樣依同分規則選出 MVP。`)
  // 同分：最高分有兩人以上
  let ties = 0
  let cross = 0
  for (const g of games) {
    const c = mvpCandidates(g.lines, g.facts ?? null).sort(compareCandidates)
    if (c.length > 1 && c[0].score === c[1].score) {
      ties++
      if (c[0].role !== c[1].role) cross++
    }
  }
  console.log(`評分同分（需要同分規則）的比賽 ${ties} 場（${pct(ties / games.length)}），其中跨角色 ${cross} 場。`)
}

// ---------------- C. 長期 ----------------

interface LongLog {
  day: number
  legendDay: number | null
  winLast7: number
  avgUnits: number
  maxUnits: number
  fastest5: number | null
  topShare: number
  top3Share: number
  /** 前 30 天得獎最多的人，後 30 天得獎占比（看正回饋） */
  avgRating: number
  levelAvg: number
  learned: number
  /** 目前的聯盟階級（0 新秀～4 傳奇）：比「到傳奇的天數」穩定，所有種子都有值 */
  tier: number
}

async function upgradeEvenly(d: ReturnType<typeof tab>): Promise<void> {
  for (let guard = 0; guard < 40; guard++) {
    const c = d.store.loadClub()!
    const ids = [...assignedIds(c.roster)]
    const rec = ids.map((id) => recordOf(c, id)!).filter((r) => r.level < MAX_LEVEL).sort((a, b) => a.level - b.level)[0]
    if (!rec) return
    const cost = upgradeCost(rec.level)!
    if (c.economy.assets.funds < cost.funds || c.economy.assets.experience < cost.experience) return
    await upgrade(d, { opSeq: c.economy.nextOpSeq, playerId: rec.player.id, expectedLevel: rec.level })
  }
}

async function longRun(seed: number, growth: boolean, train: boolean, style: CoachStyle, marks: number[]): Promise<LongLog[]> {
  MVP_RULES.growth = growth
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'mvp', clubSeed: seed, clubId: `mvp-${seed}` })
  if (style !== 'balanced') {
    const c = d.store.loadClub()!
    d.store.saveClub({ ...c, strategy: { ...c.strategy, coach: { style } } }, c.revision)
  }
  const logs: LongLog[] = []
  let legendDay: number | null = null
  const daily: { day: number; w: number; g: number }[] = []
  const firstFive = new Map<string, number>()
  const perDay = 2
  for (let s = 0; s < Math.max(...marks) * perDay; s++) {
    clock.advance((24 * HOUR) / perDay)
    const day = (s + 1) / perDay
    const r = await settleDue(d)
    daily.push({ day, w: r.settled.filter((m) => m.result.won).length, g: r.settled.length })
    await claim(d, d.store.loadClub()!.economy.nextClaimSeq)
    if (train && !d.store.loadClub()!.training.active) {
      const c = d.store.loadClub()!
      const ids = [...c.roster.lineup.map((x) => x.playerId), c.roster.starter]
      for (const id of ids) {
        const o = trainingOptions(c.clubSeed, recordOf(c, id)!, { active: null, assets: c.economy.assets }).find((x) => x.block === null && x.cls !== 'rare')
        if (o) {
          await startTraining(d, { opSeq: c.economy.nextOpSeq, playerId: id, trait: o.trait, kind: o.kind })
          break
        }
      }
    }
    await upgradeEvenly(d)
    const c = d.store.loadClub()!
    if (eligibility(c.league, c.idle.nextMatchIndex).ok) await challengeNextLeague(d, { challengeSeq: c.league.nextChallengeSeq, fromTier: c.league.tier })
    if (legendDay === null && d.store.loadClub()!.league.tier === 4) legendDay = day
    for (const p of d.store.loadClub()!.players) if (mvpUnits(p) >= 5 && !firstFive.has(p.player.id)) firstFive.set(p.player.id, day)
    if (Number.isInteger(day) && marks.includes(day)) {
      const c2 = d.store.loadClub()!
      const active = [...assignedIds(c2.roster)].map((id) => recordOf(c2, id)!)
      const counts = c2.players.map((p) => p.mvp?.count ?? 0).sort((a, b) => b - a)
      const total = counts.reduce((a, b) => a + b, 0)
      const recent = daily.filter((x) => x.day > day - 7)
      logs.push({
        day,
        legendDay,
        winLast7: recent.reduce((a, x) => a + x.w, 0) / Math.max(1, recent.reduce((a, x) => a + x.g, 0)),
        avgUnits: active.reduce((a, r) => a + mvpUnits(r), 0) / active.length,
        maxUnits: Math.max(...active.map(mvpUnits)),
        fastest5: firstFive.size ? Math.min(...firstFive.values()) : null,
        topShare: counts[0] / Math.max(1, total),
        top3Share: (counts[0] + counts[1] + counts[2]) / Math.max(1, total),
        avgRating: active.reduce((a, r) => a + Object.values(effectivePlayer(r).ratings).reduce((x, y) => x + y, 0) / Object.values(r.player.ratings).length, 0) / active.length,
        levelAvg: active.reduce((a, r) => a + r.level, 0) / active.length,
        learned: active.reduce((a, r) => a + (r.dev?.learned.length ?? 0), 0),
        tier: c2.league.tier,
      })
    }
  }
  MVP_RULES.growth = true
  return logs
}

/** 正回饋：前半段 MVP 次數最多的 3 人，在後半段的得獎占比，跟關掉成長時相比 */
async function feedback(seed: number, growth: boolean, days: number): Promise<{ firstTop3: number; laterTop3: number }> {
  MVP_RULES.growth = growth
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'mvp', clubSeed: seed, clubId: `fb-${seed}` })
  const wins = new Map<string, number[]>()
  for (let s = 0; s < days * 2; s++) {
    clock.advance(12 * HOUR)
    const r = await settleDue(d)
    for (const m of r.settled) {
      const v = unpackMvp(m.mvp!)
      const arr = wins.get(v.playerId) ?? [0, 0]
      arr[s < days ? 0 : 1]++
      wins.set(v.playerId, arr)
    }
    await claim(d, d.store.loadClub()!.economy.nextClaimSeq)
    await upgradeEvenly(d)
  }
  MVP_RULES.growth = true
  const top = [...wins.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 3)
  const first = [...wins.values()].reduce((a, x) => a + x[0], 0)
  const later = [...wins.values()].reduce((a, x) => a + x[1], 0)
  return { firstTop3: top.reduce((a, x) => a + x[1][0], 0) / first, laterTop3: top.reduce((a, x) => a + x[1][1], 0) / later }
}

async function partC(): Promise<void> {
  console.log(`\n# C. 長期（每天上線 2 次、${SEEDS} 個球團種子 401/502/603…；${DAYS.join('／')} 天；每 ${MVP_CONFIG.perGrowth} 次 MVP 成長一次）\n`)
  console.log('每次上線：結算 → 領取 →（特性訓練）→ 平均升級上場球員 → 有資格就挑戰。勝率是快照前 7 天。\n')
  console.log('| 戰術 | 特性訓練 | MVP 成長 | 天 | 到傳奇（天） | 平均聯盟階級 | 最後 7 天勝率 | 上場平均 MVP 加成 | 最多的一人 | 最快到 +0.5（天） | 得獎最多 1 人／前 3 人占比 | 上場平均能力 | 平均等級 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  const styles = (process.argv.find((a) => a.startsWith('--styles='))?.split('=')[1]?.split(',') ?? COACH_STYLES) as CoachStyle[]
  for (const style of styles) {
    for (const train of process.argv.includes('--onlyTrain') ? [true] : style === 'balanced' && !process.argv.includes('--noTrain') ? [false, true] : [false]) {
      for (const growth of [false, true]) {
        const runs: LongLog[][] = []
        for (let s = 0; s < SEEDS; s++) runs.push(await longRun(401 + s * 101, growth, train, style, DAYS))
        for (let i = 0; i < DAYS.length; i++) {
          const L = runs.map((r) => r[i])
          const avg = (f: (l: LongLog) => number) => L.reduce((a, l) => a + f(l), 0) / L.length
          const leg = L.map((l) => l.legendDay).filter((x): x is number => x !== null)
          const f5 = L.map((l) => l.fastest5).filter((x): x is number => x !== null)
          console.log(
            `| ${style} | ${train ? '有' : '—'} | ${growth ? '有' : '關'} | ${DAYS[i]} | ${leg.length ? `${(leg.reduce((a, b) => a + b, 0) / leg.length).toFixed(1)}（${leg.length}/${SEEDS}）` : '—'} | ${avg((l) => l.tier).toFixed(2)} | ${pct(avg((l) => l.winLast7))} | +${(avg((l) => l.avgUnits) / 10).toFixed(3)} | +${(Math.max(...L.map((l) => l.maxUnits)) / 10).toFixed(1)} | ${f5.length ? Math.min(...f5) : '—'} | ${pct(avg((l) => l.topShare))}／${pct(avg((l) => l.top3Share))} | ${avg((l) => l.avgRating).toFixed(3)} | ${avg((l) => l.levelAvg).toFixed(1)} |`,
          )
        }
      }
    }
  }
  if (process.argv.includes('--noFeedback')) return
  console.log('\n## 正回饋：前半段得獎最多的 3 人，在後半段的得獎占比（同種子，有／沒有成長）\n')
  console.log('| 種子 | 天數 | 沒有成長：前半 → 後半 | 有成長：前半 → 後半 |')
  console.log('|---|---|---|---|')
  const fbDays = Math.max(...DAYS) / 2
  for (let s = 0; s < SEEDS; s++) {
    const off = await feedback(401 + s * 101, false, fbDays)
    const on = await feedback(401 + s * 101, true, fbDays)
    console.log(`| ${401 + s * 101} | ${fbDays}＋${fbDays} | ${pct(off.firstTop3)} → ${pct(off.laterTop3)} | ${pct(on.firstTop3)} → ${pct(on.laterTop3)} |`)
  }
}

const games: Game[] = []
for (const [ti, tt] of TEAM_TYPES.entries()) for (const [si, style] of COACH_STYLES.entries()) games.push(...playGames(tt, style, Math.round(GAMES / 4), 10_000 * (ti + 1) + 1000 * si))
if (!process.argv.includes('--skipA')) partA(games)
partB(games)
if (!process.argv.includes('--skipLong')) await partC()
console.log(`\nMVP 設定：${JSON.stringify(MVP_CONFIG)}`)
