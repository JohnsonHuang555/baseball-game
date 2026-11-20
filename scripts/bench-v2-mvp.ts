// Phase 9 PR 4：MVP 能力成長對離線結算效能的影響。npm run bench:v2:mvp [-- --reps=5]
// 每個情境都是「離線 8 小時、一次結算 96 場」，用正式的 settleDue（含分段、存檔）。重複 reps 次取中位數。
// 要讓成長剛好發生在第 k 場：先讓全隊的 MVP 成長都到上限（不會再成長），只留一位球員 P 差一次；
// 用「關掉成長」先打一次找出 P 在這批裡第 k 場得獎、而且到第 k 場為止得獎 w 次，再把 P 的次數設成 50 − w。
// 這樣 P 一定在第 k 場拿到第 50 次 → 第 5 次成長，而且之前的場次跟關掉成長時一模一樣
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { settleDue } from '../src/v2/application/settlementService'
import type { ClubSave, PlayerRecord } from '../src/v2/domain/club'
import { leagueAtTier } from '../src/v2/domain/league'
import { MVP_RULES, awardMvp, unpackMvp } from '../src/v2/domain/mvp'
import { recordOf } from '../src/v2/domain/roster'
import { trainingOptions } from '../src/v2/domain/traitTraining'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, FlakyStorage, HOUR, MINUTE, ManualClock, T0, tab } from '../src/v2/testkit'

const REPS = Number(process.argv.find((a) => a.startsWith('--reps='))?.split('=')[1] ?? 5)
type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!

/** 50 次 MVP、5 次成長（到上限）的紀錄；成長的能力照正式規則選 */
function capped(r: PlayerRecord, n = 50): PlayerRecord['mvp'] {
  let x: PlayerRecord = { ...r, mvp: undefined }
  for (let i = 0; i < n; i++) x = awardMvp(x, i).record
  return x.mvp
}
function withMvp(c: ClubSave, f: (r: PlayerRecord) => PlayerRecord['mvp']): ClubSave {
  return { ...c, players: c.players.map((r) => ({ ...r, mvp: f(r) })) }
}

/** 打了 200 場的球團（用來量測的基準狀態） */
async function base(): Promise<ClubSave> {
  const clock = new ManualClock(T0)
  const d = tab(new MemoryStorage(), clock, new FakeLockManager())
  await createClubSafely(d, { clubName: 'bench', clubSeed: 77, clubId: 'bench' })
  MVP_RULES.growth = false
  while (load(d).idle.nextMatchIndex < 200) {
    clock.advance(Math.min(96, 200 - load(d).idle.nextMatchIndex) * 5 * MINUTE)
    await settleDue(d)
  }
  MVP_RULES.growth = true
  return withMvp(load(d), () => undefined)
}
const BASE = await base()
const NOW = BASE.idle.anchorMs + 8 * HOUR

async function run(club: ClubSave, storage: MemoryStorage | FlakyStorage = new MemoryStorage()) {
  storage.setItem(CLUB_STORAGE_KEY, JSON.stringify(club))
  const d = tab(storage, new ManualClock(NOW), new FakeLockManager())
  return { d, report: await settleDue({ ...d, batch: { yieldControl: null } }) }
}
async function dryMvps(club: ClubSave): Promise<string[]> {
  MVP_RULES.growth = false
  try {
    return (await run(club)).report.settled.map((m) => unpackMvp(m.mvp!).playerId)
  } finally {
    MVP_RULES.growth = true
  }
}

/**
 * 全隊到上限，只有一位球員在這批第 k 場（從 1 數）成長。第 k 場的 MVP 如果這批得獎超過 10 次（會更早跨過門檻），
 * 就往前找最近一個做得到的場次（最多往前 8 場），實際場次記在 lastK
 */
