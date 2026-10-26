import { fenceDistance, type BattedBall, type PitchResult, type RunnerMove } from '../sim/game'

interface Pt {
  x: number
  y: number
}

/** 中外野的全壘打牆距離；兩邊較淺，見 fenceDistance */
const FENCE_FT = fenceDistance(0)
/** 左右外野標竿的距離 */
const POLE_FT = fenceDistance(45)
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

const FIELDERS = ['P', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF'] as const
/** 撲球的內野手不含投手：投手站在中間，球往中間跑會看起來穿過他 */
const INFIELDERS = ['1B', '2B', 'SS', '3B'] as const
const OUTFIELDERS = ['LF', 'CF', 'RF'] as const

/** 點 p 在線段 a→b 上最近的位置 */
function closestOnPath(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
  return { x: a.x + dx * t, y: a.y + dy * t }
}

function distanceToPath(p: Pt, a: Pt, b: Pt): number {
  const q = closestOnPath(p, a, b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

const COLORS = {
  foul: '#2E8C43',
  fair: '#43B356',
  mow: 'rgba(0,0,0,0.07)',
  dirt: '#E3A867',
  line: '#FFFFFF',
  ink: '#141633',
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
  /** 擊球飛行時留下的軌跡（畫面座標，已含高度），讓人看清楚球往哪裡去 */
  private trail: Pt[] = []
  fieldingColor = '#FF7A1A'
  battingColor = '#2D7CFF'
  /** 圓點外圈：我方白圈、對手深色圈，色弱也分得出兩隊 */
  fieldingStroke = '#FFFFFF'
  battingStroke = '#141633'

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
    this.scale = Math.min((this.home.y - 8) / (FENCE_FT + 8), (this.w / 2 - 4) / (POLE_FT * Math.SQRT1_2))
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

    // 全壘打牆的曲線：從左外野標竿畫到右外野標竿，inset 是往內縮的英呎數
    const fencePath = (inset = 0) => {
      for (let a = -45; a <= 45; a += 3) {
        const p = this.toPx(a, fenceDistance(a) - inset)
        c.lineTo(p.x, p.y)
      }
    }
    c.beginPath()
    c.moveTo(home.x, home.y)
    fencePath()
    c.closePath()
    c.fillStyle = COLORS.fair
    c.fill()

    // 外野草皮的割草斜紋：只畫在界內
    c.save()
    c.beginPath()
    c.moveTo(home.x, home.y)
    fencePath()
    c.closePath()
    c.clip()
    c.strokeStyle = COLORS.mow
    c.lineWidth = 10
    for (let x = -this.h; x < this.w + this.h; x += 20) {
      c.beginPath()
      c.moveTo(x, 0)
      c.lineTo(x + this.h, this.h)
      c.stroke()
    }
    c.restore()

    // 全壘打牆前的警戒區
    c.strokeStyle = COLORS.dirt
    c.lineWidth = 9
    c.beginPath()
    const track = this.toPx(-45, POLE_FT - 4 / scale)
    c.moveTo(track.x, track.y)
    fencePath(4 / scale)
    c.stroke()

    // 內野：以本壘到二壘的中點為中心，土色菱形往外擴、中間草皮往內縮
    const second = this.basePt(2)
    const center = { x: (home.x + second.x) / 2, y: (home.y + second.y) / 2 }
    const diamond = (k: number, color: string) => {
      c.beginPath()
      ;[0, 1, 2, 3].forEach((n, i) => {
        const b = this.basePt(n)
        const p = { x: center.x + (b.x - center.x) * k, y: center.y + (b.y - center.y) * k }
        if (i === 0) c.moveTo(p.x, p.y)
        else c.lineTo(p.x, p.y)
      })
      c.closePath()
      c.fillStyle = color
      c.fill()
    }
    diamond(1.33, COLORS.dirt)
    diamond(0.8, COLORS.fair)

    const mound = this.toPx(...MOUND)
    c.beginPath()
    c.arc(mound.x, mound.y, 11 * scale, 0, Math.PI * 2)
    c.fillStyle = COLORS.dirt
    c.fill()

    c.strokeStyle = COLORS.line
    c.lineWidth = 2.5
    for (const a of [-45, 45]) {
      const end = this.toPx(a, POLE_FT + 40)
      c.beginPath()
      c.moveTo(home.x, home.y)
      c.lineTo(end.x, end.y)
      c.stroke()
    }

    // 壘包：白底深框的小菱形
    c.lineWidth = 1.5
    c.strokeStyle = COLORS.ink
    c.fillStyle = COLORS.line
    for (const n of [1, 2, 3]) {
      const b = this.basePt(n)
      c.save()
      c.translate(b.x, b.y)
      c.rotate(Math.PI / 4)
      c.fillRect(-5, -5, 10, 10)
      c.strokeRect(-5, -5, 10, 10)
      c.restore()
    }
    c.fillStyle = COLORS.line
    c.beginPath()
    c.moveTo(home.x - 4, home.y - 4)
    c.lineTo(home.x + 4, home.y - 4)
    c.lineTo(home.x + 4, home.y)
    c.lineTo(home.x, home.y + 4)
    c.lineTo(home.x - 4, home.y)
    c.closePath()
    c.fill()

    for (const p of this.fielders.values()) this.dot(p, this.fieldingColor, this.fieldingStroke, 1, 7.5)
    if (this.batterId && !this.runners.has(this.batterId)) this.dot(this.batterPt(), this.battingColor, this.battingStroke, 1, 8.5)
    for (const r of this.runners.values()) this.dot(r, this.battingColor, this.battingStroke, r.alpha, 8.5)

    if (this.ball) {
      const { x, y, height } = this.ball
      // 軌跡：越舊越淡、越細
      this.trail.forEach((p, i) => {
        const k = (i + 1) / this.trail.length
        c.beginPath()
        c.arc(p.x, p.y, 1.5 + k * 2.5, 0, Math.PI * 2)
        c.fillStyle = `rgba(255,255,255,${(k * 0.55).toFixed(2)})`
        c.fill()
      })
      if (height > 0) {
        c.beginPath()
        c.ellipse(x, y, 4, 2.4, 0, 0, Math.PI * 2)
        c.fillStyle = COLORS.shadow
        c.fill()
      }
      c.beginPath()
      c.arc(x, y - height, 4.5 + height * 0.04, 0, Math.PI * 2)
      c.fillStyle = COLORS.ball
      c.fill()
      c.lineWidth = 1.5
      c.strokeStyle = COLORS.ink
      c.stroke()
    }
  }

  private dot(p: Pt, color: string, stroke: string, alpha: number, radius: number): void {
    const c = this.ctx
    c.globalAlpha = alpha
    c.beginPath()
    c.arc(p.x, p.y, radius, 0, Math.PI * 2)
    c.fillStyle = color
    c.fill()
    c.lineWidth = 2.5
    c.strokeStyle = stroke
    c.stroke()
    c.globalAlpha = 1
  }

  private tween(ms: number, fn: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now()
      const tick = (now: number) => {
        // 瀏覽器給的幀時間戳記可能比 start 還早一點，進度要夾在 0～1，
        // 否則跑者動畫會用負數去查路徑而出錯，整場比賽就卡住
        const t = ms <= 0 ? 1 : Math.max(0, Math.min(1, (now - start) / ms))
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
    this.trail = []
    this.resetFielders()
    this.draw()
  }

  private async flight(ball: BattedBall, caught: boolean, ms: number): Promise<void> {
    const start = { x: this.home.x, y: this.home.y - 2 }
    const land = this.toPx(ball.angle, ball.distance)
    const peak = ball.type === 'fly' ? 40 + ball.distance * 0.12 : ball.type === 'line' ? 12 : 0
    const nearest = (positions: readonly string[], to: (p: Pt) => number): string | null => {
      let found: string | null = null
      let best = Infinity
      for (const pos of positions) {
        const d = to(this.fielders.get(pos)!)
        if (d < best) {
          best = d
          found = pos
        }
      }
      return found
    }
    // 接殺、刺殺：離落點最近的守備員準時到位。
    // 安打：外野手晚一步起跑、只追到一半，讓人看得出球落在空檔
    const chaser = nearest(caught ? FIELDERS : OUTFIELDERS, (p) => Math.hypot(p.x - land.x, p.y - land.y))
    const chaserStart = chaser ? { ...this.fielders.get(chaser)! } : null
    const fence = fenceDistance(ball.angle)
    const target = ball.distance > fence ? this.toPx(ball.angle, fence - 8) : land
    // 滾地安打：離球路最近的內野手撲過去，但差一點碰不到
    const diver = !caught && ball.type === 'ground' ? nearest(INFIELDERS, (p) => distanceToPath(p, start, land)) : null
    const diverStart = diver ? { ...this.fielders.get(diver)! } : null
    const diveTo = diverStart ? closestOnPath(diverStart, start, land) : null
    this.trail = []
    await this.tween(ms, (t) => {
      this.ball = { x: lerp(start.x, land.x, t), y: lerp(start.y, land.y, t), height: Math.sin(t * Math.PI) * peak }
      this.trail.push({ x: this.ball.x, y: this.ball.y - this.ball.height })
      if (this.trail.length > 14) this.trail.shift()
      if (chaser && chaserStart) {
        const k = caught ? Math.min(1, t * 1.15) : Math.max(0, (t - 0.25) / 0.75) * 0.5
        this.fielders.set(chaser, { x: lerp(chaserStart.x, target.x, k), y: lerp(chaserStart.y, target.y, k) })
      }
      if (diver && diverStart && diveTo) {
        const k = Math.min(1, t * 2.5) * 0.35
        this.fielders.set(diver, { x: lerp(diverStart.x, diveTo.x, k), y: lerp(diverStart.y, diveTo.y, k) })
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
