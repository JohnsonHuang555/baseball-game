// Phase 6C 的分析（npm run balance:v2:analyze）：MODE=growth | recruit | newbie | upgrades，結果寫成 JSON，報告由 report.ts 產生。
//   SEEDS=100（數量）  MATCHES=300（對照實驗每種配置幾場）  TIERS=0,2  OUT=docs/balance/data/xxx.json
import { writeFileSync } from 'node:fs'
import { overall, generateRoster } from '../../src/sim/generate'
import { Rng } from '../../src/sim/rng'
import { upgradeCost } from '../../src/v2/domain/progression'
import { RECRUIT_CONFIG } from '../../src/v2/domain/progressionConfig'
import { recruitCost } from '../../src/v2/domain/recruitment'
import { firstCapLevel, growthTable, lateGain, samplePlayers } from './growth'
import { dist, pairedDiff, simulate, type SimResult } from './simulate'
import { VARIANTS, budgetForEven, measure, type Variant, type VariantStat } from './upgrades'

const MODE = process.env.MODE ?? 'growth'
const N = Number(process.env.SEEDS ?? 100)
const SEEDS = Array.from({ length: N }, (_, i) => 1001 + i)
const OUT = process.env.OUT ?? `${MODE}.json`
const out: Record<string, unknown> = { mode: MODE, seeds: SEEDS.length, firstSeed: SEEDS[0] }

if (MODE === 'growth') {
  const { batters, pitchers } = samplePlayers(SEEDS)
  out.batters = growthTable(batters)
  out.pitchers = growthTable(pitchers)
  // 依流派、依投手主項（球威／控球較高）
  const byArch: Record<string, unknown> = {}
  for (const arch of ['power', 'speed', 'skill', 'defense']) {
    const ps = batters.filter((p) => p.role === 'batter' && p.archetype === arch)
    byArch[arch] = { n: ps.length, lv1: dist(ps.map(overall)), gain20: dist(ps.map((p) => growthTable([p])[19].gainFromLv1)), firstCap: dist(ps.map((p) => firstCapLevel(p) ?? 21)) }
  }
  out.byArchetype = byArch
  out.pitcherFirstCap = dist(pitchers.map((p) => firstCapLevel(p) ?? 21))
  const late = [...batters, ...pitchers].map(lateGain)
  out.lateGain = { gain: dist(late.map((x) => x.gain)), uncapped: dist(late.map((x) => x.uncapped)), lostToCapShare: late.filter((x) => x.gain < x.uncapped * 0.5).length / late.length, zeroLateGain: late.filter((x) => x.gain < 1e-9).length / late.length }
  out.capReachedBy20 = [...batters, ...pitchers].filter((p) => firstCapLevel(p) !== null).length / (batters.length + pitchers.length)
}

if (MODE === 'recruit') {
  // 招募的球員跟初始球員同一個分布（mean 5）：看「招募一位」有多少機會比上場同類型最弱、中位數的人強
  const rows: { role: string; beatsWeakest: number; beatsMedian: number; recruitOverall: unknown; starterOverall: unknown }[] = []
  for (const role of ['batter', 'pitcher'] as const) {
    let weak = 0
    let med = 0
    let n = 0
    const rec: number[] = []
    const st: number[] = []
    for (const seed of SEEDS) {
      const r = generateRoster(new Rng(seed))
      const active = role === 'batter' ? r.lineup.map((s) => s.player) : [r.starter, ...r.relievers]
      const ov = active.map(overall).sort((a, b) => a - b)
      st.push(...ov)
      const { recruitsB, recruitsP } = samplePlayers([seed])
      for (const p of role === 'batter' ? recruitsB : recruitsP) {
        const o = overall(p)
        rec.push(o)
        n++
        if (o > ov[0]) weak++
        if (o > ov[Math.floor(ov.length / 2)]) med++
      }
    }
    rows.push({ role, beatsWeakest: weak / n, beatsMedian: med / n, recruitOverall: dist(rec), starterOverall: dist(st) })
  }
  out.recruits = rows
  out.costs = Array.from({ length: 16 }, (_, i) => recruitCost(i).funds)
  out.mean = RECRUIT_CONFIG.mean
  // 同樣的資金拿去升級可以升幾級（以 Lv.1→2、Lv.5→6 為例；經驗另外要夠）
  out.recruitVsUpgrade = { firstRecruit: recruitCost(0).funds, lv1to2Funds: upgradeCost(1)!.funds, lv5to6Funds: upgradeCost(5)!.funds }
}

