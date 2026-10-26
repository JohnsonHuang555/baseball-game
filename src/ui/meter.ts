// 計量條：一條紅線由下往上、到頂再往下來回掃，玩家點一下就停住，停在黃色區就是好的時機
import { gradeTiming, type MeterGrade, type MeterZone } from '../sim/game'
import { kbd, setKeys } from './keys'
import { el } from './playerCard'
import { play } from './sound'
import { T } from './strings'

/** 紅線從底到頂（或從頂到底）一趟的時間（毫秒），不受比賽速度影響 */
const SWEEP_MS = 900
/** 剛打開時先擋掉輸入，避免叫出計量條的那一下被當成出手 */
const ARM_MS = 250
/** 停下後顯示判定的時間 */
const GRADE_MS = 900

export interface MeterResult {
  /** 停下的位置，取到小數第三位，記進指令紀錄 */
  timing: number
  grade: MeterGrade
}

/** 來回掃的位置：0 在底、1 在頂 */
function sweep(elapsed: number): number {
  const phase = (elapsed / SWEEP_MS) % 2
  return phase <= 1 ? phase : 2 - phase
}

export interface MeterOptions {
  /** 在黃色區旁邊標出拉打、中間、推打（配球對決的出棒） */
  aimMarks?: boolean
}

/** 方向標籤之間的最小間距（計量條高度的比例） */
const MARK_GAP = 0.12
/** 偏離中心多少（以黃色區半寬為 1）以內算打向中間 */
const CENTER_AIM = 0.35

/** 停的位置對應的擊球方向：偏下拉打、偏上推打 */
export function aimLabel(zone: MeterZone, timing: number): string {
  const offset = (timing - zone.center) / zone.good
  return Math.abs(offset) < CENTER_AIM ? T.aimMarks.center : offset < 0 ? T.aimMarks.pull : T.aimMarks.oppo
}

/** 在 host（球場）上蓋一層計量條，等玩家出手後回傳結果；按「這球交給球員」（Esc）回傳 null */
export function runMeter(host: HTMLElement, kind: 'swing' | 'aimPitch', zone: MeterZone, opts: MeterOptions = {}): Promise<MeterResult | null> {
  return new Promise((resolve) => {
    const layer = el('div', `meter-layer ${kind}`)
    layer.setAttribute('role', 'application')
    layer.setAttribute('aria-label', `${T.takeOverNames[kind]}：${T.meterHint}`)
    const meter = el('div', 'meter')
    const track = el('div', 'meter-track')
    const good = el('span', 'meter-good')
    good.style.bottom = `${(zone.center - zone.good) * 100}%`
    good.style.height = `${zone.good * 200}%`
    const perfect = el('span', 'meter-perfect')
    perfect.style.bottom = `${(zone.center - zone.perfect) * 100}%`
    perfect.style.height = `${zone.perfect * 200}%`
    const line = el('span', 'meter-line')
    track.append(good, perfect, line)
    const column = el('div', 'meter-column')
    column.append(track)
    if (opts.aimMarks) {
      // 標籤放在黃色區的下緣、中心、上緣旁邊
      const marks = el('div', 'meter-marks')
      const at = (label: string, pos: number, cls: string) => {
        const mark = el('span', `meter-mark ${cls}`, label)
        mark.style.bottom = `${pos * 100}%`
        marks.append(mark)
      }
      // 黃色區很窄時，標籤之間至少留一點距離，才不會疊在一起
      const spread = Math.max(zone.good, MARK_GAP)
      at(T.aimMarks.pull, zone.center - spread, 'pull')
      at(T.aimMarks.center, zone.center, 'center')
      at(T.aimMarks.oppo, zone.center + spread, 'oppo')
      column.prepend(marks)
    }
    meter.append(el('span', 'meter-title', T.takeOverNames[kind]), column)
    const hint = el('div', 'meter-hint')
    hint.append(T.meterHint, kbd('SPACE'))
    const skip = el('button', 'meter-skip', T.meterSkip)
    skip.type = 'button'
    skip.append(kbd('ESC'))
    layer.append(meter, hint, skip)
    host.append(layer)

    const previousKeys = setKeys({})
    const start = performance.now()
    let value = 0
    let frame = 0
    let done = false

    const tick = (now: number) => {
      value = sweep(now - start)
      line.style.bottom = `${value * 100}%`
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    const stop = () => {
      if (done || performance.now() - start < ARM_MS) return
      done = true
      cancelAnimationFrame(frame)
      cleanup()
      value = sweep(performance.now() - start)
      const timing = Math.round(value * 1000) / 1000
      const grade = gradeTiming(zone, timing)
      line.style.bottom = `${timing * 100}%`
      layer.classList.add('released')
      hint.replaceChildren(el('span', `meter-grade ${grade}`, T.meterGrades[grade]))
      play(grade === 'perfect' ? 'perfect' : grade === 'good' ? 'good' : 'miss')
      window.setTimeout(() => {
        layer.remove()
        setKeys(previousKeys)
        resolve({ timing, grade })
      }, GRADE_MS)
    }

    const giveUp = () => {
      if (done) return
      done = true
      cancelAnimationFrame(frame)
      cleanup()
      layer.remove()
      setKeys(previousKeys)
      resolve(null)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        return giveUp()
      }
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      if (!e.repeat) stop()
    }
    layer.addEventListener('pointerdown', (e) => {
      if (skip.contains(e.target as Node)) return
      e.preventDefault()
      stop()
    })
    skip.onclick = giveUp
    document.addEventListener('keydown', onKeyDown)
    function cleanup(): void {
      document.removeEventListener('keydown', onKeyDown)
    }
  })
}