let lastK = 0
async function triggerAt(k: number, edit: (c: ClubSave, id: string) => ClubSave = (c) => c): Promise<ClubSave> {
  for (let kk = k; kk >= Math.max(1, k - 8); kk--) {
    const club = await triggerExactly(kk, edit).catch(() => null)
    if (club) {
      lastK = kk
      return club
    }
  }
  throw new Error(`找不到第 ${k} 場附近成長的球員`)
}
async function triggerExactly(k: number, edit: (c: ClubSave, id: string) => ClubSave): Promise<ClubSave> {
  const allCapped = withMvp(BASE, (r) => capped(r))
  for (const r of BASE.players) {
    const four = capped(r, 49)!
    const club = edit(withMvp(allCapped, (x) => (x.player.id === r.player.id ? four : x.mvp)), r.player.id)
    const seq = await dryMvps(club)
    const w = seq.slice(0, k).filter((x) => x === r.player.id).length
    if (seq[k - 1] !== r.player.id || w > 10) continue
    return withMvp(club, (x) => (x.player.id === r.player.id ? { count: 50 - w, grants: four.grants } : x.mvp))
  }
  throw new Error(`找不到第 ${k} 場成長的球員`)
}
/** 訓練：這位球員差 k 場（他每場都出場的話第 k 場完成） */
function trainingFor(c: ClubSave, id: string, k: number): ClubSave {
  const o = trainingOptions(c.clubSeed, recordOf(c, id)!, { active: null, assets: { funds: 1e9, experience: 1e9 } }).find((x) => x.kind === 'learn' && !x.block)
  if (!o) return c
  const next = c.idle.nextMatchIndex
  const progress = Math.min(o.need - k, next)
  return { ...c, training: { ...c.training, active: { playerId: id, trait: o.trait, kind: 'learn', progress, need: o.need, startedAtMatch: next - progress, lastCountedMatch: next - 1 } } }
}
const legendLow = (c: ClubSave): ClubSave => ({ ...c, league: { ...leagueAtTier(c.league, 4), points: 6, protectionRemaining: 0 } })
const regular = (c: ClubSave, id: string) => c.roster.lineup.some((s) => s.playerId === id) || c.roster.starter === id

interface Scenario {
  name: string
  club: () => Promise<ClubSave>
  growthOff?: boolean
  label?: () => string
}
const scenarios: Scenario[] = [
  { name: '關掉成長（只選 MVP、不切段，等於加入成長前）', club: async () => BASE, growthOff: true },
  { name: '沒有成長觸發（全隊已到上限）', club: async () => withMvp(BASE, (r) => capped(r)) },
  { name: '一般狀態（打了 200 場，大家 0 次）', club: async () => BASE },
  { name: '第 1 場觸發', club: () => triggerAt(1) },
  { name: '第 48 場觸發', club: () => triggerAt(48) },
  { name: '第 96 場觸發', club: () => triggerAt(96), label: () => `最後幾場觸發（第 ${lastK} 場）` },
  { name: '一批內多次觸發（全隊都差 1 次）', club: async () => withMvp(BASE, () => ({ count: 9, grants: [] })) },
  { name: 'MVP 與訓練同一場完成（第 10 場）', club: () => triggerAt(10, (c, id) => (regular(c, id) ? trainingFor(c, id, 10) : c)) },
  { name: 'MVP 成長＋降級（傳奇、積分 6）', club: () => triggerAt(5, (c) => legendLow(c)) },
  { name: '三種同時（成長、訓練、降級）', club: () => triggerAt(5, (c, id) => legendLow(regular(c, id) ? trainingFor(c, id, 5) : c)) },
]

// 暖機：先打兩次，讓第一個情境不吃到 JIT 編譯的時間
for (let i = 0; i < 2; i++) await run(BASE)

