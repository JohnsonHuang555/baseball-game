// Phase 9 PR 2：四種戰術風格的平衡比較。npm run balance:v2:tactics [-- --games=400 --mean=5.8]
// 5 種球隊類型 × 4 種風格，每一格用同一組種子（同樣的對手、同樣的比賽亂數），只換我方的戰術風格。
// 用正式的 runMatch（自動教練＋引擎），戰術摘要是比賽事件累加出來的，跟戰報一樣。
// 球隊類型是「測試用的陣容」：在同一個隨機陣容上調整能力，代表玩家可能養出來的隊型；戰術本身沒有任何能力加成。
import { generateTeam } from '../src/sim/generate'
import { RULES_VERSION, type Side } from '../src/sim/game'
import { Rng, clamp } from '../src/sim/rng'
import type { Team } from '../src/sim/types'
import { COACH_STYLES, type CoachStyle } from '../src/v2/application/autoCoach'
import { runMatch, type MatchAi } from '../src/v2/application/matchRunner'
import { recommendStyle } from '../src/v2/domain/tacticsAdvice'

const arg = (name: string, fallback: number) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
const GAMES = arg('games', 400)
const MEAN = arg('mean', 5.8)
const OPP_MEAN = arg('opp', 5.8)

type TeamType = '平均型' | '高長打' | '高速度' | '高投手' | '低能力新手'
const TYPES: TeamType[] = ['平均型', '高長打', '高速度', '高投手', '低能力新手']
const STYLE_NAME: Record<CoachStyle, string> = { balanced: '均衡', power: '強攻', speed: '機動', defense: '守備' }

/** 在同一個隨機陣容上調整能力，做出不同的隊型（只改我方，對手不變） */
function teamOf(type: TeamType, seed: number): Team {
  const t = generateTeam(new Rng(seed), type === '低能力新手' ? 4.2 : MEAN)
  const r = t.roster
  const bat = (f: (b: (typeof r.bench)[number]) => void) => [...r.lineup.map((s) => s.player), ...r.bench].forEach(f)
  const adj = (v: number, d: number) => clamp(Math.round((v + d) * 10) / 10, 1, 10)
  if (type === '高長打') bat((b) => ((b.ratings.power = adj(b.ratings.power, 2)), (b.ratings.speed = adj(b.ratings.speed, -1.5))))
  if (type === '高速度') bat((b) => ((b.ratings.speed = adj(b.ratings.speed, 2.5)), (b.ratings.power = adj(b.ratings.power, -1.5))))
  if (type === '高投手') {
    for (const p of [r.starter, ...r.relievers]) {
      p.ratings.stuff = adj(p.ratings.stuff, 1.5)
      p.ratings.control = adj(p.ratings.control, 1.5)
    }
    bat((b) => ((b.ratings.contact = adj(b.ratings.contact, -0.8)), (b.ratings.power = adj(b.ratings.power, -0.8))))
  }
  return t
}

interface Cell {
  games: number
  wins: number
  rs: number
  ra: number
  stealAtt: number
  stealOk: number
  buntAtt: number
  buntOk: number
  hitAndRun: number
  changes: number
  starterOuts: number
  starterOutsHist: number[]
  pinchRuns: number
  pinchHits: number
  defSubs: number
  ms: number
}
const empty = (): Cell => ({ games: 0, wins: 0, rs: 0, ra: 0, stealAtt: 0, stealOk: 0, buntAtt: 0, buntOk: 0, hitAndRun: 0, changes: 0, starterOuts: 0, starterOutsHist: [0, 0, 0, 0], pinchRuns: 0, pinchHits: 0, defSubs: 0, ms: 0 })

const results = new Map<string, Cell>()
const recommended = new Map<TeamType, Record<string, number>>()
for (const type of TYPES) {
  const rec: Record<string, number> = {}
  for (let i = 0; i < GAMES; i++) {
    const seed = 70_000 + i
    const ours = teamOf(type, 1000 + (i % 40))
    if (i < 40) {
      const r = recommendStyle(ours.roster).style
      rec[r] = (rec[r] ?? 0) + 1
    }
    const opp = generateTeam(new Rng(50_000 + i), OPP_MEAN)
    const userSide: Side = i % 2 ? 'away' : 'home'
    const other: Side = userSide === 'home' ? 'away' : 'home'
    for (const style of COACH_STYLES) {
      const setup = { home: userSide === 'home' ? structuredClone(ours) : structuredClone(opp), away: userSide === 'away' ? structuredClone(ours) : structuredClone(opp), seed, userSide, rules: RULES_VERSION }
      const ai = { [userSide]: { kind: 'autoCoach', style }, [other]: { kind: 'builtin' } } as MatchAi
      const t0 = performance.now()
      const res = runMatch(setup, ai)
      const ms = performance.now() - t0
      const c = results.get(`${type}|${style}`) ?? empty()
      const t = res.tactics!
      c.games++
      c.ms += ms
      c.rs += res.score[userSide]
      c.ra += res.score[other]
      if (res.winner === userSide) c.wins++
      c.stealAtt += t.steals[0]
      c.stealOk += t.steals[1]
      c.buntAtt += t.bunts[0]
      c.buntOk += t.bunts[1]
      c.hitAndRun += t.hitAndRuns
      c.changes += t.pitchingChanges
      c.pinchRuns += t.pinchRuns
      c.pinchHits += t.pinchHits
      c.defSubs += t.defensiveSubs
      const starter = ours.roster.starter.id
      const outs = res.players.find((p) => p.side === userSide && p.playerId === starter)?.line.outs ?? 0
      c.starterOuts += outs
      c.starterOutsHist[outs < 15 ? 0 : outs < 18 ? 1 : outs < 21 ? 2 : 3]++
      results.set(`${type}|${style}`, c)
    }
  }
  recommended.set(type, rec)
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
const per = (a: number, g: number) => (a / g).toFixed(2)
console.log(`# 戰術風格平衡比較：每格 ${GAMES} 場，同一組種子與對手（對手強度 ${OPP_MEAN}），我方平均能力 ${MEAN}（新手 4.2）\n`)
for (const type of TYPES) {
  const rec = recommended.get(type)!
  console.log(`## ${type}（推薦戰術：${Object.entries(rec).map(([s, n]) => `${STYLE_NAME[s as CoachStyle]} ${n}/40`).join('、')}）\n`)
  console.log('| 風格 | 勝率 | 得分 | 失分 | 盜壘／場 | 盜壘成功率 | 觸擊／場（成功） | 打帶跑／場 | 換投／場 | 先發局數 | 先發 <5／5～6／6～7／7+ 局 | 代跑／代打／守備替補（／場） | 每場 ms |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const style of COACH_STYLES) {
    const c = results.get(`${type}|${style}`)!
    const g = c.games
    const hist = c.starterOutsHist.map((n) => pct(n, g)).join(' / ')
    console.log(
      `| ${STYLE_NAME[style]} | ${pct(c.wins, g)} | ${per(c.rs, g)} | ${per(c.ra, g)} | ${per(c.stealAtt, g)} | ${pct(c.stealOk, c.stealAtt)} | ${per(c.buntAtt, g)}（${pct(c.buntOk, c.buntAtt)}） | ${per(c.hitAndRun, g)} | ${per(c.changes, g)} | ${(c.starterOuts / g / 3).toFixed(2)} | ${hist} | ${per(c.pinchRuns, g)} / ${per(c.pinchHits, g)} / ${per(c.defSubs, g)} | ${(c.ms / g).toFixed(2)} |`,
    )
  }
  console.log('')
}
