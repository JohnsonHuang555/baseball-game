import { LEVERAGE_THRESHOLD, homeRunStats, type BattedBall, type Game, type GameEvent, type Side, type Tactic, type TakeOverKind } from '../sim/game'
import type { Player } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { FieldRenderer } from './field'
import { gradeBadge } from './grades'
import { renderDecisionPanel, type PanelState, type SheetReason } from './decisionPanel'
import { kbd, setKeys, type KeyMap } from './keys'
import { aimLabel, runMeter } from './meter'
import { runPitchCall } from './pitchCall'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { play, soundToggle } from './sound'
import { el } from './playerCard'
import { MANUAL_MODES, PROMPT_LEVELS, loadManual, loadPromptLevel, saveManual, savePromptLevel } from './prefs'
import { PITCH_TEXT, PROMPT_NAMES, T, describePlay, homeRunName, runnersText } from './strings'
import { rays } from './setupScreen'
import { CPU_COLOR, USER_COLOR, handChip, pitchChip, sideTag, tendencyChip, toast } from './visual'

export interface ResultAction {
  label: string
  primary?: boolean
  onClick: () => void
}

export interface GameScreenOptions {
  /** 可以是新開的比賽，也可以是重播回中斷點的比賽 */
  game: Game
  /** 計分板上方的小字，例如「錦標賽・八強」 */
  subtitle?: string
  /** 每推進一步或下指令後呼叫，用來存檔 */
  onProgress?: (game: Game) => void
  resultActions: (game: Game) => ResultAction[]
  /** 結果畫面上方的小字；沒給就用 subtitle */
  resultLabel?: string
  /** 結果畫面在比分下面多放的內容（例如成長名單） */
  resultExtra?: (game: Game) => HTMLElement | null
}

const HIT_KINDS = new Set(['single', 'double', 'triple'])
/** 比賽速度選項：0.75x 給想看清楚每一球的人，2x 給想快點打完的人 */
const SPEEDS = [0.75, 1, 2]

const OUT_KINDS = new Set(['groundOut', 'doublePlay', 'flyOut', 'sacrificeFly', 'lineOut', 'buntPopOut', 'sacrificeBunt'])



const PAUSE_ICON =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>'
/** 進攻方標記：用 SVG 三角形，不用 ▶ 字元（部分手機會變成 emoji） */
const BATTING_MARK =
  '<svg class="mh-mark" aria-hidden="true" width="9" height="10" viewBox="0 0 9 10"><path d="M0 0 L9 5 L0 10 Z" fill="currentColor"/></svg>'

/** 大字提示後面的爆炸框 */
const BURST_SVG = (() => {
  const pts: string[] = []
  for (let i = 0; i < 24; i++) {
    const r = i % 2 ? 46 : 74
    const a = (i * Math.PI) / 12
    pts.push(`${(Math.cos(a) * r * 1.5).toFixed(1)},${(Math.sin(a) * r * 0.9).toFixed(1)}`)
  }
  return `<svg class="burst" aria-hidden="true" viewBox="-125 -75 250 150"><polygon points="${pts.join(' ')}"/></svg>`
})()

/** 壘包狀態小菱形：有人的壘亮黃燈 */
export function basesSvg(on: readonly boolean[]): string {
  const fill = (i: number) => (on[i] ? '#FFD23F' : '#FFFFFF')
  return `<svg aria-hidden="true" viewBox="0 0 54 38">
    <rect x="20" y="3" width="14" height="14" rx="2" transform="rotate(45 27 10)" fill="${fill(1)}" stroke="#141633" stroke-width="2"/>
    <rect x="35" y="18" width="14" height="14" rx="2" transform="rotate(45 42 25)" fill="${fill(0)}" stroke="#141633" stroke-width="2"/>
    <rect x="5" y="18" width="14" height="14" rx="2" transform="rotate(45 12 25)" fill="${fill(2)}" stroke="#141633" stroke-width="2"/>
  </svg>`
}

