// V2 觀戰畫面：直播進行中的比賽（主要），以及觀看晉級挑戰賽的過程。
//
// - 只在玩家按「觀看比賽」時才由 app 動態載入，放置結算、Headless MatchRunner 不會載入任何畫面或 Canvas。
// - 畫面全部由時間軸驅動：比分、出局、壘上、打者、投手都來自確定性的模擬狀態，
//   這裡不抽任何影響結果的亂數（球場的界外球方向是純視覺的隨機，不影響狀態）。
// - 用共用的 FieldRenderer、PitchCam、爆炸框大字、全壘打數據卡，節奏與音效規則在 ui/playAnimation.ts。
// - 完全不碰球團、存檔與 controller：播放過程不寫入任何東西。
// - 直播（mode: 'live'）：依真實時間播放（livePlayer.ts），暫停只停自己的畫面，繼續時同步到當下進度；沒有重播、跳轉、調速度。
// - 挑戰賽（mode: 'challenge'）：結果已經在按下挑戰時確定並存檔，這裡只是不先揭曉結果地播出來，可以暫停、調速度、直接看結果。
// - 生命週期：close() 會停止播放迴圈、取消所有動畫與計時器、移除監聽器、還原鍵盤快捷鍵，之後不再操作 DOM。
// - 精彩時刻（Phase 6B）：application/matchMoments.ts 判定，這裡只負責演。直播每一格分成「懸念」與「揭曉」兩段，
//   得分大字、全壘打、追平／逆轉、再見、三振、雙殺、比分條的更新全部在揭曉段，也就是這一格正式提交之後（見 livePlayer.ts）。
//   特效只用 CSS 動畫與既有的 Canvas、Web Audio；系統要求降低動態效果時不閃光、不撒彩帶，文字資訊照樣顯示。
import type { Alignment, BattedBall, GameEvent, PitchResult, RunnerMove, Side } from '../../sim/game'
import { homeRunStats } from '../../sim/game'
import type { PitchType } from '../../sim/pitches'
import type { Pitcher } from '../../sim/types'
import { FieldRenderer } from '../../ui/field'
import { basesSvg } from '../../ui/bases'
import { setKeys, type KeyMap } from '../../ui/keys'
import { PITCH_MOTION, PitchCam } from '../../ui/pitchCam'
import { BURST_SVG, HIT_KINDS, MATCH_PACE, OUT_KINDS, ROUTINE_SPEEDUP, pitchSound, playSound } from '../../ui/playAnimation'
import { el } from '../../ui/playerCard'
import { play as playSoundFx, soundToggle, type SoundName } from '../../ui/sound'
import { PITCH_TEXT, T, describePlay, homeRunName, runnersText } from '../../ui/strings'
import { CPU_COLOR, USER_COLOR, sideTag } from '../../ui/visual'
import { LivePlayer, type LiveClock, type LiveSource, type LiveView } from '../application/livePlayer'
import { clutchSituation, frameMoment, headlineKind, inningStage, type ClutchSituation, type FrameMoment } from '../application/matchMoments'
import type { MatchReplay } from '../application/matchRunner'
import {
  REPLAY_SPEEDS,
  ReplayError,
  ReplayPlayer,
  abortableWait,
  buildTimeline,
  untilAborted,
  type CommitOptions,
  type FrameContext,
  type ReplayExpectation,
  type ReplayFrame,
  type ReplayPresenter,
  type ReplayState,
  type ReplayTimeline,
  type ReplayView,
} from '../application/replayPlayer'
import { V2T } from './strings'
import { iconSvg } from './icons'
import { avatar } from '../../ui/avatar'

/**
 * 球場這一層（Canvas 動畫）。正式版包住共用的 FieldRenderer 與 PitchCam；
 * 測試環境沒有 Canvas，可以換成立即完成的假實作
 */
export interface ReplayStage {
  /** 放進球場框裡的元素（canvas、投球視角小窗） */
  readonly elements: HTMLElement[]
  setColors(userFielding: boolean): void
  align(alignment: Alignment, ms: number): Promise<void>
  sync(bases: readonly (string | null)[], batterId: string | null): void
  /**
   * 投球的前段（懸念）：球飛向本壘，跟這一球的結果無關（所以沒有 result 參數）。
   * 直播在結果正式提交之前播；不能畫出界外球的後續軌跡、不能依好壞球決定進壘點
   */
  pitch(ms: number, pitch: PitchType | undefined, thrower: Pitcher | undefined): Promise<void>
  /** 投球的結果（揭曉）：進壘點、界外球的後續軌跡、球收起或留在本壘等著被擊出。直播在結果正式提交之後才播 */
  pitchResult(result: PitchResult, ms: number): Promise<void>
  play(ball: BattedBall | null, moves: RunnerMove[], caught: boolean, ms: number): Promise<void>
  run(moves: RunnerMove[], ms: number): Promise<void>
  /** 取消所有進行中的動畫 */
  cancel(): void
  resize(): void
  readonly alignment: Alignment
}

/** 正式的球場：FieldRenderer + PitchCam（src/ui） */
export function canvasStage(): ReplayStage {
  const canvas = el('canvas', 'field')
  const cam = new PitchCam()
  let field: FieldRenderer | null = null
  // 要等 canvas 進到畫面、量得到寬度之後才能建立
  const ensure = () => (field ??= new FieldRenderer(canvas))
  return {
    elements: [canvas, cam.root],
    setColors(userFielding) {
      const f = ensure()
      f.fieldingColor = userFielding ? USER_COLOR : CPU_COLOR
      f.battingColor = userFielding ? CPU_COLOR : USER_COLOR
      f.fieldingStroke = userFielding ? '#FFFFFF' : '#141633'
      f.battingStroke = userFielding ? '#141633' : '#FFFFFF'
    },
    align: (a, ms) => ensure().align(a, ms),
    sync: (bases, batterId) => ensure().sync(bases, batterId),
    async pitch(ms, pitch, thrower) {
      const f = ensure()
      if (pitch && thrower) await Promise.all([f.pitchTravel(ms, pitch, thrower.throws), cam.approach(pitch, thrower, ms)])
      else await f.pitchTravel(ms)
    },
    async pitchResult(result, ms) {
      const f = ensure()
      // 界外球：後續軌跡；投球視角：球從中性軌跡轉到真正的進壘點
      await Promise.all([f.pitchOutcome(result, result === 'foul' ? ms : 0), cam.finish(result, Math.min(ms, 160))])
    },
    play: (ball, moves, caught, ms) => ensure().play(ball, moves, caught, ms),
    run: (moves, ms) => ensure().run(moves, ms),
    cancel() {
      field?.cancel()
      cam.cancel()
    },
    resize: () => ensure().resize(),
    get alignment() {
      return ensure().alignment
    },
  }
}

