// 戰術（V2 初版）：只有均衡戰術的三個開關，對應到 CoachParams 的換算在 domain/tactics.ts
import { el } from '../../ui/playerCard'
import { toast } from '../../ui/visual'
import { BASERUNNING_OPTIONS, fromCoachParams, type TacticSettings } from '../domain/tactics'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'

export interface TacticsView {
  render(state: ControllerState): HTMLElement
  sync(state: ControllerState): void
}

export function createTacticsView(controller: ClubController): TacticsView {
  let saved: TacticSettings | null = null
  let draft: TacticSettings | null = null
  let lastState = controller.state
  let container: HTMLElement | null = null
  const dirty = () => JSON.stringify(saved) !== JSON.stringify(draft)

  function sync(state: ControllerState): void {
    if (!state.club) return
    const now = fromCoachParams(state.club.strategy.coach.params)
    if (!saved || !dirty()) draft = { ...now }
    saved = now
  }

  function rerender(): void {
    if (container?.isConnected) container.replaceWith(render(lastState))
  }

  function render(state: ControllerState): HTMLElement {
    lastState = state
    if (!draft) sync(state)
    const page = el('div', 'v2-page v2-tactics')
    container = page
    const d = draft
    if (!d) return page
    const card = el('section', 'v2-card')
    const head = el('div', 'v2-card-head')
    head.append(el('h2', 'v2-card-title', V2T.tacticsTitle), el('span', 'v2-beta', V2T.tacticsBeta))
    card.append(head, el('p', 'v2-hint', V2T.tacticsBetaNote))
    const locked = !state.canWrite || state.saving

    // 跑壘：三檔
    const run = el('fieldset', 'v2-field')
    run.append(el('legend', '', V2T.baserunningLabel))
    const seg = el('div', 'v2-segment')
    for (const option of BASERUNNING_OPTIONS) {
      const b = el('button', 'v2-seg-btn', V2T.baserunningNames[option])
      b.type = 'button'
      b.setAttribute('aria-pressed', String(d.baserunning === option))
      b.disabled = locked
      b.onclick = () => {
        draft = { ...d, baserunning: option }
        rerender()
      }
      seg.append(b)
    }
    run.append(seg, el('p', 'v2-hint', V2T.baserunningDesc[d.baserunning]))

    card.append(run, toggle(V2T.platoonLabel, V2T.platoonDesc, d.latePlatoon, locked, (v) => ((draft = { ...d, latePlatoon: v }), rerender())))
    card.append(toggle(V2T.buntLabel, V2T.buntDesc, d.sacBunt, locked, (v) => ((draft = { ...d, sacBunt: v }), rerender())))

    const bar = el('div', 'v2-savebar')
    bar.append(el('span', 'v2-savebar-status', dirty() ? V2T.unsavedChanges : V2T.tacticsEffective))
    const save = el('button', 'btn-yellow', state.saving ? V2T.saving : V2T.saveTactics)
    save.type = 'button'
    save.disabled = !dirty() || locked
    save.onclick = async () => {
      save.disabled = true
      const res = await controller.saveTactics(d)
      if (res.message) toast(res.message)
      if (res.ok && controller.state.club) {
        saved = fromCoachParams(controller.state.club.strategy.coach.params)
        draft = { ...saved }
        rerender()
      }
    }
    const buttons = el('div', 'v2-savebar-buttons')
    buttons.append(save)
    bar.append(buttons)
    page.append(card, bar)
    return page
  }

  return { render, sync }
}

function toggle(label: string, desc: string, value: boolean, locked: boolean, set: (v: boolean) => void): HTMLElement {
  const box = el('div', 'v2-field v2-toggle-row')
  const text = el('div', 'v2-toggle-text')
  text.append(el('span', 'v2-toggle-label', label), el('span', 'v2-hint', desc))
  const sw = el('button', 'v2-switch')
  sw.type = 'button'
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(value))
  sw.setAttribute('aria-label', label)
  sw.disabled = locked
  sw.append(el('span', 'v2-switch-knob'), el('span', 'v2-switch-text', value ? V2T.on : V2T.off))
  sw.onclick = () => set(!value)
  box.append(text, sw)
  return box
}
