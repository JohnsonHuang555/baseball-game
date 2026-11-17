// V2 觀戰畫面：播放已經結算的比賽（Read-only Replay）。
//
// - 只在玩家按「觀看比賽」時才由 app 動態載入，放置結算、Headless MatchRunner 不會載入任何畫面或 Canvas。
// - 畫面全部由時間軸（application/replayPlayer.ts）驅動：比分、出局、壘上、打者、投手都來自重播的模擬狀態，
//   這裡不抽任何影響結果的亂數（V1 球場的界外球方向是純視覺的隨機，不影響狀態）。
// - 用 V1 的 FieldRenderer、PitchCam、爆炸框大字、全壘打數據卡，節奏與音效規則與 V1 共用（ui/playAnimation.ts）。
// - 完全不碰球團、存檔與 controller：打開時拿到的是一份複製的 Replay，播放過程不寫入任何東西。
// - 生命週期：close() 會停止播放迴圈、取消所有動畫與計時器、移除監聽器、還原鍵盤快捷鍵，之後不再操作 DOM。
import type { Alignment, BattedBall, GameEvent, PitchResult, RunnerMove, Side } from '../../sim/game'
import { homeRunStats } from '../../sim/game'
import type { PitchType } from '../../sim/pitches'
import type { Pitcher } from '../../sim/types'
import { FieldRenderer } from '../../ui/field'
import { basesSvg } from '../../ui/gameScreen'
import { setKeys, type KeyMap } from '../../ui/keys'
import { PITCH_MOTION, PitchCam } from '../../ui/pitchCam'
import { BURST_SVG, HIT_KINDS, MATCH_PACE, OUT_KINDS, ROUTINE_SPEEDUP, pitchSound, playSound } from '../../ui/playAnimation'
import { el } from '../../ui/playerCard'
import { play, soundToggle } from '../../ui/sound'
import { PITCH_TEXT, T, describePlay, homeRunName, runnersText } from '../../ui/strings'
import { CPU_COLOR, USER_COLOR, sideTag } from '../../ui/visual'
import type { MatchReplay } from '../application/matchRunner'
import {
  REPLAY_SPEEDS,
  ReplayError,
  ReplayPlayer,
  abortableWait,
  buildTimeline,
  untilAborted,
  type FrameContext,
  type ReplayExpectation,
  type ReplayFrame,
  type ReplayPresenter,
  type ReplayState,
  type ReplayTimeline,
  type ReplayView,
} from '../application/replayPlayer'
import { V2T } from './strings'

/**
 * 球場這一層（Canvas 動畫）。正式版包住 V1 的 FieldRenderer 與 PitchCam；
 * 測試環境沒有 Canvas，可以換成立即完成的假實作
 */
export interface ReplayStage {
  /** 放進球場框裡的元素（canvas、投球視角小窗） */
  readonly elements: HTMLElement[]
  setColors(userFielding: boolean): void
  align(alignment: Alignment, ms: number): Promise<void>
  sync(bases: readonly (string | null)[], batterId: string | null): void
  pitch(result: PitchResult, ms: number, pitch: PitchType | undefined, thrower: Pitcher | undefined): Promise<void>
  play(ball: BattedBall | null, moves: RunnerMove[], caught: boolean, ms: number): Promise<void>
  run(moves: RunnerMove[], ms: number): Promise<void>
  /** 取消所有進行中的動畫 */
  cancel(): void
  resize(): void
  readonly alignment: Alignment
}

