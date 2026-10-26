// 音效：全部用 Web Audio 即時合成，不載入音檔。瀏覽器要求第一次有使用者操作後才能發聲，所以用到時才建立 AudioContext
import { kbd } from './keys'
import { el } from './playerCard'
import { loadSoundOn, saveSoundOn } from './prefs'
import { T } from './strings'

export type SoundName =
  | 'mitt' // 球進捕手手套
  | 'whoosh' // 揮空
  | 'foul' // 擦棒、界外
  | 'crack' // 打進場內
  | 'bigCrack' // 全壘打的紮實擊球
  | 'cheer' // 安打、得分的歡呼
  | 'roar' // 全壘打的大歡呼
  | 'strikeout' // 三振
  | 'alert' // 決策面板跳出
  | 'pop' // toast 提示
  | 'dice' // 重骰
  | 'sparkle' // 稀有球員、選秀
  | 'perfect' // 計量條完美
  | 'good' // 計量條不錯
  | 'miss' // 計量條失手
  | 'win' // 勝利
  | 'lose' // 落敗
  | 'champion' // 奪冠

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null
let enabled = loadSoundOn()

export function soundOn(): boolean {
  return enabled
}

export function setSoundOn(on: boolean): void {
  enabled = on
  saveSoundOn(on)
  if (on) play('pop')
}

