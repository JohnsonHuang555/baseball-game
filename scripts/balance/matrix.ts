// 平衡模擬矩陣：策略 × 登入頻率 × 種子，每一次模擬的結果寫成一行 JSON（可以分片平行跑、中斷後接著跑）。
//   SEEDS=30（數量，種子是 1001、1002、…）或 SEEDS=101,202（列表）
//   FREQS=1,2,3,6  STRATS=A,B,C,D,E  DAYS=30  SHARD=0/2  OUT=docs/balance/data/xxx.jsonl  CANDIDATE=main|pre6c|S|S45|B|C|Y|X
// 每一筆結果帶著實驗設定（experiment.ts）：同一個 OUT 只能接續同樣的候選方案、天數、格式與數值；不同就停止，請換檔名。
// 分片時每一片用自己的 OUT（兩個程序寫同一個檔案不安全）。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { applyCandidate } from './candidates'
import { completedJobs, currentExperiment, jobKey } from './experiment'
import { STRATEGIES, simulate, type Strategy } from './simulate'

// CANDIDATE=B：用候選方案的數值跑（只影響這個程序）
const candidate = applyCandidate(process.env.CANDIDATE)
console.log(`數值：${candidate}`)

const seedsEnv = process.env.SEEDS ?? '30'
const SEEDS = seedsEnv.includes(',') ? seedsEnv.split(',').map(Number) : Array.from({ length: Number(seedsEnv) }, (_, i) => 1001 + i)
const FREQS = (process.env.FREQS ?? '1,2,3,6').split(',').map(Number)
const STRATS = (process.env.STRATS ?? STRATEGIES.join(',')).split(',') as Strategy[]
const DAYS = Number(process.env.DAYS ?? 30)
const [shard, shards] = (process.env.SHARD ?? '0/1').split('/').map(Number)
const OUT = process.env.OUT ?? 'matrix.jsonl'

// 每一筆結果都帶著實驗設定（候選方案、天數、格式、存檔版本、數值指紋）；接續時設定不同就停止
const experiment = currentExperiment(process.env.CANDIDATE ?? 'main', DAYS)
const done = existsSync(OUT) ? completedJobs(readFileSync(OUT, 'utf8'), experiment) : new Set<string>()
const jobs = SEEDS.flatMap((seed) => FREQS.flatMap((f) => STRATS.map((s) => ({ seed, f, s })))).filter((_, i) => i % shards === shard)
const t0 = performance.now()
let n = 0
for (const j of jobs) {
  if (done.has(jobKey(j.s, j.f, j.seed))) continue
  const r = await simulate({ strategy: j.s, seed: j.seed, sessionsPerDay: j.f, days: DAYS })
  appendFileSync(OUT, JSON.stringify({ ...r, experiment }) + '\n')
  n++
  if (n % 10 === 0) console.log(`[${shard}/${shards}] ${n} 次，${((performance.now() - t0) / 60000).toFixed(1)} 分鐘`)
}
console.log(`[${shard}/${shards}] 完成 ${n} 次，${((performance.now() - t0) / 60000).toFixed(1)} 分鐘`)
