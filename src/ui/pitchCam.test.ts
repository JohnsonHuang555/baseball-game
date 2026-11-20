// @vitest-environment happy-dom
// 投球視角的動畫（Phase 9 PR 1；PR #20 review P2/P3）。
// 驅動真正的 PitchCam（approach → 結果提交 → finish），逐影格記錄 canvas 上畫出的「球心」與「拖尾」，
// 分開量四件事：
//   trailBend           單一影格拖尾偏離頭尾連線的最大距離 ÷ 連線長度（0 = 直線）
//   ballPathBend        整段動畫（出手到進壘）球心路徑偏離頭尾連線的最大距離 ÷ 連線長度
//   transitionJump      揭曉前最後一格到揭曉後第一格的球心位移 ÷ 連線長度（另外跟揭曉段一般一步比）
//   lateralAcceleration 相鄰兩步之間，後一步垂直於前一步方向的位移 ÷ 連線長度（突然橫向加速）
//
// 閾值依目前小窗的座標尺度訂：
//   - 小窗 118 × 94 px（shared.css .pitch-cam），出手點到進壘點的連線約 30～50 px。
//   - 直球的設定（PITCH_MOTION.fastball，power = 1）本身是嚴格的直線，量到的應該是 0。
//     ballPathBend / trailBend < 0.03 ≈ 偏離不到 1.5 px，肉眼看不出彎。
//   - lateralAcceleration < 0.01 ≈ 每格橫向不到 0.5 px。
//   - transitionJump ≤ 揭曉段一般一步的 1.5 倍 → 沒有瞬移。
//   修正前的兩個版本（PR 前的「混合球位置」、c1ceede 的「移動終點」）在同樣的進壘點會遠超過這些閾值（最後一段的測試證明）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PitchResult } from '../sim/game'
import { PITCH_TYPES, type PitchType } from '../sim/pitches'
import type { Hand, Pitcher } from '../sim/types'
import { APPROACH, PITCH_MOTION, PitchCam, pitchPoint, pitchTarget, revealProgress, type Pt } from './pitchCam'

const W = 118
const H = 94.4
const ZONE = { x: W * 0.36, y: H * 0.46, w: W * 0.28, h: H * 0.36 }
const startOf = (hand: Hand): Pt => ({ x: W * (hand === 'R' ? 0.36 : 0.64), y: H * 0.3 })
const FRAME = 1000 / 60
/** 直播實際的時間：前段 600 ms × 0.8（一般時刻再快一點），揭曉段最多 160 ms */
const APPROACH_MS = 480
const REVEAL_MS = 160

// ---- 進壘點：用 Math.random 的序列指定（pitchTarget 的規則） ----
/** [結果, Math.random 依序回傳的值]；approach 會先抽 1 次（球速起伏） */
const SPOTS: Record<string, [PitchResult, number[]]> = {
  strikeCenter: ['calledStrike', [0.5, 0.5]],
  strikeHighIn: ['calledStrike', [0, 0]],
  strikeHighAway: ['calledStrike', [1, 0]],
  strikeLowIn: ['calledStrike', [0, 1]],
  strikeLowAway: ['calledStrike', [1, 1]],
  ballLeft: ['ball', [0.1, 0.5]],
  ballRight: ['ball', [0.5, 0.5]],
  ballLow: ['ball', [0.9, 0.5]],
}
function spotPoint(name: string): Pt {
  const [result, seq] = SPOTS[name]
  const q = [...seq]
  return pitchTarget(result, ZONE, () => q.shift()!)
}

// ---- 假的 canvas、requestAnimationFrame、時鐘 ----
interface Frame {
  ball: Pt
  trail: Pt[]
}
let frames: Frame[] = []
let clock = 0
let queue: FrameRequestCallback[] = []
let randoms: number[] = []

