// 配球：先選球種、點九宮格決定位置，再照著虛線畫出這個球種的手勢
import type { Game, MeterGrade } from '../sim/game'
import { coldZone, hotZone, repertoire, spotZones, stance, type PitchType } from '../sim/pitches'
import type { Hand } from '../sim/types'
import { GESTURE_KEYS, gesturePath, scoreGesture, scoreKeys, type Point } from './gesture'
import { kbd, setKeys, type KeyMap } from './keys'
import { el } from './playerCard'
import { play } from './sound'
import { T } from './strings'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'

export interface PitchCall {
  pitch: PitchType
  spot: number
  accuracy: number
  grade: MeterGrade
}

/** 畫手勢的時間限制（毫秒），不受比賽速度影響 */
const DRAW_MS = 5000
/** 停下後顯示判定的時間 */
const GRADE_MS = 900
/** 手勢板的邊長（SVG 座標） */
const PAD = 200
/** 選球種的按鍵 */
const PITCH_KEYS = ['q', 'w', 'e', 'r']
const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }

/** 九宮格位置的名稱，例如「內角高」「外角」「正中」 */
export function spotName(spot: number, hand: Hand): string {
  const zones = spotZones(spot, hand)
  if (zones.length === 0) return T.spotMiddle
  const side = zones.find((z) => z === 'in' || z === 'out')
  const height = zones.find((z) => z === 'high' || z === 'low')
  return `${side ? T.zoneNames[side] : ''}${height ? T.zoneNames[height] : ''}`
}

/** 手勢寬容度的文字：嚴格、普通、寬鬆 */
export function gestureWidthLabel(game: Game): string {
  const slack = 1 - game.gestureZone().good
  return T.gestureWidths[slack < 0.28 ? 0 : slack < 0.38 ? 1 : 2]
}

/** 球種的小圖示：把手勢樣板縮小畫出來，起點畫一個圓點分出方向（直球往上、指叉往下） */
function pitchIcon(pitch: PitchType, size = 26): string {
  const path = gesturePath(pitch, PAD, 34)
  const [, x, y] = path.match(/^M([\d.]+) ([\d.]+)/)!
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 ${PAD} ${PAD}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x}" cy="${y}" r="26" fill="#2fbf71" stroke="#141633" stroke-width="10"/></svg>`
}

