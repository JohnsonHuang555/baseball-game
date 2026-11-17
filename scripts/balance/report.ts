// 把平衡模擬矩陣（matrix.ts 的 JSONL）整理成 Markdown 表格：IN=檔案1,檔案2  OUT=xxx.md  TITLE=標題
import { assertSingleExperiment, type Experiment } from './experiment'
import { readFileSync, writeFileSync } from 'node:fs'
import { LEAGUES } from '../../src/v2/domain/leagueConfig'
import { STRATEGIES, STRATEGY_NAMES, censoredQuantiles, dist, type SimResult, type Strategy } from './simulate'

export function loadRuns(files: string[]): SimResult[] {
  const runs = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SimResult & { experiment?: Experiment }))
  assertSingleExperiment(runs)
  return runs
}

const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—')
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—')
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—')
const day = (x: number) => (x === Infinity ? '>30' : Number.isFinite(x) ? x.toFixed(1) : '—')

function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

export const CHECK_DAYS = [1, 3, 7, 14, 30]

export function groups(runs: SimResult[]) {
  const freqs = [...new Set(runs.map((r) => r.sessionsPerDay))].sort((a, b) => a - b)
  const strats = STRATEGIES.filter((s) => runs.some((r) => r.strategy === s))
  const pick = (s: Strategy, f: number) => runs.filter((r) => r.strategy === s && r.sessionsPerDay === f)
  return { freqs, strats, pick }
}

/** 某一天到下一個檢查點之間的勝率（期間勝率） */
function periodWinRate(r: SimResult, dayIdx: number, prevIdx: number): number {
  const a = r.snapshots[dayIdx]
  const b = prevIdx >= 0 ? r.snapshots[prevIdx] : { wins: 0, losses: 0 }
  const w = a.wins - b.wins
  const l = a.losses - b.losses
  return w / Math.max(1, w + l)
}

export function summaryJson(runs: SimResult[]) {
  const { freqs, strats, pick } = groups(runs)
  const out: Record<string, unknown> = {}
  for (const f of freqs)
    for (const s of strats) {
      const rs = pick(s, f)
      const at = (d: number) => rs.map((r) => r.snapshots[d - 1])
      out[`${s}:${f}`] = {
        n: rs.length,
        days: Object.fromEntries(
          CHECK_DAYS.map((d, i) => [
            d,
            {
              power: dist(at(d).map((x) => x.power)),
              avgLevel: dist(at(d).map((x) => x.avgLevel)),
              tier: dist(at(d).map((x) => x.tier)),
              periodWinRate: dist(rs.map((r) => periodWinRate(r, d - 1, i === 0 ? -1 : CHECK_DAYS[i - 1] - 1))),
              fundsLeft: dist(at(d).map((x) => x.assets.funds)),
              expLeft: dist(at(d).map((x) => x.assets.experience)),
            },
          ]),
        ),
        reach: LEAGUES.slice(1).map((_, k) => censoredQuantiles(rs.map((r) => r.tiers[k + 1].reachedDay))),
        attempts: dist(rs.map((r) => r.tiers.reduce((a, t) => a + t.attempts, 0))),
        finalTier: rs.map((r) => r.snapshots.at(-1)!.tier),
      }
    }
  return out
}