console.log(`# MVP 與離線結算效能（每個情境離線 8 小時、一次結算 96 場；${REPS} 次取中位數；存檔用記憶體儲存）\n`)
console.log('| 情境 | 結算耗時中位數（ms） | 最大（ms） | 分段數 | 這批的 MVP 成長 | 重送 ms | 存檔大小 |')
console.log('|---|---|---|---|---|---|---|')
for (const s of scenarios) {
  const club = await s.club()
  const times: number[] = []
  let segments = 0
  let growths = 0
  let resend = 0
  let size = 0
  for (let r = 0; r < REPS; r++) {
    if (s.growthOff) MVP_RULES.growth = false
    const storage = new MemoryStorage()
    const t0 = performance.now()
    const { d, report } = await run(club, storage)
    times.push(performance.now() - t0)
    if (report.settled.length !== 96) throw new Error(`${s.name}：應該結算 96 場，實際 ${report.settled.length}`)
    segments = report.segments
    growths = report.settled.filter((m) => unpackMvp(m.mvp!).growth).length
    const t1 = performance.now()
    const again = await settleDue(d)
    resend = performance.now() - t1
    if (again.settled.length !== 0) throw new Error('重送不該再結算')
    size = storage.getItem(CLUB_STORAGE_KEY)!.length
    MVP_RULES.growth = true
  }
  times.sort((a, b) => a - b)
  console.log(`| ${s.label?.() ?? s.name} | ${times[Math.floor(times.length / 2)].toFixed(0)} | ${times.at(-1)!.toFixed(0)} | ${segments} | ${growths} | ${resend.toFixed(1)} | ${(size / 1024).toFixed(1)} KB |`)
}

// 存檔寫入失敗之後重試：第一次整批不存，第二次重新結算（結果跟一次成功相同）
{
  const club = withMvp(BASE, () => ({ count: 9, grants: [] }))
  const flaky = new FlakyStorage()
  flaky.inner.setItem(CLUB_STORAGE_KEY, JSON.stringify(club))
  const d = tab(flaky, new ManualClock(NOW), new FakeLockManager())
  flaky.failWrites = true
  const t0 = performance.now()
  const failed = await settleDue({ ...d, batch: { yieldControl: null } }).catch((e) => e)
  const tFail = performance.now() - t0
  flaky.failWrites = false
  const t1 = performance.now()
  const ok = await settleDue({ ...d, batch: { yieldControl: null } })
  const tRetry = performance.now() - t1
  const once = await run(club)
  const same = JSON.stringify(ok.club.players) === JSON.stringify(once.report.club.players)
  console.log(`\n存檔寫入失敗後重試（全隊都差 1 次）：失敗那次 ${tFail.toFixed(0)} ms（${failed instanceof Error ? failed.name : '沒有丟錯'}，什麼都沒存）、重試 ${tRetry.toFixed(0)} ms、重試結果跟一次成功${same ? '相同' : '不同'}`)
}

// 同一個球團、同一個時間：關掉成長（一段打完，等於加入 MVP 成長之前）vs 正式（MVP 成長切段），交錯各 15 次。
// 各情境的球團不同，彼此不能直接比；這一組才是「切段多了多少成本」的對照
{
  const pair = async (growth: boolean) => {
    MVP_RULES.growth = growth
    try {
      const t0 = performance.now()
      const { report } = await run(BASE)
      return { ms: performance.now() - t0, segments: report.segments }
    } finally {
      MVP_RULES.growth = true
    }
  }
  const off: number[] = []
  const on: number[] = []
  let segs = 0
  for (let i = 0; i < 15; i++) {
    off.push((await pair(false)).ms)
    const x = await pair(true)
    on.push(x.ms)
    segs = x.segments
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  console.log(`\n同一個球團交錯 15 次：關掉成長（1 段）中位數 ${med(off).toFixed(0)} ms、正式（${segs} 段）中位數 ${med(on).toFixed(0)} ms，差 ${(((med(on) - med(off)) / med(off)) * 100).toFixed(1)}%；單次範圍 ${Math.round(Math.min(...off, ...on))}～${Math.round(Math.max(...off, ...on))} ms`)
}
