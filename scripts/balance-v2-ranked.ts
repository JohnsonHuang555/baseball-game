// Phase 7B：正式競技積分／降級規則（方案 D，RANKED_CONFIG）的平衡驗收。
// 跟 Phase 7A 的 RFC 模擬不同，這裡沒有任何影子規則：積分、降級、分段結算全部是正式的 Domain 與結算服務，
// 腳本只讀每場存下的 SettledMatch.ranked 與聯盟狀態來統計。
//
//   npm run balance:v2:ranked                          # 45 天：每天 1／3／6 次 × B／E／D × 種子 1～8，再加 90 天長跑（每天 3 次 × B／E／D × 種子 1～4）
//   npm run balance:v2:ranked -- --days=45 --sessions=3 --strategies=E --seeds=1,2 --long=0 --jobs=1 --out=x.json
//   npm run balance:v2:ranked -- --report=docs/balance/data/phase7b-ranked.json
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { simulate, STRATEGY_NAMES, type Strategy } from './balance/simulate'
import { LEAGUES, RANKED_CONFIG } from '../src/v2/domain/leagueConfig'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const args = Object.fromEntries(argv.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true'])) as Record<string, string>
const list = (k: string, def: string) => (args[k] ?? def).split(',').filter(Boolean)
const N = LEAGUES.length

/** 積分區間：0、1～20（危險區）、21～79、80～99、100（上限） */
const ZONES = ['0', '1-20', '21-79', '80-99', '100'] as const
const zoneOf = (p: number) => (p <= 0 ? 0 : p <= RANKED_CONFIG.dangerThreshold ? 1 : p < 80 ? 2 : p < RANKED_CONFIG.maxPoints ? 3 : 4)

export interface RunSummary {
  strategy: Strategy
  sessions: number
  seed: number
  days: number
  /** 第一次到達各聯盟的天數 */
  reached: (number | null)[]
  tierByDay: number[]
  /** 每次降級：哪一天、從哪一級、是這次上線結算的第幾場、這次上線結算幾場、這次上線開始時的積分（同一級才有） */
  relegations: { day: number; from: number; nth: number; batch: number; startPoints: number | null }[]
  /** 每次降級後重返原聯盟的天數（沒回去是 null） */
  returns: { from: number; days: number | null }[]
  matchesAt: number[]
  winsAt: number[]
  /** 每一級每一場結束時的積分區間 */
  zones: number[][]
  /** 每一級最長的「連續停在 100 分」場數 */
  longestAtMax: number[]
  /** 每一級「停在 100 分」的每一段連續場數 */
  maxRuns: number[][]
  /** 每次上線結算的耗時（毫秒）與場數 */
  settleMs: number[]
  settleMatches: number[]
}

interface Job {
  sessions: number
  strategy: Strategy
  seed: number
  days: number
}

function jobs(): Job[] {
  const out: Job[] = []
  const days = Number(args.days ?? 45)
  for (const sessions of list('sessions', '1,3,6').map(Number))
    for (const strategy of list('strategies', 'B,E,D') as Strategy[]) for (const seed of list('seeds', '1,2,3,4,5,6,7,8').map(Number)) out.push({ sessions, strategy, seed, days })
  const long = Number(args.long ?? 90)
  if (long > 0) for (const strategy of ['B', 'E', 'D'] as Strategy[]) for (const seed of [1, 2, 3, 4]) out.push({ sessions: 3, strategy, seed, days: long })
  return out
}

async function runOne(j: Job): Promise<RunSummary> {
  const zones = LEAGUES.map(() => ZONES.map(() => 0))
  const matchesAt = Array(N).fill(0)
  const winsAt = Array(N).fill(0)
  const longestAtMax = Array(N).fill(0)
  const maxRuns: number[][] = LEAGUES.map(() => [])
  const streak = Array(N).fill(0)
  const relegations: RunSummary['relegations'] = []
  const returns: RunSummary['returns'] = []
  const pending: { from: number; day: number; idx: number }[] = []
  const settleMs: number[] = []
  const settleMatches: number[] = []
  const closeStreak = (t: number) => {
    if (streak[t] > 0) maxRuns[t].push(streak[t])
    streak[t] = 0
  }
  const r = await simulate({
    strategy: j.strategy,
    seed: j.seed,
    sessionsPerDay: j.sessions,
    days: j.days,
    onSession: ({ day, settled, before, settleMs: ms }) => {
      settleMs.push(ms)
      settleMatches.push(settled.length)
      settled.forEach((m, nth) => {
        const t = m.result.leagueTier ?? 0
        matchesAt[t]++
        if (m.result.won) winsAt[t]++
        const rk = m.ranked
        if (!rk) return
        zones[rk.tier][zoneOf(rk.after)]++
        if (rk.after >= RANKED_CONFIG.maxPoints) {
          streak[rk.tier]++
          longestAtMax[rk.tier] = Math.max(longestAtMax[rk.tier], streak[rk.tier])
        } else closeStreak(rk.tier)
        if (rk.relegatedTo !== null) {
          closeStreak(rk.tier)
          relegations.push({ day, from: rk.tier, nth: nth + 1, batch: settled.length, startPoints: before.league.tier === rk.tier ? before.league.points : null })
          returns.push({ from: rk.tier, days: null })
          pending.push({ from: rk.tier, day, idx: returns.length - 1 })
        }
      })
    },
    onChallenge: ({ day, toTier, won }) => {
      if (!won) return
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].from === toTier) {
          returns[pending[i].idx].days = day - pending[i].day
          pending.splice(i, 1)
        }
      }
    },
  })
  for (let t = 0; t < N; t++) closeStreak(t)
  return { ...j, reached: r.tiers.map((t) => t.reachedDay), tierByDay: r.snapshots.map((s) => s.tier), relegations, returns, matchesAt, winsAt, zones, longestAtMax, maxRuns, settleMs, settleMatches }
}

