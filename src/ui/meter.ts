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

/** 在 host（球場）上蓋一層計量條，等玩家出手後回傳結果 */
export function runMeter(host: HTMLElement, kind: 'swing' | 'aimPitch', zone: MeterZone): Promise<MeterResult> {
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
    meter.append(el('span', 'meter-title', T.takeOverNames[kind]), track)
    const hint = el('div', 'meter-hint')
    hint.append(T.meterHint, kbd('SPACE'))
    layer.append(meter, hint)
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

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.key !== 'Enter') return
      e.preventDefault()
      if (!e.repeat) stop()
    }
    layer.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      stop()
    })
    document.addEventListener('keydown', onKeyDown)
    function cleanup(): void {
      document.removeEventListener('keydown', onKeyDown)
    }
  })
}

/** 目標區寬度的文字：窄、普通、寬 */
export function zoneWidthLabel(zone: MeterZone): string {
  return T.zoneWidths[zone.good < 0.075 ? 0 : zone.good < 0.1 ? 1 : 2]
}
