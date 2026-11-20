// Phase 9 PR 3：特性訓練對離線結算效能的影響。npm run bench:v2:traits [-- --reps=5]
// 每個情境都是「離線 8 小時、一次結算 96 場」，用正式的 settleDue（含分段、存檔）。重複 reps 次取中位數
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { recruit, startTraining } from '../src/v2/application/economyService'
import { settleDue } from '../src/v2/application/settlementService'
import { leagueAtTier } from '../src/v2/domain/league'
import { recordOf, reserves } from '../src/v2/domain/roster'
import { trainingOptions } from '../src/v2/domain/traitTraining'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, MINUTE, ManualClock, T0, tab } from '../src/v2/testkit'

const REPS = Number(process.argv.find((a) => a.startsWith('--reps='))?.split('=')[1] ?? 5)
type Deps = ReturnType<typeof tab>
const rich = { funds: 10_000_000, experience: 1_000_000 }
const load = (d: Deps) => d.store.loadClub()!

async function world() {
  const clock = new ManualClock(T0)
  const storage = new MemoryStorage()
  const d = tab(storage, clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'bench', clubSeed: 77, clubId: 'bench' })
  const c = load(d)
  d.store.saveClub({ ...c, economy: { ...c.economy, assets: { ...rich }, earned: { ...rich } } }, c.revision)
  return { d, clock, storage }
}
async function playUntil(d: Deps, clock: ManualClock, n: number) {
  while (load(d).idle.nextMatchIndex < n) {
    clock.advance(Math.min(96, n - load(d).idle.nextMatchIndex) * 5 * MINUTE)
    await settleDue(d)
  }
}
function setProgress(d: Deps, progress: number) {
  const c = load(d)
  const a = c.training.active!
  const next = c.idle.nextMatchIndex
  d.store.saveClub({ ...c, training: { ...c.training, active: { ...a, progress, startedAtMatch: next - progress, lastCountedMatch: progress > 0 ? next - 1 : null } } }, c.revision)
}
async function train(d: Deps, id: string) {
  const c = load(d)
  const o = trainingOptions(c.clubSeed, recordOf(c, id)!, { active: null, assets: c.economy.assets }).find((x) => x.kind === 'learn' && !x.block)!
  await startTraining(d, { opSeq: c.economy.nextOpSeq, playerId: id, trait: o.trait, kind: o.kind })
  return o.need
}

interface Scenario {
  name: string
  prepare: () => Promise<{ d: Deps; clock: ManualClock; storage: MemoryStorage }>
}
const scenarios: Scenario[] = [
  { name: '沒有訓練', prepare: async () => { const w = await world(); await playUntil(w.d, w.clock, 200); return w } },
  {
    name: '訓練中（第一棒，這批不會完成）',
    prepare: async () => { const w = await world(); const need = await train(w.d, load(w.d).roster.lineup[0].playerId); await playUntil(w.d, w.clock, 200); setProgress(w.d, need - 150); return w },
  },
  {
    name: '離線第 1 場完成',
    prepare: async () => { const w = await world(); const need = await train(w.d, load(w.d).roster.lineup[0].playerId); await playUntil(w.d, w.clock, need - 1); setProgress(w.d, need - 1); return w },
  },
  {
    name: '離線最後 1 場完成',
    prepare: async () => { const w = await world(); const need = await train(w.d, load(w.d).roster.lineup[0].playerId); await playUntil(w.d, w.clock, need - 96); setProgress(w.d, need - 96); return w },
  },
  {
    name: '訓練完成＋同一批降級（傳奇、積分 6）',
    prepare: async () => {
      const w = await world()
      const need = await train(w.d, load(w.d).roster.lineup[0].playerId)
      await playUntil(w.d, w.clock, need - 10)
      setProgress(w.d, need - 10)
      const c = load(w.d)
      w.d.store.saveClub({ ...c, league: { ...leagueAtTier(c.league, 4), points: 6, protectionRemaining: 0 } }, c.revision)
      return w
    },
  },
  {
    name: '最差：板凳球員差 1 場（每段只能切 1 場）',
    prepare: async () => {
      const w = await world()
      const need = await train(w.d, load(w.d).roster.bench[0])
      await playUntil(w.d, w.clock, need)
      setProgress(w.d, need - 1)
      return w
    },
  },
  {
    name: '預備球員訓練中（不會出場，不切段）',
    prepare: async () => {
      const w = await world()
      await recruit(w.d, { opSeq: load(w.d).economy.nextOpSeq, role: 'batter', candidateIndex: 0, expectedCount: 0 })
      await train(w.d, reserves(load(w.d))[0].id)
      await playUntil(w.d, w.clock, 200)
      return w
    },
  },
]

console.log(`# 特性訓練與離線結算效能（每個情境離線 8 小時、一次結算 96 場；${REPS} 次取中位數）\n`)
console.log('| 情境 | 結算耗時中位數（ms） | 最大（ms） | 分段數 | 重送（同時間再結算）ms | 存檔大小 |')
console.log('|---|---|---|---|---|---|')
for (const s of scenarios) {
  const times: number[] = []
  let segments = 0
  let resend = 0
  let size = 0
  for (let r = 0; r < REPS; r++) {
    const w = await s.prepare()
    w.clock.advance(8 * HOUR)
    // 分段數：每一段的第一場打完時 onProgress(1, …) 會被呼叫一次
    let calls = 0
    const before = load(w.d).idle.nextMatchIndex
    const t0 = performance.now()
    const report = await settleDue({ ...w.d, batch: { yieldControl: null, onProgress: (done: number) => (done === 1 ? calls++ : 0) } })
    times.push(performance.now() - t0)
    if (report.settled.length !== 96 || load(w.d).idle.nextMatchIndex !== before + 96) throw new Error(`${s.name}：應該結算 96 場，實際 ${report.settled.length}`)
    segments = calls
    const t1 = performance.now()
    const again = await settleDue(w.d)
    resend = performance.now() - t1
    if (again.settled.length !== 0) throw new Error('重送不該再結算')
    size = w.storage.getItem(CLUB_STORAGE_KEY)!.length
  }
  times.sort((a, b) => a - b)
  console.log(`| ${s.name} | ${times[Math.floor(times.length / 2)].toFixed(0)} | ${times.at(-1)!.toFixed(0)} | ${segments} | ${resend.toFixed(1)} | ${(size / 1024).toFixed(1)} KB |`)
}
