// 配球：選一個球種，再照著虛線畫出這個球種的手勢
import type { Game, MeterGrade } from '../sim/game'
import { repertoire, type PitchType } from '../sim/pitches'
import { GESTURE_KEYS, drawnBackwards, gestureArrow, gesturePath, scoreGesture, scoreKeys, type Point } from './gesture'
import { kbd, setKeys, type KeyMap } from './keys'
import { el } from './playerCard'
import { play } from './sound'
import { T } from './strings'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'

export interface PitchCall {
  pitch: PitchType
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

/** 球種的小圖示：把手勢樣板縮小畫出來，起點一個圓點、終點一個箭頭（直球往上、指叉往下） */
function pitchIcon(pitch: PitchType, size = 26): string {
  const path = gesturePath(pitch, PAD, 40)
  const [, x, y] = path.match(/^M([\d.]+) ([\d.]+)/)!
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 ${PAD} ${PAD}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x}" cy="${y}" r="20" fill="#2fbf71" stroke="#141633" stroke-width="8"/><polygon points="${gestureArrow(pitch, PAD, 40, 64)}" fill="currentColor" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/></svg>`
}

/** 在 host（球場）上蓋一層配球畫面；按「這球交給球員」（Esc）回傳 null */
export function runPitchCall(host: HTMLElement, game: Game): Promise<PitchCall | null> {
  return new Promise((resolve) => {
    const kinds = repertoire(game.pitcher)
    const last = game.previousThrow

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

    // ---- 第一步：選球種，點一下就開始畫 ----
    function renderCall(): void {
      const keys: KeyMap = { Escape: () => finish(null) }
      const box = el('div', 'pitch-call')
      const head = el('div', 'pc-head')
      head.append(el('span', 'meter-title', T.pitchCallTitle), el('span', 'pc-hint', T.pitchCallHint))
      box.append(head)
      const pitches = el('div', 'pc-pitches')
      kinds.forEach((pitch, i) => {
        const b = el('button', `pc-pitch${pitch === last ? ' repeated' : ''}`)
        b.type = 'button'
        const icon = el('span', 'pc-pitch-icon')
        icon.innerHTML = pitchIcon(pitch)
        b.append(icon, el('span', 'pc-pitch-name', T.pitchNames[pitch]))
        if (i === 1) b.append(el('span', 'pc-tag primary', T.primaryPitch))
        if (pitch === last) b.append(el('span', 'pc-tag repeat', T.repeatedPitch))
        b.append(kbd(PITCH_KEYS[i].toUpperCase()))
        b.onclick = () => renderDraw(pitch)
        keys[PITCH_KEYS[i]] = () => renderDraw(pitch)
        pitches.append(b)
      })
      box.append(pitches)
      if (last) box.append(el('p', 'pc-warning', T.repeatWarning))
      stage.replaceChildren(box)
      setKeys(keys)
    }

    // ---- 第二步：照著虛線畫手勢（或用方向鍵） ----
    function renderDraw(pitch: PitchType): void {
      const box = el('div', 'pitch-draw')
      const head = el('div', 'pc-head')
      const back = el('button', 'pc-back', T.drawBack)
      back.type = 'button'
      head.append(el('span', 'meter-title', T.pitchNames[pitch]), back)
      const pad = el('div', 'pc-pad')
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', `0 0 ${PAD} ${PAD}`)
      const guide = gesturePath(pitch, PAD, 34)
      // 起點畫綠點、終點畫箭頭，再讓一顆小球沿著虛線從起點跑到終點示範方向；開始畫就收起來
      const start = guide.match(/^M([\d.]+) ([\d.]+)/)!
      svg.innerHTML =
        `<path class="pc-guide" d="${guide}"/>` +
        `<polygon class="pc-arrow" points="${gestureArrow(pitch, PAD, 34, 30)}"/>` +
        `<circle class="pc-start" cx="${start[1]}" cy="${start[2]}" r="9"/>` +
        `<circle class="pc-tracer" r="7"><animateMotion dur="1.1s" repeatCount="indefinite" path="${guide}"/></circle>`
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

      const release = (accuracy: number, backwards = false) => {
        if (released) return
        released = true
        window.clearTimeout(timer)
        timeFill.style.animationPlayState = 'paused'
        svg.querySelector('.pc-tracer')?.remove()
        const grade = game.gradeGesture(accuracy)
        hint.replaceChildren(el('span', `meter-grade ${grade === 'miss' ? 'late' : grade}`, T.meterGrades[grade]))
        if (backwards && grade === 'miss') hint.append(el('span', 'pc-backwards', T.drawBackwards))
        pad.classList.add('released', grade)
        play(grade === 'perfect' ? 'perfect' : grade === 'good' ? 'good' : 'miss')
        setKeys({})
        window.setTimeout(() => finish({ pitch, accuracy, grade }), GRADE_MS)
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
        svg.querySelector('.pc-tracer')?.remove()
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
        const px = stroke.map(([x, y]): Point => [x * scale, y * scale])
        const ms = performance.now() - strokeStart
        release(scoreGesture(px, pitch, ms), drawnBackwards(px, pitch, ms))
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
