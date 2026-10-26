import { describe, expect, it } from 'vitest'
import { PITCH_TYPES } from '../sim/pitches'
import { GESTURES, GESTURE_KEYS, scoreGesture, scoreKeys, type Point } from './gesture'

/** 把樣板放大到螢幕大小，加上一點手抖 */
function draw(points: readonly Point[], size = 200, wobble = 0, seed = 1): Point[] {
  let s = seed
  const noise = () => {
    s = (s * 9301 + 49297) % 233280
    return (s / 233280 - 0.5) * wobble
  }
  const out: Point[] = []
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    for (let t = 0; t < 1; t += 0.1) out.push([(ax + (bx - ax) * t) * size + noise(), (ay + (by - ay) * t) * size + noise()])
  }
  const [lx, ly] = points[points.length - 1]
  out.push([lx * size, ly * size])
  return out
}

describe('投球手勢', () => {
  it('照樣板畫幾乎滿分；手有點抖還是很高分', () => {
    for (const pitch of PITCH_TYPES) {
      expect(scoreGesture(draw(GESTURES[pitch]), pitch, 500)).toBeGreaterThan(0.95)
      expect(scoreGesture(draw(GESTURES[pitch], 200, 16), pitch, 500)).toBeGreaterThan(0.75)
    }
  })

  it('直線畫歪一點（手機上用拇指畫常見）、收筆多一個小勾，仍然算畫得好', () => {
    const tilted = (deg: number): Point[] => {
      const a = (deg * Math.PI) / 180
      return Array.from({ length: 30 }, (_, i) => [200 + i * 4 * Math.sin(a), 300 - i * 4 * Math.cos(a)])
    }
    expect(scoreGesture(tilted(20), 'fastball', 400)).toBeGreaterThan(0.9)
    expect(scoreGesture(tilted(-20), 'fastball', 400)).toBeGreaterThan(0.9)
    expect(scoreGesture([...tilted(0), [208, 182], [214, 186]], 'fastball', 400)).toBeGreaterThan(0.85)
    // 端正的直線還是比歪的分數高
    expect(scoreGesture(tilted(0), 'fastball', 400)).toBeGreaterThan(scoreGesture(tilted(20), 'fastball', 400))
    // 歪太多就不算直球
    expect(scoreGesture(tilted(60), 'fastball', 400)).toBeLessThan(0.6)
  })

  it('大小、位置不影響分數', () => {
    const small = draw(GESTURES.slider, 80).map(([x, y]): Point => [x + 300, y + 40])
    expect(scoreGesture(small, 'slider', 500)).toBeGreaterThan(0.95)
  })

  it('畫錯球種、畫反方向都很低分', () => {
    for (const pitch of PITCH_TYPES) {
      for (const other of PITCH_TYPES) {
        if (other === pitch) continue
        expect(scoreGesture(draw(GESTURES[other]), pitch, 500)).toBeLessThan(0.6)
      }
    }
    expect(scoreGesture(draw([...GESTURES.change].reverse()), 'change', 500)).toBeLessThan(0.3)
  })

  it('太短算沒畫；畫太慢會打折', () => {
    expect(scoreGesture([[0, 0], [0, -10]], 'fastball', 300)).toBe(0)
    const line = draw(GESTURES.fastball)
    expect(scoreGesture(line, 'fastball', 3000)).toBeLessThan(scoreGesture(line, 'fastball', 500))
  })

  it('方向鍵：順序對了按得快就準，按錯是失投', () => {
    for (const pitch of PITCH_TYPES) {
      const keys = GESTURE_KEYS[pitch]
      expect(scoreKeys(keys, pitch, 280 * keys.length)).toBeGreaterThan(0.8)
      expect(scoreKeys(keys, pitch, 100)).toBeLessThanOrEqual(0.88)
      expect(scoreKeys(keys, pitch, 3000)).toBeLessThan(scoreKeys(keys, pitch, 280 * keys.length))
    }
    expect(scoreKeys(['ArrowDown'], 'fastball', 200)).toBe(0.3)
  })
})