function recordingContext(): CanvasRenderingContext2D {
  let cur: Frame | null = null
  let pen: Pt | null = null
  let segs: [Pt, Pt][] = []
  const target: Record<string, unknown> = {
    clearRect: () => {
      cur = { ball: { x: NaN, y: NaN }, trail: [] }
      frames.push(cur)
    },
    beginPath: () => {
      segs = []
    },
    moveTo: (x: number, y: number) => {
      pen = { x, y }
    },
    lineTo: (x: number, y: number) => {
      if (pen) segs.push([pen, { x, y }])
      pen = { x, y }
    },
    stroke: () => {
      // 拖尾的每一段：beginPath → moveTo(前一點) → lineTo(這一點) → 黃色 stroke；好球帶、本壘板是別的顏色
      if (!cur || !String(target.strokeStyle).startsWith('rgba(255,214,63')) return
      for (const [a, b] of segs) {
        if (cur.trail.length === 0) cur.trail.push(a)
        cur.trail.push(b)
      }
    },
    arc: (x: number, y: number, _r: number, a0: number, a1: number) => {
      // 球是整圓（0 → 2π）；縫線是一小段弧
      if (cur && a0 === 0 && a1 === Math.PI * 2) cur.ball = { x, y }
    },
  }
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key as string] : () => undefined),
    set: (t, key, value) => ((t[key as string] = value), true),
  }) as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  frames = []
  clock = 0
  queue = []
  randoms = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingContext() as never)
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(Math, 'random').mockImplementation(() => (randoms.length ? randoms.shift()! : 0.5))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (queue.push(cb), queue.length))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** 推進一格：時間 +16.7 ms，跑完這一格排進來的 callback */
async function step(): Promise<void> {
  clock += FRAME
  const run = queue
  queue = []
  run.forEach((cb) => cb(clock))
  await Promise.resolve()
}
async function until(p: Promise<void>, limit = 200): Promise<void> {
  let done = false
  void p.then(() => (done = true))
  for (let i = 0; i < limit && !done; i++) await step()
  await Promise.resolve()
  expect(done).toBe(true)
}

function cam(): PitchCam {
  const c = new PitchCam()
  Object.defineProperty(c.root, 'clientWidth', { value: W })
  Object.defineProperty(c.root, 'clientHeight', { value: H })
  return c
}
const pitcher = (hand: Hand): Pitcher => ({ id: `p-${hand}`, name: 'P', throws: hand, ratings: { stuff: 5, control: 5, stamina: 5 }, traits: [] }) as unknown as Pitcher

/** 用真正的 PitchCam 投一球；回傳揭曉前、揭曉後的影格 */
async function throwPitch(c: PitchCam, pitch: PitchType, hand: Hand, spot: string): Promise<{ approach: Frame[]; reveal: Frame[]; end: Pt }> {
  const [result, seq] = SPOTS[spot]
  randoms = [0.5, ...seq]
  const from = frames.length
  await until(c.approach(pitch, pitcher(hand), APPROACH_MS))
  const mid = frames.length
  await until(c.finish(result, REVEAL_MS))
  return { approach: frames.slice(from, mid), reveal: frames.slice(mid), end: spotPoint(spot) }
}

// ---- 量測 ----
function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}
/** 偏離頭尾連線的最大距離 ÷ 連線長度 */
function bend(pts: readonly Pt[]): number {
  if (pts.length < 3) return 0
  const a = pts[0]
  const b = pts[pts.length - 1]
  const L = dist(a, b)
  if (pts.length < 3 || L === 0) return 0
  return Math.max(...pts.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / L)) / L
}
/** 去掉連續重複的點（揭曉前球停在出手點） */
function moving(pts: readonly Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-9)
}
function metrics(approach: Frame[], reveal: Frame[]) {
  const path = moving([...approach, ...reveal].map((f) => f.ball))
  const L = dist(path[0], path[path.length - 1])
  let lateral = 0
  for (let i = 2; i < path.length; i++) {
    const v1 = { x: path[i - 1].x - path[i - 2].x, y: path[i - 1].y - path[i - 2].y }
    const v2 = { x: path[i].x - path[i - 1].x, y: path[i].y - path[i - 1].y }
    lateral = Math.max(lateral, Math.abs(v1.x * v2.y - v1.y * v2.x) / Math.hypot(v1.x, v1.y) / L)
  }
  const steps = reveal.slice(1).map((f, i) => dist(reveal[i].ball, f.ball))
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)]
  const jump = dist(approach[approach.length - 1].ball, reveal[0].ball)
  return {
    trailBend: Math.max(0, ...reveal.map((f) => bend(f.trail))),
    ballPathBend: bend(path),
    transitionJump: jump / L,
    jumpVsStep: jump / typical,
    lateralAcceleration: lateral,
    path,
  }
}
/** 這個球種朝 end 的真正軌跡（pitchPoint） */
const truth = (pitch: PitchType, hand: Hand, end: Pt, n = 60) => Array.from({ length: n + 1 }, (_, i) => pitchPoint(pitch, hand, startOf(hand), end, i / n, W))

