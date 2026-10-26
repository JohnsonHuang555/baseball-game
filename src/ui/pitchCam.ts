// 投球視角：球場左下角的小窗，從捕手後面看投過來的球。
// 曲球先上飄再大弧度落下、滑球晚一點橫移、指叉球最後才下墜。只負責畫面（ADR-0001）
import type { PitchResult } from '../sim/game'
import type { PitchType } from '../sim/pitches'
import type { Hand, Pitcher } from '../sim/types'
import { el } from './playerCard'
import { T } from './strings'

export interface Pt {
  x: number
  y: number
}

/**
 * 各球種的軌跡（右投手、捕手視角：x 往右、y 往下，單位是小窗寬度的比例）：
 * breakX / breakY 是總變化量，power 越大越晚才變化，hump 是先往上飄的高度，pace 是球速（時間）倍率
 */
interface Motion {
  breakX: number
  breakY: number
  power: number
  hump: number
  pace: number
}
export const PITCH_MOTION: Record<PitchType, Motion> = {
  fastball: { breakX: -0.03, breakY: -0.02, power: 1, hump: 0, pace: 0.85 },
  slider: { breakX: 0.24, breakY: 0.05, power: 3, hump: 0, pace: 1 },
  curve: { breakX: 0.12, breakY: 0.34, power: 1.6, hump: 0.17, pace: 1.25 },
  change: { breakX: -0.11, breakY: 0.12, power: 2, hump: 0, pace: 1.3 },
  splitter: { breakX: 0, breakY: 0.26, power: 4, hump: 0, pace: 0.95 },
}

/** 跟直球比的球速差（km/h） */
const SPEED_OFFSET: Record<PitchType, number> = { fastball: 0, slider: -12, curve: -24, change: -18, splitter: -9 }

/** 顯示用的球速：球威越好直球越快，再加一點起伏 */
export function pitchSpeed(pitch: PitchType, p: Pitcher): number {
  return Math.round(138 + (p.ratings.stuff - 5) * 2 + SPEED_OFFSET[pitch] + (Math.random() * 4 - 2))
}

/**
 * 第 t（0～1）時球的位置：先朝「終點減掉變化量」直直飛，變化量依 t^power 慢慢加回來，
 * 所以變化越晚的球種越像最後一刻才轉彎；左投手左右相反
 */
export function pitchPoint(pitch: PitchType, hand: Hand, start: Pt, end: Pt, t: number, size = 1): Pt {
  const m = PITCH_MOTION[pitch]
  const bx = m.breakX * (hand === 'R' ? 1 : -1) * size
  const by = m.breakY * size
  const f = t ** m.power
  return {
    x: start.x + (end.x - bx - start.x) * t + bx * f,
    y: start.y + (end.y - by - start.y) * t + by * f - Math.sin(Math.PI * t) * m.hump * size,
  }
}

/** 停在本壘的時間，讓人看清楚進壘點 */
const HOLD_MS = 350

export class PitchCam {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly label: HTMLElement
  private hideTimer = 0

  constructor() {
    this.root = el('div', 'pitch-cam')
    this.root.setAttribute('aria-hidden', 'true')
    this.canvas = el('canvas', 'pitch-cam-canvas')
    this.label = el('span', 'pitch-cam-label')
    this.root.append(this.canvas, this.label)
    this.ctx = this.canvas.getContext('2d')!
  }

  /** 播一球：回傳時球剛好進到本壘 */
  play(pitch: PitchType, pitcher: Pitcher, result: PitchResult, ms: number): Promise<void> {
    window.clearTimeout(this.hideTimer)
    this.label.textContent = `${T.pitchNames[pitch]} ${pitchSpeed(pitch, pitcher)} km/h`
    this.root.classList.add('show')
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    if (w === 0) return Promise.resolve()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const zone = { x: w * 0.36, y: h * 0.46, w: w * 0.28, h: h * 0.36 }
    // 出手點在投手的慣用手那一側（捕手看過去，右投手在左邊）
    const start = { x: w * (pitcher.throws === 'R' ? 0.36 : 0.64), y: h * 0.3 }
    const end = this.target(result, zone)
    const trail: Pt[] = []
    return new Promise((resolve) => {
      const begin = performance.now()
      const tick = (now: number) => {
        const t = ms <= 0 ? 1 : Math.max(0, Math.min(1, (now - begin) / ms))
        const p = pitchPoint(pitch, pitcher.throws, start, end, t, w)
        trail.push(p)
        this.draw(zone, trail, p, t)
        if (t < 1) requestAnimationFrame(tick)
        else {
          this.hideTimer = window.setTimeout(() => this.root.classList.remove('show'), HOLD_MS)
          resolve()
        }
      }
      requestAnimationFrame(tick)
    })
  }