export function showGame(root: HTMLElement, opts: GameScreenOptions): void {
  const { game } = opts
  const userSide = game.userSide
  const sideTeam = (side: Side): AvatarTeam => (side === userSide ? 'user' : 'opponent')
  let promptLevel = loadPromptLevel()
  let speed = 1
  let pauseRequested = false
  let offeredPa = -1
  let warnedPitcherId = ''

  root.replaceChildren()
  const screen = el('div', 'match-screen')
  if (opts.subtitle) screen.append(el('div', 'game-subtitle', opts.subtitle))

  const board = el('header', 'match-header')
  const canvasWrap = el('section', 'match-field')
  canvasWrap.setAttribute('aria-label', '球場')
  const canvas = el('canvas', 'field')
  const callout = el('div', 'callout')
  const sideBanner = el('div', 'field-side')
  // 球場右上角：親自操作開關，打開後每一球都直接跳出計量條
  let manual = loadManual()
  const manualBtn = el('button', 'manual-toggle')
  manualBtn.type = 'button'
  const renderManual = () => {
    manualBtn.setAttribute('aria-pressed', String(manual !== 'off'))
    manualBtn.dataset.mode = manual
    manualBtn.replaceChildren(el('span', '', T.manualLabel), el('b', '', T.manualStates[manual]), kbd('T'))
  }
  renderManual()
  // 關 → 關鍵 → 每球 → 關
  const toggleManual = () => {
    manual = MANUAL_MODES[(MANUAL_MODES.indexOf(manual) + 1) % MANUAL_MODES.length]
    saveManual(manual)
    renderManual()
    toast(T.manualToast[manual])
  }
  /** 「關鍵」模式下已經提示過的打席 */
  let clutchPa = -1
  /** 這一球要不要讓教練親自出手 */
  const wantsTakeOver = (): boolean => {
    if (manual === 'all') return true
    if (manual !== 'clutch' || !game.isClutch()) return false
    // 進入關鍵打席時提示一次
    if (clutchPa !== game.paIndex) {
      clutchPa = game.paIndex
      toast(T.clutchToast)
    }
    return true
  }
  manualBtn.onclick = toggleManual
  canvasWrap.append(canvas, callout, sideBanner, manualBtn)
  const matchup = el('section', 'match-duel')
  const lastPlay = el('p', 'last-play')
  const controls = el('div', 'match-controls')
  const pauseBtn = el('button', 'btn-yellow pause-btn')
  pauseBtn.innerHTML = PAUSE_ICON
  pauseBtn.append(T.command, kbd('SPACE'))
  const requestPause = () => {
    pauseRequested = true
    pauseBtn.disabled = true
  }
  pauseBtn.onclick = requestPause
  const speedGroup = el('div', 'speed-toggle')
  speedGroup.setAttribute('role', 'group')
  speedGroup.setAttribute('aria-label', '速度')
  const setSpeed = (s: number) => {
    speed = s
    speedBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(SPEEDS[i] === s)))
  }
  const speedBtns = SPEEDS.map((s) => {
    const b = el('button', '', `${s}x`)
    b.setAttribute('aria-pressed', String(s === speed))
    b.onclick = () => setSpeed(s)
    return b
  })
  speedGroup.append(...speedBtns)
  // 決策提示頻率：點一下切換，記在瀏覽器
  const promptBtn = el('button', 'prompt-btn')
  const renderPrompt = () => {
    promptBtn.replaceChildren(el('span', '', T.promptLabel), el('span', '', PROMPT_NAMES[promptLevel]), kbd('H'))
  }
  renderPrompt()
  const cyclePrompt = () => {
    promptLevel = PROMPT_LEVELS[(PROMPT_LEVELS.indexOf(promptLevel) + 1) % PROMPT_LEVELS.length]
    savePromptLevel(promptLevel)
    renderPrompt()
    toast(T.prompts(PROMPT_NAMES[promptLevel]))
  }
  promptBtn.onclick = cyclePrompt
  const speedHint = el('span', 'speed-hint desk-only')
  speedHint.append(kbd('S'), T.cycleSpeed)
  const soundBtn = soundToggle()
  controls.append(pauseBtn, speedGroup, promptBtn, soundBtn, speedHint)
  const log = el('ol', 'match-log')
  log.setAttribute('aria-label', '比賽紀錄')
  const sheet = el('div', 'sheet hidden')

  // 電腦版多出來的：頂部完整記分板、左欄打線
  const lines = el('section', 'match-lines desk-only')
  lines.setAttribute('aria-label', '每局比分')
  const lineup = el('section', 'match-lineup desk-only')
  // 手機版這些外框不參與排版（display: contents），電腦版變成左欄、中欄
  const aside = el('div', 'match-aside')
  const logBox = el('section', 'match-log-box')
  logBox.append(el('h2', 'panel-title desk-only', T.logTitle), log)
  aside.append(lineup, logBox)
  const bar = el('div', 'match-bar')
  bar.append(lastPlay, controls)
  const center = el('div', 'match-center')
  center.append(canvasWrap, matchup, bar)
  const top = el('div', 'match-top')
  top.append(lines, board)
  screen.append(top, aside, center, sheet)
  root.append(screen)

  const gameKeys: KeyMap = {
    Space: requestPause,
    s: () => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]),
    h: cyclePrompt,
    m: () => soundBtn.click(),
    t: toggleManual,
  }
  setKeys(gameKeys)

  const field = new FieldRenderer(canvas)
  // 球場跟著欄寬縮放：電腦版打開決策欄時中欄會變窄
  let fieldWidth = canvas.clientWidth
  const onResize = () => {
    // 畫面被換掉時寬度會變 0，不用重畫
    if (canvas.clientWidth === fieldWidth || canvas.clientWidth === 0) return
    fieldWidth = canvas.clientWidth
    field.resize()
    syncField()
  }
  const resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(canvasWrap)

  const name = (id: string) => game.player(id)?.name ?? '?'

  function syncField(): void {
    const userFielding = game.fieldingSide === userSide
    field.fieldingColor = userFielding ? USER_COLOR : CPU_COLOR
    field.battingColor = userFielding ? CPU_COLOR : USER_COLOR
    field.fieldingStroke = userFielding ? '#FFFFFF' : '#141633'
    field.battingStroke = userFielding ? '#141633' : '#FFFFFF'
    // 佈陣變了（打席結束恢復標準、AI 換佈陣）：野手跑到新位置；AI 佈陣時記一筆
    if (field.alignment !== game.alignment) {
      if (!game.over && game.battingSide === userSide && game.alignment !== 'normal') {
        addLog(T.enemyAligned(T.alignmentNames[game.alignment]))
      }
      void field.align(game.alignment, 450)
    }
    field.sync(
      game.bases.map((b) => b?.id ?? null),
      game.over ? null : game.batter.id,
    )
  }

  /** 比分條：兩隊比分、局數、壘包狀態、好壞球與出局燈號 */
  function renderBoard(): void {
    board.replaceChildren()
    const teams = el('div', 'mh-teams')
    for (const side of ['away', 'home'] as const) {
      const batting = !game.over && game.battingSide === side
      const row = el('div', `mh-team ${batting ? 'batting' : ''}`)
      const swatch = el('span', `mh-swatch ${side === userSide ? 'user' : 'opponent'}`)
      const nameEl = el('span', 'mh-name')
      if (batting) nameEl.innerHTML = BATTING_MARK
      nameEl.append(game.teams[side].name)
      if (side === userSide) nameEl.append(sideTag(true))
      row.append(swatch, nameEl, el('span', 'mh-score', String(game.score[side])))
      teams.append(row)
    }
    const inning = el('div', 'mh-inning')
    inning.append(el('span', 'mh-inning-num', String(game.inning)), el('span', 'mh-inning-half', game.half === 'top' ? T.halfTop : T.halfBottom))
    const bases = el('div', 'mh-bases')
    bases.innerHTML = basesSvg(game.bases.map(Boolean))
    bases.setAttribute('role', 'img')
    bases.setAttribute('aria-label', runnersText(game.bases.map(Boolean)))
    const count = el('div', 'mh-count')
    const lights = (label: string, n: number, max: number, cls: string) => {
      count.append(el('span', 'mh-count-label', label))
      for (let i = 0; i < 3; i++) count.append(el('span', i < max ? `mh-light ${i < n ? cls : ''}` : ''))
    }
    lights('B', game.balls, 3, 'on-ball')
    lights('S', game.strikes, 2, 'on-strike')
    lights('O', game.outs, 2, 'on-out')
    board.append(teams, inning, bases, count)
    lines.replaceChildren(linescoreTable(true))
    renderLineup()

    // 球場左上角：我方現在是進攻還是守備
    sideBanner.className = `field-side ${game.battingSide === userSide ? 'batting' : 'fielding'}`
    const aligned = game.alignment === 'normal' ? '' : T.alignmentNames[game.alignment]
    sideBanner.textContent = game.over
      ? ''
      : game.battingSide === userSide
        ? T.weAreBatting + (aligned ? T.vsEnemyAlignment(aligned) : '')
        : T.weAreFielding + (aligned ? ` · ${aligned}` : '')
    sideBanner.hidden = game.over

    matchup.replaceChildren()
    if (game.over) return
    const tired = game.isFatigued(game.fielding)
    const card = (player: Player, s: Side, isPitcher: boolean) => {
      const box = el('div', 'duel-card')
      const info = el('div', 'duel-info')
      const top = el('div', 'duel-top')
      top.append(el('span', 'duel-card-name', player.name), sideTag(s === userSide))
      if (isPitcher && tired) top.append(el('span', 'tired-tag', T.tiredTag))
      const grades = el('div', 'duel-grades')
      for (const v of Object.values(player.ratings)) grades.append(gradeBadge(v, 'sm'))
      if (player.role === 'batter') grades.append(tendencyChip(player.tendency))
      // 打者標出對這位投手是同側（不利）還是對側
      grades.append(handChip(player, !isPitcher && game.platoonOn ? game.matchup() : undefined))
      if (player.role === 'pitcher') grades.append(pitchChip(player))
      if (isPitcher) grades.append(el('span', `duel-pitches ${tired ? 'warn' : ''}`, T.pitchCount(game.fielding.pitchCount)))
      const label = isPitcher ? T.pitcherPitches(game.fielding.pitchCount) : T.batterNth(game.batting.battingIndex + 1)
      if (isPitcher) {
        // 電腦版在等級旁邊多一條體力條
        const left = Math.round(game.staminaLeft(game.fielding) * 100)
        const meter = el('span', `stamina-meter desk-only ${left < 30 ? 'low' : ''}`)
        const fill = el('span', 'stamina-fill')
        fill.style.width = `${left}%`
        meter.append(fill)
        grades.append(meter, el('span', 'stamina-num desk-only', `${left}%`))
      }
      info.append(el('span', 'duel-label desk-only', label), top, grades)
      box.append(avatar(player.id, sideTeam(s), `team-ring ${sideTeam(s)}`), info)
      return box
    }
    matchup.append(card(game.batter, game.battingSide, false), card(game.pitcher, game.fieldingSide, true))
  }

  /** 電腦版左欄：進攻方打線，標出誰在壘上、誰在打擊 */
  function renderLineup(): void {
    lineup.replaceChildren()
    if (game.over) return
    const side = game.battingSide
    const team = game.batting
    const title = el('h2', 'panel-title', T.lineupTitle(team.name))
    title.append(sideTag(side === userSide))
    lineup.append(title)
    team.lineup.forEach((spot, i) => {
      const current = i === team.battingIndex
      const base = game.bases.findIndex((b) => b?.id === spot.player.id)
      const row = el('div', `lineup-row ${current ? 'current' : ''}`)
      row.append(
        el('span', 'lineup-num', String(i + 1)),
        avatar(spot.player.id, sideTeam(side), `team-ring ${sideTeam(side)}`),
        el('span', 'lineup-name', spot.player.name),
      )
      if (current) row.append(el('span', 'lineup-tag at-bat', T.atBat))
      else if (base >= 0) row.append(el('span', `lineup-tag ${sideTeam(side)}`, T.baseNames[base]))
      lineup.append(row)
    })
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
        // 對手的換人前面加「對手」，一眼分得出是誰在調度
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

  function addLog(text: string, cls = ''): void {
    log.querySelector('.latest')?.classList.remove('latest')
    const li = el('li', `${cls} ${cls === 'divider' ? '' : 'latest'}`, text)
    log.prepend(li)
    while (log.children.length > 40) log.lastChild?.remove()
  }

  /** 球場上的爆炸框大字：label 是主要文字，top 是上方的小一行（例如 6-4-3） */
  function flash(label: string, tone: 'hr' | 'score' | 'dp' | 'error' | 'k' | 'k looking', top = ''): void {
    callout.replaceChildren()
    callout.insertAdjacentHTML('afterbegin', BURST_SVG)
    if (top) callout.append(el('span', 'callout-top', top))
    callout.append(el('span', 'callout-label', label))
    callout.className = `callout show ${tone}`
    window.setTimeout(() => (callout.className = 'callout'), 1600 / speed)
  }

  /** 全壘打的擊球數據卡：飛行距離、擊球初速、仰角，蓋在球場下緣 */
  function showHomeRunStats(ball: BattedBall): void {
    const stats = homeRunStats(ball)
    canvasWrap.querySelector('.hr-stats')?.remove()
    const card = el('div', 'hr-stats')
    card.setAttribute('role', 'status')
    const tile = (label: string, value: string, unit: string) => {
      const t = el('div', 'hr-stat')
      const v = el('span', 'hr-stat-value', value)
      v.append(el('span', 'hr-stat-unit', unit))
      t.append(el('span', 'hr-stat-label', label), v)
      return t
    }
    card.append(
      tile(T.hrDistance, T.meters(stats.distanceFt), 'm'),
      tile(T.hrExitVelocity, T.kmh(stats.exitVelocityMph), 'km/h'),
      tile(T.hrLaunchAngle, String(stats.launchAngle), '°'),
    )
    canvasWrap.append(card)
    // 快轉時也至少留一秒多，讓人看得到
    const shown = 2600 / Math.min(speed, 2)
    window.setTimeout(() => card.classList.add('leaving'), shown)
    window.setTimeout(() => card.remove(), shown + 300)
  }

  const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

  /** 1x 時的節奏（毫秒）：動畫本身加上之後的停頓，讓人看得清楚每一球 */
  const PACE = {
    pitch: 600,
    afterPitch: 300,
    flightBase: 650,
    flightPerFoot: 2.6,
    afterPlay: 800,
    steal: 650,
    afterHalfInning: 900,
    homeRunStats: 1400,
    strikeout: 500,
  }

  async function animate(events: GameEvent[], important: boolean): Promise<void> {
    // 關鍵時刻用正常速度，平常稍微快一點
    const k = 1 / (speed * (important ? 1 : 1.4))
    for (const [i, e] of events.entries()) {
      const text = describe(e)
      if (e.type === 'pitch') {
        lastPlay.textContent = PITCH_TEXT[e.result]
        await field.pitch(e.result, PACE.pitch * k)
        // 球到本壘的那一刻發聲：進手套、揮空、擦棒，或打進場內（全壘打更響）
        const next = events[i + 1]
        play(
          e.result === 'inPlay'
            ? next?.type === 'play' && next.kind === 'homeRun'
              ? 'bigCrack'
              : 'crack'
            : e.result === 'foul'
              ? 'foul'
              : e.result === 'swingingStrike'
                ? 'whoosh'
                : 'mitt',
        )
        if (e.result !== 'inPlay') {
          renderBoard()
          await wait(PACE.afterPitch * k)
        }
      } else if (e.type === 'play') {
        const caught = OUT_KINDS.has(e.kind)
        const ms = (PACE.flightBase + (e.ball?.distance ?? 0) * PACE.flightPerFoot) * k
        await field.play(e.ball, e.moves, caught, ms)
        if (e.kind === 'homeRun') play('roar')
        else if (e.kind === 'strikeout') play('strikeout')
        else if (e.runs > 0 || HIT_KINDS.has(e.kind) || e.kind === 'doublePlay') play('cheer')
        const cls = e.kind === 'homeRun' ? 'hr' : e.runs > 0 ? 'score' : e.kind === 'error' ? 'error' : ''
        if (e.kind === 'homeRun') {
          flash(`${homeRunName(e.runs)}！`, 'hr')
          if (e.ball) showHomeRunStats(e.ball)
        } else if (e.kind === 'strikeout') {
          // 三振：大大的 K；站著不動被三振（第三個好球沒揮棒）照記分慣例把 K 反過來
          const prev = events[i - 1]
          const looking = prev?.type === 'pitch' && prev.result === 'calledStrike'
          flash('K', looking ? 'k looking' : 'k', looking ? T.calledStrikeout : T.callStrikeout)
        } else if (e.runs > 0) flash(T.scored(e.runs).replace('，', ''), 'score')
        else if (e.kind === 'doublePlay') flash(T.callDoublePlay, 'dp', e.notation ?? '')
        else if (e.kind === 'error') flash(T.callError, 'error')
        lastPlay.textContent = text
        addLog(text!, cls)
        renderBoard()
        // 全壘打多停一下，讓人看清楚擊球數據
        await wait((PACE.afterPlay + (e.kind === 'homeRun' ? PACE.homeRunStats : e.kind === 'strikeout' ? PACE.strikeout : 0)) * k)
      } else if (e.type === 'steal') {
        await field.run(e.moves, PACE.steal * k)
        lastPlay.textContent = text
        addLog(text!)
        renderBoard()
        await wait(PACE.afterPlay * k)
      } else if (text) {
        addLog(text, e.type === 'halfInningEnd' ? 'divider' : '')
        // 對手換投、派代打：跳提示，玩家下指令前就知道
        if (e.type === 'substitution' && e.side !== userSide) {
          toast(text)
          await wait(PACE.afterPlay * k)
        }
        if (e.type === 'halfInningEnd') await wait(PACE.afterHalfInning * k)
      }
    }
    syncField()
    renderBoard()
  }

  /** 打開決策面板，等教練下完指令或交給球員 */
  function openSheet(reason: SheetReason): Promise<void> {
    return new Promise((resolve) => {
      const state: PanelState = { showOthers: false, showDetails: false, picking: null }
      const close = () => {
        sheet.classList.add('hidden')
        sheet.classList.remove('settled')
        screen.classList.remove('deciding')
        setKeys(gameKeys)
        resolve()
      }
      const handOver = () => {
        toast(T.handToPlayers)
        close()
      }
      const choose = async (t: Tactic) => {
        // 佈陣立刻生效，面板留著，可以接著下其他指令或親自投球
        if (t.type === 'alignment') {
          game.issue(t)
          opts.onProgress?.(game)
          toast(T.aligned(T.alignmentNames[t.alignment]))
          renderBoard()
          render()
          void field.align(t.alignment, 450)
          return
        }
        // 名字要在下指令前取，換人之後打者和投手就變了
        const queuedText = T.queued(T.commandNames[t.type])
        const walkText = T.walkedIntentionally(game.batter.name)
        const events = game.issue(t)
        opts.onProgress?.(game)
        const sub = events.find((e) => e.type === 'substitution')
        toast(sub ? describe(sub)! : t.type === 'intentionalWalk' ? walkText : queuedText)
        state.picking = null
        if (t.type === 'steal' || t.type === 'bunt' || t.type === 'hitAndRun') return close()
        sheet.classList.add('hidden')
        screen.classList.remove('deciding')
        setKeys({})
        await animate(events, true)
        if (game.over || t.type === 'intentionalWalk') return close()
        sheet.classList.remove('hidden')
        screen.classList.add('deciding')
        render()
      }
      const render = () => {
        sheet.replaceChildren(renderDecisionPanel(game, reason, state, { choose, handOver, rerender: render }))
      }
      render()
      sheet.classList.remove('hidden')
      screen.classList.add('deciding')
      play('alert')
      // 滑入動畫只在第一次打開時播；之後重畫（佈陣、展開其他指令）不再重播
      window.setTimeout(() => sheet.classList.add('settled'), 400)
      // 面板滑出後再講解，位置才準
      window.setTimeout(async () => {
        await maybeTutorial('decision', TUTORIAL_STEPS.decision)
        if (game.fieldingSide === userSide) await maybeTutorial('alignment', TUTORIAL_STEPS.alignment)
      }, 350)
    })
  }

  /**
   * 親自出手一球並送出指令；選了「這球交給球員」就什麼都不做，回傳 false。
   * 配球對決：出棒停紅線決定時機與方向，投球是選球種再畫手勢；舊規則的比賽照舊跑計量條
   */
  async function personallyPlay(kind: TakeOverKind): Promise<boolean> {
    if (kind === 'throw') {
      const call = await runPitchCall(canvasWrap, game)
      if (!call) return false
      game.issue({ type: 'throw', pitch: call.pitch, accuracy: call.accuracy })
      opts.onProgress?.(game)
      addLog(T.throwLog(T.pitchNames[call.pitch], T.meterGrades[call.grade]), call.grade === 'perfect' ? 'score' : '')
      return true
    }
    if (kind === 'aimPitch' || !game.pitchMix) {
      const result = await runMeter(canvasWrap, kind, game.meterZone(kind))
      if (!result) return false
      game.issue({ type: kind, timing: result.timing })
      opts.onProgress?.(game)
      addLog(T.meterLog(kind, T.meterGrades[result.grade]), result.grade === 'perfect' ? 'score' : '')
      return true
    }
    const pitch = T.pitchNames[game.nextPitch()]
    const zone = game.meterZone('swing')
    const result = await runMeter(canvasWrap, 'swing', zone, { aimMarks: true })
    if (!result) return false
    game.issue({ type: 'swing', timing: result.timing })
    opts.onProgress?.(game)
    addLog(T.swingLog(T.meterGrades[result.grade], aimLabel(zone, result.timing), pitch), result.grade === 'perfect' ? 'score' : '')
    return true
  }

  async function loop(): Promise<void> {
    while (!game.over) {
      if (pauseRequested) {
        pauseRequested = false
        await openSheet('pause')
        pauseBtn.disabled = false
        if (game.over) break
      } else {
        const reasons = promptLevel === 'off' ? [] : game.decisionReasons(promptLevel === 'many' ? 'many' : 'few')
        const fatigue = reasons.includes('fatigue') && warnedPitcherId !== game.pitcher.id
        const leverage = promptLevel !== 'pitcher' && reasons.includes('leverage') && offeredPa !== game.paIndex
        if (fatigue || leverage) {
          if (fatigue) warnedPitcherId = game.pitcher.id
          offeredPa = game.paIndex
          await openSheet(fatigue ? 'fatigue' : 'leverage')
          if (game.over) break
        }
      }
      // 親自操作：每一球（或關鍵時刻的每一球）投出前直接讓教練出手；已經排了其他戰術的那一球除外。
      // 關鍵時刻也會先跳出指令面板，面板關掉之後才輪到這裡
      const kind = !pauseRequested && game.takeOver() && wantsTakeOver() ? game.takeOver() : null
      if (kind) {
        setKeys({})
        await personallyPlay(kind)
        setKeys(gameKeys)
        if (game.over) break
      }
      const important = game.leverage() >= LEVERAGE_THRESHOLD
      const events = game.step()
      opts.onProgress?.(game)
      await animate(events, important)
    }
    showResult()
  }

  /** 比賽結果：全螢幕，大字勝負、雙方比分、每局比分與 R H E */
  function showResult(): void {
    resizeObserver.disconnect()
    const won = game.winner === userSide
    play(won ? 'win' : 'lose')
    const opponentSide: Side = userSide === 'home' ? 'away' : 'home'
    const screen = el('div', `result-screen ${won ? 'won' : 'lost'}`)
    if (won) screen.insertAdjacentHTML('afterbegin', `<svg class="result-rays" aria-hidden="true" viewBox="-350 -350 700 700">${rays(350)}</svg>`)

    const head = el('div', 'result-head')
    const label = opts.subtitle ?? opts.resultLabel
    if (label) head.append(el('span', 'result-eyebrow', label))
    head.append(el('h1', 'result-title', won ? T.win : T.lose))

    const teamTile = (side: Side) => {
      const box = el('div', `result-team ${side === userSide ? 'user' : 'opponent'}`)
      box.append(el('span', 'result-tile', game.teams[side].name.slice(0, 1)), el('span', 'result-team-name', game.teams[side].name))
      if (side === userSide) box.append(sideTag(true))
      return box
    }
    const scoreline = el('div', 'result-scoreline')
    const nums = el('span', 'result-score')
    nums.append(String(game.score[userSide]), el('span', 'result-colon', ':'), String(game.score[opponentSide]))
    scoreline.append(teamTile(userSide), nums, teamTile(opponentSide))

    // 主要按鈕是 Enter，次要按鈕是 Esc
    const buttons = el('div', 'result-buttons')
    const keys: KeyMap = {}
    for (const action of opts.resultActions(game)) {
      const key = action.primary ? 'Enter' : 'Escape'
      const btn = el('button', action.primary ? 'btn-yellow btn-big' : 'btn-outline-light btn-wide', action.label)
      btn.append(kbd(action.primary ? 'ENTER' : 'ESC'))
      btn.onclick = action.onClick
      keys[key] ??= action.onClick
      buttons.append(btn)
    }
    const inner = el('div', 'result-inner')
    inner.append(head, scoreline, linescoreTable())
    const extra = opts.resultExtra?.(game)
    if (extra) inner.append(extra)
    inner.append(buttons)
    screen.append(inner)
    root.replaceChildren(screen)
    setKeys(keys)
  }

  /** 每局比分：延長賽會多出欄位；九局下沒打顯示 X；最後是 R H E */
  function linescoreTable(live = false): HTMLElement {
    const innings = Math.max(game.linescore.away.length, 9)
    const wrap = el('section', 'linescore-box')
    wrap.setAttribute('aria-label', '每局比分')
    const table = el('table', 'linescore')
    const head = el('tr')
    head.append(el('th'))
    for (let i = 1; i <= innings; i++) head.append(el('th', '', String(i)))
    head.append(el('th', 'ls-gap'), el('th', 'ls-total', 'R'), el('th', 'ls-total', 'H'), el('th', 'ls-total', 'E'))
    table.append(head)
    for (const side of ['away', 'home'] as const) {
      const row = el('tr', side === userSide ? 'mine' : '')
      const nameCell = el('td', 'ls-name')
      if (live) {
        nameCell.append(el('span', `mh-swatch ${sideTeam(side)}`))
        if (!game.over && game.battingSide === side) nameCell.insertAdjacentHTML('beforeend', BATTING_MARK)
      }
      nameCell.append(game.teams[side].name)
      if (side === userSide) nameCell.append(sideTag(true))
      row.append(nameCell)
      for (let i = 0; i < innings; i++) {
        const v = game.linescore[side][i]
        const now = live && !game.over && game.battingSide === side && i === game.inning - 1
        if (now) row.append(el('td', 'ls-live', String(v ?? 0)))
        else if (v === undefined) row.append(el('td', 'ls-skip', side === 'home' && !live ? 'X' : ''))
        else row.append(el('td', '', String(v)))
      }
      row.append(
        el('td', 'ls-gap'),
        el('td', 'ls-total', String(game.score[side])),
        el('td', 'ls-total', String(game.hits[side])),
        el('td', 'ls-total', String(game.errors[side])),
      )
      table.append(row)
    }
    wrap.append(table)
    return wrap
  }

  syncField()
  renderBoard()
  // 第一次進比賽先看教學，看完才開打
  void maybeTutorial('match', TUTORIAL_STEPS.match).then(loop)
}
