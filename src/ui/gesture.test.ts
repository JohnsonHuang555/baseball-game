import { describe, expect, it } from 'vitest'
import { PITCH_TYPES, type PitchType } from '../sim/pitches'
import {
  GESTURES,
  PLAIN,
  TEMPO,
  drawnBackwards,
  gestureKeys,
  gestureTemplate,
  randomVariant,
  scoreGesture,
  scoreKeys,
  tempoMiss,
  type GestureVariant,
  type Point,
} from './gesture'

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

/** 照著這個球種的節奏畫 */
const onTempo = (pitch: PitchType) => TEMPO[pitch].show

describe('投球手勢', () => {
  it('照樣板、照節奏畫幾乎滿分；手有點抖還是很高分', () => {
    for (const pitch of PITCH_TYPES) {
      expect(scoreGesture(draw(GESTURES[pitch]), pitch, onTempo(pitch))).toBeGreaterThan(0.95)
      expect(scoreGesture(draw(GESTURES[pitch], 200, 16), pitch, onTempo(pitch))).toBeGreaterThan(0.75)
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

  it('形狀對了但方向畫反，可以認出來提醒玩家', () => {
    for (const pitch of PITCH_TYPES) {
      expect(drawnBackwards(draw([...GESTURES[pitch]].reverse()), pitch, onTempo(pitch))).toBe(true)
      expect(drawnBackwards(draw(GESTURES[pitch]), pitch, onTempo(pitch))).toBe(false)
    }
    // 亂畫一通不算畫反
    expect(drawnBackwards(draw(GESTURES.curve), 'fastball', 400)).toBe(false)
  })

  it('大小、位置不影響分數', () => {
    const small = draw(GESTURES.slider, 80).map(([x, y]): Point => [x + 300, y + 40])
    expect(scoreGesture(small, 'slider', onTempo('slider'))).toBeGreaterThan(0.95)
  })

  it('畫錯球種、畫反方向都很低分', () => {
    for (const pitch of PITCH_TYPES) {
      for (const other of PITCH_TYPES) {
        if (other === pitch) continue
        expect(scoreGesture(draw(GESTURES[other]), pitch, onTempo(pitch))).toBeLessThan(0.6)
      }
    }
    expect(scoreGesture(draw([...GESTURES.change].reverse()), 'change', onTempo('change'))).toBeLessThan(0.3)
  })

  it('太短算沒畫', () => {
    expect(scoreGesture([[0, 0], [0, -10]], 'fastball', 300)).toBe(0)
  })

  it('節奏：直球要快、變速球要慢；太快太慢都打折，而且說得出是哪一種', () => {
    const fast = draw(GESTURES.fastball)
    expect(scoreGesture(fast, 'fastball', 1500)).toBeLessThan(scoreGesture(fast, 'fastball', 300) - 0.2)
    expect(tempoMiss('fastball', 1500)).toBe('slow')
    expect(tempoMiss('fastball', 300)).toBeNull()
    const change = draw(GESTURES.change)
    expect(scoreGesture(change, 'change', 250)).toBeLessThan(scoreGesture(change, 'change', 1200) - 0.2)
    expect(tempoMiss('change', 250)).toBe('fast')
    // 再怎麼離譜也只扣到一個底線，形狀畫對還是有分
    expect(scoreGesture(fast, 'fastball', 10000)).toBeGreaterThan(0.55)
  })

  it('左投手：手勢左右鏡像，照右投手的畫法反而低分', () => {
    const lefty: GestureVariant = { ...PLAIN, mirror: true }
    expect(scoreGesture(draw(gestureTemplate('slider', lefty)), 'slider', onTempo('slider'), lefty)).toBeGreaterThan(0.95)
    expect(scoreGesture(draw(GESTURES.slider), 'slider', onTempo('slider'), lefty)).toBeLessThan(0.6)
    expect(scoreGesture(draw(GESTURES.curve), 'curve', onTempo('curve'), lefty)).toBeLessThan(0.6)
    // 直線、V 字左右對稱，鏡像後一樣
    expect(scoreGesture(draw(GESTURES.fastball), 'fastball', 300, lefty)).toBeGreaterThan(0.95)
    expect(gestureKeys('slider', lefty)).toEqual(['ArrowRight', 'ArrowDown', 'ArrowLeft'])
  })

  it('每一球轉個角度：照著轉過的虛線畫才高分', () => {
    const turned: GestureVariant = { ...PLAIN, tilt: 12 }
    for (const pitch of PITCH_TYPES) {
      expect(scoreGesture(draw(gestureTemplate(pitch, turned)), pitch, onTempo(pitch), turned)).toBeGreaterThan(0.95)
    }
    // 隨機的變化都在範圍內
    let r = 0
    const seq = () => (r = (r + 0.37) % 1)
    for (let i = 0; i < 50; i++) {
      const v = randomVariant(i % 2 ? 'L' : 'R', seq)
      expect(Math.abs(v.tilt)).toBeLessThanOrEqual(12)
      expect(v.scale).toBeGreaterThanOrEqual(0.72)
      expect(v.scale).toBeLessThanOrEqual(1)
      expect(v.mirror).toBe(i % 2 === 1)
    }
  })

  it('方向鍵：順序對了按得快就準，按錯是失投', () => {
    for (const pitch of PITCH_TYPES) {
      const keys = gestureKeys(pitch)
      expect(scoreKeys(keys, pitch, 280 * keys.length)).toBeGreaterThan(0.8)
      expect(scoreKeys(keys, pitch, 100)).toBeLessThanOrEqual(0.88)
      expect(scoreKeys(keys, pitch, 3000)).toBeLessThan(scoreKeys(keys, pitch, 280 * keys.length))
    }
    expect(scoreKeys(['ArrowDown'], 'fastball', 200)).toBe(0.3)
  })
})
