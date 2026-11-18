// @vitest-environment happy-dom
// 球場與投球視角的投球動畫：V1 的 pitch() / play() 行為不變；V2 直播用的「中性前段」不依結果畫任何東西，結果另外播
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PitchResult } from '../sim/game'
import type { Pitcher } from '../sim/types'
import { FieldRenderer } from './field'
import { APPROACH, PitchCam } from './pitchCam'

/** 2D context 的替身：所有方法都是空的 */
function stubContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => ({ addColorStop: () => undefined })),
    set: (target, key, value) => ((target[key as string] = value), true),
  }) as unknown as CanvasRenderingContext2D
}

let snapshots: (() => void)[] = []
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => stubContext() as never)
  // 每一幀都跳到補間的最後（t = 1），並在每一幀之後記錄畫面狀態
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => {
      cb(performance.now() + 1e6)
      snapshots.forEach((s) => s())
    }, 0),
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  snapshots = []
})

function field() {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 360 })
  Object.defineProperty(canvas, 'clientHeight', { value: 300 })
  const f = new FieldRenderer(canvas)
  const balls: ({ x: number; y: number } | null)[] = []
  snapshots.push(() => balls.push(f.ballState ? { x: f.ballState.x, y: f.ballState.y } : null))
  return { f, balls }
}

const RESULTS: PitchResult[] = ['ball', 'calledStrike', 'swingingStrike', 'foul', 'inPlay']

describe('FieldRenderer', () => {
  it('V1 的 pitch()：界外球有後續軌跡，打進場內留在本壘，其他結果收起球（行為不變）', async () => {
    for (const r of RESULTS) {
      const { f, balls } = field()
      await f.pitch(r, 100, 'slider', 'R')
      const plate = balls[0]!
      if (r === 'foul') expect(balls.some((b) => b && (b.x !== plate.x || b.y !== plate.y))).toBe(true)
      if (r === 'inPlay') expect(f.ballState).not.toBeNull()
      else expect(f.ballState).toBeNull()
    }
  })

  it('V2 的 pitchTravel()：不管之後是什麼結果，球都停在本壘、沒有界外球軌跡；pitchOutcome() 才畫結果', async () => {
    const ends = new Set<string>()
    for (const r of RESULTS) {
      const { f, balls } = field()
      await f.pitchTravel(100, 'curve', 'L')
      const atPlate = f.ballState!
      ends.add(`${atPlate.x},${atPlate.y}`)
      expect(balls.every((b) => b !== null)).toBe(true)
      const before = balls.length
      await f.pitchOutcome(r, 100)
      const after = balls.slice(before)
      if (r === 'foul') expect(after.some((b) => b && (b.x !== atPlate.x || b.y !== atPlate.y))).toBe(true)
      else expect(after).toEqual([])
      if (r === 'inPlay') expect(f.ballState).not.toBeNull()
      else expect(f.ballState).toBeNull()
    }
    // 前段的終點跟結果無關
    expect(ends.size).toBe(1)
  })

  it('cancel() 之後補間立刻結束，不再改畫面', async () => {
    const { f } = field()
    const p = f.pitchTravel(10_000)
    f.cancel()
    await p
    expect(f.ballState).toBeNull()
  })
})

describe('PitchCam', () => {
  const pitcher = { id: 'p', name: '投手', role: 'pitcher', throws: 'R', ratings: { stuff: 5, control: 5, stamina: 5 }, traits: [] } as unknown as Pitcher
  const cam = () => {
    const c = new PitchCam()
    Object.defineProperty(c.root, 'clientWidth', { value: 120 })
    Object.defineProperty(c.root, 'clientHeight', { value: 100 })
    return c
  }

  it('approach() 不收結果、只播到 APPROACH；finish() 才把球帶到進壘點；沒有 approach 時 finish 什麼都不做', async () => {
    expect(APPROACH).toBeLessThan(1)
    expect(PitchCam.prototype.approach.length).toBe(3)
    const c = cam()
    const random = vi.spyOn(Math, 'random')
    await c.approach('slider', pitcher, 100)
    // 前段只抽了球速的起伏（1 次），沒有抽進壘點
    expect(random).toHaveBeenCalledTimes(1)
    expect(c.root.classList.contains('show')).toBe(true)
    await c.finish('ball', 50)
    expect(random.mock.calls.length).toBeGreaterThan(1)
    const lonely = cam()
    const before = random.mock.calls.length
    await lonely.finish('ball', 50)
    expect(random.mock.calls.length).toBe(before)
  })

  it('cancel() 會丟掉播到一半的球：之後的 finish 不畫任何東西；V1 的 play() 照舊', async () => {
    const c = cam()
    await c.approach('fastball', pitcher, 100)
    c.cancel()
    expect(c.root.classList.contains('show')).toBe(false)
    const random = vi.spyOn(Math, 'random')
    await c.finish('foul', 50)
    expect(random).not.toHaveBeenCalled()
    await c.play('curve', pitcher, 'ball', 50)
    expect(random).toHaveBeenCalled()
  })
})
