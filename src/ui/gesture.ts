// 投球手勢：每個球種一個簡單的筆畫，畫得越像樣板 accuracy 越高（0～1）
import type { PitchType } from '../sim/pitches'

export type Point = [number, number]

/** 取樣點數：樣板和玩家的筆畫都重新取樣成這麼多點再比對 */
const SAMPLES = 32
/** 平均誤差到這個值就是 0 分（以筆畫外框的最長邊為 1） */
const MAX_ERROR = 0.32
/** 畫得太短（像素）就當作沒畫 */
const MIN_LENGTH = 40
/** 超過這個時間（毫秒）才畫完，準確度開始打折 */
const SLOW_MS = 1100

const arc = (): Point[] =>
  Array.from({ length: 13 }, (_, i) => {
    const t = Math.PI - (Math.PI * i) / 12
    return [0.5 + 0.5 * Math.cos(t), 1 - Math.sin(t)]
  })

/**
 * 樣板（x 往右、y 往下，0～1）：
 * 直球往上一條線、指叉往下一條線、變速球打勾（V）、曲球畫拱門、滑球畫「ㄑ」
 */
export const GESTURES: Record<PitchType, Point[]> = {
  fastball: [
    [0.5, 1],
    [0.5, 0],
  ],
  splitter: [
    [0.5, 0],
    [0.5, 1],
  ],
  change: [
    [0, 0],
    [0.5, 1],
    [1, 0],
  ],
  curve: arc(),
  slider: [
    [1, 0],
    [0, 0.5],
    [1, 1],
  ],
}

/** 鍵盤玩家用方向鍵輸入同樣的筆畫 */
export const GESTURE_KEYS: Record<PitchType, string[]> = {
  fastball: ['ArrowUp'],
  splitter: ['ArrowDown'],
  change: ['ArrowDown', 'ArrowUp'],
  curve: ['ArrowUp', 'ArrowRight', 'ArrowDown'],
  slider: ['ArrowLeft', 'ArrowDown', 'ArrowRight'],
}

function pathLength(points: readonly Point[]): number {
  let len = 0
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  return len
}

/** 沿著筆畫等距取 n 個點 */
export function resample(points: readonly Point[], n = SAMPLES): Point[] {
  const step = pathLength(points) / (n - 1)
  const out: Point[] = [points[0]]
  let carry = 0
  for (let i = 1; i < points.length; i++) {
    let [px, py] = points[i - 1]
    const [qx, qy] = points[i]
    let seg = Math.hypot(qx - px, qy - py)
    while (carry + seg >= step && step > 0 && out.length < n) {
      const t = (step - carry) / seg
      px += (qx - px) * t
      py += (qy - py) * t
      out.push([px, py])
      seg = Math.hypot(qx - px, qy - py)
      carry = 0
    }
    carry += seg
  }
  while (out.length < n) out.push(points[points.length - 1])
  return out
}

/** 移到外框中心、用最長邊縮放：大小和位置不影響分數，形狀和方向才算 */
function normalize(points: readonly Point[]): Point[] {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const size = Math.max(maxX - minX, maxY - minY) || 1
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return points.map(([x, y]) => [(x - cx) / size, (y - cy) / size])
}

/** 以外框中心旋轉 deg 度 */
function rotate(points: readonly Point[], deg: number): Point[] {
  const a = (deg * Math.PI) / 180
  const [cos, sin] = [Math.cos(a), Math.sin(a)]
  return points.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos])
}

function meanDistance(a: readonly Point[], b: readonly Point[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1])
  return sum / a.length
}

/** 容許的歪斜角度：手機上用拇指畫，直線很少是正的 */
const MAX_TILT = 25
const TILT_STEP = 5
/** 起筆、收筆時可以忽略的小勾（取樣點數，細取樣共 TRIM_SAMPLES 點） */
const TRIM_SAMPLES = 64
const TRIMS = [0, 3, 6]