/** 正式的球場：V1 的 FieldRenderer + PitchCam */
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
    async pitch(result, ms, pitch, thrower) {
      const f = ensure()
      if (pitch && thrower) await Promise.all([f.pitch(result, ms, pitch, thrower.throws), cam.play(pitch, thrower, result, ms)])
      else await f.pitch(result, ms)
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

export interface ReplayViewerOptions {
  /** 開啟時複製好的 Replay（之後存檔被更新也不影響這一份） */
  replay: MatchReplay
  /** 戰報摘要：用來核對重播結果 */
  expected?: ReplayExpectation
  /** 標題，例如「第 12 場・對手」 */
  title: string
  /** 關閉之後呼叫（回到原本的畫面） */
  onClose?: () => void
  /** 測試用：換掉 Canvas 球場 */
  createStage?: () => ReplayStage
  /** 開啟後自動開始播放（預設 true） */
  autoplay?: boolean
  /** 測試用：所有等待時間乘上這個數字（0 = 不等待） */
  timeScale?: number
}

export interface ReplayViewerHandle {
  close(): void
  /** 時間軸建立失敗時是 null */
  readonly player: ReplayPlayer | null
  readonly root: HTMLElement
}

const SPEED_KEYS: Record<string, number> = { '1': 1, '2': 2, '4': 4 }

/** 打開觀戰畫面（蓋在 V2 畫面上方的子畫面） */
export function openReplayViewer(opts: ReplayViewerOptions): ReplayViewerHandle {
  const overlay = el('div', 'v2-replay-overlay')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', V2T.replayTitle)
  const screen = el('div', 'v2-replay')
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

  // 頂部：返回、標題、音效
  const top = el('div', 'v2-replay-top')
  const back = el('button', 'btn-white v2-replay-back', V2T.replayBack)
  back.type = 'button'
  back.dataset.action = 'replay-back'
  top.append(back, el('h2', 'v2-replay-title', opts.title), soundToggle('sound-btn v2-replay-sound'))
  screen.append(top)

  let player: ReplayPlayer | null = null
  let stage: ReplayStage | null = null
  function close(): void {
    if (closed) return
    closed = true
    player?.dispose()
    stage?.cancel()
    for (const t of timers) clearTimeout(t)
    timers.clear()
    for (const c of cleanups) c()
    setKeys(previousKeys)
    overlay.remove()
    opts.onClose?.()
  }
  back.onclick = close

  let timeline: ReplayTimeline
  try {
    timeline = buildTimeline(opts.replay, opts.expected)
  } catch (e) {
    // 資料損壞、版本不相容：顯示可以理解的錯誤，可以返回；不碰存檔
    const error = e instanceof ReplayError ? e : new ReplayError('corrupt', String(e))
    const box = el('section', 'v2-card v2-replay-error')
    box.setAttribute('role', 'alert')
    box.append(el('h3', '', V2T.replayErrorTitle), el('p', '', V2T.replayErrorText(error.code)), el('p', 'v2-hint', error.message))
    screen.append(box)
    setKeys({ Escape: close })
    return { close, player: null, root: overlay }
  }

  const userSide = timeline.userSide
  const otherSide: Side = userSide === 'home' ? 'away' : 'home'
  const name = (id: string | null) => (id ? (timeline.players.get(id)?.name ?? '?') : '')
  const theStage = (opts.createStage ?? canvasStage)()
  stage = theStage

  // 比分條（沿用 V1 比分條的樣式）
  const board = el('header', 'match-header v2-replay-board')
  // 球場
  const fieldBox = el('section', 'match-field v2-replay-field')
  fieldBox.setAttribute('aria-label', '球場')
  const callout = el('div', 'callout')
  const finalPanel = el('div', 'v2-replay-final')
  finalPanel.hidden = true
  fieldBox.append(...theStage.elements, callout, finalPanel)
  // 打者與投手、最近一球
  const duel = el('div', 'v2-replay-duel')
  const lastPlay = el('p', 'v2-replay-last')
  lastPlay.setAttribute('aria-live', 'polite')
  const log = el('ol', 'v2-replay-log')
  log.setAttribute('aria-label', '比賽紀錄')
  // 控制區
  const controls = el('div', 'v2-replay-controls')
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
    b.onclick = () => player?.setSpeed(s)
    return b
  })
  speedGroup.append(...speedBtns)
  const restart = el('button', 'btn-white v2-replay-restart', V2T.replayRestart)
  restart.type = 'button'
  restart.dataset.action = 'replay-restart'
  const skip = el('button', 'btn-white v2-replay-skip', V2T.replaySkip)
  skip.type = 'button'
  skip.dataset.action = 'replay-skip'
  controls.append(toggle, speedGroup, restart, skip)
  screen.append(board, fieldBox, duel, lastPlay, log, controls)

  // ---- 畫面 ----

  function renderBoard(s: ReplayState, outsOverride?: number): void {
    board.replaceChildren()
    const teams = el('div', 'mh-teams')
    for (const side of ['away', 'home'] as const) {
      const batting = !s.over && s.battingSide === side
      const row = el('div', `mh-team ${batting ? 'batting' : ''}`)
      const nameEl = el('span', 'mh-name', timeline.teamNames[side])
      if (side === userSide) nameEl.append(sideTag(true))
      const score = el('span', 'mh-score', String(s.score[side]))
      score.dataset.score = side === userSide ? 'us' : 'them'
      row.append(el('span', `mh-swatch ${side === userSide ? 'user' : 'opponent'}`), nameEl, score)
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
      const box = el('div', `v2-replay-duel-card ${side === userSide ? 'user' : 'opponent'}`)
      const n = el('strong', '', name(id))
      n.dataset[key] = id ?? ''
      box.append(el('span', 'v2-replay-duel-label', label), n)
      if (side === userSide) box.append(sideTag(true))
      return box
    }
    duel.append(card(V2T.replayBatter, s.batterId, s.battingSide, 'batter'), card(V2T.replayPitcher, s.pitcherId, fielding, 'pitcher'))
  }

  function addLog(text: string, cls = ''): void {
    const li = el('li', cls, text)
    log.prepend(li)
    while (log.children.length > 30) log.lastChild?.remove()
  }

  function flash(label: string, tone: string, topText = ''): void {
    callout.replaceChildren()
    callout.insertAdjacentHTML('afterbegin', BURST_SVG)
    if (topText) callout.append(el('span', 'callout-top', topText))
    callout.append(el('span', 'callout-label', label))
    callout.className = `callout show ${tone}`
    const speed = player?.view.speed ?? 2
    later(() => (callout.className = 'callout'), 1600 / speed)
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
    const speed = player?.view.speed ?? 2
    const shown = 2600 / Math.min(speed, 2)
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
        return (e.side === userSide ? '' : T.opponentPrefix) + fn(name(e.inId), name(e.outId))
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
    fieldBox.querySelector('.hr-stats')?.remove()
  }

  /** 直接把畫面設成某個狀態（跳轉、暫停中斷、比賽結束） */
  function showState(s: ReplayState, position: number): void {
    if (closed) return
    clearEffects()
    theStage.setColors((s.battingSide === 'home' ? 'away' : 'home') === userSide)
    if (theStage.alignment !== s.alignment) void theStage.align(s.alignment, 0)
    theStage.sync(s.bases, s.over ? null : s.batterId)
    renderBoard(s)
    if (position === 0) {
      log.replaceChildren()
      lastPlay.textContent = V2T.replayReady
    }
    finalPanel.hidden = !s.over
    if (s.over) renderFinal(s)
  }

  function renderFinal(s: ReplayState): void {
    const won = s.winner === userSide
    finalPanel.className = `v2-replay-final ${won ? 'won' : 'lost'}`
    finalPanel.replaceChildren(el('strong', 'v2-replay-verdict', won ? V2T.win : V2T.loss), el('span', 'v2-replay-final-score', `${s.score[userSide]} : ${s.score[otherSide]}`), linescore(s))
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
      const row = el('tr', side === userSide ? 'mine' : '')
      row.append(el('td', 'name', timeline.teamNames[side]))
      for (let i = 0; i < innings; i++) row.append(el('td', '', s.linescore[side][i] === undefined ? 'X' : String(s.linescore[side][i])))
      row.append(el('td', 'total', String(s.score[side])), el('td', '', String(s.hits[side])), el('td', '', String(s.errors[side])))
      table.append(row)
    }
    return table
  }

  // ---- 播一格（V1 animate() 的觀戰版：狀態全部來自時間軸） ----

  const presenter: ReplayPresenter = {
    async playFrame(frame: ReplayFrame, ctx: FrameContext): Promise<void> {
      const { signal } = ctx
      const scale = opts.timeScale ?? 1
      const k = () => scale / (ctx.speed() * (frame.important ? 1 : ROUTINE_SPEEDUP))
      const wait = (ms: number) => abortableWait(ms * k(), signal)
      const anim = <T>(p: Promise<T>) => untilAborted(p, signal)
      let thrower = timeline.players.get(frame.throwerId) as Pitcher | undefined
      const shown: ReplayState = structuredClone(ctx.before)
      const endsHalf = frame.events.some((e) => e.type === 'halfInningEnd' || e.type === 'gameOver')
      const lastAction = frame.events.reduce((last, e, j) => (e.type === 'play' || e.type === 'steal' ? j : last), -1)
      /** 打完一球（或盜壘）之後的比分條：得分逐一累加；結束半局時顯示三出局；這一格最後的動作之後就是模擬的狀態 */
      const afterAction = (i: number, runs: number) => {
        shown.score[ctx.before.battingSide] += runs
        shown.balls = 0
        shown.strikes = 0
        if (endsHalf) renderBoard(shown, frame.after.over ? Math.max(frame.after.outs, shown.outs) : 3)
        else if (i === lastAction) renderBoard(frame.after)
        else renderBoard(shown)
      }
      for (const [i, e] of frame.events.entries()) {
        if (signal.aborted || closed) throw new Error('aborted')
        const text = describe(e)
        if (e.type === 'substitution' && e.kind === 'pitcher') thrower = timeline.players.get(e.inId) as Pitcher | undefined
        if (e.type === 'pitch') {
          lastPlay.textContent = PITCH_TEXT[e.result]
          await anim(theStage.pitch(e.result, MATCH_PACE.pitch * k() * pitchPace(e.pitch), e.pitch, thrower))
          play(pitchSound(e, frame.events[i + 1]))
          if (e.result !== 'inPlay') {
            shown.balls = e.balls
            shown.strikes = e.strikes
            renderBoard(shown)
            await wait(MATCH_PACE.afterPitch)
          }
        } else if (e.type === 'play') {
          const ms = (MATCH_PACE.flightBase + (e.ball?.distance ?? 0) * MATCH_PACE.flightPerFoot) * k()
          await anim(theStage.play(e.ball, e.moves, OUT_KINDS.has(e.kind), ms))
          const sound = playSound(e.kind, e.runs)
          if (sound) play(sound)
          if (e.kind === 'homeRun') {
            flash(`${homeRunName(e.runs)}！`, 'hr')
            if (e.ball) showHomeRunStats(e.ball)
          } else if (e.kind === 'strikeout') {
            const prev = frame.events[i - 1]
            const looking = prev?.type === 'pitch' && prev.result === 'calledStrike'
            flash('K', looking ? 'k looking' : 'k', looking ? T.calledStrikeout : T.callStrikeout)
          } else if (e.runs > 0) flash(T.scored(e.runs).replace('，', ''), 'score')
          else if (e.kind === 'doublePlay') flash(T.callDoublePlay, 'dp', e.notation ?? '')
          else if (e.kind === 'error') flash(T.callError, 'error')
          lastPlay.textContent = text
          addLog(text!, e.kind === 'homeRun' ? 'hr' : e.runs > 0 ? 'score' : HIT_KINDS.has(e.kind) ? 'hit' : '')
          afterAction(i, e.runs)
          await wait(MATCH_PACE.afterPlay + (e.kind === 'homeRun' ? MATCH_PACE.homeRunStats : e.kind === 'strikeout' ? MATCH_PACE.strikeout : 0))
        } else if (e.type === 'steal') {
          await anim(theStage.run(e.moves, MATCH_PACE.steal * k()))
          lastPlay.textContent = text
          addLog(text!)
          afterAction(i, 0)
          await wait(MATCH_PACE.afterPlay)
        } else if (text) {
          addLog(text, e.type === 'halfInningEnd' ? 'divider' : e.type === 'substitution' ? 'sub' : '')
          if (e.type === 'substitution') {
            lastPlay.textContent = text
            await wait(MATCH_PACE.afterPlay)
          }
          if (e.type === 'halfInningEnd') {
            lastPlay.textContent = text.replace(/─/g, '').trim()
            await wait(MATCH_PACE.afterHalfInning)
          }
        }
      }
      if (signal.aborted || closed) throw new Error('aborted')
      // 一格結束：對齊這一步之後的模擬狀態
      const after = frame.after
      theStage.setColors((after.battingSide === 'home' ? 'away' : 'home') === userSide)
      if (!after.over && theStage.alignment !== after.alignment) void theStage.align(after.alignment, 450 * k())
      theStage.sync(after.bases, after.over ? null : after.batterId)
      renderBoard(after)
    },
    show: showState,
  }

  // ---- 控制 ----

  function renderControls(v: ReplayView): void {
    const playing = v.status === 'playing'
    toggle.textContent = playing ? V2T.replayPause : v.status === 'completed' ? V2T.replayAgain : V2T.replayPlay
    toggle.setAttribute('aria-pressed', String(playing))
    toggle.dataset.status = v.status
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(REPLAY_SPEEDS[i] === v.speed)))
    skip.disabled = v.status === 'completed'
    screen.dataset.status = v.status
    screen.dataset.position = `${v.position}/${v.total}`
  }

  const togglePlay = () => {
    if (!player) return
    const s = player.view.status
    if (s === 'playing') player.pause()
    else if (s === 'paused') player.resume()
    else if (s === 'completed') player.restart()
    else player.play()
  }
  toggle.onclick = togglePlay
  restart.onclick = () => player?.restart()
  skip.onclick = () => player?.skipToEnd()

  // 先把畫面放進 DOM（球場量得到寬度）再建立播放器
  player = new ReplayPlayer(timeline, presenter)
  const unsubscribe = player.subscribe((v) => {
    if (closed) return
    renderControls(v)
    if (v.status === 'error' && v.error) lastPlay.textContent = `${V2T.replayErrorTitle}：${v.error.message}`
  })
  cleanups.push(unsubscribe)

  const keys: KeyMap = {
    Space: togglePlay,
    Escape: close,
    s: () => {
      if (!player) return
      const i = REPLAY_SPEEDS.indexOf(player.view.speed)
      player.setSpeed(REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length])
    },
    e: () => player?.skipToEnd(),
  }
  for (const [key, s] of Object.entries(SPEED_KEYS)) keys[key] = () => player?.setSpeed(s as 1 | 2 | 4)
  setKeys(keys)

  // 背景化：暫停播放（不自動恢復），不在看不到的時候跑 Canvas 動畫
  const onVisibility = () => {
    if (document.hidden && player?.view.status === 'playing') player.pause()
  }
  document.addEventListener('visibilitychange', onVisibility)
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))

  // 球場跟著寬度縮放：中斷這一格（不推進）、重畫目前狀態，播放中的話接著播
  if (typeof ResizeObserver !== 'undefined') {
    let width = fieldBox.clientWidth
    const ro = new ResizeObserver(() => {
      if (closed || fieldBox.clientWidth === width || fieldBox.clientWidth === 0) return
      width = fieldBox.clientWidth
      const wasPlaying = player?.view.status === 'playing'
      if (wasPlaying) player!.pause()
      theStage.resize()
      if (player) showState(player.view.state, player.view.position)
      if (wasPlaying) player!.resume()
    })
    ro.observe(fieldBox)
    cleanups.push(() => ro.disconnect())
  }

  if (opts.autoplay !== false) player.play()
  return { close, player, root: overlay }
}

/** 球種的投球速度係數（變化球比較慢），沒有球種就是 1 */
function pitchPace(pitch: PitchType | undefined): number {
  return pitch ? PITCH_MOTION[pitch].pace : 1
}
