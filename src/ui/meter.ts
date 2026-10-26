// 計量條：按住蓄力、放開出手，停在黃色區就是好的時機（類似 2K 的投籃條）
import { gradeTiming, type MeterGrade, type MeterZone } from '../sim/game'
import { kbd, setKeys } from './keys'
import { el } from './playerCard'
import { T } from './strings'

/** 從空到滿的時間（毫秒），不受比賽速度影響 */
const FILL_MS = 1000
/** 放開後顯示判定的時間 */
const GRADE_MS = 900

export interface MeterResult {
  /** 停下的位置，取到小數第三位，記進指令紀錄 */
  timing: number
  grade: MeterGrade
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
    const fill = el('span', 'meter-fill')
    track.append(fill, good, perfect)
    meter.append(el('span', 'meter-title', T.takeOverNames[kind]), track)
    const hint = el('div', 'meter-hint')
    hint.append(T.meterHint, kbd('SPACE'))
    layer.append(meter, hint)
    host.append(layer)

    const previousKeys = setKeys({})
    let start = 0
    let value = 0
    let frame = 0
    let done = false

    const tick = (now: number) => {
      value = Math.min(1, (now - start) / FILL_MS)
      fill.style.height = `${value * 100}%`
      if (value >= 1) release()
      else frame = requestAnimationFrame(tick)
    }
    const press = () => {
      if (start || done) return
      start = performance.now()
      layer.classList.add('charging')
      frame = requestAnimationFrame(tick)
    }
    const release = () => {
      if (!start || done) return
      done = true
      cancelAnimationFrame(frame)
      cleanup()
      const timing = Math.round(value * 1000) / 1000
      const grade = gradeTiming(zone, timing)
      fill.style.height = `${timing * 100}%`
      layer.classList.remove('charging')
      layer.classList.add('released')
      hint.replaceChildren(el('span', `meter-grade ${grade}`, T.meterGrades[grade]))
      window.setTimeout(() => {
        layer.remove()
        setKeys(previousKeys)
        resolve({ timing, grade })
      }, GRADE_MS)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      e.preventDefault()
      if (!e.repeat) press()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      e.preventDefault()
      release()
    }
    layer.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      layer.setPointerCapture(e.pointerId)
      press()
    })
    layer.addEventListener('pointerup', release)
    layer.addEventListener('pointercancel', release)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    function cleanup(): void {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  })
}

/** 目標區寬度的文字：窄、普通、寬 */
export function zoneWidthLabel(zone: MeterZone): string {
  return T.zoneWidths[zone.good < 0.075 ? 0 : zone.good < 0.1 ? 1 : 2]
}