// ---- 測試 ----

describe('直球：球心從出手到進壘是一條直線（PR #20 review P2）', () => {
  for (const hand of ['R', 'L'] as const) {
    for (const spot of Object.keys(SPOTS)) {
      it(`${hand === 'R' ? '右投' : '左投'}直球 → ${spot}：ballPathBend、trailBend、lateralAcceleration、transitionJump 都在閾值內`, async () => {
        const { approach, reveal, end } = await throwPitch(cam(), 'fastball', hand, spot)
        const m = metrics(approach, reveal)
        expect(m.ballPathBend).toBeLessThan(0.03)
        expect(m.trailBend).toBeLessThan(0.03)
        expect(m.lateralAcceleration).toBeLessThan(0.01)
        expect(m.jumpVsStep).toBeLessThanOrEqual(1.5)
        // 起點是出手點、終點是真正的進壘點
        expect(m.path[0].x).toBeCloseTo(startOf(hand).x, 6)
        expect(m.path.at(-1)!.x).toBeCloseTo(end.x, 6)
        expect(m.path.at(-1)!.y).toBeCloseTo(end.y, 6)
      })
    }
  }
})

describe('揭曉前不透露進壘點；揭曉前後位置連續', () => {
  it('approach 的每一格球都在出手點（不往任何方向橫移），沒有拖尾', async () => {
    for (const spot of ['ballLeft', 'ballRight', 'strikeCenter']) {
      const { approach } = await throwPitch(cam(), 'curve', 'R', spot)
      expect(approach.length).toBeGreaterThan(20)
      for (const f of approach) {
        expect(f.ball).toEqual(startOf('R'))
        expect(f.trail).toEqual([])
      }
    }
  })

  it('approach → finish：第一格揭曉的球緊接著出手點，位移不超過揭曉段一般一步（各球種）', async () => {
    for (const pitch of PITCH_TYPES) {
      const { approach, reveal } = await throwPitch(cam(), pitch, 'R', 'ballLeft')
      const m = metrics(approach, reveal)
      // 揭曉段大約 10 格走完整條路：第一格不超過連線的 15%
      expect(m.transitionJump).toBeLessThan(0.15)
      expect(m.jumpVsStep).toBeLessThanOrEqual(1.5)
    }
  })

  it('揭曉段每一格的球都在這個球種的真正軌跡上（pitchPoint(revealProgress(u))），拖尾就是球走過的路', async () => {
    for (const pitch of PITCH_TYPES) {
      for (const hand of ['R', 'L'] as const) {
        const { reveal, end } = await throwPitch(cam(), pitch, hand, 'strikeLowAway')
        reveal.forEach((f, i) => {
          const u = Math.min(1, ((i + 1) * FRAME) / REVEAL_MS)
          const p = pitchPoint(pitch, hand, startOf(hand), end, revealProgress(u), W)
          expect(f.ball.x).toBeCloseTo(p.x, 6)
          expect(f.ball.y).toBeCloseTo(p.y, 6)
          expect(f.trail.at(-1) ?? f.ball).toEqual(f.ball)
        })
        expect(reveal.at(-1)!.trail.length).toBe(reveal.length)
      }
    }
  })
})

