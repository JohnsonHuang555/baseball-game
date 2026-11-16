// V2 放置結算的效能量測：npm run bench:v2:idle
// 量 1、10、96、1,000 場「做計畫 → 批次模擬 → 記帳 → 存檔」各段的耗時，以及存檔大小
import { planMatches, runBatch, yieldToMain } from '../src/v2/application/batchRunner'
import { settleOutcomes } from '../src/v2/application/settlementService'
import { ClubRepository, MemoryStorage, CLUB_STORAGE_KEY } from '../src/v2/infrastructure/clubRepository'
import { T0 } from '../src/v2/testkit'
import { MATCH_INTERVAL_MS } from '../src/v2/application/idleEngine'

const ms = (t: number) => `${t.toFixed(1)} ms`

async function measure(n: number, yieldControl: () => Promise<void> = () => Promise.resolve()) {
  const storage = new MemoryStorage()
  const repo = new ClubRepository(storage)
  const club = repo.createClub({ clubName: '效能測試', clubSeed: 1, clubId: 'bench', now: T0 })
  let t = performance.now()
  const plans = planMatches(club, 0, n)
  const tPlan = performance.now() - t
  t = performance.now()
  // 每 8 場讓出一次；表格用微任務代替，量的是模擬本身，最後一列用正式的 yieldToMain
  const batch = await runBatch(plans, { chunkSize: 8, yieldControl })
  const tSim = performance.now() - t
  t = performance.now()
  // 1,000 場超過放置一次 96 場的上限，這裡跳過時間錨點、只量記帳本身
  const settled = settleOutcomes(club, batch.outcomes, T0 + n * MATCH_INTERVAL_MS).club
  const tSettle = performance.now() - t
  t = performance.now()
  repo.saveClub(settled, club.revision)
  const tSave = performance.now() - t
  const size = storage.getItem(CLUB_STORAGE_KEY)!.length
  return { n, tPlan, tSim, tSettle, tSave, size, total: tPlan + tSim + tSettle + tSave }
}

await measure(200) // 暖機
console.log('場數 | 總耗時 | 每場 | 計畫 | 模擬 | 記帳 | 存檔 | 存檔大小')
for (const n of [1, 10, 96, 1000]) {
  const r = await measure(n)
  console.log(`${n} | ${ms(r.total)} | ${(r.total / n).toFixed(2)} ms | ${ms(r.tPlan)} | ${ms(r.tSim)} | ${ms(r.tSettle)} | ${ms(r.tSave)} | ${(r.size / 1024).toFixed(1)} KB`)
}

const real = await measure(96, yieldToMain)
console.log(`96（yieldToMain）| ${ms(real.total)} | ${(real.total / 96).toFixed(2)} ms | 模擬含讓出 ${ms(real.tSim)}`)
