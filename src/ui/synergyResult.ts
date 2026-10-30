// 比賽結果的羈絆區塊：本場啟動過的羈絆、相關數據、羈絆促成的結果，中途失效的標出局數
import type { AssistKind, Game, Side, SynergyRecord } from '../sim/game'
import { SYNERGY_KEYS, thresholds, type SynergyKey } from '../sim/synergy'
import { el } from './playerCard'
import { SYNERGY_NAMES, T } from './strings'
import { isPositionKey, synergyIcon } from './synergyUi'

const ASSIST_ORDER: readonly AssistKind[] = ['homeRun', 'extraBase', 'hit', 'steal', 'advance', 'avoidK', 'walk', 'doublePlay', 'caughtStealing', 'errorSaved', 'hitSaved']

/** 這一隊在這場啟動過的羈絆，依六個羈絆的固定順序 */
function records(game: Game, side: Side): SynergyRecord[] {
  return SYNERGY_KEYS.flatMap((k) => game.synergyLog[side][k] ?? [])
}

/** 階級標籤：3 人、5 人（有門檻秘技時照實際門檻），守位羈絆寫成立 */
function tierLabel(game: Game, side: Side, r: SynergyRecord): string {
  if (isPositionKey(r.key)) return T.positionOn
  const [low, high] = thresholds(r.key, game.teams[side].relics)
  return T.synergyTierLabel(r.peak === 2 ? high : low)
}

/** 跟這個羈絆有關的數據 */
function statLine(game: Game, side: Side, key: SynergyKey): string {
  const s = game.synergyStats[side]
  switch (key) {
    case 'power':
      return T.statPower(s.powerHR, s.powerK)
    case 'speed':
      return T.statSpeed(s.speedSB)
    case 'skill':
      return T.statSkill(s.skillK, s.skillBB)
    case 'defense':
      return T.statDefense(game.errors[side])
    case 'middle':
      return T.statMiddle(s.doublePlays)
    case 'battery':
      return T.statBattery(s.walksAllowed, s.caughtStealing)
  }
}

/** 「羈絆促成：全壘打 1、雙殺 1」；沒有就寫「羈絆促成：無」 */
function assistLine(r: SynergyRecord): string {
  const parts = ASSIST_ORDER.filter((k) => r.assists[k]).map((k) => `${T.assistNames[k]} ${r.assists[k]}`)
  return T.assistSummary(parts.length ? parts.join('、') : T.noSynergyShort)
}

function row(game: Game, side: Side, r: SynergyRecord): HTMLElement {
  const line = el('div', `result-syn-row${r.lostInning !== null ? ' lost' : ''}`)
  const body = el('span', 'result-syn-body')
  const title = el('span', 'result-syn-title')
  title.append(el('span', 'syn-name', SYNERGY_NAMES[r.key]), el('span', 'syn-status on', tierLabel(game, side, r)))
  if (r.lostInning !== null) title.append(el('span', 'result-syn-lost', T.lostAtInning(r.lostInning)))
  const credited = Object.values(r.assists).some((n) => n)
  body.append(title, el('span', 'result-syn-stat', statLine(game, side, r.key)), el('span', `result-syn-assist${credited ? '' : ' none'}${side === game.userSide ? '' : ' opponent'}`, assistLine(r)))
  line.append(synergyIcon(r.key, 32, `syn-icon${r.lostInning !== null ? ' faded' : ''}`), body)
  return line
}

/** 比賽結果的羈絆區塊；舊規則的比賽、雙方都沒有羈絆時回傳 null */
export function synergyResult(game: Game): HTMLElement | null {
  if (!game.synergyOn) return null
  const user = game.userSide
  const opp: Side = user === 'home' ? 'away' : 'home'
  const ours = records(game, user)
  const theirs = records(game, opp)
  if (!ours.length && !theirs.length) return null
  const box = el('section', 'result-synergy')
  box.setAttribute('aria-label', T.synergyTitle)
  const head = el('div', 'result-syn-head')
  head.append(el('h2', 'result-syn-heading', T.synergyTitle), el('span', 'result-syn-sub', T.resultSynergyHint))
  box.append(head)
  if (!ours.length) box.append(el('p', 'syn-note', T.noSynergy))
  for (const r of ours) box.append(row(game, user, r))
  if (theirs.length) {
    // 對手的羈絆收在一行，點開看細節；電腦版預設展開
    const toggle = el('button', 'result-syn-opp')
    toggle.type = 'button'
    toggle.append(el('span', 'result-syn-opp-tag', T.opponentSide), el('span', 'result-syn-opp-text', `${game.teams[opp].name}：${theirs.map((r) => `${SYNERGY_NAMES[r.key]}${isPositionKey(r.key) ? '' : `（${tierLabel(game, opp, r)}）`}`).join('、')}`))
    const list = el('div', 'result-syn-opp-list')
    list.append(...theirs.map((r) => row(game, opp, r)))
    const open = window.matchMedia('(min-width: 1024px)').matches
    list.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.onclick = () => {
      list.hidden = !list.hidden
      toggle.setAttribute('aria-expanded', String(!list.hidden))
    }
    box.append(toggle, list)
  }
  return box
}
