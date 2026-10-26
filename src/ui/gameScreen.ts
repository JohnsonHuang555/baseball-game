import { LEVERAGE_THRESHOLD, type Game, type GameEvent, type Side, type Tactic } from '../sim/game'
import type { Player } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { FieldRenderer } from './field'
import { gradeBadge } from './grades'
import { renderDecisionPanel, type PanelState, type SheetReason } from './decisionPanel'
import { el } from './playerCard'
import { PROMPT_LEVELS, loadPromptLevel, savePromptLevel } from './prefs'
import { PITCH_TEXT, PROMPT_NAMES, T, describePlay, homeRunName, runnersText } from './strings'
import { rays } from './setupScreen'
import { CPU_COLOR, USER_COLOR, toast } from './visual'

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
}

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
  canvasWrap.append(canvas, callout)
  const matchup = el('section', 'match-duel')
  const lastPlay = el('p', 'last-play')
  const controls = el('div', 'match-controls')
  const pauseBtn = el('button', 'btn-yellow pause-btn')
  pauseBtn.innerHTML = PAUSE_ICON
  pauseBtn.append(T.command)
  pauseBtn.onclick = () => {
    pauseRequested = true
    pauseBtn.disabled = true
  }
  const speedGroup = el('div', 'speed-toggle')
  speedGroup.setAttribute('role', 'group')
  speedGroup.setAttribute('aria-label', '速度')
  const speedBtns = [1, 2, 4].map((s) => {
    const b = el('button', '', `${s}x`)
    b.setAttribute('aria-pressed', String(s === speed))
    b.onclick = () => {
      speed = s
      speedBtns.forEach((x, i) => x.setAttribute('aria-pressed', String([1, 2, 4][i] === s)))
    }
    return b
  })
  speedGroup.append(...speedBtns)
  // 決策提示頻率：點一下切換，記在瀏覽器
  const promptBtn = el('button', 'prompt-btn')
  const renderPrompt = () => {
    promptBtn.replaceChildren(el('span', '', T.promptLabel), el('span', '', PROMPT_NAMES[promptLevel]))
  }
  renderPrompt()
  promptBtn.onclick = () => {
    promptLevel = PROMPT_LEVELS[(PROMPT_LEVELS.indexOf(promptLevel) + 1) % PROMPT_LEVELS.length]
    savePromptLevel(promptLevel)
    renderPrompt()
    toast(T.prompts(PROMPT_NAMES[promptLevel]))
  }
  controls.append(pauseBtn, speedGroup, promptBtn)
  const log = el('ol', 'match-log')
  log.setAttribute('aria-label', '比賽紀錄')
  const sheet = el('div', 'sheet hidden')
  screen.append(board, canvasWrap, matchup, lastPlay, controls, log, sheet)
  root.append(screen)

  const field = new FieldRenderer(canvas)
  const onResize = () => {
    field.resize()
    syncField()
  }
  window.addEventListener('resize', onResize)

  const name = (id: string) => game.player(id)?.name ?? '?'

  function syncField(): void {
    const userFielding = game.fieldingSide === userSide
    field.fieldingColor = userFielding ? USER_COLOR : CPU_COLOR
    field.battingColor = userFielding ? CPU_COLOR : USER_COLOR
    field.fieldingStroke = userFielding ? '#FFFFFF' : '#141633'
    field.battingStroke = userFielding ? '#141633' : '#FFFFFF'
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

    matchup.replaceChildren()
    if (game.over) return
    const tired = game.isFatigued(game.fielding)
    const card = (player: Player, s: Side, isPitcher: boolean) => {
      const box = el('div', 'duel-card')
      const info = el('div', 'duel-info')
      const top = el('div', 'duel-top')
      top.append(el('span', 'duel-card-name', player.name))
      if (isPitcher && tired) top.append(el('span', 'tired-tag', T.tiredTag))
      const grades = el('div', 'duel-grades')
      for (const v of Object.values(player.ratings)) grades.append(gradeBadge(v, 'sm'))
      if (isPitcher) grades.append(el('span', `duel-pitches ${tired ? 'warn' : ''}`, T.pitchCount(game.fielding.pitchCount)))
      info.append(top, grades)
      box.append(avatar(player.id, sideTeam(s), `team-ring ${sideTeam(s)}`), info)
      return box
    }
    matchup.append(card(game.batter, game.battingSide, false), card(game.pitcher, game.fieldingSide, true))
  }

  function describe(e: GameEvent): string | null {
    switch (e.type) {
      case 'play': {
        const text = describePlay(e.kind, e.ball, e.runs, e.notation)
        return `${name(e.batterId)} ${text}${e.runs && e.kind !== 'homeRun' ? T.scored(e.runs) : ''}`
      }
      case 'steal':
        return `${name(e.runnerId)} ${T.stealResult(e.success)}`
      case 'substitution': {
        const fn = { pinchHit: T.subPinchHit, pinchRun: T.subPinchRun, pitcher: T.subPitcher, defense: T.subDefense }[e.kind]
        return fn(name(e.inId), name(e.outId))
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
  function flash(label: string, tone: 'hr' | 'score' | 'dp' | 'error', top = ''): void {
    callout.replaceChildren()
    callout.insertAdjacentHTML('afterbegin', BURST_SVG)
    if (top) callout.append(el('span', 'callout-top', top))
    callout.append(el('span', 'callout-label', label))
    callout.className = `callout show ${tone}`
    window.setTimeout(() => (callout.className = 'callout'), 1600 / speed)
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
  }

  async function animate(events: GameEvent[], important: boolean): Promise<void> {
    // 關鍵時刻用正常速度，平常稍微快一點
    const k = 1 / (speed * (important ? 1 : 1.4))
    for (const e of events) {
      const text = describe(e)
      if (e.type === 'pitch') {
        lastPlay.textContent = PITCH_TEXT[e.result]
        await field.pitch(e.result, PACE.pitch * k)
        if (e.result !== 'inPlay') {
          renderBoard()
          await wait(PACE.afterPitch * k)
        }
      } else if (e.type === 'play') {
        const caught = OUT_KINDS.has(e.kind)
        const ms = (PACE.flightBase + (e.ball?.distance ?? 0) * PACE.flightPerFoot) * k
        await field.play(e.ball, e.moves, caught, ms)
        const cls = e.kind === 'homeRun' ? 'hr' : e.runs > 0 ? 'score' : e.kind === 'error' ? 'error' : ''
        if (e.kind === 'homeRun') flash(`${homeRunName(e.runs)}！`, 'hr')
        else if (e.runs > 0) flash(T.scored(e.runs).replace('，', ''), 'score')
        else if (e.kind === 'doublePlay') flash(T.callDoublePlay, 'dp', e.notation ?? '')
        else if (e.kind === 'error') flash(T.callError, 'error')
        lastPlay.textContent = text
        addLog(text!, cls)
        renderBoard()
        await wait(PACE.afterPlay * k)
      } else if (e.type === 'steal') {
        await field.run(e.moves, PACE.steal * k)
        lastPlay.textContent = text
        addLog(text!)
        renderBoard()
        await wait(PACE.afterPlay * k)
      } else if (text) {
        addLog(text, e.type === 'halfInningEnd' ? 'divider' : '')
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
        resolve()
      }
      const handOver = () => {
        toast(T.handToPlayers)
        close()
      }
      const choose = async (t: Tactic) => {
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
        await animate(events, true)
        if (game.over || t.type === 'intentionalWalk') return close()
        sheet.classList.remove('hidden')
        render()
      }
      const render = () => {
        sheet.replaceChildren(renderDecisionPanel(game, reason, state, { choose, handOver, rerender: render }))
      }
      render()
      sheet.classList.remove('hidden')
    })
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
      const important = game.leverage() >= LEVERAGE_THRESHOLD
      const events = game.step()
      opts.onProgress?.(game)
      await animate(events, important)
    }
    showResult()
  }

  /** 比賽結果：全螢幕，大字勝負、雙方比分、每局比分與 R H E */
  function showResult(): void {
    window.removeEventListener('resize', onResize)
    const won = game.winner === userSide
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
      return box
    }
    const scoreline = el('div', 'result-scoreline')
    const nums = el('span', 'result-score')
    nums.append(String(game.score[userSide]), el('span', 'result-colon', ':'), String(game.score[opponentSide]))
    scoreline.append(teamTile(userSide), nums, teamTile(opponentSide))

    const buttons = el('div', 'result-buttons')
    for (const action of opts.resultActions(game)) {
      const btn = el('button', action.primary ? 'btn-yellow btn-big' : 'btn-outline-light btn-wide', action.label)
      btn.onclick = action.onClick
      buttons.append(btn)
    }
    screen.append(head, scoreline, linescoreTable(), buttons)
    root.replaceChildren(screen)
  }

  /** 每局比分：延長賽會多出欄位；九局下沒打顯示 X；最後是 R H E */
  function linescoreTable(): HTMLElement {
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
      row.append(el('td', 'ls-name', game.teams[side].name))
      for (let i = 0; i < innings; i++) {
        const v = game.linescore[side][i]
        row.append(v === undefined ? el('td', 'ls-skip', side === 'home' ? 'X' : '') : el('td', '', String(v)))
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
  void loop()
}