export function report(runs: SimResult[], title: string): string {
  const { freqs, strats, pick } = groups(runs)
  const seeds = [...new Set(runs.map((r) => r.seed))].sort((a, b) => a - b)
  const lines: string[] = [`## ${title}`, '', `樣本：${seeds.length} 個球團種子（${seeds[0]}～${seeds.at(-1)}），每個種子 × ${freqs.length} 種登入頻率 × ${strats.length} 種策略，共 ${runs.length} 次 30 天模擬。`, '']

  // 1. 登入頻率的時間與場數
  lines.push('### 登入頻率：真實時間、有效結算時間、上線與操作次數（第 30 天，B 平均養成）', '')
  lines.push(
    table(
      ['每天上線', '經過的真實時間', '已結算場數', '系統有效結算時間', '有效比例', '上線次數', '操作次數（P50）'],
      freqs.map((f) => {
        const rs = pick('B', f).length ? pick('B', f) : pick(strats[0], f)
        const last = rs.map((r) => r.snapshots.at(-1)!)
        return [`${f} 次`, `${f1(last[0].realHours)} 小時`, f0(last[0].matches), `${f1(last[0].settledHours)} 小時`, pct(last[0].settledHours / last[0].realHours), last[0].sessions, f0(dist(last.map((x) => x.actions)).p50)]
      }),
    ),
    '',
  )

  // 2. 各策略在各檢查點的戰力、等級、聯盟、勝率
  for (const f of freqs) {
    lines.push(`### 每天上線 ${f} 次：戰力、等級、聯盟、期間勝率（P50，括號是 P10～P90）`, '')
    const rows: (string | number)[][] = []
    for (const s of strats) {
      const rs = pick(s, f)
      CHECK_DAYS.forEach((d, i) => {
        const xs = rs.map((r) => r.snapshots[d - 1])
        const pw = dist(xs.map((x) => x.power))
        const lv = dist(xs.map((x) => x.avgLevel))
        const tier = dist(xs.map((x) => x.tier + 1))
        const wr = dist(rs.map((r) => periodWinRate(r, d - 1, i === 0 ? -1 : CHECK_DAYS[i - 1] - 1)))
        rows.push([i === 0 ? STRATEGY_NAMES[s] : '', d, `${f2(pw.p50)}（${f2(pw.p10)}～${f2(pw.p90)}）`, `${f1(lv.p50)}`, `${f1(tier.mean)}（${f0(tier.min)}～${f0(tier.max)}）`, `${pct(wr.p50)}（${pct(wr.p10)}～${pct(wr.p90)}）`, f0(dist(xs.map((x) => x.assets.funds)).p50), f0(dist(xs.map((x) => x.assets.experience)).p50)])
      })
    }
    lines.push(table(['策略', '天', '上場平均能力', '上場平均等級', '聯盟（平均，最低～最高）', '期間勝率', '剩餘資金', '剩餘經驗'], rows), '')
  }

  // 3. 聯盟晉級
  for (const f of freqs) {
    lines.push(`### 每天上線 ${f} 次：到達各聯盟的天數（P50／P90，>30 代表一半或一成以上的樣本 30 天內沒到）與 30 天內到達比例`, '')
    lines.push(
      table(
        ['策略', ...LEAGUES.slice(1).map((l) => l.name), '平均挑戰次數', '挑戰失敗率', '平均冷卻場數', '第 30 天停在新秀聯盟'],
        strats.map((s) => {
          const rs = pick(s, f)
          const cols = LEAGUES.slice(1).map((_, k) => {
            const q = censoredQuantiles(rs.map((r) => r.tiers[k + 1].reachedDay))
            return `${day(q.p50)}／${day(q.p90)}（${pct(q.reached / q.n)}）`
          })
          const att = rs.reduce((a, r) => a + r.tiers.reduce((x, t) => x + t.attempts, 0), 0)
          const suc = rs.reduce((a, r) => a + r.tiers.reduce((x, t) => x + t.successes, 0), 0)
          const cd = rs.reduce((a, r) => a + r.tiers.reduce((x, t) => x + t.cooldownMatches, 0), 0)
          const stuck = rs.filter((r) => r.snapshots.at(-1)!.tier === 0).length
          return [STRATEGY_NAMES[s], ...cols, f1(att / rs.length), pct(att ? 1 - suc / att : NaN), f1(cd / rs.length), pct(stuck / rs.length)]
        }),
      ),
      '',
    )
  }

  // 4. 各聯盟的勝率與停留時間（所有頻率合計）
  lines.push('### 各聯盟一般比賽的勝率（所有登入頻率合計）與平均停留天數', '')
  lines.push(
    table(
      ['策略', ...LEAGUES.map((l) => `${l.name} 勝率`), ...LEAGUES.slice(0, 4).map((l) => `${l.name} 停留（天，P50）`)],
      strats.map((s) => {
        const rs = runs.filter((r) => r.strategy === s)
        const wr = LEAGUES.map((_, t) => {
          const g = rs.reduce((a, r) => a + r.tiers[t].games, 0)
          return g ? pct(rs.reduce((a, r) => a + r.tiers[t].wins, 0) / g) : '—'
        })
        const stay = LEAGUES.slice(0, 4).map((_, t) => {
          const xs = rs.filter((r) => r.tiers[t].reachedDay !== null).map((r) => (r.tiers[t + 1].reachedDay ?? r.days) - r.tiers[t].reachedDay!)
          return f1(dist(xs).p50)
        })
        return [STRATEGY_NAMES[s], ...wr, ...stay]
      }),
    ),
    '',
  )

  // 5. 30 天收支
  for (const f of freqs) {
    lines.push(`### 每天上線 ${f} 次：30 天收支（平均）`, '')
    lines.push(
      table(
        ['策略', '勝場資金', '敗場資金', '得分資金', '聯盟倍率加成', '晉級獎勵（資金／經驗）', '總收入（資金／經驗）', '升級支出（資金／經驗）', '招募支出', '剩餘＋未領取（資金／經驗）', '資金閒置比例', '經驗閒置比例'],
        strats.map((s) => {
          const rs = pick(s, f)
          const m = (fn: (r: SimResult) => number) => dist(rs.map(fn)).mean
          const last = (r: SimResult) => r.snapshots.at(-1)!
          const ef = m((r) => last(r).earned.funds)
          const ee = m((r) => last(r).earned.experience)
          const lf = m((r) => last(r).assets.funds + last(r).unclaimed.funds)
          const le = m((r) => last(r).assets.experience + last(r).unclaimed.experience)
          return [
            STRATEGY_NAMES[s],
            f0(m((r) => r.ledger.baseWinFunds)),
            f0(m((r) => r.ledger.baseLossFunds)),
            f0(m((r) => r.ledger.runFunds)),
            `${f0(m((r) => r.ledger.multiplierFunds))}／${f0(m((r) => r.ledger.multiplierExp))}`,
            `${f0(m((r) => r.ledger.promotion.funds))}／${f0(m((r) => r.ledger.promotion.experience))}`,
            `${f0(ef)}／${f0(ee)}`,
            `${f0(m((r) => r.ledger.upgrades.funds))}／${f0(m((r) => r.ledger.upgrades.experience))}`,
            f0(m((r) => r.ledger.recruits.funds)),
            `${f0(lf)}／${f0(le)}`,
            pct(lf / ef),
            pct(le / ee),
          ]
        }),
      ),
      '',
    )
  }
  return lines.join('\n')
}

if (process.env.IN) {
  const files = (process.env.IN ?? '').split(',').filter(Boolean)
  const runs = loadRuns(files)
  const md = report(runs, process.env.TITLE ?? '平衡模擬')
  if (process.env.OUT) {
    writeFileSync(process.env.OUT, md)
    writeFileSync(process.env.OUT.replace(/\.md$/, '.summary.json'), JSON.stringify(summaryJson(runs)))
  } else console.log(md)
}