describe('各球種保有自己的變化', () => {
  it('曲球：先上飄、最後大幅下墜；整段路徑的彎度等於真正的曲球、遠大於直球', async () => {
    const { approach, reveal, end } = await throwPitch(cam(), 'curve', 'R', 'strikeCenter')
    const m = metrics(approach, reveal)
    expect(m.ballPathBend).toBeGreaterThan(0.15)
    expect(Math.abs(m.ballPathBend - bend(truth('curve', 'R', end)))).toBeLessThan(0.03)
    // 上飄：有一段比出手點還高
    expect(Math.min(...m.path.map((p) => p.y))).toBeLessThan(startOf('R').y)
    // 下墜：最後 30% 的垂直位移比直球同一段多
    const drop = (pts: Pt[]) => pts.at(-1)!.y - pts[Math.floor(pts.length * 0.7)].y
    const fast = await throwPitch(cam(), 'fastball', 'R', 'strikeCenter')
    expect(drop(m.path)).toBeGreaterThan(drop(metrics(fast.approach, fast.reveal).path) * 1.3)
  })

  it('滑球：右投、左投的橫向變化方向相反，幅度都明顯', async () => {
    /** 路徑相對頭尾連線的有號偏移（取絕對值最大的那一點） */
    const lateral = async (hand: Hand) => {
      const { approach, reveal, end } = await throwPitch(cam(), 'slider', hand, 'strikeCenter')
      const path = metrics(approach, reveal).path
      const s = startOf(hand)
      const off = path.map((p) => ((end.x - s.x) * (p.y - s.y) - (end.y - s.y) * (p.x - s.x)) / dist(s, end))
      return off.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
    }
    const r = await lateral('R')
    const l = await lateral('L')
    expect(Math.sign(r)).toBe(-Math.sign(l))
    expect(Math.abs(r)).toBeGreaterThan(3)
    expect(Math.abs(l)).toBeGreaterThan(3)
  })

  it('變速球、指叉球：整段路徑的彎度等於真正的軌跡，而且比直球彎', async () => {
    for (const pitch of ['change', 'splitter'] as const) {
      for (const spot of ['strikeCenter', 'ballLow']) {
        const { approach, reveal, end } = await throwPitch(cam(), pitch, 'R', spot)
        const m = metrics(approach, reveal)
        expect(Math.abs(m.ballPathBend - bend(truth(pitch, 'R', end)))).toBeLessThan(0.03)
        expect(m.ballPathBend).toBeGreaterThan(0.03)
      }
    }
  })

  it('直球的設定本身就是直線（power = 1、沒有上飄），而且最快', () => {
    const f = PITCH_MOTION.fastball
    expect(f.power).toBe(1)
    expect(f.hump).toBe(0)
    for (const p of PITCH_TYPES) if (p !== 'fastball') expect(PITCH_MOTION[p].pace).toBeGreaterThan(f.pace)
  })
})

describe('取消與下一球', () => {
  it('揭曉到一半 cancel()：之後不再畫任何影格，小窗收起', async () => {
    const c = cam()
    randoms = [0.5, 0.1, 0.5]
    await until(c.approach('fastball', pitcher('R'), APPROACH_MS))
    const p = c.finish('ball', REVEAL_MS)
    await step()
    await step()
    c.cancel()
    const drawn = frames.length
    for (let i = 0; i < 20; i++) await step()
    await p
    expect(frames.length).toBe(drawn)
    expect(c.root.classList.contains('show')).toBe(false)
  })

  it('前段到一半 cancel()：之後的 finish 不畫；下一球照常從新的出手點開始', async () => {
    const c = cam()
    randoms = [0.5]
    const p = c.approach('curve', pitcher('R'), APPROACH_MS)
    await step()
    c.cancel()
    const drawn = frames.length
    for (let i = 0; i < 10; i++) await step()
    await p
    await until(c.finish('ball', REVEAL_MS))
    expect(frames.length).toBe(drawn)
    const next = await throwPitch(c, 'fastball', 'L', 'strikeCenter')
    expect(next.approach[0].ball).toEqual(startOf('L'))
  })

  it('前段還沒播完就投下一球（直播快轉）：舊的那一球不再畫，新的一球不繼承舊的狀態', async () => {
    const c = cam()
    randoms = [0.5]
    const old = c.approach('curve', pitcher('R'), APPROACH_MS)
    await step()
    const next = throwPitch(c, 'fastball', 'L', 'ballRight')
    const { approach, reveal } = await next
    await old
    for (const f of approach) expect(f.ball).toEqual(startOf('L'))
    expect(metrics(approach, reveal).ballPathBend).toBeLessThan(0.03)
  })

  it('連投兩球：第二球的拖尾只有第二球自己的點，不繼承前一球', async () => {
    const c = cam()
    const first = await throwPitch(c, 'curve', 'R', 'ballRight')
    const second = await throwPitch(c, 'fastball', 'L', 'ballLeft')
    expect(first.reveal.at(-1)!.trail.length).toBe(first.reveal.length)
    expect(second.reveal[0].trail.length).toBeLessThanOrEqual(1)
    expect(second.reveal.at(-1)!.trail.length).toBe(second.reveal.length)
    const firstPts = new Set(first.reveal.at(-1)!.trail.map((p) => `${p.x},${p.y}`))
    expect(second.reveal.at(-1)!.trail.some((p) => firstPts.has(`${p.x},${p.y}`))).toBe(false)
    expect(metrics(second.approach, second.reveal).ballPathBend).toBeLessThan(0.03)
  })
})

