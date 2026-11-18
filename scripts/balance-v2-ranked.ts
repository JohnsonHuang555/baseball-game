// Phase 7 RFC：競技積分／降級方案的平衡模擬（模擬專用數字，不是正式規則）。
//
//   npm run balance:v2:ranked                       # 預設：全部方案 × 每天 1／3／6 次 × B／E／D × 種子 1～4 × 45 天
//   npm run balance:v2:ranked -- --variants=A+2-2,B40 --sessions=3 --strategies=E --seeds=1,2 --days=30 --out=x.json
//   npm run balance:v2:ranked -- --report=docs/balance/data/phase7-ranked.json   # 只從已經跑好的結果產生表格
//
// 每一筆結果都是正式服務實際跑出來的（見 scripts/balance/simulate.ts），積分只記在影子狀態（scripts/balance/ranked.ts）。
import { readFileSync, writeFileSync } from 'node:fs'
import { createRankedHook, RANKED_VARIANTS } from './balance/ranked'
import { simulate, STRATEGY_NAMES, type Strategy } from './balance/simulate'
import { LEAGUES } from '../src/v2/domain/leagueConfig'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')) as [string, string][])
const list = (k: string, def: string) => (args[k] ?? def).split(',').filter(Boolean)

export interface RunSummary {
  variant: string
  strategy: Strategy
  sessions: number
  seed: number
  days: number
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
}

async function run() {
  const variants = list('variants', Object.keys(RANKED_VARIANTS).join(','))
  const sessions = list('sessions', '1,3,6').map(Number)
  const strategies = list('strategies', 'B,E,D') as Strategy[]
  const seeds = list('seeds', '1,2,3,4').map(Number)
  const days = Number(args.days ?? 45)
  const out = args.out ?? 'docs/balance/data/phase7-ranked.json'
  const rows: RunSummary[] = []
  const t0 = Date.now()
  for (const variant of variants) {
    for (const spd of sessions) {
      for (const strategy of strategies) {
        for (const seed of seeds) {
          const rules = RANKED_VARIANTS[variant]
          if (rules === undefined) throw new Error(`沒有這個方案：${variant}`)
          const hook = rules ? createRankedHook(rules) : undefined
          const r = await simulate({ strategy, seed, sessionsPerDay: spd, days, ranked: hook })
          const log = r.ranked
          rows.push({
            variant,
            strategy,
            sessions: spd,
            seed,
            days,
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
          })
          console.error(`${variant} ${spd}x ${strategy} s${seed}: 聯盟 ${rows.at(-1)!.tierByDay.join('')}  降級 ${rows.at(-1)!.relegations.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
          writeFileSync(out, JSON.stringify(rows))
        }
      }
    }
  }
  return out
}

// ---- 報告 ----

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]
}
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—')

/** 從 a 到 b 的天數（設限：沒到算 >days） */
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
  return { started, reached, p50: q(xs, 0.5), p90: q(xs, 0.9) }
}

export function report(rows: RunSummary[]): string {
  const out: string[] = []
  const variants = [...new Set(rows.map((r) => r.variant))]
  const days = rows[0]?.days ?? 0
  out.push(`## 方案比較（${days} 天，每格 n = 同方案同頻率的 策略 × 種子 數）`, '')
  out.push('| 方案 | 每天 | n | 新秀→挑戰者 P50 | 挑戰者→職業 P50（到達率） | 職業→傳奇 P50（到達率） | 有降級的球團 | 職業降級／千場 | 傳奇降級／千場 | 降級後重返 P50 天（重返率） | 單次上線就被降級 | 最後一天在傳奇 |')
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const v of variants) {
    for (const spd of [1, 3, 6]) {
      const rs = rows.filter((r) => r.variant === v && r.sessions === spd)
      if (!rs.length) continue
      const a = span(rs, 0, 2)
      const b = span(rs, 2, 3)
      const c = span(rs, 3, 4)
      const rel = rs.filter((r) => r.relegations.length > 0).length
      const relPer = (tier: number) => {
        const n = rs.reduce((x, r) => x + r.relegations.filter((e) => e.from === tier).length, 0)
        const m = rs.reduce((x, r) => x + r.matchesAt[tier], 0)
        return m ? fmt((n / m) * 1000, 2) : '—'
      }
      const rets = rs.flatMap((r) => r.returns)
      const back = rets.filter((x) => x.days !== null).map((x) => x.days!)
      const oneBatch = rs.reduce((x, r) => x + r.oneBatchRelegations, 0)
      const relTotal = rs.reduce((x, r) => x + r.relegations.length, 0)
      const atTop = rs.filter((r) => r.tierByDay.at(-1) === 4).length
      out.push(`| ${v} | ${spd} | ${rs.length} | ${fmt(a.p50)} | ${fmt(b.p50)}（${pct(b.reached, b.started)}） | ${fmt(c.p50)}（${pct(c.reached, c.started)}） | ${pct(rel, rs.length)} | ${relPer(3)} | ${relPer(4)} | ${fmt(q(back, 0.5))}（${pct(back.length, rets.length)}） | ${relTotal ? `${oneBatch}／${relTotal}` : '—'} | ${pct(atTop, rs.length)} |`)
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
        return xs.length ? `${fmt((xs.reduce((a, b) => a + b, 0) / xs.length) * 100)}%` : '—'
      }
      const dz = (t: number) => pct(rs.reduce((x, r) => x + r.dangerAt[t], 0), rs.reduce((x, r) => x + r.matchesAt[t], 0))
      out.push(`| ${v} | ${STRATEGY_NAMES[s]} | ${pct(rs.filter((r) => r.reached[4] !== null).length, rs.length)} | ${fmt(rs.reduce((x, r) => x + r.relegations.length, 0) / rs.length, 2)} | ${wr(3)} | ${wr(4)} | ${dz(3)} | ${dz(4)} |`)
    }
  }
  out.push('', `聯盟：${LEAGUES.map((l, i) => `${i}=${l.name}`).join('、')}`)
  return out.join('\n')
}

if (args.report) {
  console.log(report(JSON.parse(readFileSync(args.report, 'utf8'))))
} else {
  const file = await run()
  console.log(report(JSON.parse(readFileSync(file, 'utf8'))))
}