interface ViewerCommon {
  /** 標題，例如「第 12 場・對手」 */
  title: string
  /** 關閉之後呼叫（回到原本的畫面） */
  onClose?: () => void
  /** 測試用：換掉 Canvas 球場 */
  createStage?: () => ReplayStage
  /** 測試用：所有等待時間乘上這個數字（0 = 不等待） */
  timeScale?: number
  /** 測試用：音效（預設是 ui/sound 的 play） */
  sound?: (name: SoundName) => void
  /** 測試用：是否降低動態效果（預設看系統的 prefers-reduced-motion） */
  reducedMotion?: boolean
  /** 測試用：每次顯示特效、更新比分條時通知（驗證揭露時間） */
  onEffect?: (e: { kind: 'callout' | 'banner' | 'transition' | 'board' | 'final' | 'clutch' | 'celebrate'; label: string }) => void
}

export interface LiveViewerOptions extends ViewerCommon {
  mode: 'live'
  source: LiveSource
  clock: LiveClock
  /** 這一場結束後，取得下一場（app 會先結算再推算）；沒有就是 null */
  next?: () => Promise<{ source: LiveSource; title: string } | null>
}

export interface ChallengeViewerOptions extends ViewerCommon {
  mode: 'challenge'
  /** 挑戰賽的 Replay（已經確定、已經存檔的那一場的複製） */
  replay: MatchReplay
  expected: ReplayExpectation
  /** 播完（或直接看結果）之後呼叫：顯示挑戰結果 */
  onFinished?: () => void
  autoplay?: boolean
}

export type MatchViewerOptions = LiveViewerOptions | ChallengeViewerOptions

export interface MatchViewerHandle {
  close(): void
  readonly root: HTMLElement
  /** 測試用 */
  readonly live: () => LivePlayer | null
  readonly replay: () => ReplayPlayer | null
}

