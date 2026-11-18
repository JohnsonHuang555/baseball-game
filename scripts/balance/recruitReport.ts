// 招募市場的平衡比較：舊制（4,000／+800／隨機一位）、新制（2,000／+400／三選一）、折衷（3,000／+500／三選一）
// 在同樣的（策略、登入頻率、種子）上比較。
//   OLD=a.jsonl,b.jsonl NEW=... MID=... [OUT=xxx.md] npx vite-node scripts/balance/recruitReport.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { LEAGUES } from '../../src/v2/domain/leagueConfig'
import { assertSingleExperiment, type Experiment } from './experiment'
import { censoredQuantiles, dist, STRATEGY_NAMES, type SimResult } from './simulate'

type Run = SimResult & { experiment?: Experiment }

export function readRuns(files: string[]): Run[] {
  const runs = files.flatMap((f) => {
    const buf = readFileSync(f)
    const text = f.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Run)
  })
  assertSingleExperiment(runs)
  return runs
}

const key = (r: SimResult) => `${r.strategy}:${r.sessionsPerDay}:${r.seed}`
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—')
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')
const day = (x: number) => (x === Infinity ? '>30' : Number.isFinite(x) ? x.toFixed(1) : '—')

export interface VariantStats {
  n: number
  /** 第一次招募在第幾天（30 天沒招募算 >30） */
  firstRecruit: { p50: number; p90: number; reached: number }
  /** 球隊戰力（上場 14 人平均能力，含養成）第 7、14、30 天的平均 */
  power: Record<7 | 14 | 30, number>
  /** 30 天招募次數 */
  recruits: number
  /** 簽下的球員平均總評（Lv.1） */
  recruitOverall: number
  /** 三選一時，三位候選人裡最高總評的平均（看三選一提供多少「挑選空間」） */
  bestOfThreeOverall: number
  /** 簽下的人能力高於比較對象（預估差距 ≥ 0.3）的比例 */
  improveRate: number
  /** 第 30 天的資金、經驗餘額（資產＋未領取） */
  funds30: number
  exp30: number
  /** 30 天招募花費 */
  recruitSpent: number
  /** 30 天釋出次數（D 策略名單滿了會釋出最差的預備球員再招募） */
  releases: number
  /** 30 天升級花費（資金） */
  upgradeSpent: number
  /** 30 天累計支出（招募＋升級的資金） */
  totalSpent: number
  /** 30 天累計資金收入 */
  earned: number
  /** 第 30 天所在聯盟的分布（新秀…傳奇） */
  tierDist: number[]
  /** 30 天內到達職業、傳奇的比例；到傳奇的 P50 天數 */
  proRate: number
  legendRate: number
  legendP50: number
  legendP90: number
}

export function variantStats(runs: Run[]): VariantStats {
  const snapAt = (r: Run, d: number) => r.snapshots[d - 1]
  const recs = runs.flatMap((r) => r.recruits)
  const fr = censoredQuantiles(runs.map((r) => (r.recruits.length ? r.recruits[0].day : null)))
  const legend = censoredQuantiles(runs.map((r) => r.tiers[4].reachedDay))
  const last = (r: Run) => r.snapshots.at(-1)!
  return {
    n: runs.length,
    firstRecruit: { p50: fr.p50, p90: fr.p90, reached: fr.reached / Math.max(1, fr.n) },
    power: { 7: dist(runs.map((r) => snapAt(r, 7).power)).mean, 14: dist(runs.map((r) => snapAt(r, 14).power)).mean, 30: dist(runs.map((r) => last(r).power)).mean },
    recruits: dist(runs.map((r) => r.recruits.length)).mean,
    recruitOverall: dist(recs.map((x) => x.overall)).mean,
    bestOfThreeOverall: dist(recs.map((x) => Math.max(...x.candidates))).mean,
    improveRate: recs.length ? recs.filter((x) => x.improves).length / recs.length : NaN,
    funds30: dist(runs.map((r) => last(r).assets.funds + last(r).unclaimed.funds)).mean,
    exp30: dist(runs.map((r) => last(r).assets.experience + last(r).unclaimed.experience)).mean,
    recruitSpent: dist(runs.map((r) => last(r).spentRecruit.funds)).mean,
    releases: dist(runs.map((r) => r.ledger.releaseCount)).mean,
    upgradeSpent: dist(runs.map((r) => last(r).spentUpgrade.funds)).mean,
    totalSpent: dist(runs.map((r) => last(r).spentRecruit.funds + last(r).spentUpgrade.funds)).mean,
    earned: dist(runs.map((r) => last(r).earned.funds)).mean,
    tierDist: LEAGUES.map((_, t) => runs.filter((r) => last(r).tier === t).length / runs.length),
    proRate: runs.filter((r) => r.tiers[3].reachedDay !== null).length / runs.length,
    legendRate: legend.reached / Math.max(1, legend.n),
    legendP50: legend.p50,
    legendP90: legend.p90,
  }
}

