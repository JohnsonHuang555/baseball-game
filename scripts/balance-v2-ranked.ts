// Phase 7 RFC：競技積分／降級方案的平衡模擬（模擬專用數字，不是正式規則）。
//
//   npm run balance:v2:ranked                       # 預設：全部方案 × 每天 1／3／6 次 × B／E／D × 種子 1～3 × 45 天，2 個行程平行
//   npm run balance:v2:ranked -- --variants=C+3-2 --sessions=3 --strategies=E --seeds=1 --days=20 --jobs=1 --out=x.json
//   npm run balance:v2:ranked -- --approx            # 舊的整批近似（降級後同一批的比賽不重新規劃），用來比較
//   npm run balance:v2:ranked -- --report=docs/balance/data/phase7-ranked.json --compare=docs/balance/data/phase7-ranked-approx.json
//
// 每一筆結果都是正式服務實際跑出來的（見 scripts/balance/simulate.ts），積分只記在影子狀態（scripts/balance/ranked.ts）。
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRankedHook, RANKED_VARIANTS, ZONES } from './balance/ranked'
import { simulate, STRATEGY_NAMES, type Strategy } from './balance/simulate'
import { LEAGUES } from '../src/v2/domain/leagueConfig'

const argv = process.argv.slice(2).filter((a) => a !== '--')
const args = Object.fromEntries(argv.map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true'])) as Record<string, string>
const list = (k: string, def: string) => (args[k] ?? def).split(',').filter(Boolean)

export interface RunSummary {
  variant: string
  strategy: Strategy
  sessions: number
  seed: number
  days: number
  approx?: boolean
  /** 第一次到達各聯盟的天數（沒到 null） */
  reached: (number | null)[]
  /** 每一天結束時的聯盟 */
  tierByDay: number[]
  relegations: { day: number; from: number }[]
  returns: { from: number; days: number | null }[]
  matchesAt: number[]
  dangerAt: number[]
  worstBatchDrop: number[]
  oneBatchRelegations: number
  winRateAt: (number | null)[]
  sessionsTotal: number
  actions: number
  zoneMatches?: number[][]
  conflict?: { sessions: number; eligibleLow: number; highNotEligible: number }[]
  relegationBatch?: number[]
  rescues?: number
  staleAfterRelegation?: number
}

interface Job {
  variant: string
  sessions: number
  strategy: Strategy
  seed: number
}

function jobs(): Job[] {
  const out: Job[] = []
  for (const variant of list('variants', Object.keys(RANKED_VARIANTS).join(',')))
    for (const sessions of list('sessions', '1,3,6').map(Number))
      for (const strategy of list('strategies', 'B,E,D') as Strategy[]) for (const seed of list('seeds', '1,2,3').map(Number)) out.push({ variant, sessions, strategy, seed })
  return out
}

async function runJobs(todo: Job[], out: string): Promise<void> {
  const days = Number(args.days ?? 45)
  const approx = args.approx === 'true'
  const rows: RunSummary[] = []
  const t0 = Date.now()
  for (const j of todo) {
    const rules = RANKED_VARIANTS[j.variant]
    if (rules === undefined) throw new Error(`沒有這個方案：${j.variant}`)
    const hook = rules ? createRankedHook(rules) : undefined
    const r = await simulate({ strategy: j.strategy, seed: j.seed, sessionsPerDay: j.sessions, days, ranked: hook, rankedApprox: approx })
    const log = r.ranked
    rows.push({
      ...j,
      days,
      approx,
      reached: r.tiers.map((t) => t.reachedDay),
      tierByDay: r.snapshots.map((s) => s.tier),
      relegations: log?.events.filter((e) => e.kind === 'relegate').map((e) => ({ day: e.day, from: e.from })) ?? [],
      returns: log?.returns ?? [],
      matchesAt: log?.matchesAt ?? r.tiers.map((t) => t.games),
      dangerAt: log?.dangerAt ?? r.tiers.map(() => 0),
      worstBatchDrop: log?.worstBatchDrop ?? r.tiers.map(() => 0),
      oneBatchRelegations: log?.oneBatchRelegations ?? 0,
      winRateAt: r.tiers.map((t) => (t.games ? t.wins / t.games : null)),
      sessionsTotal: r.snapshots.at(-1)?.sessions ?? 0,
      actions: r.snapshots.at(-1)?.actions ?? 0,
      zoneMatches: log?.zoneMatches,
      conflict: log?.conflict,
      relegationBatch: log?.relegationBatch,
      rescues: log?.events.filter((e) => e.kind === 'rescue').length ?? 0,
      staleAfterRelegation: log?.staleAfterRelegation ?? 0,
    })
    const last = rows.at(-1)!
    console.error(`${j.variant} ${j.sessions}x ${j.strategy} s${j.seed}: 聯盟 ${last.tierByDay.join('')}  降級 ${last.relegations.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    writeFileSync(out, JSON.stringify(rows))
  }
}

/** 把工作平均分給 n 個子行程（同一份腳本，用 --part=i/n 只跑自己那份），跑完合併 */
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
  const order = jobs().map((j) => `${j.variant}|${j.sessions}|${j.strategy}|${j.seed}`)
  const rows = parts.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as RunSummary[])
  rows.sort((a, b) => order.indexOf(`${a.variant}|${a.sessions}|${a.strategy}|${a.seed}`) - order.indexOf(`${b.variant}|${b.sessions}|${b.strategy}|${b.seed}`))
  writeFileSync(out, JSON.stringify(rows))
  for (const f of parts) rmSync(f, { force: true })
}

// ---- 報告 ----

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
}
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** 從 a 到 b 的天數（只算兩者都到的） */
function span(rows: RunSummary[], a: number, b: number) {
  const xs: number[] = []
  let reached = 0
  let started = 0
  for (const r of rows) {
    const s = r.reached[a]
    if (s === null) continue
    started++
    const e = r.reached[b]
    if (e === null) continue
    reached++
    xs.push(e - s)
  }
  return { started, reached, p50: q(xs, 0.5) }
}

function cell(rs: RunSummary[]) {
  const relPer = (tier: number) => {
    const n = sum(rs.map((r) => r.relegations.filter((e) => e.from === tier).length))
    const m = sum(rs.map((r) => r.matchesAt[tier]))
    return m ? (n / m) * 1000 : NaN
  }
  const rets = rs.flatMap((r) => r.returns)
  const back = rets.filter((x) => x.days !== null).map((x) => x.days!)
  return {
    a: span(rs, 0, 2),
    b: span(rs, 2, 3),
    c: span(rs, 3, 4),
    rel: rs.filter((r) => r.relegations.length > 0).length,
    relTotal: sum(rs.map((r) => r.relegations.length)),
    rel3: relPer(3),
    rel4: relPer(4),
    back,
    rets,
    oneBatch: sum(rs.map((r) => r.oneBatchRelegations)),
    atTop: rs.filter((r) => r.tierByDay.at(-1) === 4).length,
    rescues: sum(rs.map((r) => r.rescues ?? 0)),
    stale: sum(rs.map((r) => r.staleAfterRelegation ?? 0)),
  }
}

export function report(rows: RunSummary[], compare?: RunSummary[]): string {
  const out: string[] = []
  const variants = [...new Set(rows.map((r) => r.variant))]
  const days = rows[0]?.days ?? 0
  out.push(`## 方案比較（${days} 天，${rows[0]?.approx ? '整批近似' : '分段結算'}；每格 n = 策略 × 種子 數）`, '')
  out.push('| 方案 | 每天 | n | 新秀→挑戰者 P50 | 挑戰者→職業 P50（到達率） | 職業→傳奇 P50（到達率） | 有降級的球團 | 職業降級／千場 | 傳奇降級／千場 | 降級後重返 P50 天（重返率） | 一次上線就從安全區被降級 | 保級緩衝觸發 | 最後一天在傳奇 |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const v of variants) {
    for (const spd of [1, 3, 6]) {
      const rs = rows.filter((r) => r.variant === v && r.sessions === spd)
      if (!rs.length) continue
      const x = cell(rs)
      out.push(
        `| ${v} | ${spd} | ${rs.length} | ${fmt(x.a.p50)} | ${fmt(x.b.p50)}（${pct(x.b.reached, x.b.started)}） | ${fmt(x.c.p50)}（${pct(x.c.reached, x.c.started)}） | ${pct(x.rel, rs.length)} | ${fmt(x.rel3, 2)} | ${fmt(x.rel4, 2)} | ${fmt(q(x.back, 0.5))}（${pct(x.back.length, x.rets.length)}） | ${x.relTotal ? `${x.oneBatch}／${x.relTotal}` : '—'} | ${x.rescues || '—'} | ${pct(x.atTop, rs.length)} |`,
      )
    }
  }

  out.push('', '## 依策略（所有頻率合計）', '')
  out.push('| 方案 | 策略 | 到傳奇率 | 平均降級次數 | 職業勝率 | 傳奇勝率 | 職業危險區場數比例 | 傳奇危險區場數比例 |')
  out.push('|---|---|---|---|---|---|---|---|')
  for (const v of variants) {
    for (const s of ['B', 'E', 'D'] as Strategy[]) {
      const rs = rows.filter((r) => r.variant === v && r.strategy === s)
      if (!rs.length) continue
      const wr = (t: number) => {
        const xs = rs.map((r) => r.winRateAt[t]).filter((x): x is number => x !== null)
        return xs.length ? `${fmt((sum(xs) / xs.length) * 100)}%` : '—'
      }
      const dz = (t: number) => pct(sum(rs.map((r) => r.dangerAt[t])), sum(rs.map((r) => r.matchesAt[t])))
      out.push(`| ${v} | ${STRATEGY_NAMES[s]} | ${pct(rs.filter((r) => r.reached[4] !== null).length, rs.length)} | ${fmt(sum(rs.map((r) => r.relegations.length)) / rs.length, 2)} | ${wr(3)} | ${wr(4)} | ${dz(3)} | ${dz(4)} |`)
    }
  }

  const classic = (v: string) => {
    const r = RANKED_VARIANTS[v]
    return r?.kind === 'points' && r.promotion === 'classic'
  }
  const zoned = rows.filter((r) => r.zoneMatches && r.conflict && classic(r.variant))
  if (zoned.length) {
    out.push('', '## 方案 C／D：積分分布與晉級條件是否矛盾', '')
    out.push(`每一場結束時積分落在哪個區間（${ZONES.join('／')}），以及每次上線時「100 場＋60%」與「積分 ≥ 80」是否一致。C 只在職業、傳奇顯示積分；D 從挑戰者開始顯示——兩者的比賽結果相同，所以挑戰者那一列就是 D 玩家會看到的積分。`, '')
    out.push('| 方案 | 聯盟 | 場數 | 0 | 1～20 | 21～79 | ≥ 80 | 上線檢查次數 | 已達晉級條件但積分 < 80 | 積分 ≥ 80 但未達晉級條件 |')
    out.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const v of [...new Set(zoned.map((r) => r.variant))]) {
      for (const t of [2, 3, 4]) {
        const rs = zoned.filter((r) => r.variant === v)
        const z = ZONES.map((_, i) => sum(rs.map((r) => r.zoneMatches![t][i])))
        const total = sum(z)
        const k = { s: sum(rs.map((r) => r.conflict![t].sessions)), lo: sum(rs.map((r) => r.conflict![t].eligibleLow)), hi: sum(rs.map((r) => r.conflict![t].highNotEligible)) }
        out.push(`| ${v} | ${LEAGUES[t].name} | ${total} | ${z.map((x) => pct(x, total)).join(' | ')} | ${t < 4 ? k.s : '—'} | ${t < 4 ? pct(k.lo, k.s) : '—'} | ${t < 4 ? pct(k.hi, k.s) : '—'} |`)
      }
    }
  }

  const batches = rows.flatMap((r) => (r.relegationBatch ?? []).map((m) => ({ s: r.sessions, m })))
  if (batches.length) {
    out.push('', '## 降級發生在一次上線的第幾場離線結算', '')
    out.push('| 每天上線 | 降級次數 | 第幾場 P50 | P90 |')
    out.push('|---|---|---|---|')
    for (const spd of [1, 3, 6]) {
      const ms = batches.filter((b) => b.s === spd).map((b) => b.m)
      if (ms.length) out.push(`| ${spd} | ${ms.length} | ${fmt(q(ms, 0.5), 0)} | ${fmt(q(ms, 0.9), 0)} |`)
    }
  }

  if (compare?.length) {
    out.push('', '## 分段結算 vs 整批近似', '')
    out.push('整批近似：一次上線的離線比賽全部用上線當時的聯盟規劃，結算完才算積分，降級後同一批剩下的比賽仍是舊聯盟的對手與收益倍率、而且不計分。分段結算：降級那一場之後的比賽改用新聯盟規劃（等同正式設計）。每格「分段／整批」。', '')
    out.push('| 方案 | 每天 | 降級次數 | 職業降級／千場 | 傳奇降級／千場 | 重返 P50 天 | 一次上線就被降級 | 挑戰者→職業 P50 | 最後一天在傳奇 | 整批：降級後仍用舊聯盟的比賽 |')
    out.push('|---|---|---|---|---|---|---|---|---|---|')
    for (const v of variants) {
      for (const spd of [1, 3, 6]) {
        const a = rows.filter((r) => r.variant === v && r.sessions === spd)
        const b = compare.filter((r) => r.variant === v && r.sessions === spd)
        if (!a.length || !b.length || v === 'BASE') continue
        const x = cell(a)
        const y = cell(b)
        const staleKnown = b.some((r) => r.staleAfterRelegation !== undefined)
        out.push(
          `| ${v} | ${spd} | ${x.relTotal}／${y.relTotal} | ${fmt(x.rel3, 2)}／${fmt(y.rel3, 2)} | ${fmt(x.rel4, 2)}／${fmt(y.rel4, 2)} | ${fmt(q(x.back, 0.5))}／${fmt(q(y.back, 0.5))} | ${x.oneBatch}／${y.oneBatch} | ${fmt(x.b.p50)}／${fmt(y.b.p50)} | ${pct(x.atTop, a.length)}／${pct(y.atTop, b.length)} | ${!staleKnown ? '（未記錄）' : y.relTotal ? `${y.stale} 場（每次降級約 ${fmt(y.stale / y.relTotal, 0)} 場）` : '—'} |`,
        )
      }
    }
  }
  out.push('', `聯盟：${LEAGUES.map((l, i) => `${i}=${l.name}`).join('、')}`)
  return out.join('\n')
}

const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as RunSummary[]
const defaultOut = args.approx === 'true' ? 'docs/balance/data/phase7-ranked-approx.json' : 'docs/balance/data/phase7-ranked.json'
const compareFile = args.compare ?? (args.approx === 'true' ? undefined : 'docs/balance/data/phase7-ranked-approx.json')
const tryLoad = (f?: string) => {
  try {
    return f ? load(f) : undefined
  } catch {
    return undefined
  }
}

if (args.report) {
  console.log(report(load(args.report), tryLoad(args.compare)))
} else {
  const out = args.out ?? defaultOut
  const n = Number(args.jobs ?? 2)
  if (args.part) {
    const [i, k] = args.part.split('/').map(Number)
    await runJobs(jobs().filter((_, idx) => idx % k === i), out)
  } else if (n > 1) await runParallel(n, out)
  else await runJobs(jobs(), out)
  if (!args.part) console.log(report(load(out), tryLoad(compareFile)))
}
