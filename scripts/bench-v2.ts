// V2 自動比賽的效能量測：npm run bench:v2
// 量 1、10、96、1,000 場的總耗時，並拆出開賽（建 Game）、自動教練、引擎推進、結果整理各佔多少
import { Game, type GameSetup } from '../src/sim/game'
import { generateTeam } from '../src/sim/generate'
import { Rng } from '../src/sim/rng'
import { AutoCoach, BalancedPolicy } from '../src/v2/application/autoCoach'
import { runMatch } from '../src/v2/application/matchRunner'

const setups = (n: number): GameSetup[] =>
  Array.from({ length: n }, (_, i) => ({ home: generateTeam(new Rng(i * 2 + 1)), away: generateTeam(new Rng(i * 2 + 2)), seed: i + 1, userSide: 'home' }))

const ms = (t: number) => `${t.toFixed(1)} ms`

// 暖機：讓 JIT 先把熱路徑編好
for (const s of setups(200)) runMatch(s)

console.log('場數 | 總耗時 | 每場 | 平均步數')
for (const n of [1, 10, 96, 1000]) {
  const list = setups(n)
  const t0 = performance.now()
  let steps = 0
  for (const s of list) steps += runMatch(s).steps
  const total = performance.now() - t0
  console.log(`${n} | ${ms(total)} | ${(total / n).toFixed(3)} ms | ${(steps / n).toFixed(0)}`)
}

// 拆解：同樣 1,000 場，手動跑一遍、分段計時
const list = setups(1000)
let tNew = 0
let tCoach = 0
let tStep = 0
let tTotal = 0
const t0 = performance.now()
for (const s of list) {
  let t = performance.now()
  const game = new Game({ ...s, rules: 9 })
  const coach = new AutoCoach(new BalancedPolicy())
  tNew += performance.now() - t
  while (!game.over) {
    t = performance.now()
    coach.act(game)
    const t1 = performance.now()
    game.step()
    const t2 = performance.now()
    tCoach += t1 - t
    tStep += t2 - t1
  }
}
tTotal = performance.now() - t0
const tFull = (() => {
  const t = performance.now()
  for (const s of list) runMatch(s)
  return performance.now() - t
})()
console.log(`\n拆解（1,000 場，含計時本身的開銷 ${ms(tTotal - tNew - tCoach - tStep)}）`)
console.log(`建立 Game：${ms(tNew)}，自動教練：${ms(tCoach)}，引擎 step()：${ms(tStep)}`)
console.log(`runMatch 全部（含精彩事件、結果整理）：${ms(tFull)}`)
