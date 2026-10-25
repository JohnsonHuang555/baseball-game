import type { BattedBall, PitchResult, RunnerMove } from '../sim/game'

interface Pt {
  x: number
  y: number
}

const FENCE_FT = 400
const INFIELD_FT = 150
/** [角度, 距離英呎]：角度 0 為中外野方向 */
const BASES: Record<0 | 1 | 2 | 3, [number, number]> = { 0: [0, 0], 1: [45, 90], 2: [0, 127.3], 3: [-45, 90] }
const MOUND: [number, number] = [0, 60.5]
const FIELDER_SPOTS: Record<string, [number, number]> = {
  P: [0, 60.5],
  C: [0, -10],
  '1B': [38, 105],
  '2B': [14, 145],
  SS: [-14, 145],
  '3B': [-38, 105],
  LF: [-28, 285],
  CF: [0, 315],
  RF: [28, 285],
}

const COLORS = {
  foul: '#1d5a2a',
  fair: '#2f8a3e',
  dirt: '#b98558',
  line: '#f4f1e8',
  fence: '#f2c94c',
  ball: '#ffffff',
  shadow: 'rgba(0,0,0,0.35)',
}

interface Dot extends Pt {
  alpha: number
}

/** 俯視球場。只負責畫面，比賽狀態全部來自模擬（ADR-0001） */
export class FieldRenderer {
  private readonly ctx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private scale = 1
  private home: Pt = { x: 0, y: 0 }
  private fielders = new Map<string, Pt>()
  private runners = new Map<string, Dot>()
  private batterId: string | null = null
  private ball: (Pt & { height: number }) | null = null
  fieldingColor = '#ef4444'
  battingColor = '#3b82f6'

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1
    this.w = this.canvas.clientWidth
    this.h = Math.round(this.w * 0.82)
    this.canvas.style.height = `${this.h}px`
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.home = { x: this.w / 2, y: this.h * 0.93 }
    this.scale = Math.min((this.home.y - 8) / (FENCE_FT + 8), (this.w / 2 - 4) / (FENCE_FT * Math.SQRT1_2))
    this.resetFielders()
    this.draw()
  }

  private toPx(angleDeg: number, ft: number): Pt {
    const rad = (angleDeg * Math.PI) / 180
    return { x: this.home.x + Math.sin(rad) * ft * this.scale, y: this.home.y - Math.cos(rad) * ft * this.scale }
  }

  private basePt(n: number): Pt {
    const [a, d] = BASES[(n % 4) as 0 | 1 | 2 | 3]
    return this.toPx(a, d)
  }

  private batterPt(): Pt {
    return { x: this.home.x - 15, y: this.home.y - 4 }
  }

  resetFielders(): void {
    for (const [pos, [a, d]] of Object.entries(FIELDER_SPOTS)) this.fielders.set(pos, this.toPx(a, d))
  }

  /** 讓畫面上的跑者與打者對齊模擬狀態 */
  sync(bases: readonly (string | null)[], batterId: string | null): void {
    this.runners.clear()
    bases.forEach((id, i) => {
      if (id) this.runners.set(id, { ...this.basePt(i + 1), alpha: 1 })
    })
    this.batterId = batterId
    this.ball = null
    this.draw()
  }

  draw(): void {
    const c = this.ctx
    const { home, scale } = this
    c.fillStyle = COLORS.foul
    c.fillRect(0, 0, this.w, this.h)

    const wedge = (radiusFt: number, color: string) => {
      c.beginPath()
      c.moveTo(home.x, home.y)
      c.arc(home.x, home.y, radiusFt * scale, -Math.PI * 0.75, -Math.PI * 0.25)
      c.closePath()
      c.fillStyle = color
      c.fill()
    }
    wedge(FENCE_FT, COLORS.fair)
    wedge(INFIELD_FT, COLORS.dirt)

    // 內野草皮：壘包連線往投手丘內縮
    const mound = this.toPx(...MOUND)
    c.beginPath()
    ;[0, 1, 2, 3].forEach((n, i) => {
      const b = this.basePt(n)
      const p = { x: mound.x + (b.x - mound.x) * 0.72, y: mound.y + (b.y - mound.y) * 0.72 }
      if (i === 0) c.moveTo(p.x, p.y)
      else c.lineTo(p.x, p.y)
    })
    c.closePath()
    c.fillStyle = COLORS.fair
    c.fill()

    c.beginPath()
    c.arc(mound.x, mound.y, 9 * scale, 0, Math.PI * 2)
    c.fillStyle = COLORS.dirt
    c.fill()

    c.strokeStyle = COLORS.line
    c.lineWidth = 1.5
    for (const a of [-45, 45]) {
      const end = this.toPx(a, FENCE_FT)
      c.beginPath()
      c.moveTo(home.x, home.y)
      c.lineTo(end.x, end.y)
      c.stroke()
    }
    c.strokeStyle = COLORS.fence
    c.lineWidth = 3
    c.beginPath()
    c.arc(home.x, home.y, FENCE_FT * scale, -Math.PI * 0.75, -Math.PI * 0.25)
    c.stroke()

    c.fillStyle = COLORS.line
    for (const n of [1, 2, 3]) {
      const b = this.basePt(n)
      c.save()
      c.translate(b.x, b.y)
      c.rotate(Math.PI / 4)
      c.fillRect(-3.5, -3.5, 7, 7)
      c.restore()
    }
    c.beginPath()
    c.moveTo(home.x - 4, home.y - 4)
    c.lineTo(home.x + 4, home.y - 4)
    c.lineTo(home.x + 4, home.y)
    c.lineTo(home.x, home.y + 4)
    c.lineTo(home.x - 4, home.y)
    c.closePath()
    c.fill()

    for (const p of this.fielders.values()) this.dot(p, this.fieldingColor, 1)
    if (this.batterId && !this.runners.has(this.batterId)) this.dot(this.batterPt(), this.battingColor, 1)
    for (const r of this.runners.values()) this.dot(r, this.battingColor, r.alpha)

    if (this.ball) {
      const { x, y, height } = this.ball
      if (height > 0) {
        c.beginPath()
        c.ellipse(x, y, 3, 1.8, 0, 0, Math.PI * 2)
        c.fillStyle = COLORS.shadow
        c.fill()
      }
      c.beginPath()
      c.arc(x, y - height, 3 + height * 0.04, 0, Math.PI * 2)
      c.fillStyle = COLORS.ball
      c.fill()
    }
  }

  private dot(p: Pt, color: string, alpha: number): void {
    const c = this.ctx
    c.globalAlpha = alpha
    c.beginPath()
    c.arc(p.x, p.y, 6.5, 0, Math.PI * 2)
    c.fillStyle = color
    c.fill()
    c.lineWidth = 1.5
    c.strokeStyle = '#ffffff'
    c.stroke()
    c.globalAlpha = 1
  }

  private tween(ms: number, fn: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now()
      const tick = (now: number) => {
        const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms)
        fn(t)
        this.draw()
        if (t < 1) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
  }

  async pitch(result: PitchResult, ms: number): Promise<void> {
    const from = this.toPx(...MOUND)
    const to = { x: this.home.x, y: this.home.y - 2 }
    await this.tween(ms, (t) => {
      this.ball = { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t), height: 0 }
    })
    if (result === 'foul') {
      const side = Math.random() < 0.5 ? -1 : 1
      const end = this.toPx(side * (55 + Math.random() * 20), 90 + Math.random() * 60)
      await this.tween(ms * 0.8, (t) => {
        this.ball = { x: lerp(to.x, end.x, t), y: lerp(to.y, end.y, t), height: Math.sin(t * Math.PI) * 25 }
      })
    }
    if (result !== 'inPlay') this.ball = null
    this.draw()
  }

  /** 擊球飛行，同時讓跑者開始跑壘 */
  async play(ball: BattedBall | null, moves: RunnerMove[], caught: boolean, ms: number): Promise<void> {
    const flight = ball ? this.flight(ball, caught, ms) : Promise.resolve()
    await Promise.all([flight, this.run(moves, ms * 0.45)])
    this.ball = null
    this.resetFielders()
    this.draw()
  }

  private async flight(ball: BattedBall, caught: boolean, ms: number): Promise<void> {
    const start = { x: this.home.x, y: this.home.y - 2 }
    const land = this.toPx(ball.angle, ball.distance)
    const peak = ball.type === 'fly' ? 40 + ball.distance * 0.12 : ball.type === 'line' ? 12 : 0
    // 離落點最近的守備員去追球
    let chaser: string | null = null
    let best = Infinity
    for (const [pos, p] of this.fielders) {
      if (pos === 'C') continue
      const d = Math.hypot(p.x - land.x, p.y - land.y)
      if (d < best) {
        best = d
        chaser = pos
      }
    }
    const chaserStart = chaser ? { ...this.fielders.get(chaser)! } : null
    const reach = caught ? 1 : 0.8
    const target = ball.distance > FENCE_FT ? this.toPx(ball.angle, FENCE_FT - 8) : land
    await this.tween(ms, (t) => {
      this.ball = { x: lerp(start.x, land.x, t), y: lerp(start.y, land.y, t), height: Math.sin(t * Math.PI) * peak }
      if (chaser && chaserStart) {
        const k = Math.min(1, t * 1.15) * reach
        this.fielders.set(chaser, { x: lerp(chaserStart.x, target.x, k), y: lerp(chaserStart.y, target.y, k) })
      }
    })
  }

  /** 跑者沿著壘包移動；出局的跑者跑到一半淡出 */
  async run(moves: RunnerMove[], msPerBase: number): Promise<void> {
    const paths = new Map<string, Pt[]>()
    for (const m of moves) {
      const startPt = m.from === 0 ? this.batterPt() : this.basePt(m.from)
      if (m.to === 'out') {
        const next = this.basePt(m.from + 1)
        paths.set(m.runnerId, [startPt, { x: lerp(startPt.x, next.x, 0.5), y: lerp(startPt.y, next.y, 0.5) }])
      } else {
        const pts = [startPt]
        for (let b = m.from + 1; b <= m.to; b++) pts.push(this.basePt(b))
        paths.set(m.runnerId, pts)
      }
      if (!this.runners.has(m.runnerId)) this.runners.set(m.runnerId, { ...startPt, alpha: 1 })
    }
    const segments = Math.max(1, ...[...paths.values()].map((p) => p.length - 1))
    const outs = new Set(moves.filter((m) => m.to === 'out').map((m) => m.runnerId))
    const scorers = new Set(moves.filter((m) => m.to === 4).map((m) => m.runnerId))
    await this.tween(segments * msPerBase, (t) => {
      const progress = t * segments
      for (const [id, pts] of paths) {
        const r = this.runners.get(id)!
        const segs = pts.length - 1
        if (segs === 0) continue
        const local = Math.min(progress, segs)
        const i = Math.min(Math.floor(local), segs - 1)
        const f = local - i
        r.x = lerp(pts[i].x, pts[i + 1].x, f)
        r.y = lerp(pts[i].y, pts[i + 1].y, f)
        if (outs.has(id)) r.alpha = 1 - (local / segs) * 0.7
      }
    })
    for (const id of [...outs, ...scorers]) this.runners.delete(id)
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
