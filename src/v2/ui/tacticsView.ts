// 戰術（V2 初版）：只有均衡戰術的三個開關，對應到 CoachParams 的換算在 domain/tactics.ts
import { el } from '../../ui/playerCard'
import { toast } from '../../ui/visual'
import { BASERUNNING_OPTIONS, fromCoachParams, type TacticSettings } from '../domain/tactics'
import type { ClubController, ControllerState } from './clubController'
import { V2T } from './strings'
import { barButton, draftBar } from './draftBar'

export interface TacticsView {
  render(state: ControllerState): HTMLElement
  sync(state: ControllerState): void
  hasUnsavedChanges(): boolean
}

export function createTacticsView(controller: ClubController): TacticsView {
  let saved: TacticSettings | null = null
  let draft: TacticSettings | null = null
  /** 草稿建立時的戰術版本：儲存時在鎖內比對 */
  let base: string | null = null
  let lastState = controller.state
  let container: HTMLElement | null = null
  const dirty = () => !!saved && JSON.stringify(saved) !== JSON.stringify(draft)
  const stale = () => dirty() && base !== null && base !== (controller.settingsVersions()?.coach ?? null)

  function resetDraft(now: TacticSettings): void {
    draft = { ...now }
    base = controller.settingsVersions()?.coach ?? null
  }

  function sync(state: ControllerState): void {
    if (!state.club) return
    const now = fromCoachParams(state.club.strategy.coach.params)
    const keep = !!saved && dirty()
    saved = now
    if (!keep) resetDraft(now)
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
    const locked = !state.canWrite || state.saving
    const changed = dirty()

    const head = el('div', 'v2-page-head')
    const titles = el('div', 'v2-page-titles')
    const titleRow = el('div', 'v2-page-title-row')
    titleRow.append(el('h2', 'v2-page-title', V2T.tacticsTitle), el('span', 'v2-beta', V2T.tacticsBeta))
    titles.append(titleRow, el('span', 'v2-page-sub', V2T.tacticsBetaNote))
    head.append(titles)

    // 跑壘：三檔分段按鈕；有變更時在原本的設定下面標「目前使用」
    const run = el('section', 'v2-card v2-field')
    run.setAttribute('aria-label', V2T.baserunningLabel)
    run.append(el('h3', 'v2-card-title', V2T.baserunningLabel))
    const seg = el('div', 'v2-segment')
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', V2T.baserunningLabel)
    for (const option of BASERUNNING_OPTIONS) {
      const b = el('button', 'v2-seg-btn', V2T.baserunningNames[option])
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(d.baserunning === option))
      b.dataset.option = option
      if (changed && saved?.baserunning === option) b.append(el('span', 'v2-seg-current', V2T.currentlyUsed))
      b.disabled = locked
      b.onclick = () => {
        draft = { ...d, baserunning: option }
        rerender()
      }
      seg.append(b)
    }
    const desc = el('div', 'v2-seg-desc')
    desc.append(el('strong', '', V2T.baserunningTitle[d.baserunning]))
    const ul = el('ul', 'v2-bullets')
    for (const line of V2T.baserunningLines[d.baserunning]) ul.append(el('li', '', line))
    desc.append(ul)
    run.append(seg, desc)

    const toggles = el('section', 'v2-card v2-toggles')
    toggles.append(
      toggle(V2T.platoonLabel, V2T.platoonDesc, d.latePlatoon, locked, (v) => ((draft = { ...d, latePlatoon: v }), rerender())),
      toggle(V2T.buntLabel, V2T.buntDesc, d.sacBunt, locked, (v) => ((draft = { ...d, sacBunt: v }), rerender())),
    )
    page.append(head, run, toggles, el('p', 'v2-page-hint', V2T.tacticsEffectiveLong), saveBar(state, d))
    return page
  }

  function saveBar(state: ControllerState, d: TacticSettings): HTMLElement {
    const resetToSaved = () => {
      if (saved) resetDraft(saved)
      rerender()
    }
    if (stale()) {
      const load = barButton('btn-yellow', V2T.loadLatest, 'load-latest', resetToSaved)
      load.disabled = state.saving
      return draftBar('stale', V2T.draftStaleTitle, V2T.draftStale, [load])
    }
    if (!dirty()) return draftBar('clean', V2T.tacticsEffective, '', [])
    const reset = barButton('btn-white', V2T.resetDraft, 'reset-draft', resetToSaved, 'undo')
    reset.disabled = state.saving
    const save = barButton('btn-yellow', state.saving ? V2T.saving : V2T.saveTactics, 'save-draft', async () => {
      save.disabled = true
      const res = await controller.saveTactics(d, base ?? '')
      if (res.message) toast(res.message, res.ok ? 'success' : 'error')
      if (res.ok && controller.state.club) {
        saved = fromCoachParams(controller.state.club.strategy.coach.params)
        resetDraft(saved)
      }
      rerender()
    }, 'save')
    save.disabled = !state.canWrite || state.saving
    return draftBar('dirty', V2T.unsavedCount(changes(d)), V2T.savedFromNext, [reset, save])
  }

  /** 草稿跟存檔差幾項 */
  function changes(d: TacticSettings): number {
    if (!saved) return 0
    return (['baserunning', 'latePlatoon', 'sacBunt'] as const).filter((k) => saved![k] !== d[k]).length
  }

  return { render, sync, hasUnsavedChanges: dirty }
}

function toggle(label: string, desc: string, value: boolean, locked: boolean, set: (v: boolean) => void): HTMLElement {
  const box = el('div', 'v2-toggle-row')
  const text = el('div', 'v2-toggle-text')
  text.append(el('span', 'v2-toggle-label', label), el('span', 'v2-toggle-desc', desc))
  const sw = el('button', 'v2-switch')
  sw.type = 'button'
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(value))
  sw.setAttribute('aria-label', label)
  sw.disabled = locked
  sw.append(el('span', 'v2-switch-knob'))
  sw.onclick = () => set(!value)
  box.append(text, sw)
  return box
}
