// Phase 8 球員生涯紀錄的長期容量與效能：npm run bench:v2:stats
// 用正式結算打 3,000／10,000 場，期間每隔幾場招募一位、換上第九棒、把原本的人釋出（被釋出的都真的上過場），
// 量 100／500／1,000 位已釋出球員時的存檔大小、生涯紀錄大小、讀寫與結算耗時、V9 → V10 遷移成本
import fixtureV9 from '../src/v2/domain/__fixtures__/club-v9-phase7b.json'
import { generateRoster } from '../src/sim/generate'
import { Rng } from '../src/sim/rng'
import { leaderboard, periodTotals, playerStats } from '../src/v2/application/statsQuery'
import { newClub, validateClub, type ClubSave } from '../src/v2/domain/club'
import { migrateToLatest } from '../src/v2/domain/migration'
import { ClubRepository, CLUB_STORAGE_KEY, MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { richClub, rotateNinth, settleMatches } from '../src/v2/longRunKit'

const T0 = Date.UTC(2026, 0, 1)
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
const ms = (t: number) => `${t.toFixed(2)} ms`
const time = (fn: () => void, n = 20) => {
  const t = performance.now()
  for (let i = 0; i < n; i++) fn()
  return (performance.now() - t) / n
}

async function longRun(matches: number, releases: number): Promise<ClubSave> {
  let club = richClub(newClub({ clubId: `cap-${matches}-${releases}`, clubName: '容量', clubSeed: matches + releases, roster: generateRoster(new Rng(7)), now: T0 }))
  const every = Math.max(1, Math.floor(matches / (releases + 1)))
  let done = 0
  while (club.idle.nextMatchIndex < matches) {
    club = await settleMatches(club, Math.min(every, matches - club.idle.nextMatchIndex), T0)
    if (done < releases) {
      club = rotateNinth(club, T0).club
      done++
    }
  }
  return club
}

console.log('場數 | 已釋出 | 生涯紀錄 | 存檔 JSON | 其中生涯 | 其中最近 50 場 lines | 讀檔（parse＋驗證） | 存檔（驗證＋寫入） | 96 場結算 | 期間＋排行 | 詳情（已釋出）')
for (const [matches, releases] of [
  [3000, 100],
  [3000, 500],
  [3000, 1000],
  [10000, 100],
  [10000, 500],
  [10000, 1000],
] as const) {
  const club = await longRun(matches, releases)
  const released = Object.values(club.stats.players).filter((r) => r.releasedAt !== undefined)
  const json = JSON.stringify(club)
  const statsBytes = JSON.stringify(club.stats).length
  const lineBytes = JSON.stringify(club.recentMatches.map((m) => m.lines ?? null)).length
  const tLoad = time(() => validateClub(JSON.parse(json)))
  const storage = new MemoryStorage()
  storage.setItem(CLUB_STORAGE_KEY, json)
  const repo = new ClubRepository(storage)
  let current = repo.loadClub()!
  const tSave = time(() => {
    current = repo.saveClub(current, current.revision)
  })
  const t = performance.now()
  await settleMatches(club, 96, T0)
  const tSettle = performance.now() - t
  const tQuery = time(() => {
    periodTotals(club, 'last30')
    periodTotals(club, 'career')
    leaderboard(club, 'batter', 'career', 'ops')
  })
  const oldest = released.sort((a, b) => a.releasedAt! - b.releasedAt!)[0]
  const oldestId = Object.entries(club.stats.players).find(([, r]) => r === oldest)?.[0]
  const tDetail = oldestId ? time(() => playerStats(club, oldestId, 'career')) : 0
  console.log(
    `${matches} | ${released.length} | ${Object.keys(club.stats.players).length} | ${kb(json.length)} | ${kb(statsBytes)} | ${kb(lineBytes)} | ${ms(tLoad)} | ${ms(tSave)} | ${ms(tSettle)} | ${ms(tQuery)} | ${ms(tDetail)}`,
  )
}

// V9 → V10 遷移：只加一個空的 stats，成本跟已釋出人數無關（舊存檔沒有生涯紀錄）
{
  const raw = JSON.stringify(fixtureV9)
  const tMigrate = time(() => migrateToLatest(JSON.parse(raw)), 50)
  console.log(`\nV9 → V10 遷移（312 場、50 場戰報的真實 V9 存檔）：每次 ${ms(tMigrate)}，存檔 ${kb(raw.length)} → ${kb(JSON.stringify(migrateToLatest(JSON.parse(raw))).length)}`)
}
console.log('localStorage 一般上限約 5 MB（UTF-16 時約 5M 字元）')