if (MODE === 'newbie') {
  // 新手前 24 小時：A. 一直開著（每 5 分鐘看一次，前 1 小時）＋之後 4、8、24 小時回來；B. 只在 10、30、60 分鐘、4、8、24 小時回來
  const active = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 240, 480, 1440]
  const casual = [10, 30, 60, 240, 480, 1440]
  for (const [name, schedule] of [['active', active], ['casual', casual]] as const) {
    const runs: SimResult[] = []
    for (const seed of SEEDS) runs.push(await simulate({ strategy: 'E', seed, sessionsPerDay: 1, days: 1, sessionMinutes: [...schedule] }))
    out[name] = {
      schedule,
      checkpoints: schedule.map((m, i) => ({
        minute: m,
        matches: dist(runs.map((r) => r.snapshots[i].matches)),
        earnedFunds: dist(runs.map((r) => r.snapshots[i].earned.funds)),
        earnedExp: dist(runs.map((r) => r.snapshots[i].earned.experience)),
        upgraded: runs.filter((r) => r.snapshots[i].spentUpgrade.experience > 0).length / runs.length,
        avgLevel: dist(runs.map((r) => r.snapshots[i].avgLevel)),
        assetsExp: dist(runs.map((r) => r.snapshots[i].assets.experience)),
        assetsFunds: dist(runs.map((r) => r.snapshots[i].assets.funds)),
        spentUpgradeExp: dist(runs.map((r) => r.snapshots[i].spentUpgrade.experience)),
        recruited: runs.filter((r) => r.snapshots[i].players > 14).length / runs.length,
        power: dist(runs.map((r) => r.snapshots[i].power)),
        actions: dist(runs.map((r) => r.snapshots[i].actions)),
      })),
      firstMatchReward: dist(runs.map((r) => r.milestones.firstMatchReward?.experience ?? NaN)),
      firstMatchFunds: dist(runs.map((r) => r.milestones.firstMatchReward?.funds ?? NaN)),
      firstUpgradeMinutes: dist(runs.map((r) => r.milestones.firstUpgradeMinutes ?? NaN)),
      firstUpgradeMatches: dist(runs.map((r) => r.milestones.firstUpgradeMatches ?? NaN)),
      firstUpgradeClaims: dist(runs.map((r) => r.milestones.firstUpgradeClaims ?? NaN)),
      firstUpgradePowerGain: dist(runs.map((r) => r.milestones.firstUpgradePowerGain ?? NaN)),
      upgradedWithin24h: runs.filter((r) => r.milestones.firstUpgradeMinutes !== null).length / runs.length,
      firstRecruitMinutes: dist(runs.map((r) => r.milestones.firstRecruitMinutes ?? NaN)),
      recruitedWithin24h: runs.filter((r) => r.milestones.firstRecruitMinutes !== null).length / runs.length,
    }
  }
}

if (MODE === 'upgrades') {
  const MATCHES = Number(process.env.MATCHES ?? 300)
  const TIERS = (process.env.TIERS ?? '0,2').split(',').map(Number)
  const LEVELS = (process.env.LEVELS ?? '3,5,8,12').split(',').map(Number)
  const results: unknown[] = []
  for (const tier of TIERS) {
    const base = await Promise.all(SEEDS.map((s) => measure(s, tier, 'base', 0, MATCHES)))
    results.push({ tier, level: 1, variant: 'base', budget: 0, stats: summarize(base), perSeed: base.map((b) => b.winRate) })
    for (const level of LEVELS) {
      const budget = budgetForEven(level)
      for (const v of VARIANTS) {
        const xs: VariantStat[] = []
        for (const s of SEEDS) xs.push(await measure(s, tier, v as Variant, budget, MATCHES))
        const diff = pairedDiff(xs.map((x) => x.winRate), base.map((b) => b.winRate))
        const rf = pairedDiff(xs.map((x) => x.runsFor), base.map((b) => b.runsFor))
        const ra = pairedDiff(xs.map((x) => x.runsAgainst), base.map((b) => b.runsAgainst))
        const spent = dist(xs.map((x) => x.spent)).mean
        results.push({ tier, level, variant: v, budget, spent, stats: summarize(xs), winDiff: diff, runsForDiff: rf, runsAgainstDiff: ra, winPer1000Exp: (diff.mean / spent) * 1000 })
        console.log(`tier ${tier} Lv.${level} ${v}: 勝率 ${(dist(xs.map((x) => x.winRate)).mean * 100).toFixed(1)}%（差 ${(diff.mean * 100).toFixed(1)}，95% CI ${(diff.lo * 100).toFixed(1)}～${(diff.hi * 100).toFixed(1)}）`)
      }
    }
  }
  out.matchesPerVariant = MATCHES
  out.results = results
}

function summarize(xs: { winRate: number; runsFor: number; runsAgainst: number; power: number; lineupContactPower: number; pitcherStuffControl: number }[]) {
  return {
    winRate: dist(xs.map((x) => x.winRate)),
    runsFor: dist(xs.map((x) => x.runsFor)).mean,
    runsAgainst: dist(xs.map((x) => x.runsAgainst)).mean,
    power: dist(xs.map((x) => x.power)).mean,
    lineupContactPower: dist(xs.map((x) => x.lineupContactPower)).mean,
    pitcherStuffControl: dist(xs.map((x) => x.pitcherStuffControl)).mean,
  }
}

writeFileSync(OUT, JSON.stringify(out, null, 1))
console.log(`已寫入 ${OUT}`)