/** 打開觀戰畫面（蓋在 V2 畫面上方的子畫面） */
export function openMatchViewer(opts: MatchViewerOptions): MatchViewerHandle {
  const overlay = el('div', 'v2-replay-overlay')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', opts.mode === 'live' ? V2T.liveTitle : V2T.challengeTitle)
  const screen = el('div', `v2-replay ${opts.mode}`)
  overlay.append(screen)
  document.body.append(overlay)

  let closed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t)
      if (!closed) fn()
    }, ms)
    timers.add(t)
  }
  const cleanups: (() => void)[] = []
  const previousKeys = setKeys({})

  // 頂部：離開、標題、直播狀態、音效
  const top = el('div', 'v2-replay-top')
  const back = el('button', 'v2-replay-back')
  back.type = 'button'
  back.dataset.action = 'replay-back'
  back.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
  back.append(opts.mode === 'live' ? V2T.liveLeave : V2T.replayBack)
  const titles = el('div', 'v2-replay-titles')
  const title = el('h2', 'v2-replay-title', opts.title)
  // 直播：直播中／即將開始／比賽結束；挑戰賽：挑戰賽重播
  const badge = el('span', `v2-live-badge ${opts.mode === 'live' ? '' : 'replay'}`, opts.mode === 'live' ? '' : V2T.replayBadge)
  titles.append(title, badge)
  top.append(back, titles, soundToggle('sound-btn v2-replay-sound'))
  screen.append(top)

  let livePlayer: LivePlayer | null = null
  let replayPlayer: ReplayPlayer | null = null
  let stage: ReplayStage | null = null
  function close(): void {
    if (closed) return
    closed = true
    livePlayer?.dispose()
    replayPlayer?.dispose()
    stage?.cancel()
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const c of cleanups) c()
    setKeys(previousKeys)
    overlay.remove()
    opts.onClose?.()
  }
  back.onclick = close
  const handle: MatchViewerHandle = { close, root: overlay, live: () => livePlayer, replay: () => replayPlayer }

  let timeline: ReplayTimeline
  try {
    timeline = opts.mode === 'live' ? opts.source.timeline : buildTimeline(opts.replay, opts.expected)
  } catch (e) {
    // 資料損壞、版本不相容：顯示可以理解的錯誤，可以返回；不碰存檔
    const error = e instanceof ReplayError ? e : new ReplayError('corrupt', String(e))
    const box = el('section', 'v2-card v2-replay-error')
    box.setAttribute('role', 'alert')
    box.append(el('h3', '', V2T.replayErrorTitle), el('p', '', V2T.replayErrorText(error.code)), el('p', 'v2-hint', error.message))
    screen.append(box)
    setKeys({ Escape: close })
    return handle
  }

  const theStage = (opts.createStage ?? canvasStage)()
  stage = theStage

  const board = el('header', 'match-header v2-replay-board')
  const fieldBox = el('section', 'match-field v2-replay-field')
  fieldBox.setAttribute('aria-label', '球場')
  const callout = el('div', 'callout')
  const finalPanel = el('div', 'v2-replay-final')
  finalPanel.hidden = true
  /** 結果面板底下的按鈕（直播：離開、觀看下一場） */
  const finalExtra = el('div', 'v2-final-extra')
  const pausedPanel = el('div', 'v2-live-paused')
  pausedPanel.hidden = true
  // Phase 6B 的特效層：閃光、彩帶、精彩時刻橫幅、關鍵打席標籤、局間轉場（都在球場框裡，不蓋比分條）
  const flashLayer = el('div', 'v2-fx-flash')
  const confettiLayer = el('div', 'v2-fx-confetti')
  confettiLayer.setAttribute('aria-hidden', 'true')
  const momentBanner = el('div', 'v2-fx-moment')
  momentBanner.setAttribute('role', 'status')
  const clutchChip = el('div', 'v2-fx-clutch')
  clutchChip.hidden = true
  const transition = el('div', 'v2-fx-transition')
  fieldBox.append(...theStage.elements, flashLayer, confettiLayer, clutchChip, momentBanner, transition, callout, pausedPanel, finalPanel)
  const reduced = opts.reducedMotion ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  if (reduced) screen.classList.add('reduced-motion')
  const sound = opts.sound ?? playSoundFx
  /** 同一格的同一個音效只播一次（暫停恢復、重繪都不重播） */
  const sounded = new Set<string>()
  const cue = (key: string, name: SoundName | null) => {
    if (!name || sounded.has(`${key}:${name}`)) return
    sounded.add(`${key}:${name}`)
    sound(name)
  }
  const duel = el('div', 'v2-replay-duel')
  const lastPlay = el('p', 'v2-replay-last')
  lastPlay.setAttribute('aria-live', 'polite')
  const log = el('ol', 'v2-replay-log')
  log.setAttribute('aria-label', '比賽紀錄')
  const controls = el('div', `v2-replay-controls ${opts.mode}`)
  screen.append(board, fieldBox, duel, lastPlay, log, controls)

  const name = (id: string | null) => (id ? (timeline.players.get(id)?.name ?? '?') : '')
  const userSide = () => timeline.userSide
  const otherSide = (): Side => (timeline.userSide === 'home' ? 'away' : 'home')
  const speedNow = () => replayPlayer?.view.speed ?? 1

  // ---- 畫面 ----

  function renderBoard(s: ReplayState, outsOverride?: number): void {
    opts.onEffect?.({ kind: 'board', label: `${s.score.away}:${s.score.home}:${s.over ? 'over' : ''}` })
    board.replaceChildren()
    const teams = el('div', 'mh-teams')
    for (const side of ['away', 'home'] as const) {
      const batting = !s.over && s.battingSide === side
      const row = el('div', `mh-team ${batting ? 'batting' : ''}`)
      const nameEl = el('span', 'mh-name', timeline.teamNames[side])
      if (side === userSide()) nameEl.append(sideTag(true))
      const score = el('span', 'mh-score', String(s.score[side]))
      score.dataset.score = side === userSide() ? 'us' : 'them'
      row.append(el('span', `mh-swatch ${side === userSide() ? 'user' : 'opponent'}`), nameEl, score)
      teams.append(row)
    }
    const inning = el('div', 'mh-inning')
    inning.dataset.inning = `${s.inning}${s.half}`
    inning.append(el('span', 'mh-inning-num', String(s.inning)), el('span', 'mh-inning-half', s.over ? V2T.replayFinalShort : s.half === 'top' ? T.halfTop : T.halfBottom))
    const bases = el('div', 'mh-bases')
    bases.innerHTML = basesSvg(s.bases.map(Boolean))
    bases.setAttribute('role', 'img')
    bases.setAttribute('aria-label', runnersText(s.bases.map(Boolean)))
    bases.dataset.bases = s.bases.map((b) => (b ? '1' : '0')).join('')
    const count = el('div', 'mh-count')
    const outs = outsOverride ?? s.outs
    count.dataset.outs = String(outs)
    const lights = (label: string, n: number, max: number, cls: string) => {
      count.append(el('span', 'mh-count-label', label))
      for (let i = 0; i < 3; i++) count.append(el('span', i < max ? `mh-light ${i < n ? cls : ''}` : ''))
    }
    lights('B', s.balls, 3, 'on-ball')
    lights('S', s.strikes, 2, 'on-strike')
    lights('O', outs, 2, 'on-out')
    board.append(teams, inning, bases, count)

    duel.replaceChildren()
    if (s.over) return
    const fielding: Side = s.battingSide === 'home' ? 'away' : 'home'
    const card = (label: string, id: string | null, side: Side, key: string) => {
      const ours = side === userSide()
      const box = el('div', `v2-replay-duel-card ${ours ? 'user' : 'opponent'}`)
      const n = el('strong', '', name(id))
      n.dataset[key] = id ?? ''
      const words = el('span', 'v2-replay-duel-words')
      words.append(el('span', 'v2-replay-duel-label', label), n)
      if (ours) words.append(sideTag(true))
      box.append(avatar(id ?? key, ours ? 'user' : 'opponent', 'v2-replay-duel-face'), words)
      return box
    }
    duel.append(card(V2T.replayBatter, s.batterId, s.battingSide, 'batter'), card(V2T.replayPitcher, s.pitcherId, fielding, 'pitcher'))
  }

  function addLog(text: string, cls = ''): void {
    const li = el('li', cls, text)
    log.prepend(li)
    while (log.children.length > 30) log.lastChild?.remove()
  }

  /** 大字（爆炸框）：ms 是顯示多久（已經依時間預算算好），sub 是下面的小字（打點、出局數、比分） */
  function flash(label: string, tone: string, topText = '', ms = 1600 / speedNow(), sub = ''): void {
    callout.replaceChildren()
    callout.insertAdjacentHTML('afterbegin', BURST_SVG)
    if (topText) callout.append(el('span', 'callout-top', topText))
    callout.append(el('span', 'callout-label', label))
    if (sub) callout.append(el('span', 'callout-sub', sub))
    callout.className = `callout show ${tone}`
    callout.dataset.fx = label
    opts.onEffect?.({ kind: 'callout', label })
    later(() => {
      callout.className = 'callout'
      delete callout.dataset.fx
    }, ms)
  }

  /** 精彩時刻橫幅（追平、超前、逆轉、換投、局間），tone：good 我方好消息、bad 對手好消息、info 中性 */
  function banner(text: string, tone: 'good' | 'bad' | 'info', ms: number, sub = ''): void {
    momentBanner.replaceChildren(el('strong', '', text))
    if (sub) momentBanner.append(el('span', '', sub))
    momentBanner.className = `v2-fx-moment show ${tone}`
    momentBanner.dataset.fx = text
    opts.onEffect?.({ kind: 'banner', label: text })
    later(() => {
      momentBanner.className = 'v2-fx-moment'
      delete momentBanner.dataset.fx
    }, ms)
  }

  /** 局間轉場：半局結束、比賽進入後段、最終局、延長賽 */
  function showTransition(lines: string[], ms: number): void {
    transition.replaceChildren(...lines.map((t, i) => el(i === 0 ? 'strong' : 'span', '', t)))
    transition.className = 'v2-fx-transition show'
    transition.dataset.fx = lines.join('／')
    opts.onEffect?.({ kind: 'transition', label: transition.dataset.fx })
    later(() => {
      transition.className = 'v2-fx-transition'
      delete transition.dataset.fx
    }, ms)
  }

  /** 閃光、彩帶：降低動態效果時不做（資訊仍由大字與橫幅顯示） */
  function celebrate(level: 'big' | 'huge', tone: 'good' | 'neutral'): void {
    opts.onEffect?.({ kind: 'celebrate', label: `${level}:${tone}${reduced ? ':reduced' : ''}` })
    if (reduced) return
    flashLayer.className = `v2-fx-flash show ${level}`
    later(() => (flashLayer.className = 'v2-fx-flash'), 450)
    if (tone !== 'good') return
    const n = level === 'huge' ? 18 : 10
    const colors = ['#ffd23f', '#ff4f7b', '#5fd068', '#4fc3ff', '#ffffff']
    confettiLayer.replaceChildren()
    for (let i = 0; i < n; i++) {
      const piece = el('span', 'v2-fx-piece')
      // 純視覺的位置與顏色（用序號決定，不抽亂數）
      piece.style.left = `${((i * 37) % 100) + 0.5}%`
      piece.style.background = colors[i % colors.length]
      piece.style.animationDelay = `${(i % 6) * 40}ms`
      confettiLayer.append(piece)
    }
    later(() => confettiLayer.replaceChildren(), 1600)
  }

  /** 關鍵打席：球場加上聚焦框、左上角標籤；只看這一格之前的狀態 */
  function setClutch(c: ClutchSituation | null): void {
    fieldBox.classList.toggle('clutch', !!c)
    fieldBox.classList.toggle('clutch-high', c?.level === 'high')
    clutchChip.hidden = !c
    if (!c) {
      delete clutchChip.dataset.clutch
      return
    }
    clutchChip.className = `v2-fx-clutch ${c.ours ? 'ours' : 'theirs'} ${c.level}`
    clutchChip.dataset.clutch = c.level
    opts.onEffect?.({ kind: 'clutch', label: c.level })
    clutchChip.replaceChildren(el('strong', '', c.level === 'high' ? V2T.clutchHigh : V2T.clutchTag), el('span', '', V2T.clutchLine(c.ours, c.deficit)))
  }

  function showHomeRunStats(ball: BattedBall): void {
    const stats = homeRunStats(ball)
    fieldBox.querySelector('.hr-stats')?.remove()
    const card = el('div', 'hr-stats')
    const tile = (label: string, value: string, unit: string) => {
      const t = el('div', 'hr-stat')
      const v = el('span', 'hr-stat-value', value)
      v.append(el('span', 'hr-stat-unit', unit))
      t.append(el('span', 'hr-stat-label', label), v)
      return t
    }
    card.append(tile(T.hrDistance, T.meters(stats.distanceFt), 'm'), tile(T.hrExitVelocity, T.kmh(stats.exitVelocityMph), 'km/h'), tile(T.hrLaunchAngle, String(stats.launchAngle), '°'))
    fieldBox.append(card)
    const shown = 2600 / Math.min(speedNow(), 2)
    later(() => card.classList.add('leaving'), shown)
    later(() => card.remove(), shown + 300)
  }

  function describe(e: GameEvent): string | null {
    switch (e.type) {
      case 'play': {
        const text = describePlay(e.kind, e.ball, e.runs, e.notation)
        const hr = e.kind === 'homeRun' && e.ball ? T.hrLog(e.ball.distance) : ''
        return `${name(e.batterId)} ${text}${hr}${e.runs && e.kind !== 'homeRun' ? T.scored(e.runs) : ''}`
      }
      case 'steal':
        return `${name(e.runnerId)} ${T.stealResult(e.success)}`
      case 'substitution': {
        const fn = { pinchHit: T.subPinchHit, pinchRun: T.subPinchRun, pitcher: T.subPitcher, defense: T.subDefense }[e.kind]
        return (e.side === userSide() ? '' : T.opponentPrefix) + fn(name(e.inId), name(e.outId))
      }
      case 'halfInningEnd':
        return T.halfEnd(e.inning, e.half === 'top')
      case 'gameOver':
        return T.gameOver
      case 'pitch':
        return null
    }
  }

  function clearEffects(): void {
    theStage.cancel()
    callout.className = 'callout'
    delete callout.dataset.fx
    momentBanner.className = 'v2-fx-moment'
    delete momentBanner.dataset.fx
    transition.className = 'v2-fx-transition'
    delete transition.dataset.fx
    flashLayer.className = 'v2-fx-flash'
    confettiLayer.replaceChildren()
    fieldBox.querySelector('.hr-stats')?.remove()
  }

  /** 已經提交、但等揭曉動畫（球落地、跑者到壘）才顯示在比分條上的狀態 */
  let pendingBoard: ReplayState | null = null

  /** 直接把畫面設成某個狀態（剛進來、同步、暫停中斷、比賽結束） */
  function showState(s: ReplayState, position: number): void {
    if (closed) return
    clearEffects()
    pendingBoard = null
    theStage.setColors((s.battingSide === 'home' ? 'away' : 'home') === userSide())
    if (theStage.alignment !== s.alignment) void theStage.align(s.alignment, 0)
    theStage.sync(s.bases, s.over ? null : s.batterId)
    renderBoard(s)
    setClutch(opts.mode === 'live' ? clutchSituation(s, userSide()) : null)
    if (position === 0 && opts.mode === 'challenge') {
      log.replaceChildren()
      lastPlay.textContent = V2T.replayReady
    }
    finalPanel.hidden = !s.over
    if (s.over) renderFinal(s)
  }

  /** 比分條、壘上、守備位置換成這個狀態（不中斷大字與特效） */
  function applyBoard(s: ReplayState): void {
    theStage.setColors((s.battingSide === 'home' ? 'away' : 'home') === userSide())
    if (!s.over && theStage.alignment !== s.alignment) void theStage.align(s.alignment, 300)
    theStage.sync(s.bases, s.over ? null : s.batterId)
    renderBoard(s)
  }

  /**
   * 直播：正式提交某個時間點的比賽狀態。只更新比分條、局數、壘上與守備位置，不中斷進行中的大字與數據卡。
   * 播放器只會提交「排定時間已經到了」的狀態，所以這裡不會出現未來的比分。
   * 接下來要演這一格的揭曉時（opts.reveal），等球落地、跑者到壘才換比分條：只會比提交晚，不會比提交早
   */
  function commitState(s: ReplayState, _position: number, o?: CommitOptions): void {
    if (closed) return
    if (pendingBoard) applyBoard(pendingBoard)
    pendingBoard = null
    if (o?.reveal) pendingBoard = s
    else applyBoard(s)
  }

  /** 揭曉動畫走到結果那一刻：把等著的比分條顯示出來 */
  function flushBoard(fallback: ReplayState, live: boolean): void {
    if (!live) return
    const s = pendingBoard ?? fallback
    pendingBoard = null
    applyBoard(s)
  }

  function renderFinal(s: ReplayState): void {
    const won = s.winner === userSide()
    opts.onEffect?.({ kind: 'final', label: won ? 'won' : 'lost' })
    finalPanel.className = `v2-replay-final ${won ? 'won' : 'lost'}`
    finalPanel.replaceChildren(el('strong', 'v2-replay-verdict', won ? V2T.win : V2T.loss), el('span', 'v2-replay-final-score', `${s.score[userSide()]} : ${s.score[otherSide()]}`), linescore(s), finalExtra)
    lastPlay.textContent = V2T.replayFinalLine(won, s.inning)
  }

  function linescore(s: ReplayState): HTMLElement {
    const table = el('table', 'v2-replay-linescore')
    const innings = Math.max(s.linescore.away.length, 9)
    const head = el('tr')
    head.append(el('th'))
    for (let i = 1; i <= innings; i++) head.append(el('th', '', String(i)))
    head.append(el('th', '', 'R'), el('th', '', 'H'), el('th', '', 'E'))
    table.append(head)
    for (const side of ['away', 'home'] as const) {
      const row = el('tr', side === userSide() ? 'mine' : '')
      row.append(el('td', 'name', timeline.teamNames[side]))
      for (let i = 0; i < innings; i++) row.append(el('td', '', s.linescore[side][i] === undefined ? 'X' : String(s.linescore[side][i])))
      row.append(el('td', 'total', String(s.score[side])), el('td', '', String(s.hits[side])), el('td', '', String(s.errors[side])))
      table.append(row)
    }
    return table
  }

  // ---- 播一格（原本逐球比賽畫面 animate() 的觀戰版：狀態全部來自時間軸） ----
  //
  // 一格分成兩段：
  // - prelude（懸念）：關鍵打席提示、換投公告、打者上場、盜壘起跑、投球飛向本壘。只用這一格「之前」的狀態，不揭露結果。
  // - reveal（揭曉）：投球結果文字與音效、擊球軌跡、跑壘、比分條、大字、精彩時刻、局間轉場。
  // 直播把兩段分開排（揭曉在這一格正式提交之後）；挑戰賽依序演完整一格

  /** 懸念段在 1× 時大約多久 */
  function preludeMs(frame: ReplayFrame): number {
    let ms = 0
    for (const e of frame.events) {
      if (e.type === 'pitch') ms += MATCH_PACE.pitch * pitchPace(e.pitch)
      else if (e.type === 'substitution') ms += MATCH_PACE.afterPlay
    }
    return ms
  }

  /** 揭曉段在 1× 時大約多久（跟下面實際的等待一致），直播時用來把動畫縮放進時間預算 */
  function revealMs(frame: ReplayFrame): number {
    let ms = 0
    for (const e of frame.events) {
      if (e.type === 'pitch') ms += MATCH_PACE.afterPitch * 0.4 + (e.result === 'foul' ? MATCH_PACE.pitch * 0.8 : 0) + (e.result === 'inPlay' ? 0 : MATCH_PACE.afterPitch)
      else if (e.type === 'play') ms += MATCH_PACE.flightBase + (e.ball?.distance ?? 0) * MATCH_PACE.flightPerFoot + MATCH_PACE.afterPlay + (e.kind === 'homeRun' ? MATCH_PACE.homeRunStats : e.kind === 'strikeout' ? MATCH_PACE.strikeout : 0)
      else if (e.type === 'steal') ms += MATCH_PACE.steal + MATCH_PACE.afterPlay
      else if (e.type === 'halfInningEnd') ms += MATCH_PACE.afterHalfInning
    }
    return ms
  }

  /** 上一次提示關鍵打席的打席（同一個打席只提示、只響一次） */
  let clutchAnnounced = ''
  let batterAnnounced = ''

  async function prelude(frame: ReplayFrame, ctx: FrameContext, k: () => number): Promise<void> {
    const { signal } = ctx
    const live = !!ctx.presentOnly
    const before = ctx.before
    // 關鍵打席：只看事件發生前的狀態
    const clutch = clutchSituation(before, userSide())
    setClutch(clutch)
    const atBatKey = `${before.inning}${before.half}${before.batterId}`
    if (clutch && clutchAnnounced !== atBatKey) {
      clutchAnnounced = atBatKey
      cue(`${frame.index}:clutch`, 'alert')
    }
    let thrower = timeline.players.get(frame.throwerId) as Pitcher | undefined
    const pitches = frame.events.filter((e) => e.type === 'pitch')
    // 直播：投手先準備，球在這一格的提交時間到達本壘（剩下的時間先等）
    if (live && ctx.budgetMs !== undefined) {
      const lead = ctx.budgetMs - preludeMs(frame) * k()
      if (lead > 0) await abortableWait(lead * (opts.timeScale ?? 1), signal)
    }
    for (const e of frame.events) {
      if (signal.aborted || closed) throw abortErr()
      if (e.type === 'substitution') {
        const text = describe(e)
        if (e.kind === 'pitcher') {
          thrower = timeline.players.get(e.inId) as Pitcher | undefined
          // 換投是投球前就確定的事：投手卡先換成新投手（其他狀態仍等提交）
          const card = duel.querySelector<HTMLElement>('[data-pitcher]')
          if (card) {
            card.textContent = name(e.inId)
            card.dataset.pitcher = e.inId
          }
          banner(V2T.pitcherChange(name(e.inId), e.side === userSide()), 'info', Math.min(2200, MATCH_PACE.afterPlay * 2 * Math.max(k(), 0.5)))
        }
        if (text) {
          lastPlay.textContent = text
          addLog(text, 'sub')
        }
        await abortableWait(MATCH_PACE.afterPlay * k(), signal)
      } else if (e.type === 'pitch') {
        if (batterAnnounced !== atBatKey && before.balls === 0 && before.strikes === 0 && pitches[0] === e) {
          batterAnnounced = atBatKey
          lastPlay.textContent = V2T.atBat(name(before.batterId))
        }
        // 中性的投球：不帶結果（結果在揭曉段才畫）
        await untilAborted(theStage.pitch(MATCH_PACE.pitch * k() * pitchPace(e.pitch), e.pitch, thrower), signal)
      } else if (e.type === 'steal') {
        lastPlay.textContent = V2T.stealStart(name(e.runnerId))
      }
    }
  }

  async function reveal(frame: ReplayFrame, ctx: FrameContext, k: () => number): Promise<void> {
    const { signal } = ctx
    const live = !!ctx.presentOnly
    const before = ctx.before
    const m = frameMoment(before, frame, userSide())
    const startedAt = Date.now()
    const wait = (ms: number) => abortableWait(ms * k(), signal)
    /** 特效顯示多久：照預算縮放，最少讓人看得到、最多不長時間蓋住球場 */
    const fxMs = (natural: number, cap: number) => Math.max(500, Math.min(cap, natural * Math.max(k(), 0.6))) * (opts.timeScale ?? 1)
    const shown: ReplayState = structuredClone(before)
    const endsHalf = m.endsHalf
    const lastAction = frame.events.reduce((last, e, j) => (e.type === 'play' || e.type === 'steal' ? j : last), -1)
    /** 挑戰賽：打完一球的比分條（得分逐一累加；結束半局時顯示三出局）。直播的比分條在提交時已經準備好，揭曉到結果時才顯示 */
    const board = (st: ReplayState, outs?: number) => {
      if (!live) renderBoard(st, outs)
    }
    const afterAction = (i: number, runs: number) => {
      shown.score[before.battingSide] += runs
      shown.balls = 0
      shown.strikes = 0
      if (live) flushBoard(frame.after, true)
      else if (endsHalf) board(shown, frame.after.over ? Math.max(frame.after.outs, shown.outs) : 3)
      else if (i === lastAction) board(frame.after)
      else board(shown)
    }
    for (const [i, e] of frame.events.entries()) {
      if (signal.aborted || closed) throw abortErr()
      if (e.type === 'pitch') {
        // 投球結果（揭曉）：進壘點、界外球後續軌跡；結果文字與音效在球到位的同時
        cue(`${frame.index}:pitch`, pitchSound(e, frame.events[i + 1]))
        lastPlay.textContent = PITCH_TEXT[e.result]
        await untilAborted(theStage.pitchResult(e.result, (e.result === 'foul' ? MATCH_PACE.pitch * 0.8 : MATCH_PACE.afterPitch * 0.4) * k()), signal)
        if (e.result !== 'inPlay') {
          shown.balls = e.balls
          shown.strikes = e.strikes
          if (live) flushBoard(frame.after, true)
          else board(shown)
          await wait(MATCH_PACE.afterPitch)
        }
      } else if (e.type === 'play') {
        // 打席有了結果：關鍵打席的提示收起來（下一個打席開始時再依狀態判定）
        setClutch(null)
        const ms = (MATCH_PACE.flightBase + (e.ball?.distance ?? 0) * MATCH_PACE.flightPerFoot) * k()
        await untilAborted(theStage.play(e.ball, e.moves, OUT_KINDS.has(e.kind), ms), signal)
        const text = describe(e)!
        afterAction(i, e.runs)
        const scoreLine = m.runs > 0 && i === lastAction ? `（${V2T.scoreNow(m.score.us, m.score.them)}）` : ''
        lastPlay.textContent = `${text}${scoreLine}`
        addLog(text, e.kind === 'homeRun' ? 'hr' : e.runs > 0 ? 'score' : HIT_KINDS.has(e.kind) ? 'hit' : '')
        if (i === lastAction) playMoment(frame, m, e, fxMs)
        else {
          const sound = playSound(e.kind, e.runs)
          cue(`${frame.index}:${i}`, sound)
        }
        await wait(MATCH_PACE.afterPlay + (e.kind === 'homeRun' ? MATCH_PACE.homeRunStats : e.kind === 'strikeout' ? MATCH_PACE.strikeout : 0))
      } else if (e.type === 'steal') {
        await untilAborted(theStage.run(e.moves, MATCH_PACE.steal * k()), signal)
        const text = describe(e)!
        afterAction(i, 0)
        lastPlay.textContent = text
        addLog(text)
        if (i === lastAction && m.primary) playMoment(frame, m, null, fxMs)
        await wait(MATCH_PACE.afterPlay)
      } else if (e.type === 'halfInningEnd') {
        const text = describe(e)!
        addLog(text, 'divider')
        const top = e.half === 'top'
        const stage = inningStage(frame.after)
        const lines = [V2T.halfOver(e.inning, top), `${timeline.teamNames[userSide()]} ${frame.after.score[userSide()]} : ${frame.after.score[otherSide()]} ${timeline.teamNames[otherSide()]}`]
        if (stage === 'late') lines.push(V2T.stageLate)
        else if (stage === 'final') lines.push(V2T.stageFinal)
        else if (stage === 'extra') lines.push(V2T.stageExtra(frame.after.inning))
        if (!frame.after.over) showTransition(lines, fxMs(MATCH_PACE.afterHalfInning * 2, 2200))
        lastPlay.textContent = text.replace(/─/g, '').trim()
        await wait(MATCH_PACE.afterHalfInning)
      } else if (e.type === 'gameOver') {
        // 直播：「比賽結束」只在 endsAt 之後的最後揭曉（final）才出現
        if (!live || ctx.final) addLog(T.gameOver)
      }
    }
    if (live) flushBoard(frame.after, true)
    // 最後一格（endsAt 之後）：讓再見、最後一個出局的演出停留一下，再換成勝負面板（同一個勝利演出不重複）
    // 停留時間算在這一段的時間預算裡（FINAL_REVEAL_MS），至少 0.6 秒、最多 2.6 秒
    if (ctx.final) {
      const left = (ctx.budgetMs ?? 0) - (Date.now() - startedAt)
      await abortableWait(Math.max(600, Math.min(m.walkOff ? 2600 : 900, left)) * (opts.timeScale ?? 1), signal)
    }
  }

  /**
   * 這一格的主要演出：同一格符合多個分類時只演一個（再見 > 滿貫 > 全壘打 > 超前／逆轉 > 追平 > 得分），
   * 其他資訊（打點、比分）放在同一個大字的小字裡。我方是振奮的演出，對手只用客觀的播報，不放勝利效果
   */
  function playMoment(frame: ReplayFrame, m: FrameMoment, e: Extract<GameEvent, { type: 'play' }> | null, fxMs: (natural: number, cap: number) => number): void {
    const key = `${frame.index}:moment`
    const head = headlineKind(m)
    const scoreSub = V2T.scoreNow(m.score.us, m.score.them)
    const batter = name(m.batterId)
    if (head === 'walkOffGrandSlam' || head === 'walkOffHomeRun' || head === 'walkOff') {
      // 再見：直播只會在 endsAt 之後的最後揭曉走到這裡（最後一格的揭曉）；勝負面板接在後面，不重複演勝利動畫
      const sub = [m.homeRun ? V2T.fxRbi(m.runs) : '', V2T.fxFinal(m.score.us, m.score.them)].filter(Boolean).join('・')
      if (m.ours) {
        flash(head === 'walkOffGrandSlam' ? V2T.fxWalkOffGrandSlam : head === 'walkOffHomeRun' ? V2T.fxWalkOffHomeRun : e && HIT_KINDS.has(e.kind) ? V2T.fxWalkOff : V2T.fxWalkOffOther, 'walkoff', batter, fxMs(3200, 4200), sub)
        celebrate('huge', 'good')
        cue(key, 'champion')
      } else {
        flash(V2T.fxOppWalkOff, 'opp', batter, fxMs(2400, 3200), sub)
        cue(key, 'lose')
      }
      if (m.homeRun?.distance && e?.ball) showHomeRunStats(e.ball)
      return
    }
    if (head === 'grandSlam' || head === 'homeRun') {
      const slam = head === 'grandSlam'
      const extra = m.kinds.includes('takeLead') ? (m.comeback ? (m.ours ? V2T.fxComeback : V2T.fxOppComeback) : m.ours ? V2T.fxLead : V2T.fxOppLead) : m.kinds.includes('tieGame') ? (m.ours ? V2T.fxTie : V2T.fxOppTie) : ''
      const sub = [V2T.fxRbi(m.runs), extra.replace('！', ''), scoreSub].filter(Boolean).join('・')
      if (m.ours) {
        flash(slam ? V2T.fxGrandSlam : `${homeRunName(m.homeRun!.runs)}！`, slam ? 'hr slam' : 'hr', batter, fxMs(slam ? 2600 : 2200, slam ? 3200 : 2600), sub)
        celebrate(slam ? 'huge' : 'big', 'good')
        cue(key, 'roar')
        if (slam) later(() => cue(`${key}:slam`, 'sparkle'), 250)
      } else {
        flash(slam ? V2T.fxOppGrandSlam : V2T.fxOppHomeRun, 'opp', batter, fxMs(1800, 2200), sub)
        celebrate('big', 'neutral')
        cue(key, 'pop')
      }
      if (e?.ball) showHomeRunStats(e.ball)
      return
    }
    if (head === 'takeLead' || head === 'comeback' || head === 'tieGame') {
      const text = head === 'comeback' ? (m.ours ? V2T.fxComeback : V2T.fxOppComeback) : head === 'takeLead' ? (m.ours ? V2T.fxLead : V2T.fxOppLead) : m.ours ? V2T.fxTie : V2T.fxOppTie
      banner(text, m.ours ? 'good' : 'bad', fxMs(2200, 2600), `${m.ours ? V2T.fxScore(m.runs) : V2T.fxOppScore(m.runs)}・${scoreSub}`)
      if (m.ours) {
        if (head === 'comeback') celebrate('big', 'good')
        cue(key, head === 'tieGame' ? 'cheer' : 'sparkle')
      } else cue(key, 'pop')
      return
    }
    if (head === 'score') {
      flash(m.ours ? V2T.fxScore(m.runs) : V2T.fxOppScore(m.runs), m.ours ? 'score' : 'opp', '', fxMs(1500, 1800), scoreSub)
      cue(key, m.ours ? 'cheer' : null)
      return
    }
    // 沒有得分：三振、雙殺、失誤、安打
    const outsNow = m.endsHalf ? 3 : frame.after.outs
    if (m.strikeout) {
      // 第三個出局：短一點，接半局轉場
      const looking = m.strikeout === 'looking'
      flash('K', looking ? 'k looking' : 'k', looking ? V2T.fxStrikeoutLooking : V2T.fxStrikeoutSwinging, fxMs(m.endsHalf ? 900 : 1400, 1600), V2T.fxOuts(outsNow))
      cue(key, 'strikeout')
      return
    }
    if (m.doublePlay) {
      const names = m.doublePlay.outs.map((id) => name(id)).join('、')
      flash(V2T.fxDoublePlay, 'dp', m.doublePlay.notation ?? '', fxMs(m.endsHalf ? 1100 : 1600, 1800), V2T.fxDoublePlayOuts(names))
      cue(key, 'cheer')
      return
    }
    if (e?.kind === 'error') {
      flash(T.callError, 'error', '', fxMs(1200, 1600))
      return
    }
    cue(key, e ? playSound(e.kind, e.runs) : null)
  }

  const presenter: ReplayPresenter = {
    async playFrame(frame: ReplayFrame, ctx: FrameContext): Promise<void> {
      const { signal } = ctx
      const scale = opts.timeScale ?? 1
      // 直播：這一段動畫縮放到時間預算裡（最多放慢一點點，不會拖過預算）；挑戰賽：照速度
      const natural = ctx.phase === 'prelude' ? preludeMs(frame) : ctx.phase === 'reveal' ? revealMs(frame) : preludeMs(frame) + revealMs(frame)
      const k = () => (ctx.budgetMs !== undefined ? scale * Math.min(1.3, ctx.budgetMs / Math.max(1, natural)) : scale / (ctx.speed() * (frame.important ? 1 : ROUTINE_SPEEDUP)))
      if (ctx.phase !== 'reveal') await prelude(frame, ctx, k)
      if (ctx.phase !== 'prelude') await reveal(frame, ctx, k)
      if (signal.aborted || closed) throw abortErr()
      // 直播：狀態由播放器提交（揭曉時已經顯示）
      if (ctx.presentOnly) return
      // 一格結束：對齊這一步之後的模擬狀態
      const after = frame.after
      theStage.setColors((after.battingSide === 'home' ? 'away' : 'home') === userSide())
      if (!after.over && theStage.alignment !== after.alignment) void theStage.align(after.alignment, 450 * k())
      theStage.sync(after.bases, after.over ? null : after.batterId)
      renderBoard(after)
    },
    show: showState,
    commit: commitState,
  }

  // ---- 球場縮放 ----

  if (typeof ResizeObserver !== 'undefined') {
    let width = fieldBox.clientWidth
    const ro = new ResizeObserver(() => {
      if (closed || fieldBox.clientWidth === width || fieldBox.clientWidth === 0) return
      width = fieldBox.clientWidth
      // 中斷這一格（不推進）、重畫目前狀態，播放中的話接著播
      if (livePlayer) {
        const wasLive = livePlayer.view.status === 'live'
        if (wasLive) livePlayer.pause()
        theStage.resize()
        showState(livePlayer.view.state, livePlayer.view.position)
        if (wasLive) livePlayer.resume()
      } else if (replayPlayer) {
        const wasPlaying = replayPlayer.view.status === 'playing'
        if (wasPlaying) replayPlayer.pause()
        theStage.resize()
        showState(replayPlayer.view.state, replayPlayer.view.position)
        if (wasPlaying) replayPlayer.resume()
      }
    })
    ro.observe(fieldBox)
    cleanups.push(() => ro.disconnect())
  }

  if (opts.mode === 'live') setupLive(opts)
  else setupChallenge(opts)
  return handle

  // ---- 直播 ----

  function setupLive(o: LiveViewerOptions): void {
    const toggle = el('button', 'v2-replay-toggle')
    toggle.type = 'button'
    toggle.dataset.action = 'live-toggle'
    const toggleLabel = el('span', '')
    const toggleIcon = el('span', 'v2-toggle-ico')
    toggle.append(toggleIcon, toggleLabel)
    const note = el('span', 'v2-live-note', V2T.livePauseNote)
    const remain = el('span', 'v2-live-remain')
    // 比賽結束：結果面板疊在球場上，「觀看下一場」是唯一的黃色按鈕，旁邊是「離開」
    const nextBtn = el('button', 'btn-yellow v2-live-next', V2T.liveWatchNext)
    nextBtn.type = 'button'
    nextBtn.dataset.action = 'live-next'
    nextBtn.hidden = true
    const leave = el('button', 'btn-white v2-final-leave', V2T.liveLeave)
    leave.type = 'button'
    leave.onclick = close
    const finalButtons = el('div', 'v2-final-buttons')
    finalButtons.append(leave, nextBtn)
    controls.append(toggle, note, remain)
    pausedPanel.append(el('strong', '', V2T.livePaused), el('span', '', V2T.livePausedHint))

    let unsubscribe = () => {}
    /** 剩餘時間：只看真實時間，跟畫面暫停無關 */
    const tick = () => {
      if (closed || !livePlayer) return
      const v = livePlayer.view
      const now = o.clock.now()
      remain.textContent = now < v.startsAt ? V2T.liveStartsIn(fmtClock(v.startsAt - now)) : now < v.endsAt ? V2T.liveRemaining(fmtClock(v.endsAt - now)) : V2T.liveSettling
    }
    const render = (v: LiveView) => {
      if (closed) return
      screen.dataset.status = v.status
      screen.dataset.position = `${v.position}/${v.total}`
      toggleLabel.textContent = v.status === 'paused' ? V2T.liveResume : V2T.livePause
      toggleIcon.innerHTML = iconSvg(v.status === 'paused' ? 'play' : 'pause', 16)
      toggle.classList.toggle('resume', v.status === 'paused')
      note.hidden = v.status === 'paused' || v.status === 'ended'
      if (!finalExtra.contains(finalButtons)) finalExtra.append(finalButtons)
      toggle.hidden = v.status === 'ended' || v.status === 'error'
      pausedPanel.hidden = v.status !== 'paused'
      nextBtn.hidden = v.status !== 'ended' || !o.next
      badge.textContent = v.status === 'waiting' ? V2T.liveUpcoming : v.status === 'ended' ? V2T.liveEnded : V2T.liveBadge
      badge.className = `v2-live-badge ${v.status}`
      if (v.status === 'ended') lastPlay.textContent = V2T.liveEndedLine(v.state.winner === userSide(), v.state.inning)
      if (v.status === 'error') lastPlay.textContent = V2T.replayErrorTitle
      tick()
    }
    const mount = (source: LiveSource) => {
      unsubscribe()
      livePlayer?.dispose()
      timeline = source.timeline
      log.replaceChildren()
      lastPlay.textContent = ''
      finalPanel.hidden = true
      const player = new LivePlayer(source, presenter, o.clock)
      livePlayer = player
      unsubscribe = player.subscribe(render)
      player.start()
    }
    const interval = setInterval(tick, 1000)
    cleanups.push(() => clearInterval(interval))
    cleanups.push(() => unsubscribe())

    toggle.onclick = () => {
      if (!livePlayer) return
      if (livePlayer.view.status === 'paused') livePlayer.resume()
      else livePlayer.pause()
    }
    nextBtn.onclick = async () => {
      if (!o.next) return
      nextBtn.disabled = true
      const next = await o.next().catch(() => null)
      if (closed) return
      nextBtn.disabled = false
      if (!next) return
      title.textContent = next.title
      mount(next.source)
    }
    // 背景化：自己的畫面先停住（比賽照走）；回到前景時同步到當下的進度
    let hiddenPaused = false
    const onVisibility = () => {
      if (!livePlayer) return
      if (document.hidden) {
        if (livePlayer.view.status === 'live' || livePlayer.view.status === 'waiting') {
          livePlayer.pause()
          hiddenPaused = true
        }
      } else if (hiddenPaused) {
        hiddenPaused = false
        livePlayer.resume()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
    setKeys({ Space: () => toggle.click(), Escape: close })
    mount(o.source)
  }

  // ---- 晉級挑戰賽（結果已經確定，不先揭曉） ----

  function setupChallenge(o: ChallengeViewerOptions): void {
    const toggle = el('button', 'btn-yellow v2-replay-toggle')
    toggle.type = 'button'
    toggle.dataset.action = 'replay-toggle'
    const speedGroup = el('div', 'speed-toggle v2-replay-speed')
    speedGroup.setAttribute('role', 'group')
    speedGroup.setAttribute('aria-label', V2T.replaySpeed)
    const speedBtns = REPLAY_SPEEDS.map((s) => {
      const b = el('button', '', `${s}×`)
      b.type = 'button'
      b.dataset.speed = String(s)
      b.onclick = () => replayPlayer?.setSpeed(s)
      return b
    })
    speedGroup.append(...speedBtns)
    const skip = el('button', 'btn-white v2-replay-skip', V2T.challengeShowResult)
    skip.type = 'button'
    skip.dataset.action = 'replay-skip'
    controls.append(toggle, speedGroup, skip)

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      o.onFinished?.()
    }
    const player = new ReplayPlayer(timeline, presenter)
    replayPlayer = player
    const render = (v: ReplayView) => {
      if (closed) return
      const playing = v.status === 'playing'
      toggle.textContent = playing ? V2T.replayPause : V2T.replayPlay
      toggle.hidden = v.status === 'completed'
      speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(REPLAY_SPEEDS[i] === v.speed)))
      skip.hidden = v.status === 'completed'
      screen.dataset.status = v.status
      screen.dataset.position = `${v.position}/${v.total}`
      if (v.status === 'error' && v.error) lastPlay.textContent = `${V2T.replayErrorTitle}：${v.error.message}`
      if (v.status === 'completed') finish()
    }
    cleanups.push(player.subscribe(render))
    toggle.onclick = () => {
      const s = player.view.status
      if (s === 'playing') player.pause()
      else if (s === 'paused') player.resume()
      else player.play()
    }
    skip.onclick = () => player.skipToEnd()
    const keys: KeyMap = {
      Space: () => toggle.click(),
      Escape: close,
      s: () => player.setSpeed(REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(player.view.speed) + 1) % REPLAY_SPEEDS.length]),
      e: () => player.skipToEnd(),
    }
    setKeys(keys)
    const onVisibility = () => {
      if (document.hidden && player.view.status === 'playing') player.pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
    if (o.autoplay !== false) player.play()
  }
}

function abortErr(): Error {
  const e = new Error('播放被中斷')
  e.name = 'AbortError'
  return e
}

function fmtClock(ms: number): string {
  const secs = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** 球種的投球速度係數（變化球比較慢），沒有球種就是 1 */
function pitchPace(pitch: PitchType | undefined): number {
  return pitch ? PITCH_MOTION[pitch].pace : 1
}