describe('新的量測抓得到修正前的錯誤', () => {
  // 修正前的兩種畫法（同樣的時間切分：前段 APPROACH 朝好球帶中心、揭曉段 smoothstep）
  const neutral = { x: ZONE.x + ZONE.w / 2, y: ZONE.y + ZONE.h / 2 }
  function legacy(kind: 'blendBall' | 'moveEnd', pitch: PitchType, hand: Hand, end: Pt): [Frame[], Frame[]] {
    const s = startOf(hand)
    const approach: Frame[] = []
    const reveal: Frame[] = []
    const ts: number[] = []
    const trail: Pt[] = []
    for (let i = 1; i <= Math.ceil(APPROACH_MS / FRAME); i++) {
      const t = APPROACH * Math.min(1, (i * FRAME) / APPROACH_MS)
      ts.push(t)
      const ball = pitchPoint(pitch, hand, s, neutral, t, W)
      trail.push(ball)
      approach.push({ ball, trail: [...trail] })
    }
    for (let i = 1; i <= Math.ceil(REVEAL_MS / FRAME); i++) {
      const u = Math.min(1, (i * FRAME) / REVEAL_MS)
      const t = APPROACH + (1 - APPROACH) * u
      const k = u * u * (3 - 2 * u)
      ts.push(t)
      if (kind === 'blendBall') {
        const a = pitchPoint(pitch, hand, s, neutral, t, W)
        const b = pitchPoint(pitch, hand, s, end, t, W)
        const ball = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }
        trail.push(ball)
        reveal.push({ ball, trail: [...trail] })
      } else {
        const target = { x: neutral.x + (end.x - neutral.x) * k, y: neutral.y + (end.y - neutral.y) * k }
        reveal.push({ ball: pitchPoint(pitch, hand, s, target, t, W), trail: ts.map((x) => pitchPoint(pitch, hand, s, target, x, W)) })
      }
    }
    return [approach, reveal]
  }

  it('PR 前（混合球的位置）：拖尾與球心都彎；c1ceede（移動終點）：拖尾是直的，但球心路徑仍然轉彎（只量拖尾抓不到）', () => {
    for (const spot of ['ballLeft', 'ballRight', 'strikeHighAway', 'strikeLowIn']) {
      const end = spotPoint(spot)
      const a = metrics(...legacy('blendBall', 'fastball', 'R', end))
      const b = metrics(...legacy('moveEnd', 'fastball', 'R', end))
      expect(a.ballPathBend).toBeGreaterThan(0.03)
      expect(a.trailBend).toBeGreaterThan(0.03)
      expect(b.trailBend).toBeLessThan(0.03)
      expect(b.ballPathBend).toBeGreaterThan(0.03)
      expect(b.lateralAcceleration).toBeGreaterThan(0.01)
    }
  })
})