/**
 * 筆畫跟樣板的平均距離。容許整體歪一點、頭尾多出一小段，
 * 但每次放寬都加一點誤差，畫得端正的筆畫還是分數最高
 */
export function shapeError(stroke: readonly Point[], template: readonly Point[]): number {
  const target = normalize(resample(template))
  const fine = resample(stroke, TRIM_SAMPLES)
  let best = Infinity
  for (const head of TRIMS) {
    for (const tail of TRIMS) {
      const core = normalize(resample(fine.slice(head, TRIM_SAMPLES - tail)))
      const trimPenalty = ((head + tail) / TRIM_SAMPLES) * 0.15
      for (let deg = -MAX_TILT; deg <= MAX_TILT; deg += TILT_STEP) {
        // 轉正後重新以外框置中、縮放，再跟樣板比
        const error = meanDistance(normalize(rotate(core, deg)), target) + (Math.abs(deg) / MAX_TILT) * 0.03 + trimPenalty
        if (error < best) best = error
      }
    }
  }
  return best
}

/** 畫得多準：形狀越像越高，畫太慢會打折，太短算沒畫 */
export function scoreGesture(stroke: readonly Point[], pitch: PitchType, durationMs: number): number {
  if (stroke.length < 2 || pathLength(stroke) < MIN_LENGTH) return 0
  const shape = Math.max(0, 1 - shapeError(stroke, GESTURES[pitch]) / MAX_ERROR)
  const pace = durationMs <= SLOW_MS ? 1 : Math.max(0.8, 1 - (durationMs - SLOW_MS) / 4000)
  return Math.round(shape * pace * 1000) / 1000
}

/**
 * 方向鍵輸入：順序對了，按得越快越準；按錯就是失投。
 * 按鍵比畫線容易，所以上限壓低一點，控球普通的投手要按得夠快才會完美
 */
export function scoreKeys(keys: readonly string[], pitch: PitchType, durationMs: number): number {
  const want = GESTURE_KEYS[pitch]
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return 0.3
  const spare = Math.max(0, durationMs - 250 * want.length)
  return Math.round(Math.min(0.88, Math.max(0.5, 0.9 - spare / 1500)) * 1000) / 1000
}

/**
 * 形狀對了、方向畫反（例如直球從上往下畫）：
 * 反過來看的分數夠高，而且明顯比正著看高
 */
export function drawnBackwards(stroke: readonly Point[], pitch: PitchType, durationMs: number): boolean {
  if (stroke.length < 2) return false
  const reversed = scoreGesture([...stroke].reverse(), pitch, durationMs)
  return reversed >= 0.6 && reversed > scoreGesture(stroke, pitch, durationMs) + 0.25
}

/** 樣板在方框裡的座標（size 是方框邊長，pad 是留白） */
export function gesturePoints(pitch: PitchType, size: number, pad: number): Point[] {
  const s = size - pad * 2
  return GESTURES[pitch].map(([x, y]) => [pad + x * s, pad + y * s])
}

/** 把樣板畫成 SVG 路徑 */
export function gesturePath(pitch: PitchType, size: number, pad: number): string {
  return gesturePoints(pitch, size, pad)
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ')
}

/** 終點的箭頭（SVG polygon 的 points），順著最後一段的方向 */
export function gestureArrow(pitch: PitchType, size: number, pad: number, head: number): string {
  const pts = gesturePoints(pitch, size, pad)
  const [ex, ey] = pts[pts.length - 1]
  const [px, py] = pts[pts.length - 2]
  const len = Math.hypot(ex - px, ey - py) || 1
  const [dx, dy] = [(ex - px) / len, (ey - py) / len]
  const tip: Point = [ex + dx * head * 0.6, ey + dy * head * 0.6]
  const back: Point = [ex - dx * head * 0.6, ey - dy * head * 0.6]
  const left: Point = [back[0] - dy * head * 0.7, back[1] + dx * head * 0.7]
  const right: Point = [back[0] + dy * head * 0.7, back[1] - dx * head * 0.7]
  return [tip, left, right].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
}
