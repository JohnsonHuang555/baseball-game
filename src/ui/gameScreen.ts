import { Game, LEVERAGE_THRESHOLD, type GameEvent, type Side, type Tactic } from '../sim/game'
import type { Team } from '../sim/types'
import { FieldRenderer } from './field'
import { el, ratingsText, traitChips } from './playerCard'
import { PITCH_TEXT, PLAY_TEXT, T } from './strings'
import { randomSeed } from './setupScreen'

const USER_COLOR = '#3b82f6'
const CPU_COLOR = '#ef4444'
const OUT_KINDS = new Set(['groundOut', 'doublePlay', 'flyOut', 'sacrificeFly', 'lineOut', 'buntPopOut', 'sacrificeBunt'])

type SheetReason = 'leverage' | 'fatigue' | 'pause'

/** 選項多於一個時，收進第二層選單 */
const SUBMENU_LABELS: Partial<Record<Tactic['type'], string>> = {
  pinchHit: T.tacticPinchHit,
  pinchRun: T.pinchRunMenu,
  changePitcher: T.tacticChangePitcher,
}

export function showGame(root: HTMLElement, user: Team, opponent: Team, onExit: (again: boolean) => void): void {
  const userSide: Side = 'home'
  const game = new Game({ home: user, away: opponent, seed: randomSeed(), userSide })
  let speed = 1
  let pauseRequested = false
  let offeredPa = -1
  let warnedPitcherId = ''

  root.replaceChildren()
  const screen = el('div', 'screen game')

  const board = el('div', 'scoreboard')
  const canvasWrap = el('div', 'field-wrap')
  const canvas = el('canvas', 'field')
  const callout = el('div', 'callout')
  canvasWrap.append(canvas, callout)
  const matchup = el('div', 'matchup')
  const lastPlay = el('div', 'last-play')
  const controls = el('div', 'controls')
  const pauseBtn = el('button', 'btn btn-primary', `⏸ ${T.command}`)
  pauseBtn.onclick = () => {
    pauseRequested = true
    pauseBtn.disabled = true
  }
  const speedGroup = el('div', 'speed')
  const speedBtns = [1, 2, 4].map((s) => {
    const b = el('button', 'chip', `${s}x`)
    b.onclick = () => {
      speed = s
      speedBtns.forEach((x, i) => x.classList.toggle('active', [1, 2, 4][i] === s))
    }
    return b
  })
  speedBtns[0].classList.add('active')
  speedGroup.append(...speedBtns)
  controls.append(pauseBtn, speedGroup)
  const log = el('ol', 'log')
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
    field.fieldingColor = game.fieldingSide === userSide ? USER_COLOR : CPU_COLOR
    field.battingColor = game.battingSide === userSide ? USER_COLOR : CPU_COLOR
    field.sync(
      game.bases.map((b) => b?.id ?? null),
      game.over ? null : game.batter.id,
    )
  }

  function renderBoard(): void {
    board.replaceChildren()
    const teamRow = (side: Side) => {
      const row = el('div', `team-row ${side === userSide ? 'mine' : ''}`)
      const batting = !game.over && game.battingSide === side
      row.append(
        el('span', 'team-name', `${batting ? '▸ ' : ''}${game.teams[side].name}`),
        el('span', 'team-score', String(game.score[side])),
      )
      return row
    }
    const teams = el('div', 'teams')
    teams.append(teamRow('away'), teamRow('home'))
    const state = el('div', 'state')
    state.append(el('div', 'inning', T.inning(game.inning, game.half === 'top')))
    const count = el('div', 'count')
    const dots = (label: string, n: number, max: number, cls: string) => {
      const row = el('div', 'count-row')
      row.append(el('span', 'count-label', label))
      for (let i = 0; i < max; i++) row.append(el('span', `count-dot ${i < n ? cls : ''}`))
      return row
    }
    count.append(dots('B', game.balls, 3, 'on-ball'), dots('S', game.strikes, 2, 'on-strike'), dots('O', game.outs, 2, 'on-out'))
    state.append(count)
    board.append(teams, state)

    matchup.replaceChildren()
    if (game.over) return
    const b = game.batter
    const p = game.pitcher
    const tired = game.isFatigued(game.fielding)
    const side = (label: string, n: string, stats: string, extra: string, mine: boolean) => {
      const box = el('div', `mu ${mine ? 'mine' : ''}`)
      box.append(el('div', 'mu-label', label), el('div', 'mu-name', n), el('div', 'mu-stats', stats))
      if (extra) box.append(el('div', `mu-extra ${tired ? 'warn' : ''}`, extra))
      return box
    }
    const bBox = side(T.batter, b.name, ratingsText(b), '', game.battingSide === userSide)
    if (b.traits.length) bBox.append(traitChips(b))
    const pBox = side(
      T.pitcher,
      p.name,
      ratingsText(p),
      `${T.pitchCount(game.fielding.pitchCount)}${tired ? `・${T.tired}` : ''}`,
      game.fieldingSide === userSide,
    )
    if (p.traits.length) pBox.append(traitChips(p))
    matchup.append(bBox, pBox)
  }

  function describe(e: GameEvent): string | null {
    switch (e.type) {
      case 'play':
        return `${name(e.batterId)} ${PLAY_TEXT[e.kind]}${e.runs ? T.scored(e.runs) : ''}`
      case 'steal':
        return `${name(e.runnerId)} ${T.stealResult(e.success)}`
      case 'substitution': {
        const fn = e.kind === 'pinchHit' ? T.subPinchHit : e.kind === 'pinchRun' ? T.subPinchRun : T.subPitcher
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
    const li = el('li', cls, text)
    log.prepend(li)
    while (log.children.length > 40) log.lastChild?.remove()
  }

  function flash(text: string, cls: string): void {
    callout.textContent = text
    callout.className = `callout show ${cls}`
    window.setTimeout(() => (callout.className = 'callout'), 1200 / speed)
  }

  async function animate(events: GameEvent[], important: boolean): Promise<void> {
    // 關鍵時刻放慢，平常快轉
    const k = 1 / (speed * (important ? 1 : 2.2))
    for (const e of events) {
      const text = describe(e)
      if (e.type === 'pitch') {
        lastPlay.textContent = PITCH_TEXT[e.result]
        await field.pitch(e.result, 420 * k)
      } else if (e.type === 'play') {
        const caught = OUT_KINDS.has(e.kind)
        const ms = e.ball ? (500 + e.ball.distance * 2.2) * k : 500 * k
        await field.play(e.ball, e.moves, caught, ms)
        const cls = e.kind === 'homeRun' ? 'hr' : e.runs > 0 ? 'score' : ''
        if (e.kind === 'homeRun') flash(PLAY_TEXT.homeRun, 'hr')
        else if (e.runs > 0) flash(T.scored(e.runs).replace('，', ''), 'score')
        lastPlay.textContent = text
        addLog(text!, cls)
      } else if (e.type === 'steal') {
        await field.run(e.moves, 500 * k)
        lastPlay.textContent = text
        addLog(text!)
      } else if (text) {
        addLog(text, e.type === 'halfInningEnd' ? 'divider' : '')
      }
    }
    syncField()
    renderBoard()
  }

  function tacticLabel(t: Tactic): string {
    const b = game.batting
    switch (t.type) {
      case 'steal': {
        const r = game.bases[t.from - 1]!
        return T.tacticSteal(t.from, r.name, r.ratings.speed)
      }
      case 'bunt':
        return T.tacticBunt
      case 'hitAndRun':
        return T.tacticHitAndRun
      case 'pinchHit': {
        const p = b.bench[t.benchIndex]
        return `${T.tacticPinchHit}：${p.name}（${ratingsText(p)}）`
      }
      case 'pinchRun': {
        const p = b.bench[t.benchIndex]
        return `${T.tacticPinchRun(t.base, game.bases[t.base - 1]!.name)} → ${p.name}（速 ${p.ratings.speed}）`
      }
      case 'changePitcher': {
        const p = game.fielding.relievers[t.relieverIndex]
        return `${T.tacticChangePitcher}：${p.name}（${ratingsText(p)}）`
      }
      case 'intentionalWalk':
        return T.tacticIntentionalWalk
    }
  }

  function openSheet(reason: SheetReason): Promise<void> {
    return new Promise((resolve) => {
      let submenu: Tactic['type'] | null = null
      const close = () => {
        sheet.classList.add('hidden')
        resolve()
      }
      const render = () => {
        sheet.replaceChildren()
        const panel = el('div', 'sheet-panel')
        const title = reason === 'leverage' ? T.reasonLeverage : reason === 'fatigue' ? T.reasonFatigue : T.reasonPause
        panel.append(el('h2', '', title))
        const runners = ([1, 2, 3] as const).filter((n) => game.bases[n - 1]).map((n) => T.baseName(n))
        panel.append(
          el(
            'div',
            'situation',
            `${T.inning(game.inning, game.half === 'top')}・${T.outs(game.outs)}・${runners.length ? runners.join('、') + '壘有人' : T.runnersNone}・${game.score.away}:${game.score.home}`,
          ),
        )
        if (game.queued) panel.append(el('div', 'queued', T.queued(tacticLabel(game.queued))))

        const tactics = game.over ? [] : game.availableTactics()
        const optionButton = (t: Tactic) => {
          const btn = el('button', 'btn btn-option', tacticLabel(t))
          btn.onclick = async () => {
            submenu = null
            const events = game.issue(t)
            if (t.type === 'steal' || t.type === 'bunt' || t.type === 'hitAndRun') return close()
            sheet.classList.add('hidden')
            await animate(events, true)
            if (game.over || t.type === 'intentionalWalk') return close()
            sheet.classList.remove('hidden')
            render()
          }
          return btn
        }

        if (submenu) {
          // 第二層：只列出這一類的選項
          const type = submenu
          panel.append(el('h3', '', SUBMENU_LABELS[type]))
          for (const t of tactics.filter((x) => x.type === type)) panel.append(optionButton(t))
          const back = el('button', 'btn btn-ghost', `‹ ${T.back}`)
          back.onclick = () => {
            submenu = null
            render()
          }
          panel.append(back)
        } else {
          const groups: [string, Tactic['type'][]][] = [
            [T.groupOffense, ['steal', 'bunt', 'hitAndRun']],
            [T.groupSubs, ['pinchHit', 'pinchRun']],
            [T.groupDefense, ['changePitcher', 'intentionalWalk']],
          ]
          for (const [label, types] of groups) {
            const list = tactics.filter((t) => types.includes(t.type))
            if (!list.length) continue
            panel.append(el('h3', '', label))
            for (const type of types) {
              const ofType = list.filter((t) => t.type === type)
              if (ofType.length === 0) continue
              if (ofType.length === 1 || !(type in SUBMENU_LABELS)) {
                ofType.forEach((t) => panel.append(optionButton(t)))
                continue
              }
              const open = el('button', 'btn btn-option', `${SUBMENU_LABELS[type]}…`)
              open.onclick = () => {
                submenu = type
                render()
              }
              panel.append(open)
            }
          }
        }
        const resume = el('button', 'btn btn-primary', `▶ ${T.resume}`)
        resume.onclick = close
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
        const reasons = game.decisionReasons()
        const fatigue = reasons.includes('fatigue') && warnedPitcherId !== game.pitcher.id
        const leverage = reasons.includes('leverage') && offeredPa !== game.paIndex
        if (fatigue || leverage) {
          if (fatigue) warnedPitcherId = game.pitcher.id
          offeredPa = game.paIndex
          await openSheet(fatigue ? 'fatigue' : 'leverage')
          if (game.over) break
        }
      }
      const important = game.leverage() >= LEVERAGE_THRESHOLD
      await animate(game.step(), important)
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
    const again = el('button', 'btn btn-primary', `🎲 ${T.playAgain}`)
    again.onclick = () => onExit(true)
    const home = el('button', 'btn btn-ghost', T.backToTitle)
    home.onclick = () => onExit(false)
    panel.append(again, home)
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
