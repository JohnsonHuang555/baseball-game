// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Game, RULES_VERSION, type GameSetup } from '../../sim/game'
import { generateTeam } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import { AutoCoach, BalancedPolicy, type CoachPolicy } from './autoCoach'

function setup(seed: number): GameSetup {
  return { home: generateTeam(new Rng(seed * 2 + 1)), away: generateTeam(new Rng(seed * 2 + 2)), seed, userSide: 'home', rules: RULES_VERSION }
}

/** 包住均衡策略，記下每次被詢問時是第幾局的哪個半局、第幾個打席 */
class RecordingPolicy implements CoachPolicy {
  readonly style = 'balanced' as const
  readonly asked = new Set<string>()
  private readonly inner = new BalancedPolicy()
  next(game: Game) {
    this.asked.add(`${game.inning}-${game.half}-${game.paIndex}`)
    return this.inner.next(game)
  }
}

describe('AutoCoach 打席識別', () => {
  it('盜壘失敗造成第三出局（打席序號沒變）時，新半局的第一個打席照樣會決策', () => {
    let edgeCases = 0
    for (let seed = 1; seed <= 300; seed++) {
      const game = new Game(setup(seed))
      const policy = new RecordingPolicy()
      const coach = new AutoCoach(policy)
      const halves = new Set<string>()
      while (!game.over) {
        halves.add(`${game.inning}-${game.half}-${game.halfStartPa}`)
        coach.act(game)
        const paBefore = game.paIndex
        const halfBefore = `${game.inning}-${game.half}`
        const events = game.step()
        // 邊界：這一步換了半局，打席序號卻沒變（盜壘被阻殺成第三個出局）
        if (!game.over && paBefore === game.paIndex && halfBefore !== `${game.inning}-${game.half}`) {
          expect(events.some((e) => e.type === 'steal' && !e.success)).toBe(true)
          edgeCases++
        }
      }
      // 每一個打過的半局，第一個打席自動教練都有被詢問
      for (const half of halves) expect(policy.asked.has(half)).toBe(true)
    }
    expect(edgeCases).toBeGreaterThan(0)
  })
})