  /** 進壘點：壞球落在好球帶外，其他落在好球帶內（只是畫面，隨機就好） */
  private target(result: PitchResult, zone: { x: number; y: number; w: number; h: number }): Pt {
    if (result === 'ball') {
      const r = Math.random()
      if (r < 0.35) return { x: zone.x - zone.w * 0.35, y: zone.y + zone.h * Math.random() }
      if (r < 0.7) return { x: zone.x + zone.w * 1.35, y: zone.y + zone.h * Math.random() }
      return { x: zone.x + zone.w * Math.random(), y: zone.y + zone.h * 1.3 }
    }
    return { x: zone.x + zone.w * (0.15 + Math.random() * 0.7), y: zone.y + zone.h * (0.15 + Math.random() * 0.7) }
  }

  private draw(zone: { x: number; y: number; w: number; h: number }, trail: Pt[], ball: Pt, t: number): void {
    const c = this.ctx
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    c.clearRect(0, 0, w, h)
    // 好球帶：外框加九宮格淡線
    c.strokeStyle = 'rgba(255,255,255,0.25)'
    c.lineWidth = 1
    for (let i = 1; i < 3; i++) {
      c.beginPath()
      c.moveTo(zone.x + (zone.w * i) / 3, zone.y)
      c.lineTo(zone.x + (zone.w * i) / 3, zone.y + zone.h)
      c.moveTo(zone.x, zone.y + (zone.h * i) / 3)
      c.lineTo(zone.x + zone.w, zone.y + (zone.h * i) / 3)
      c.stroke()
    }
    c.strokeStyle = '#ffffff'
    c.lineWidth = 2
    c.strokeRect(zone.x, zone.y, zone.w, zone.h)
    // 本壘板
    const plateY = h * 0.93
    c.fillStyle = 'rgba(255,255,255,0.85)'
    c.beginPath()
    c.moveTo(w * 0.42, plateY - 4)
    c.lineTo(w * 0.58, plateY - 4)
    c.lineTo(w * 0.58, plateY)
    c.lineTo(w * 0.5, plateY + 4)
    c.lineTo(w * 0.42, plateY)
    c.closePath()
    c.fill()
    // 軌跡：從出手到現在整條留著，越靠近現在越粗、越亮，看得出整個弧度
    c.lineCap = 'round'
    for (let i = 1; i < trail.length; i++) {
      const k = i / trail.length
      c.beginPath()
      c.moveTo(trail[i - 1].x, trail[i - 1].y)
      c.lineTo(trail[i].x, trail[i].y)
      c.strokeStyle = `rgba(255,214,63,${(0.25 + k * 0.6).toFixed(2)})`
      c.lineWidth = 1 + k * 3
      c.stroke()
    }
    // 球：越接近本壘越大
    const r = 2 + t * t * w * 0.045
    c.beginPath()
    c.arc(ball.x, ball.y, r, 0, Math.PI * 2)
    c.fillStyle = '#ffffff'
    c.fill()
    c.lineWidth = 1.5
    c.strokeStyle = '#141633'
    c.stroke()
    if (r > 5) {
      // 縫線
      c.strokeStyle = '#e5383b'
      c.lineWidth = 1
      c.beginPath()
      c.arc(ball.x - r * 0.9, ball.y, r * 0.7, -0.9, 0.9)
      c.stroke()
      c.beginPath()
      c.arc(ball.x + r * 0.9, ball.y, r * 0.7, Math.PI - 0.9, Math.PI + 0.9)
      c.stroke()
    }
  }
}
