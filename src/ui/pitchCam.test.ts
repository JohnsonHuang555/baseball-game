// 投球視角的軌跡（Phase 9 PR 1：直球動畫看起來像曲球）。
// 固定球種、固定進壘點，量「畫出來的整條軌跡」偏離直線多少：直球每一格都要接近直線，曲球、滑球保有自己的變化
import { describe, expect, it } from 'vitest'
import { PITCH_TYPES, type PitchType } from '../sim/pitches'
import { APPROACH, PITCH_MOTION, blendedFlight, pitchPoint, type Pt } from './pitchCam'

const W = 200
const H = 150
const zone = { x: W * 0.36, y: H * 0.46, w: W * 0.28, h: H * 0.36 }
const startR = { x: W * 0.36, y: H * 0.3 }
const neutral = { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 }
/** 壞球（左、右、低）與好球帶四個角落：這些是畫面實際會用到的進壘點範圍 */
const TARGETS: Record<string, Pt> = {
  ballLeft: { x: zone.x - zone.w * 0.35, y: zone.y + zone.h / 2 },
  ballRight: { x: zone.x + zone.w * 1.35, y: zone.y + zone.h / 2 },
  ballLow: { x: zone.x + zone.w / 2, y: zone.y + zone.h * 1.3 },
  strikeLowIn: { x: zone.x + zone.w * 0.15, y: zone.y + zone.h * 0.85 },
  strikeHighAway: { x: zone.x + zone.w * 0.85, y: zone.y + zone.h * 0.15 },
}

/** 軌跡偏離「頭尾連線」的最大距離，除以連線長度（0 = 直線） */
function bend(pts: readonly Pt[]): number {
  const a = pts[0]
  const b = pts[pts.length - 1]
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  return Math.max(...pts.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L)) / L
}

/** 照直播的節奏產生一球：前段 41 格飛向中性點，揭曉段 20 格；回傳每一格畫出來的軌跡 */
function frames(pitch: PitchType, end: Pt, hand: 'R' | 'L' = 'R'): Pt[][] {
  const start = hand === 'R' ? startR : { x: W * 0.64, y: H * 0.3 }
  const ts: number[] = []
  const out: Pt[][] = []
  for (let i = 0; i <= 40; i++) {
    ts.push((APPROACH * i) / 40)
    out.push(ts.map((t) => pitchPoint(pitch, hand, start, neutral, t, W)))
  }
  for (let i = 1; i <= 20; i++) {
    const u = i / 20
    const t = APPROACH + (1 - APPROACH) * u
    ts.push(t)
    out.push(blendedFlight(pitch, hand, start, neutral, end, W, ts, t, u * u * (3 - 2 * u)).trail)
  }
  return out
}

/** 修正前的做法（只把球的位置在最後 20% 混合）：用來證明測試量得到這個錯誤 */
function legacyTrail(pitch: PitchType, end: Pt): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= 40; i++) pts.push(pitchPoint(pitch, 'R', startR, neutral, (APPROACH * i) / 40, W))
  for (let i = 1; i <= 20; i++) {
    const u = i / 20
    const t = APPROACH + (1 - APPROACH) * u
    const s = u * u * (3 - 2 * u)
    const a = pitchPoint(pitch, 'R', startR, neutral, t, W)
    const b = pitchPoint(pitch, 'R', startR, end, t, W)
    pts.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s })
  }
  return pts
}

/** 這個球種朝 end 的「真正」軌跡 */
const truth = (pitch: PitchType, end: Pt) => Array.from({ length: 61 }, (_, i) => pitchPoint(pitch, 'R', startR, end, i / 60, W))

describe('直球：不能有曲球那樣的彎', () => {
  it.each(Object.keys(TARGETS))('進壘點 %s：每一格畫出來的軌跡都接近直線（左右投都一樣）', (name) => {
    for (const hand of ['R', 'L'] as const) {
      for (const trail of frames('fastball', TARGETS[name], hand)) {
        if (trail.length < 3) continue
        expect(bend(trail)).toBeLessThan(0.03)
      }
    }
  })

  it('修正前的做法在同樣的進壘點會彎得比真正的曲球還多（這個測試量得到原本的錯誤）', () => {
    const legacy = Math.max(...Object.values(TARGETS).map((e) => bend(legacyTrail('fastball', e))))
    expect(legacy).toBeGreaterThan(0.2)
    expect(legacy).toBeGreaterThan(Math.max(...Object.values(TARGETS).map((e) => bend(truth('curve', e)))) * 0.5)
  })

  it('直球的設定本身就幾乎沒有變化，而且最快', () => {
    const f = PITCH_MOTION.fastball
    expect(Math.abs(f.breakX)).toBeLessThanOrEqual(0.05)
    expect(Math.abs(f.breakY)).toBeLessThanOrEqual(0.05)
    expect(f.hump).toBe(0)
    for (const p of PITCH_TYPES) if (p !== 'fastball') expect(PITCH_MOTION[p].pace).toBeGreaterThan(f.pace)
  })
})

describe('各球種保有自己的形狀', () => {
  it('揭曉結束時，畫出來的就是這個球種朝真正進壘點的軌跡', () => {
    for (const pitch of PITCH_TYPES) {
      for (const end of Object.values(TARGETS)) {
        const last = frames(pitch, end).at(-1)!
        expect(last.at(-1)!.x).toBeCloseTo(end.x, 6)
        expect(last.at(-1)!.y).toBeCloseTo(end.y, 6)
        // 跟真正的軌跡同一條曲線：每一點都落在 pitchPoint(pitch, start, end, t) 上
        expect(bend(last)).toBeCloseTo(bend(truth(pitch, end)), 1)
      }
    }
  })

  it('曲球有明顯的下墜與先上飄：中段比直線高、最後幾格下墜比直球多', () => {
    const end = TARGETS.strikeLowIn
    const drop = (pitch: PitchType) => {
      const pts = truth(pitch, end)
      // 最後 20% 的垂直位移（往下為正）
      return pts.at(-1)!.y - pts[48].y
    }
    expect(drop('curve')).toBeGreaterThan(drop('fastball') * 1.5)
    const mid = truth('curve', end)[30]
    const line = { x: (startR.x + end.x) / 2, y: (startR.y + end.y) / 2 }
    expect(mid.y).toBeLessThan(line.y)
  })

  it('滑球有橫向偏移：右投往捕手看的右邊（左投相反），直球幾乎沒有', () => {
    const lateral = (pitch: PitchType, hand: 'R' | 'L') => {
      const start = hand === 'R' ? startR : { x: W * 0.64, y: H * 0.3 }
      const end = TARGETS.strikeLowIn
      const mid = pitchPoint(pitch, hand, start, end, 0.5, W)
      const straight = { x: (start.x + end.x) / 2 }
      return straight.x - mid.x
    }
    expect(lateral('slider', 'R')).toBeGreaterThan(5)
    expect(lateral('slider', 'L')).toBeLessThan(-5)
    expect(Math.abs(lateral('fastball', 'R'))).toBeLessThan(lateral('slider', 'R') / 4)
  })
})