function audio(): AudioContext | null {
  if (!enabled) return null
  try {
    if (!ctx) {
      ctx = new AudioContext()
      master = ctx.createGain()
      master.gain.value = 0.55
      master.connect(ctx.destination)
      // 一秒的白噪音，打擊聲、歡呼聲都從這裡濾出來
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
      const data = noise.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** 音量包絡：attack 秒內升到 peak，之後在 decay 秒內指數衰減 */
function envelope(c: AudioContext, at: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(peak, at + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay)
  g.connect(master!)
  return g
}

function tone(c: AudioContext, type: OscillatorType, from: number, to: number, at: number, peak: number, attack: number, decay: number): void {
  const o = c.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(from, at)
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + attack + decay)
  o.connect(envelope(c, at, peak, attack, decay))
  o.start(at)
  o.stop(at + attack + decay + 0.05)
}

function burst(c: AudioContext, filter: BiquadFilterType, freq: number, q: number, at: number, peak: number, attack: number, decay: number): BiquadFilterNode {
  const src = c.createBufferSource()
  src.buffer = noise
  src.loop = true
  const f = c.createBiquadFilter()
  f.type = filter
  f.frequency.setValueAtTime(freq, at)
  f.Q.value = q
  src.connect(f)
  f.connect(envelope(c, at, peak, attack, decay))
  src.start(at, Math.random() * 0.5)
  src.stop(at + attack + decay + 0.05)
  return f
}

/** 一串音符：每個音 [頻率, 開始時間（秒）] */
function melody(c: AudioContext, type: OscillatorType, notes: [number, number][], length: number, peak: number): void {
  const t = c.currentTime
  for (const [freq, start] of notes) tone(c, type, freq, freq, t + start, peak, 0.01, length)
}

/** 觀眾聲：帶通噪音，慢慢升起再退去，加一點起伏 */
function crowd(c: AudioContext, peak: number, length: number): void {
  const t = c.currentTime
  for (const [freq, delay] of [
    [900, 0],
    [1400, 0.05],
    [600, 0.1],
  ] as const) {
    const f = burst(c, 'bandpass', freq, 0.8, t + delay, peak, length * 0.25, length * 0.75)
    f.frequency.linearRampToValueAtTime(freq * 1.25, t + length * 0.4)
  }
}

const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const C6 = 1046.5

export function play(name: SoundName): void {
  const c = audio()
  if (!c) return
  const t = c.currentTime
  switch (name) {
    case 'mitt':
      tone(c, 'sine', 150, 60, t, 0.5, 0.004, 0.09)
      burst(c, 'lowpass', 900, 1, t, 0.25, 0.002, 0.05)
      break
    case 'whoosh': {
      const f = burst(c, 'bandpass', 400, 1.5, t, 0.25, 0.06, 0.12)
      f.frequency.exponentialRampToValueAtTime(1800, t + 0.16)
      break
    }
    case 'foul':
      burst(c, 'highpass', 2500, 1, t, 0.35, 0.002, 0.05)
      tone(c, 'triangle', 1500, 700, t, 0.15, 0.002, 0.04)
      break
    case 'crack':
      burst(c, 'bandpass', 2200, 1.2, t, 0.7, 0.002, 0.07)
      tone(c, 'triangle', 1900, 500, t, 0.3, 0.002, 0.05)
      break
    case 'bigCrack':
      burst(c, 'bandpass', 1800, 1, t, 0.95, 0.002, 0.12)
      tone(c, 'triangle', 2200, 400, t, 0.4, 0.002, 0.08)
      tone(c, 'sine', 120, 50, t, 0.4, 0.003, 0.15)
      break
    case 'cheer':
      crowd(c, 0.16, 1.4)
      break
    case 'roar':
      crowd(c, 0.3, 2.8)
      melody(c, 'square', [[C5, 0.15], [E5, 0.27], [G5, 0.39], [C6, 0.51]], 0.22, 0.06)
      break
    case 'strikeout':
      melody(c, 'triangle', [[G5, 0], [C5, 0.12]], 0.18, 0.2)
      break
    case 'alert':
      melody(c, 'square', [[E5 * 2, 0], [E5 * 2, 0.13]], 0.08, 0.07)
      break
    case 'pop':
      tone(c, 'sine', 700, 1100, t, 0.18, 0.005, 0.07)
      break
    case 'dice':
      for (let i = 0; i < 6; i++) burst(c, 'highpass', 3000, 1, t + i * 0.045 + Math.random() * 0.02, 0.3, 0.002, 0.03)
      break
    case 'sparkle':
      melody(c, 'sine', [[C6, 0], [E5 * 2, 0.07], [G5 * 2, 0.14], [C6 * 2, 0.21]], 0.25, 0.14)
      break
    case 'perfect':
      melody(c, 'triangle', [[G5, 0], [C6, 0.08], [E5 * 2, 0.16]], 0.3, 0.22)
      break
    case 'good':
      melody(c, 'triangle', [[E5, 0], [G5, 0.08]], 0.22, 0.2)
      break
    case 'miss':
      tone(c, 'sawtooth', 160, 90, t, 0.12, 0.01, 0.25)
      break
    case 'win':
      melody(c, 'square', [[C5, 0], [E5, 0.12], [G5, 0.24], [C6, 0.4], [G5, 0.55], [C6, 0.68]], 0.3, 0.07)
      crowd(c, 0.18, 2)
      break
    case 'lose':
      melody(c, 'triangle', [[G5, 0], [E5, 0.22], [C5, 0.44], [C5 / 1.06, 0.7]], 0.45, 0.16)
      break
    case 'champion':
      melody(c, 'square', [[C5, 0], [C5, 0.12], [C5, 0.24], [E5, 0.4], [G5, 0.6], [E5, 0.8], [G5, 0.92], [C6, 1.1]], 0.4, 0.07)
      crowd(c, 0.28, 3.2)
      break
  }
}


/** 音效開關按鈕（喇叭圖示加鍵帽 M），點一下切換並記在瀏覽器 */
export function soundToggle(className = 'sound-btn'): HTMLButtonElement {
  const btn = el('button', className)
  btn.type = 'button'
  const render = () => {
    btn.innerHTML = soundIcon(enabled)
    btn.setAttribute('aria-pressed', String(enabled))
    btn.setAttribute('aria-label', enabled ? T.soundOn : T.soundOff)
    btn.title = enabled ? T.soundOn : T.soundOff
    btn.append(kbd('M'))
  }
  render()
  btn.onclick = () => {
    setSoundOn(!enabled)
    render()
  }
  return btn
}

/** 喇叭圖示：開或關（加一條斜線） */
function soundIcon(on: boolean): string {
  return `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${
    on ? '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>' : '<path d="M17 9l5 6M22 9l-5 6"/>'
  }</svg>`
}
