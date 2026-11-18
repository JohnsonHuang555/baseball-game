// 最高聯盟（傳奇）進度的比較：兩組矩陣結果（例如方案 S 與 S45）在同樣的種子、策略、登入頻率下比較
//   A=檔案1,檔案2 B=檔案3 LABEL_A=S LABEL_B=S45 [SEEDS=10] [OUT=xxx.md] npx vite-node scripts/balance/legend.ts
// 只比較兩邊都有的（策略、頻率、種子），避免不同種子造成的差異。
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { MAX_LEVEL } from '../../src/v2/domain/progressionConfig'
import { totalUpgradeCost } from '../../src/v2/domain/progression'
import { assertSingleExperiment, type Experiment } from './experiment'
import { censoredQuantiles, STRATEGY_NAMES, type SimResult } from './simulate'

const LEGEND = 4
const STUCK_DAYS = 14

export function readRuns(files: string[]): SimResult[] {
  const runs = files.flatMap((f) => {
    const buf = readFileSync(f)
    const text = f.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as SimResult & { experiment?: Experiment })
  })
  assertSingleExperiment(runs)
  return runs
}

/** 平均等級 L（可以是小數）的球員，從 Lv.1 累計花掉的經驗（相鄰整數等級之間線性內插） */
function cumExp(level: number): number {
  const lo = Math.max(1, Math.floor(level))
  const a = totalUpgradeCost(1, lo).experience
  if (lo >= MAX_LEVEL) return a
  return a + (totalUpgradeCost(1, lo + 1).experience - a) * (level - lo)
}

export interface LegendStats {
  n: number
  reachPct: number
  p10: number
  p50: number
  p90: number
  /** 到達傳奇那天的平均球員等級（只算有到達的） */
  levelAtReach: number
  /** 第 30 天的平均球員等級（只算有到達的） */
  levelDay30: number
  /** 第 30 天距離全隊 Lv.20 還差的經驗比例（用平均等級估算；只算有到達的） */
  roomPct: number
  /** 這些經驗以第 24～30 天的經驗收入還要幾天（只算有到達的） */
  roomDays: number
  /** 第 30 天卡在同一個聯盟（傳奇以外）14 天以上 */
  stuckPct: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export function legendStats(runs: SimResult[]): LegendStats {
  const reached = runs.filter((r) => r.tiers[LEGEND].reachedDay !== null)
  const q = censoredQuantiles(runs.map((r) => r.tiers[LEGEND].reachedDay))
  const snapAt = (r: SimResult, d: number) => r.snapshots[Math.min(r.snapshots.length - 1, Math.max(0, Math.ceil(d) - 1))]
  const room = reached.map((r) => {
    const s = r.snapshots.at(-1)!
    const full = cumExp(MAX_LEVEL)
    const left = s.players * (full - cumExp(s.avgLevel))
    const week = r.snapshots.at(-8)!
    const daily = (s.earned.experience - week.earned.experience) / 7
    return { pct: 1 - cumExp(s.avgLevel) / full, days: daily > 0 ? left / daily : Infinity }
  })
  const stuck = runs.filter((r) => {
    const s = r.snapshots.at(-1)!
    return s.tier < LEGEND && r.days - (r.tiers[s.tier].reachedDay ?? 0) >= STUCK_DAYS
  })
  return {
    n: runs.length,
    reachPct: reached.length / runs.length,
    p10: q.p10,
    p50: q.p50,
    p90: q.p90,
    levelAtReach: mean(reached.map((r) => snapAt(r, r.tiers[LEGEND].reachedDay!).avgLevel)),
    levelDay30: mean(reached.map((r) => r.snapshots.at(-1)!.avgLevel)),
    roomPct: mean(room.map((x) => x.pct)),
    roomDays: mean(room.map((x) => x.days).filter(Number.isFinite)),
    stuckPct: stuck.length / runs.length,
  }
}

const key = (r: SimResult) => `${r.strategy}:${r.sessionsPerDay}:${r.seed}`
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')
const dayFmt = (x: number) => (x === Infinity ? '>30' : Number.isFinite(x) ? x.toFixed(1) : '—')
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')

/** 兩組結果在共同的（策略、頻率、種子）上的比較表 */
export function compareLegend(a: SimResult[], b: SimResult[], labelA: string, labelB: string): string {
  const bKeys = new Set(b.map(key))
  const aKeys = new Set(a.map(key))
  const A = a.filter((r) => bKeys.has(key(r)))
  const B = b.filter((r) => aKeys.has(key(r)))
  const cells = [...new Set(A.map((r) => `${r.strategy}:${r.sessionsPerDay}`))].sort()
  const head = ['策略', '每天', '方案', 'n', '30 天到傳奇', '到傳奇 P10／P50／P90（天）', '到傳奇時平均等級', '第 30 天平均等級', '距全隊 Lv.20 的經驗', '約需幾天經驗收入', '卡關 ≥ 14 天']
  const rows: string[] = []
  for (const c of cells) {
    for (const [label, rs] of [[labelA, A], [labelB, B]] as const) {
      const s = legendStats(rs.filter((r) => `${r.strategy}:${r.sessionsPerDay}` === c))
      const [st, f] = c.split(':')
      rows.push(
        `| ${STRATEGY_NAMES[st as keyof typeof STRATEGY_NAMES]} | ${f} | ${label} | ${s.n} | ${pct(s.reachPct)} | ${dayFmt(s.p10)}／${dayFmt(s.p50)}／${dayFmt(s.p90)} | ${f1(s.levelAtReach)} | ${f1(s.levelDay30)} | ${pct(s.roomPct)} | ${f1(s.roomDays)} | ${pct(s.stuckPct)} |`,
      )
    }
  }
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows].join('\n')
}

if (process.env.A && process.env.B) {
  const seedLimit = process.env.SEEDS ? Number(process.env.SEEDS) : Infinity
  const pick = (rs: SimResult[]) => rs.filter((r) => r.seed < 1001 + seedLimit)
  const md = compareLegend(pick(readRuns(process.env.A.split(','))), pick(readRuns(process.env.B.split(','))), process.env.LABEL_A ?? 'A', process.env.LABEL_B ?? 'B')
  if (process.env.OUT) writeFileSync(process.env.OUT, md + '\n')
  else console.log(md)
}
