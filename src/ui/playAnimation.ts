// 觀戰畫面的動畫規則：節奏、事件分類、音效選擇、爆炸框圖形（原本跟 V1 比賽畫面共用，數值沒變）
import type { GameEvent, PlayKind } from '../sim/game'
import type { SoundName } from './sound'

/** 1x 時的節奏（毫秒）：動畫本身加上之後的停頓，讓人看得清楚每一球 */
export const MATCH_PACE = {
  pitch: 600,
  afterPitch: 300,
  flightBase: 650,
  flightPerFoot: 2.6,
  afterPlay: 800,
  steal: 650,
  afterHalfInning: 900,
  homeRunStats: 1400,
  strikeout: 500,
} as const

/** 一般時刻比關鍵時刻再快 1.4 倍 */
export const ROUTINE_SPEEDUP = 1.4

export const HIT_KINDS: ReadonlySet<string> = new Set(['single', 'double', 'triple'])
export const OUT_KINDS: ReadonlySet<string> = new Set(['groundOut', 'doublePlay', 'flyOut', 'sacrificeFly', 'lineOut', 'buntPopOut', 'sacrificeBunt'])

/** 球到本壘那一刻的音效：進手套、揮空、擦棒，或打進場內（全壘打更響） */
export function pitchSound(e: Extract<GameEvent, { type: 'pitch' }>, next: GameEvent | undefined): SoundName {
  if (e.result === 'inPlay') return next?.type === 'play' && next.kind === 'homeRun' ? 'bigCrack' : 'crack'
  if (e.result === 'foul') return 'foul'
  if (e.result === 'swingingStrike') return 'whoosh'
  return 'mitt'
}

/** 打擊結果的音效；沒有就是 null */
export function playSound(kind: PlayKind, runs: number): SoundName | null {
  if (kind === 'homeRun') return 'roar'
  if (kind === 'strikeout') return 'strikeout'
  if (runs > 0 || HIT_KINDS.has(kind) || kind === 'doublePlay') return 'cheer'
  return null
}

/** 大字提示後面的爆炸框 */
export const BURST_SVG = (() => {
  const pts: string[] = []
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 46 : 74
    const a = (i * Math.PI) / 12
    pts.push(`${(Math.cos(a) * r * 1.5).toFixed(1)},${(Math.sin(a) * r * 0.9).toFixed(1)}`)
  }
  return `<svg class="burst" aria-hidden="true" viewBox="-125 -75 250 150"><polygon points="${pts.join(' ')}"/></svg>`
})()
