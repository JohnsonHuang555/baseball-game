import { LEVERAGE_THRESHOLD, sameTactic, type Game, type GameEvent, type Side, type Tactic } from '../sim/game'
import type { Batter, Player } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { FieldRenderer } from './field'
import { gradeBadge } from './grades'
import { el, traitChips } from './playerCard'
import { PROMPT_LEVELS, loadPromptLevel, savePromptLevel } from './prefs'
import { PITCH_TEXT, POSITION_NAMES, PROMPT_NAMES, RATING_FULL, T, describePlay, homeRunName, runnersText } from './strings'
import { CPU_COLOR, USER_COLOR, gradeLine, toast } from './visual'

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
}

const OUT_KINDS = new Set(['groundOut', 'doublePlay', 'flyOut', 'sacrificeFly', 'lineOut', 'buntPopOut', 'sacrificeBunt'])

type SheetReason = 'leverage' | 'fatigue' | 'pause'

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

  /** 一列球員資訊：標籤、名字、能力值字母、特性 */
  function infoRow(label: string, p: Player, mine: boolean, extra?: HTMLElement): HTMLElement {
    const row = el('div', `info-row ${mine ? 'mine' : ''}`)
    const head = el('div', 'info-head')
    head.append(el('span', 'info-label', label), el('span', 'info-name', p.name), gradeLine(p))
    row.append(head)
    if (extra) row.append(extra)
    if (p.traits.length) row.append(traitChips(p))
    return row
  }

  function staminaBar(team: typeof game.fielding): HTMLElement {
    const left = game.staminaLeft(team)
    const wrap = el('div', 'stamina')
    const bar = el('div', `bar ${left < 0.25 ? 'low' : ''}`)
    const fill = el('div', 'bar-fill')
    fill.style.width = `${Math.round(left * 100)}%`
    bar.append(fill)
    wrap.append(el('span', 'rating-name', T.stamina), bar, el('span', 'muted', T.pitchCount(team.pitchCount)))
    return wrap
  }

  /** 詳細資訊：打者、投手、壘上跑者、下一棒 */
  function situationInfo(): HTMLElement {
    const wrap = el('div', 'sheet-info')
    const batting = game.battingSide === userSide
    wrap.append(infoRow(T.batter, game.batter, batting), infoRow(T.pitcher, game.pitcher, !batting, staminaBar(game.fielding)))
    for (const base of [1, 2, 3] as const) {
      const runner = game.bases[base - 1]
      if (runner) wrap.append(infoRow(T.runnerOn(base), runner, batting))
    }
    const team = game.batting
    wrap.append(infoRow(T.onDeck, team.lineup[(team.battingIndex + 1) % 9].player, batting))
    return wrap
  }

  /** 小壘包圖：有人的壘包亮起來 */
  function miniDiamond(): HTMLElement {
    const box = el('div', 'mini-diamond')
    const on = (i: number) => (game.bases[i] ? 'on' : '')
    box.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
      <rect class="${on(1)}" x="15" y="3" width="10" height="10" transform="rotate(45 20 8)"/>
      <rect class="${on(2)}" x="3" y="15" width="10" height="10" transform="rotate(45 8 20)"/>
      <rect class="${on(0)}" x="27" y="15" width="10" height="10" transform="rotate(45 32 20)"/>
      <path d="M16 31 L24 31 L24 35 L20 38 L16 35 Z" fill="#e2e8f0"/>
    </svg>`
    return box
  }

  /** 對比：舊值 → 新值，都用字母等級 */
  function compare(label: string, from: number, to: number): HTMLElement {
    const c = el('span', 'compare')
    c.append(el('span', 'rating-name', label), gradeBadge(from, 'sm'), el('span', 'arrow', '→'), gradeBadge(to, 'sm'))
    return c
  }

  const battingValue = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3

  interface KeyOption {
    tactic: Tactic
    title: string
    detail: HTMLElement[]
  }

  /** 這個時刻最有意義的兩三個調度，每個只比一兩個關鍵數字 */
  function keyOptions(tactics: Tactic[]): KeyOption[] {
    const options: KeyOption[] = []
    const has = (t: Tactic) => tactics.some((x) => sameTactic(x, t))
    if (game.battingSide === userSide) {
      const team = game.batting
      const batter = game.batter
      // 代打：板凳裡打擊最好的人，明顯比現任打者強才提
      const bestHit = team.bench.map((p, i) => ({ p, i })).sort((a, b) => battingValue(b.p) - battingValue(a.p))[0]
      if (bestHit && battingValue(bestHit.p) - battingValue(batter) >= 1) {
        options.push({
          tactic: { type: 'pinchHit', benchIndex: bestHit.i },
          title: `${T.tacticPinchHit} ${bestHit.p.name}`,
          detail: [compare(RATING_FULL.contact, batter.ratings.contact, bestHit.p.ratings.contact), compare(RATING_FULL.power, batter.ratings.power, bestHit.p.ratings.power)],
        })
      }
      // 盜壘：成功率夠高才提
      for (const from of [2, 1] as const) {
        const runner = game.bases[from - 1]
        const chance = game.stealChance(from)
        if (runner && has({ type: 'steal', from }) && chance >= 0.6) {
          const s = el('span', 'compare')
          s.append(el('span', 'rating-name', RATING_FULL.speed), gradeBadge(runner.ratings.speed, 'sm'), el('span', 'muted', T.stealChance(Math.round(chance * 100))))
          options.push({ tactic: { type: 'steal', from }, title: T.tacticSteal(from, runner.name), detail: [s] })
        }
      }
      // 代跑：得點圈的慢腳跑者，換成板凳最快的人
      for (const base of [3, 2] as const) {
        const runner = game.bases[base - 1]
        const fastest = team.bench.map((p, i) => ({ p, i })).sort((a, b) => b.p.ratings.speed - a.p.ratings.speed)[0]
        if (runner && fastest && fastest.p.ratings.speed - runner.ratings.speed >= 2) {
          options.push({
            tactic: { type: 'pinchRun', base, benchIndex: fastest.i },
            title: `${T.tacticPinchRun(base, runner.name)} → ${fastest.p.name}`,
            detail: [compare(RATING_FULL.speed, runner.ratings.speed, fastest.p.ratings.speed)],
          })
          break
        }
      }
      // 觸擊：無人出局、打者打擊弱，把跑者送上得點圈
      if (game.outs === 0 && has({ type: 'bunt' }) && !game.bases[2] && batter.ratings.contact <= 5) {
        const s = el('span', 'compare')
        s.append(el('span', 'rating-name', RATING_FULL.contact), gradeBadge(batter.ratings.contact, 'sm'), el('span', 'muted', T.buntChance(Math.round(game.buntChance() * 100))))
        options.push({ tactic: { type: 'bunt' }, title: T.tacticBunt, detail: [s] })
      }
    } else {
      const team = game.fielding
      // 換投：體力快見底時，推薦球威加控球最好的後援
      const best = team.relievers.map((p, i) => ({ p, i })).sort((a, b) => b.p.ratings.stuff + b.p.ratings.control - (a.p.ratings.stuff + a.p.ratings.control))[0]
      const left = game.staminaLeft(team)
      if (best && left < 0.25) {
        const stamina = el('span', 'compare')
        stamina.append(el('span', 'rating-name', T.stamina), el('span', 'pct low', `${Math.round(left * 100)}%`), el('span', 'arrow', '→'), el('span', 'pct', '100%'))
        const grades = el('span', 'compare')
        grades.append(el('span', 'rating-name', `${RATING_FULL.stuff}/${RATING_FULL.control}`), gradeBadge(best.p.ratings.stuff, 'sm'), gradeBadge(best.p.ratings.control, 'sm'))
        options.push({
          tactic: { type: 'changePitcher', relieverIndex: best.i },
          title: `${T.tacticChangePitcher} ${best.p.name}`,
          detail: [stamina, grades],
        })
      }
      // 故意四壞：一壘空著、強打者後面接弱打者
      const lineup = game.batting.lineup
      const next = lineup[(game.batting.battingIndex + 1) % 9].player
      if (has({ type: 'intentionalWalk' }) && !game.bases[0] && battingValue(game.batter) >= 6.5 && battingValue(game.batter) - battingValue(next) >= 2) {
        const c = el('span', 'compare')
        c.append(el('span', 'rating-name', T.batter), gradeBadge(battingValue(game.batter), 'sm'), el('span', 'arrow', '→'), el('span', 'rating-name', T.onDeck), gradeBadge(battingValue(next), 'sm'))
        options.push({ tactic: { type: 'intentionalWalk' }, title: T.tacticIntentionalWalk, detail: [c] })
      }
      // 守備替補：後段領先或平手時守住比分，板凳有守備明顯更好的人才提
      const ahead = game.score[userSide] >= game.score[game.battingSide]
      const top = defensiveSubs(tactics)[0]
      if (game.inning >= 7 && ahead && top && top.gain >= 3) {
        const t = top.tactic
        const out = team.lineup[t.lineupIndex].player
        const sub = team.bench[t.benchIndex]
        options.push({
          tactic: t,
          title: tacticLabel(t),
          detail: [
            compare(RATING_FULL.fielding, out.ratings.fielding, sub.ratings.fielding),
            compare(RATING_FULL.contact, out.ratings.contact, sub.ratings.contact),
          ],
        })
      }
    }
    return options.filter((o) => has(o.tactic)).slice(0, 3)
  }

  /** 守備替補的組合很多，只留下守備有變好的，依提升幅度排序 */
  function defensiveSubs(tactics: Tactic[]) {
    const team = game.fielding
    return tactics
      .flatMap((t) => (t.type === 'defensiveSub' ? [t] : []))
      .map((t) => ({ tactic: t, gain: team.bench[t.benchIndex].ratings.fielding - team.lineup[t.lineupIndex].player.ratings.fielding }))
      .filter((d) => d.gain > 0)
      .sort((a, b) => b.gain - a.gain)
  }

  function tacticLabel(t: Tactic): string {
    const b = game.batting
    switch (t.type) {
      case 'steal':
        return T.tacticSteal(t.from, game.bases[t.from - 1]!.name)
      case 'bunt':
        return T.tacticBunt
      case 'hitAndRun':
        return T.tacticHitAndRun
      case 'pinchHit':
        return `${T.tacticPinchHit} ${b.bench[t.benchIndex].name}`
      case 'pinchRun':
        return `${T.tacticPinchRun(t.base, game.bases[t.base - 1]!.name)} → ${b.bench[t.benchIndex].name}`
      case 'changePitcher':
        return `${T.tacticChangePitcher} ${game.fielding.relievers[t.relieverIndex].name}`
      case 'intentionalWalk':
        return T.tacticIntentionalWalk
      case 'defensiveSub': {
        const spot = game.fielding.lineup[t.lineupIndex]
        return T.tacticDefensiveSub(POSITION_NAMES[spot.position], spot.player.name, game.fielding.bench[t.benchIndex].name)
      }
    }
  }

  /** 指令涉及的球員，其他指令清單裡要顯示他的能力值 */
  function tacticPlayer(t: Tactic): Player | null {
    if (t.type === 'pinchHit' || t.type === 'pinchRun') return game.batting.bench[t.benchIndex]
    if (t.type === 'changePitcher') return game.fielding.relievers[t.relieverIndex]
    if (t.type === 'defensiveSub') return game.fielding.bench[t.benchIndex]
    if (t.type === 'steal') return game.bases[t.from - 1]
    return null
  }

  function openSheet(reason: SheetReason): Promise<void> {
    return new Promise((resolve) => {
      let showOthers = false
      let showDetails = false
      const close = () => {
        sheet.classList.add('hidden')
        resolve()
      }
      const choose = async (t: Tactic) => {
        // 名字要在下指令前取，換人之後打者和投手就變了
        const queuedText = T.queued(tacticLabel(t))
        const walkText = T.walkedIntentionally(game.batter.name)
        const events = game.issue(t)
        opts.onProgress?.(game)
        const sub = events.find((e) => e.type === 'substitution')
        toast(sub ? describe(sub)! : t.type === 'intentionalWalk' ? walkText : queuedText)
        if (t.type === 'steal' || t.type === 'bunt' || t.type === 'hitAndRun') return close()
        sheet.classList.add('hidden')
        await animate(events, true)
        if (game.over || t.type === 'intentionalWalk') return close()
        sheet.classList.remove('hidden')
        render()
      }
      const render = () => {
        sheet.replaceChildren()
        const panel = el('div', 'sheet-panel decision')
        const title = reason === 'leverage' ? T.reasonLeverage : reason === 'fatigue' ? T.reasonFatigue : T.reasonPause

        const top = el('div', 'decision-top')
        const words = el('div', 'grow')
        words.append(
          el('h2', '', title),
          el('div', 'situation', `${T.inning(game.inning, game.half === 'top')}・${T.outs(game.outs)}・${game.score.away} : ${game.score.home}`),
          el('div', 'runners-big', runnersText(game.bases.map(Boolean))),
        )
        top.append(words, miniDiamond())
        panel.append(top)
        if (game.over) {
          const resume = el('button', 'btn btn-primary', T.handToPlayers)
          resume.onclick = close
          panel.append(resume)
          sheet.append(panel)
          return
        }

        // 核心對決：打者對投手，只放字母等級和體力
        const duel = el('div', 'duel')
        const batterBox = el('div', `duel-side ${game.battingSide === userSide ? 'mine' : ''}`)
        batterBox.append(avatar(game.batter.id, sideTeam(game.battingSide)), el('div', 'duel-name', game.batter.name), gradeLine(game.batter))
        const pitcherBox = el('div', `duel-side ${game.fieldingSide === userSide ? 'mine' : ''}`)
        pitcherBox.append(avatar(game.pitcher.id, sideTeam(game.fieldingSide)), el('div', 'duel-name', game.pitcher.name), staminaBar(game.fielding))
        duel.append(batterBox, el('div', 'vs', 'VS'), pitcherBox)
        panel.append(duel)
        if (game.queued) panel.append(el('div', 'queued', T.queued(tacticLabel(game.queued))))

        const tactics = game.availableTactics()
        const keys = keyOptions(tactics)
        if (keys.length === 0) panel.append(el('div', 'hint', T.noKeyOptions))
        for (const k of keys) {
          const btn = el('button', 'key-option')
          const detail = el('div', 'key-detail')
          detail.append(...k.detail)
          btn.append(el('div', 'key-title', k.title), detail)
          btn.onclick = () => choose(k.tactic)
          panel.append(btn)
        }

        const toggles = el('div', 'row')
        const others = el('button', `chip ${showOthers ? 'active' : ''}`, `${T.otherTactics} ${showOthers ? '▴' : '▾'}`)
        others.onclick = () => {
          showOthers = !showOthers
          render()
        }
        const details = el('button', `chip ${showDetails ? 'active' : ''}`, `${T.details} ${showDetails ? '▴' : '▾'}`)
        details.onclick = () => {
          showDetails = !showDetails
          render()
        }
        toggles.append(others, details)
        panel.append(toggles)

        if (showOthers) {
          const list = el('div', 'other-list')
          // 守備替補只列出守備會變好的前三個組合，避免清單太長
          const subs = defensiveSubs(tactics)
            .slice(0, 3)
            .map((d) => d.tactic)
          const others = [...tactics.filter((t) => t.type !== 'defensiveSub'), ...subs]
          for (const t of others.filter((t) => !keys.some((k) => sameTactic(k.tactic, t)))) {
            const btn = el('button', 'btn btn-option')
            btn.append(el('span', '', tacticLabel(t)))
            const who = tacticPlayer(t)
            if (who) btn.append(gradeLine(who))
            btn.onclick = () => choose(t)
            list.append(btn)
          }
          panel.append(list)
        }
        if (showDetails) panel.append(situationInfo())

        const resume = el('button', 'btn btn-primary', T.handToPlayers)
        resume.onclick = () => {
          toast(T.handToPlayers)
          close()
        }
        panel.append(resume)
        sheet.append(panel)
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

  function showResult(): void {
    window.removeEventListener('resize', onResize)
    pauseBtn.disabled = true
    const won = game.winner === userSide
    sheet.replaceChildren()
    const panel = el('div', 'sheet-panel result')
    panel.append(el('h2', won ? 'win' : 'lose', won ? T.win : T.lose))
    panel.append(linescoreTable())
    for (const action of opts.resultActions(game)) {
      const btn = el('button', `btn ${action.primary ? 'btn-primary' : 'btn-ghost'}`, action.label)
      btn.onclick = action.onClick
      panel.append(btn)
    }
    sheet.append(panel)
    sheet.classList.remove('hidden')
  }

  function linescoreTable(): HTMLElement {
    const innings = Math.max(game.linescore.away.length, 9)
    const table = el('table', 'linescore')
    const head = el('tr')
    head.append(el('th'))
    for (let i = 1; i <= innings; i++) head.append(el('th', '', String(i)))
    head.append(el('th', '', 'R'))
    table.append(head)
    for (const side of ['away', 'home'] as const) {
      const row = el('tr', side === userSide ? 'mine' : '')
      row.append(el('td', 'ls-name', game.teams[side].name))
      for (let i = 0; i < innings; i++) {
        const v = game.linescore[side][i]
        row.append(el('td', '', v === undefined ? (i < innings && side === 'home' && game.over ? 'X' : '') : String(v)))
      }
      row.append(el('td', 'ls-total', String(game.score[side])))
      table.append(row)
    }
    return table
  }

  syncField()
  renderBoard()
  void loop()
}
