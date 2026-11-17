// V2 養成、招募、經濟的平衡模擬：npm run balance:v2
// 用真正的服務（結算、領取、升級、招募）跑完整的遊玩流程，不是另外寫一套公式，所以結果就是玩家實際會遇到的數字。
//
// 假設（可以用參數改）：
// - 每天上線 SESSIONS_PER_DAY 次、平均分散；預設 2 次（間隔 12 小時），每次都碰到離線 8 小時上限 → 一天 192 場
// - 每次上線：結算 → 領取全部收益 → 依策略花錢 → 離開
// - 對手固定是平均能力 5 的隊伍（Phase 4 沒有聯盟升降級），所以變強之後勝率會一直往上
// - 每種策略跑 SEEDS 個不同的球團種子取平均，結果可以重現
import { overall } from '../src/sim/generate'
import { claim, settleDue } from '../src/v2/application/settlementService'
import { createClubSafely } from '../src/v2/application/clubLifecycle'
import { canAfford, recruit, upgrade } from '../src/v2/application/economyService'
import { updateSettings } from '../src/v2/application/settlementService'
import type { ClubSave } from '../src/v2/domain/club'
import { swapWithReserve, type LineupDraft } from '../src/v2/domain/lineup'
import { totalUpgradeCost, upgradeCost } from '../src/v2/domain/progression'
import { MAX_LEVEL, RECRUIT_CONFIG } from '../src/v2/domain/progressionConfig'
import { recruitCost, rosterFull } from '../src/v2/domain/recruitment'
import { assignedIds, reserves, resolveRoster, toAssignment } from '../src/v2/domain/roster'
import { MemoryStorage } from '../src/v2/infrastructure/clubRepository'
import { FakeLockManager, HOUR, ManualClock, T0, tab } from '../src/v2/testkit'
import { isOffPosition } from '../src/sim/positions'
import type { Batter, Pitcher, Player } from '../src/sim/types'

const SESSIONS_PER_DAY = Number(process.env.SESSIONS ?? 2)
const DAYS = 14
const SEEDS = [101, 202, 303]
const CHECKPOINTS = [1, 3, 7, 14]

type Strategy = 'A 完全不養成' | 'B 平均養成' | 'C 集中養成' | 'D 招募優先'
const STRATEGIES: Strategy[] = ['A 完全不養成', 'B 平均養成', 'C 集中養成', 'D 招募優先']

type Deps = ReturnType<typeof tab>
const load = (d: Deps) => d.store.loadClub()!

/** 上場球員（先發、板凳、投手），依目前能力 */
const activeRecords = (c: ClubSave) => {
  const ids = assignedIds(c.roster)
  return c.players.filter((r) => ids.has(r.player.id))
}

/** 把升級的錢花在等級最低的上場球員上，直到付不起 */
async function upgradeEvenly(d: Deps, pool: (c: ClubSave) => string[]): Promise<void> {
  for (let guard = 0; guard < 500; guard++) {
    const c = load(d)
    const ids = new Set(pool(c))
    const target = c.players.filter((r) => ids.has(r.player.id) && r.level < MAX_LEVEL).sort((a, b) => a.level - b.level)[0]
    if (!target || !canAfford(c, upgradeCost(target.level)!)) return
    await upgrade(d, { opSeq: c.economy.nextOpSeq, playerId: target.player.id, expectedLevel: target.level })
  }
}

const batterScore = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3 + b.ratings.speed * 0.15
const pitcherScore = (p: Pitcher) => p.ratings.stuff + p.ratings.control + p.ratings.stamina * 0.3