async function runJobs(todo: Job[], out: string): Promise<void> {
  const rows: RunSummary[] = []
  const t0 = Date.now()
  for (const j of todo) {
    rows.push(await runOne(j))
    const last = rows.at(-1)!
    console.error(`${j.days}d ${j.sessions}x ${j.strategy} s${j.seed}: 聯盟 ${last.tierByDay.join('')}  降級 ${last.relegations.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    writeFileSync(out, JSON.stringify(rows))
  }
}

/** 把工作平均分給 n 個子行程（--part=i/n），跑完合併 */
async function runParallel(n: number, out: string): Promise<void> {
  const parts = Array.from({ length: n }, (_, i) => `${out}.part${i}`)
  const passthrough = argv.filter((a) => !/^--(jobs|out|part)=/.test(a))
  await Promise.all(
    parts.map(
      (file, i) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn('npx', ['vite-node', fileURLToPath(import.meta.url), '--', ...passthrough, `--part=${i}/${n}`, `--out=${file}`, '--jobs=1'], { stdio: ['ignore', 'ignore', 'inherit'] })
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`子行程 ${i} 結束代碼 ${code}`))))
        }),
    ),
  )
  const key = (j: Job) => `${j.days}|${j.sessions}|${j.strategy}|${j.seed}`
  const order = jobs().map(key)
  const rows = parts.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as RunSummary[])
  rows.sort((a, b) => order.indexOf(key(a)) - order.indexOf(key(b)))
  writeFileSync(out, JSON.stringify(rows))
  for (const f of parts) rmSync(f, { force: true })
}

// ---- 統計 ----

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
}
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')

/** 比例的 95% Wilson 區間 */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - h) / d, (c + h) / d]
}
/** 次數（Poisson）的 95% 區間（Wilson–Hilferty 近似；0 次的上限 3.69） */
export function poisson(k: number): [number, number] {
  if (k === 0) return [0, 3.69]
  const lo = k * (1 - 1 / (9 * k) - 1.96 / (3 * Math.sqrt(k))) ** 3
  const k1 = k + 1
  const hi = k1 * (1 - 1 / (9 * k1) + 1.96 / (3 * Math.sqrt(k1))) ** 3
  return [lo, hi]
}
const ciPct = ([a, b]: [number, number]) => `${fmt(a * 100, 0)}～${fmt(b * 100, 0)}%`

function span(rows: RunSummary[], a: number, b: number) {
  const xs: number[] = []
  let started = 0
  for (const r of rows) {
    const s = r.reached[a]
    if (s === null) continue
    started++
    const e = r.reached[b]
    if (e !== null) xs.push(e - s)
  }
  return { started, reached: xs.length, p50: q(xs, 0.5), p90: q(xs, 0.9) }
}

export function report(rows: RunSummary[]): string {
  const out: string[] = []
  const D = Math.min(...rows.map((x) => x.days))
  const short = rows.filter((r) => r.days === D)
  const long = rows.filter((r) => r.days !== D)

  out.push(`## 1. 進度（${D} 天；每格 n = 3 策略 × ${new Set(short.map((r) => r.seed)).size} 種子）`, '')
  out.push('| 每天上線 | n | 新秀→挑戰者 P50／P90（到達率） | 挑戰者→職業 P50／P90（到達率） | 職業→傳奇 P50／P90（到達率） | 最後一天在傳奇 |')
  out.push('|---|---|---|---|---|---|')
  for (const spd of [1, 3, 6]) {
    const rs = short.filter((r) => r.sessions === spd)
    if (!rs.length) continue
    const cells = [span(rs, 0, 2), span(rs, 2, 3), span(rs, 3, 4)].map((x) => `${fmt(x.p50)}／${fmt(x.p90)}（${pct(x.reached, x.started)}）`)
    out.push(`| ${spd} | ${rs.length} | ${cells.join(' | ')} | ${pct(rs.filter((r) => r.tierByDay.at(-1) === 4).length, rs.length)} |`)
  }

  const relTable = (rs: RunSummary[], label: string) => {
    out.push('', `## ${label}`, '')
    out.push('| 每天上線 | 策略 | n | 有降級的球團（95% 區間） | 職業降級：次數／千場 = 每千場（95% 區間） | 傳奇降級：次數／千場 = 每千場（95% 區間） | 降級後重返 P50 天（重返率） | 一次上線就從危險區以上被降級 |')
    out.push('|---|---|---|---|---|---|---|---|')
    const groups: [string, string, RunSummary[]][] = []
    for (const spd of [1, 3, 6]) {
      for (const s of ['B', 'E', 'D'] as Strategy[]) {
        const g = rs.filter((r) => r.sessions === spd && r.strategy === s)
        if (g.length) groups.push([String(spd), STRATEGY_NAMES[s], g])
      }
      const all = rs.filter((r) => r.sessions === spd)
      if (all.length) groups.push([String(spd), '**合計**', all])
    }
    for (const [spd, name, g] of groups) {
      const ever = g.filter((r) => r.relegations.length > 0).length
      const per = (t: number) => {
        const n = sum(g.map((r) => r.relegations.filter((e) => e.from === t).length))
        const m = sum(g.map((r) => r.matchesAt[t]))
        if (!m) return '—'
        const [lo, hi] = poisson(n)
        return `${n}／${fmt(m / 1000, 1)} = ${fmt((n / m) * 1000, 2)}（${fmt((lo / m) * 1000, 2)}～${fmt((hi / m) * 1000, 2)}）`
      }
      const rets = g.flatMap((r) => r.returns)
      const back = rets.filter((x) => x.days !== null).map((x) => x.days!)
      const rels = g.flatMap((r) => r.relegations)
      const oneBatch = rels.filter((e) => e.startPoints !== null && e.startPoints > RANKED_CONFIG.dangerThreshold).length
      out.push(`| ${spd} | ${name} | ${g.length} | ${pct(ever, g.length)}（${ciPct(wilson(ever, g.length))}） | ${per(3)} | ${per(4)} | ${fmt(q(back, 0.5))}（${pct(back.length, rets.length)}） | ${rels.length ? `${oneBatch}／${rels.length}` : '—'} |`)
    }
  }
  relTable(short, `2. 降級（${D} 天）`)
  if (long.length) relTable(long, `3. 長時間穩定性（${long[0].days} 天，每天 3 次 × 3 策略 × ${new Set(long.map((r) => r.seed)).size} 種子）`)

  const zoneTable = (rs: RunSummary[], label: string) => {
    out.push('', `## ${label}`, '')
    out.push(`每一場結束時的積分區間（${ZONES.join('／')}）；「停在 100」是連續好幾場都在上限（贏球也加不上去）。`, '')
    out.push('| 聯盟 | 場數 | 0 | 1～20 | 21～79 | 80～99 | 100 | 每段停在 100 平均場數（約幾小時） | 最長一段 P50／最大（場） |')
    out.push('|---|---|---|---|---|---|---|---|---|')
    for (const t of [2, 3, 4]) {
      const z = ZONES.map((_, i) => sum(rs.map((r) => r.zones[t][i])))
      const total = sum(z)
      const runs = rs.flatMap((r) => r.maxRuns[t])
      const longest = rs.map((r) => r.longestAtMax[t]).filter((x) => x > 0)
      const avg = runs.length ? sum(runs) / runs.length : NaN
      out.push(`| ${LEAGUES[t].name} | ${total} | ${z.map((x) => pct(x, total)).join(' | ')} | ${fmt(avg, 0)}（${fmt((avg * 5) / 60, 1)}） | ${fmt(q(longest, 0.5), 0)}／${longest.length ? Math.max(...longest) : '—'} |`)
    }
  }
  zoneTable(short, `4. 積分分布與 100 分停滯（${D} 天，所有頻率與策略合計）`)
  if (long.length) zoneTable(long, `5. 積分分布與 100 分停滯（${long[0].days} 天長跑）`)

  out.push('', `## 6. 各聯盟勝率（${D} 天）`, '')
  out.push('| 策略 | ' + LEAGUES.map((l) => l.name).join(' | ') + ' |')
  out.push('|---|' + LEAGUES.map(() => '---').join('|') + '|')
  for (const s of ['B', 'E', 'D'] as Strategy[]) {
    const g = short.filter((r) => r.strategy === s)
    out.push(`| ${STRATEGY_NAMES[s]} | ` + LEAGUES.map((_, t) => pct(sum(g.map((r) => r.winsAt[t])), sum(g.map((r) => r.matchesAt[t])))).join(' | ') + ' |')
  }

  const rels = rows.flatMap((r) => r.relegations.map((e) => ({ ...e, s: r.sessions })))
  if (rels.length) {
    out.push('', '## 7. 降級發生在一次上線結算的第幾場（所有模擬）', '')
    out.push('| 每天上線 | 降級次數 | 那次上線結算幾場 P50 | 第幾場 P50／P90 | 降級後同一批改用新聯盟規劃的比賽（合計） |')
    out.push('|---|---|---|---|---|')
    for (const spd of [1, 3, 6]) {
      const e = rels.filter((x) => x.s === spd)
      if (e.length) out.push(`| ${spd} | ${e.length} | ${fmt(q(e.map((x) => x.batch), 0.5), 0)} | ${fmt(q(e.map((x) => x.nth), 0.5), 0)}／${fmt(q(e.map((x) => x.nth), 0.9), 0)} | ${sum(e.map((x) => x.batch - x.nth))} |`)
    }
  }

  out.push('', `## 8. 結算耗時（Node 模擬環境，${D} 天）`, '')
  out.push('| 每天上線 | 上線次數 | 每次結算場數 P50 | 每場耗時 P50（ms） | P90（ms） |')
  out.push('|---|---|---|---|---|')
  for (const spd of [1, 3, 6]) {
    const g = short.filter((r) => r.sessions === spd)
    const per = g.flatMap((r) => r.settleMs.map((ms, i) => (r.settleMatches[i] ? ms / r.settleMatches[i] : NaN)).filter(Number.isFinite))
    const n = g.flatMap((r) => r.settleMatches)
    if (g.length) out.push(`| ${spd} | ${n.length} | ${fmt(q(n, 0.5), 0)} | ${fmt(q(per, 0.5), 2)} | ${fmt(q(per, 0.9), 2)} |`)
  }
  out.push('', `聯盟：${LEAGUES.map((l, i) => `${i}=${l.name}`).join('、')}；規則：RANKED_CONFIG（勝 +${RANKED_CONFIG.winPoints}／敗 ${RANKED_CONFIG.lossPoints}、0～${RANKED_CONFIG.maxPoints}、起始 ${RANKED_CONFIG.initialPoints}、危險區 ≤ ${RANKED_CONFIG.dangerThreshold}、晉級後保護 ${RANKED_CONFIG.promotionProtectionMatches} 場）`)
  return out.join('\n')
}

const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as RunSummary[]

if (args.report) {
  console.log(report(load(args.report)))
} else {
  const out = args.out ?? 'docs/balance/data/phase7b-ranked.json'
  const n = Number(args.jobs ?? 2)
  if (args.part) {
    const [i, k] = args.part.split('/').map(Number)
    await runJobs(jobs().filter((_, idx) => idx % k === i), out)
  } else if (n > 1) await runParallel(n, out)
  else await runJobs(jobs(), out)
  if (!args.part) console.log(report(load(out)))
}