const VARIANTS = [
  ['A 舊制', 'OLD'],
  ['B 新制', 'NEW'],
  ['C 折衷', 'MID'],
] as const

export function recruitReport(groups: Record<'OLD' | 'NEW' | 'MID', Run[]>): string {
  // 只比較三組都有的（策略、頻率、種子）
  const common = new Set(groups.OLD.map(key).filter((k) => groups.NEW.some((r) => key(r) === k) && groups.MID.some((r) => key(r) === k)))
  const pick = (rs: Run[], strategy: string, f: number) => rs.filter((r) => common.has(key(r)) && r.strategy === strategy && r.sessionsPerDay === f)
  const cells = [...new Set([...common].map((k) => k.split(':').slice(0, 2).join(':')))].sort()
  const head = [
    '策略',
    '每天',
    '方案',
    'n',
    '第一次招募（P50／P90 天）',
    '招募次數',
    '簽下的總評',
    '三人中最高總評',
    '能力高於比較對象',
    '戰力 第 7／14／30 天',
    '30 天招募花費',
    '第 30 天資金／經驗餘額',
    '到職業',
    '到傳奇（P50／P90 天）',
  ]
  const rows: string[] = []
  for (const cell of cells) {
    const [st, f] = cell.split(':')
    for (const [label, g] of VARIANTS) {
      const s = variantStats(pick(groups[g], st, Number(f)))
      rows.push(
        `| ${STRATEGY_NAMES[st as keyof typeof STRATEGY_NAMES]} | ${f} | ${label} | ${s.n} | ${day(s.firstRecruit.p50)}／${day(s.firstRecruit.p90)} | ${f1(s.recruits)} | ${f2(s.recruitOverall)} | ${f2(s.bestOfThreeOverall)} | ${pct(s.improveRate)} | ${f2(s.power[7])}／${f2(s.power[14])}／${f2(s.power[30])} | ${f0(s.recruitSpent)} | ${f0(s.funds30)}／${f0(s.exp30)} | ${pct(s.proRate)} | ${pct(s.legendRate)}（${day(s.legendP50)}／${day(s.legendP90)}） |`,
      )
    }
  }
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows].join('\n')
}

/** 招募操作與支出：30 天的簽約、釋出次數與累計支出（看積極招募的 D 反覆「釋出 → 招募」花了多少） */
export function spendingReport(groups: Record<'OLD' | 'NEW' | 'MID', Run[]>): string {
  const common = new Set(groups.OLD.map(key).filter((k) => groups.NEW.some((r) => key(r) === k) && groups.MID.some((r) => key(r) === k)))
  const cells = [...new Set([...common].map((k) => k.split(':').slice(0, 2).join(':')))].sort()
  const head = ['策略', '每天', '方案', 'n', '30 天簽約次數', '30 天釋出次數', '招募花費', '升級花費', '累計支出（招募＋升級）', '30 天資金收入', '招募佔收入']
  const rows: string[] = []
  for (const cell of cells) {
    const [st, f] = cell.split(':')
    for (const [label, g] of VARIANTS) {
      const s = variantStats(groups[g].filter((r) => common.has(key(r)) && r.strategy === st && r.sessionsPerDay === Number(f)))
      rows.push(
        `| ${STRATEGY_NAMES[st as keyof typeof STRATEGY_NAMES]} | ${f} | ${label} | ${s.n} | ${f1(s.recruits)} | ${f1(s.releases)} | ${f0(s.recruitSpent)} | ${f0(s.upgradeSpent)} | ${f0(s.totalSpent)} | ${f0(s.earned)} | ${pct(s.recruitSpent / s.earned)} |`,
      )
    }
  }
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows].join('\n')
}

if (process.env.OLD && process.env.NEW && process.env.MID) {
  const groups = { OLD: readRuns(process.env.OLD.split(',')), NEW: readRuns(process.env.NEW.split(',')), MID: readRuns(process.env.MID.split(',')) }
  const md = `${recruitReport(groups)}\n\n### 招募操作與支出（30 天）\n\n${spendingReport(groups)}`
  if (process.env.OUT) writeFileSync(process.env.OUT, md + '\n')
  else console.log(md)
}