/** 招募優先玩家的排陣：預備名單裡更好的人換上場（打者要守本職或當指定打擊，投手直接比） */
async function promoteReserves(d: Deps): Promise<void> {
  const c = load(d)
  let draft: LineupDraft = { roster: resolveRoster(c), reserves: reserves(c) }
  let changed = false
  for (let pass = 0; pass < 30; pass++) {
    let improved = false
    for (let ri = 0; ri < draft.reserves.length && !improved; ri++) {
      const p = draft.reserves[ri] as Player
      if (p.role === 'batter') {
        draft.roster.lineup.forEach((s, i) => {
          if (improved) return
          const fits = s.position === 'DH' || !isOffPosition(p, s.position)
          if (fits && batterScore(p) > batterScore(s.player) + 0.3) {
            draft = swapWithReserve(draft, { kind: 'lineup', index: i }, ri)
            improved = true
          }
        })
      } else {
        const slots = [{ kind: 'starter' as const }, ...draft.roster.relievers.map((_, i) => ({ kind: 'reliever' as const, index: i }))]
        for (const slot of slots) {
          const current = slot.kind === 'starter' ? draft.roster.starter : draft.roster.relievers[slot.index]
          if (!improved && pitcherScore(p as Pitcher) > pitcherScore(current) + 0.3) {
            draft = swapWithReserve(draft, slot, ri)
            improved = true
          }
        }
      }
    }
    if (!improved) break
    changed = true
  }
  if (changed) await updateSettings(d, { roster: toAssignment(draft.roster) })
}

async function session(d: Deps, strategy: Strategy, core: Set<string>): Promise<void> {
  await settleDue(d)
  await claim(d, load(d).economy.nextClaimSeq)
  if (strategy === 'B 平均養成') await upgradeEvenly(d, (c) => activeRecords(c).map((r) => r.player.id))
  if (strategy === 'C 集中養成') {
    // 先把 5 位主力升滿，主力都滿級之後才平均養成其他人
    await upgradeEvenly(d, () => [...core])
    const c = load(d)
    if (c.players.filter((r) => core.has(r.player.id)).every((r) => r.level >= MAX_LEVEL)) await upgradeEvenly(d, (x) => activeRecords(x).map((r) => r.player.id))
  }
  if (strategy === 'D 招募優先') {
    for (let guard = 0; guard < 40; guard++) {
      const c = load(d)
      if (rosterFull(c) || c.economy.assets.funds < recruitCost(c.recruitment.count).funds) break
      // 打者、投手大約 2：1
      const role = c.recruitment.count % 3 === 2 ? 'pitcher' : 'batter'
      await recruit(d, { opSeq: c.economy.nextOpSeq, role })
    }
    await promoteReserves(d)
    await upgradeEvenly(d, (c) => activeRecords(c).map((r) => r.player.id))
  }
}

interface Snapshot {
  day: number
  earnedFunds: number
  earnedExp: number
  funds: number
  exp: number
  avgLevel: number
  maxLevel: number
  power: number
  players: number
  winRate: number
  periodWinRate: number
  games: number
}