/** 在 host（球場）上蓋一層配球畫面；按「這球交給球員」（Esc）回傳 null */
export function runPitchCall(host: HTMLElement, game: Game): Promise<PitchCall | null> {
  return new Promise((resolve) => {
    const kinds = repertoire(game.pitcher)
    const hand = stance(game.batter, game.pitcher)
    const hot = hotZone(game.batter)
    const cold = coldZone(game.batter)
    const last = game.previousThrow
    let selected: PitchType = last === kinds[1] ? kinds[0] : kinds[1]

    const layer = el('div', 'pitch-layer')
    const skip = el('button', 'meter-skip', T.meterSkip)
    skip.type = 'button'
    skip.append(kbd('ESC'))
    const stage = el('div', 'pitch-stage')
    layer.append(stage, skip)
    host.append(layer)

    const previousKeys = setKeys({})
    let timer = 0
    let done = false
    const finish = (value: PitchCall | null) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      layer.remove()
      setKeys(previousKeys)
      resolve(value)
    }
    skip.onclick = () => finish(null)

    // ---- 第一步：選球種、點位置 ----
    function renderCall(): void {
      const keys: KeyMap = { Escape: () => finish(null) }
      const box = el('div', 'pitch-call')
      const head = el('div', 'pc-head')
      head.append(el('span', 'meter-title', T.pitchCallTitle), el('span', 'pc-hint', T.pitchCallHint))
      box.append(head)

      const zoneWrap = el('div', `pc-zone-wrap ${hand === 'R' ? 'bats-right' : 'bats-left'}`)
      zoneWrap.append(el('span', 'pc-batter', T.batterStance(hand)))
      const zone = el('div', 'pc-zone')
      for (let spot = 0; spot < 9; spot++) {
        const zones = spotZones(spot, hand)
        const cls = zones.includes(hot) ? 'hot' : zones.includes(cold) ? 'cold' : ''
        const cell = el('button', `pc-cell ${cls}`)
        cell.type = 'button'
        cell.setAttribute('aria-label', `${spotName(spot, hand)}${cls ? `（${cls === 'hot' ? T.hotZone : T.coldZone}）` : ''}`)
        cell.append(kbd(String(spot + 1)))
        cell.onclick = () => renderDraw(selected, spot)
        keys[String(spot + 1)] = () => renderDraw(selected, spot)
        zone.append(cell)
      }
      zoneWrap.append(zone)
      const body = el('div', 'pc-body')
      const pitches = el('div', 'pc-pitches')
      body.append(zoneWrap, pitches)
      box.append(body, el('p', 'pc-legend', T.hotLegend(T.zoneNames[hot], T.zoneNames[cold])))

      kinds.forEach((pitch, i) => {
        const b = el('button', `pc-pitch${pitch === selected ? ' selected' : ''}`)
        b.type = 'button'
        b.setAttribute('aria-pressed', String(pitch === selected))
        const icon = el('span', 'pc-pitch-icon')
        icon.innerHTML = pitchIcon(pitch)
        b.append(icon, el('span', 'pc-pitch-name', T.pitchNames[pitch]))
        if (i === 1) b.append(el('span', 'pc-tag primary', T.primaryPitch))
        if (pitch === last) b.append(el('span', 'pc-tag repeat', T.repeatedPitch))
        b.append(kbd(PITCH_KEYS[i].toUpperCase()))
        const pick = () => {
          selected = pitch
          renderCall()
        }
        b.onclick = pick
        keys[PITCH_KEYS[i]] = pick
        pitches.append(b)
      })
      if (selected === last) box.append(el('p', 'pc-warning', T.repeatWarning))
      stage.replaceChildren(box)
      setKeys(keys)
    }

    // ---- 第二步：照著虛線畫手勢（或用方向鍵） ----
    function renderDraw(pitch: PitchType, spot: number): void {
      const box = el('div', 'pitch-draw')
      const head = el('div', 'pc-head')
      const back = el('button', 'pc-back', T.drawBack)
      back.type = 'button'
      head.append(el('span', 'meter-title', `${T.pitchNames[pitch]}・${spotName(spot, hand)}`), back)
      const pad = el('div', 'pc-pad')
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', `0 0 ${PAD} ${PAD}`)
      const guide = gesturePath(pitch, PAD, 34)
      svg.innerHTML = `<path class="pc-guide" d="${guide}"/>`
      // 起點的圓點：從這裡開始畫
      const start = guide.match(/^M([\d.]+) ([\d.]+)/)!
      svg.insertAdjacentHTML('beforeend', `<circle class="pc-start" cx="${start[1]}" cy="${start[2]}" r="9"/>`)
      const trail = document.createElementNS(ns, 'polyline')
      trail.setAttribute('class', 'pc-trail')
      svg.append(trail)
      pad.append(svg)
      const timeBar = el('div', 'pc-time')
      const timeFill = el('span', 'pc-time-fill')
      timeFill.style.animationDuration = `${DRAW_MS}ms`
      timeBar.append(timeFill)
      const hint = el('div', 'pc-draw-hint')
      hint.append(T.drawHint(T.pitchNames[pitch]), el('span', 'pc-keys', `${T.drawKeys} ${GESTURE_KEYS[pitch].map((k) => ARROWS[k]).join('')}`))
      box.append(head, pad, timeBar, hint)
      stage.replaceChildren(box)

      const began = performance.now()
      let stroke: Point[] = []
      let strokeStart = 0
      let drawing = false
      let released = false
      const typed: string[] = []

      const release = (accuracy: number) => {
        if (released) return
        released = true
        window.clearTimeout(timer)
        timeFill.style.animationPlayState = 'paused'
        const grade = game.gradeGesture(accuracy)
        hint.replaceChildren(el('span', `meter-grade ${grade === 'miss' ? 'late' : grade}`, T.meterGrades[grade]))
        pad.classList.add('released', grade)
        play(grade === 'perfect' ? 'perfect' : grade === 'good' ? 'good' : 'miss')
        setKeys({})
        window.setTimeout(() => finish({ pitch, spot, accuracy, grade }), GRADE_MS)
      }
      // 時間到還沒畫完就是失投
      timer = window.setTimeout(() => release(drawing ? scoreGesture(stroke, pitch, DRAW_MS) : 0), DRAW_MS)

      const toPad = (e: PointerEvent): Point => {
        const r = svg.getBoundingClientRect()
        return [((e.clientX - r.left) / r.width) * PAD, ((e.clientY - r.top) / r.height) * PAD]
      }
      const show = () => trail.setAttribute('points', stroke.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '))
      pad.addEventListener('pointerdown', (e) => {
        if (released) return
        e.preventDefault()
        pad.setPointerCapture(e.pointerId)
        drawing = true
        strokeStart = performance.now()
        stroke = [toPad(e)]
        show()
      })
      pad.addEventListener('pointermove', (e) => {
        if (!drawing || released) return
        stroke.push(toPad(e))
        show()
      })
      const end = () => {
        if (!drawing || released) return
        drawing = false
        // 分數用螢幕上的像素長度判斷有沒有畫，所以換算回像素
        const scale = svg.getBoundingClientRect().width / PAD
        release(scoreGesture(stroke.map(([x, y]): Point => [x * scale, y * scale]), pitch, performance.now() - strokeStart))
      }
      pad.addEventListener('pointerup', end)
      pad.addEventListener('pointercancel', end)

      const want = GESTURE_KEYS[pitch]
      const arrow = (key: string) => () => {
        if (released) return
        typed.push(key)
        stroke = []
        if (typed.length >= want.length || key !== want[typed.length - 1]) release(scoreKeys(typed, pitch, performance.now() - began))
      }
      const keys: KeyMap = { Escape: () => finish(null) }
      for (const key of Object.keys(ARROWS)) keys[key] = arrow(key)
      setKeys(keys)
      back.onclick = () => {
        if (released) return
        window.clearTimeout(timer)
        renderCall()
      }
    }

    renderCall()
    void maybeTutorial('pitchCall', TUTORIAL_STEPS.pitchCall)
  })
}