async function run(strategy: Strategy, seed: number): Promise<Snapshot[]> {
  const storage = new MemoryStorage()
  const clock = new ManualClock(T0)
  const d = tab(storage, clock, new FakeLockManager())
  d.batch.yieldControl = null
  await createClubSafely(d, { clubName: '平衡測試', clubSeed: seed, clubId: `bal-${seed}` })
  const c0 = load(d)
  // 集中養成的主力：上場打者打擊最好的 4 人 + 先發投手
  const r0 = resolveRoster(c0)
  const core = new Set([...r0.lineup.map((s) => s.player).sort((a, b) => batterScore(b) - batterScore(a)).slice(0, 4).map((p) => p.id), r0.starter.id])
  const out: Snapshot[] = []
  let last = { wins: 0, losses: 0 }
  for (let day = 1; day <= DAYS; day++) {
    for (let s = 0; s < SESSIONS_PER_DAY; s++) {
      clock.advance((24 / SESSIONS_PER_DAY) * HOUR)
      await session(d, strategy, core)
    }
    if (CHECKPOINTS.includes(day)) {
      const c = load(d)
      const active = activeRecords(c)
      const roster = resolveRoster(c)
      const team = [...roster.lineup.map((x) => x.player), ...roster.bench, roster.starter, ...roster.relievers]
      const { wins, losses } = c.record
      const pw = wins - last.wins
      const pl = losses - last.losses
      out.push({
        day,
        earnedFunds: c.economy.earned.funds,
        earnedExp: c.economy.earned.experience,
        funds: c.economy.assets.funds,
        exp: c.economy.assets.experience,
        avgLevel: active.reduce((x, r) => x + r.level, 0) / active.length,
        maxLevel: Math.max(...c.players.map((r) => r.level)),
        power: team.reduce((x, p) => x + overall(p), 0) / team.length,
        players: c.players.length,
        winRate: wins / (wins + losses),
        periodWinRate: pw / (pw + pl),
        games: wins + losses,
      })
      last = { wins, losses }
    }
  }
  return out
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

console.log(`# V2 平衡模擬：每天上線 ${SESSIONS_PER_DAY} 次（每次離線 ${24 / SESSIONS_PER_DAY} 小時，最多算 8 小時），${DAYS} 天，球團種子 ${SEEDS.join('、')} 取平均\n`)
const lvl = (n: number) => totalUpgradeCost(1, n)
console.log('升級成本（單人累計）：', [2, 5, 10, 15, 20].map((n) => `Lv.${n}：${lvl(n).funds.toLocaleString()} 資金／${lvl(n).experience.toLocaleString()} 經驗`).join('；'))
console.log('單級成本：', [1, 5, 10, 15, 19].map((l) => `Lv.${l}→${l + 1}：${upgradeCost(l)!.funds}／${upgradeCost(l)!.experience}`).join('；'))
console.log(`招募：第 1 次 ${recruitCost(0).funds}、第 16 次 ${recruitCost(15).funds} 資金；上限 ${RECRUIT_CONFIG.maxPlayers} 人，16 次總共 ${Array.from({ length: 16 }, (_, i) => recruitCost(i).funds).reduce((a, b) => a + b, 0).toLocaleString()} 資金\n`)

const results: Record<string, Snapshot[]> = {}
for (const strategy of STRATEGIES) {
  const runs = await Promise.all(SEEDS.map((seed) => run(strategy, seed)))
  results[strategy] = CHECKPOINTS.map((day, i) => {
    const xs = runs.map((r) => r[i])
    const m = (k: keyof Snapshot) => avg(xs.map((x) => x[k] as number))
    return { day, earnedFunds: m('earnedFunds'), earnedExp: m('earnedExp'), funds: m('funds'), exp: m('exp'), avgLevel: m('avgLevel'), maxLevel: m('maxLevel'), power: m('power'), players: m('players'), winRate: m('winRate'), periodWinRate: m('periodWinRate'), games: m('games') }
  })
}

const f0 = (x: number) => Math.round(x).toLocaleString()
for (const strategy of STRATEGIES) {
  console.log(`## ${strategy}`)
  console.table(
    results[strategy].map((s) => ({
      天: s.day,
      累計資金: f0(s.earnedFunds),
      累計經驗: f0(s.earnedExp),
      剩餘資金: f0(s.funds),
      剩餘經驗: f0(s.exp),
      上場平均等級: s.avgLevel.toFixed(1),
      最高等級: s.maxLevel.toFixed(0),
      上場平均能力: s.power.toFixed(2),
      球員數: s.players.toFixed(0),
      這段期間勝率: (s.periodWinRate * 100).toFixed(1) + '%',
      累計勝率: (s.winRate * 100).toFixed(1) + '%',
    })),
  )
}
const final = STRATEGIES.map((s) => ({ s, last: results[s][results[s].length - 1] }))
console.log('## 第 14 天比較')
console.table(final.map(({ s, last }) => ({ 策略: s, 上場平均能力: last.power.toFixed(2), '第 8～14 天勝率': (last.periodWinRate * 100).toFixed(1) + '%', 上場平均等級: last.avgLevel.toFixed(1), 球員數: last.players.toFixed(0) })))
