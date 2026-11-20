// 戰術（Phase 9 PR 2）：四張球隊風格卡片＋推薦戰術＋收合的進階設定。對應到 CoachParams 的換算在 domain/tactics.ts。
// 規則：選卡片 → 進階設定換成那個風格的預設；改進階設定 → 標記「自訂」；「恢復預設」→ 換回目前風格的預設。
// 草稿、儲存、取消修改、多分頁版本衝突（在鎖內比對戰術版本）、下一場起生效都沿用原本的機制
import { el } from '../../ui/playerCard'
import { toast } from '../../ui/visual'
import { COACH_STYLES, type CoachStyle } from '../application/autoCoach'
import { resolveRoster } from '../domain/roster'
import { BASERUNNING_OPTIONS, BASERUNNING_STEAL_MIN, baserunningOf, fromCoachSettings, isCustom, presetSettings, type TacticSettings } from '../domain/tactics'
import { recommendStyle, type TacticsAdvice } from '../domain/tacticsAdvice'
import type { ClubController, ControllerState } from './clubController'
import { barButton, draftBar } from './draftBar'
import { icon, type IconName } from './icons'
import { V2T } from './strings'

export interface TacticsView {
  render(state: ControllerState): HTMLElement
  sync(state: ControllerState): void
  hasUnsavedChanges(): boolean
}

export const STYLE_ICON: Record<CoachStyle, IconName> = { balanced: 'styleBalanced', power: 'stylePower', speed: 'styleSpeed', defense: 'styleDefense' }

const FIELDS = ['style', 'stealMin', 'latePlatoon', 'sacBunt'] as const

export function createTacticsView(controller: ClubController): TacticsView {
  let saved: TacticSettings | null = null
  let draft: TacticSettings | null = null
  /** 草稿建立時的戰術版本：儲存時在鎖內比對 */
  let base: string | null = null
  let lastState = controller.state
  let container: HTMLElement | null = null
  /** 進階設定預設收合；展開後重畫也保持展開 */
  let advancedOpen = false
  const dirty = () => !!saved && JSON.stringify(saved) !== JSON.stringify(draft)
  const stale = () => dirty() && base !== null && base !== (controller.settingsVersions()?.coach ?? null)

  function resetDraft(now: TacticSettings): void {
    draft = { ...now }
    base = controller.settingsVersions()?.coach ?? null
  }

  function sync(state: ControllerState): void {
    if (!state.club) return
    const now = fromCoachSettings(state.club.strategy.coach)
    const keep = !!saved && dirty()
    saved = now
    if (!keep) resetDraft(now)
  }

  function rerender(): void {
    if (container?.isConnected) {
      const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.focusKey
      container.replaceWith(render(lastState))
      if (focusKey) container?.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`)?.focus()
    }
  }

  function set(next: TacticSettings): void {
    draft = next
    rerender()
  }

  function render(state: ControllerState): HTMLElement {
    lastState = state
    if (!draft) sync(state)
    const page = el('div', 'v2-page v2-tactics')
    container = page
    const d = draft
    if (!d || !state.club) return page
    const locked = !state.canWrite || state.saving

    const head = el('div', 'v2-page-head')
    const titles = el('div', 'v2-page-titles')
    titles.append(el('h2', 'v2-page-title', V2T.tacticsTitle), el('span', 'v2-page-sub', V2T.tacticsSub))
    head.append(titles)

    const advice = recommendStyle(resolveRoster(state.club))
    page.append(head, adviceCard(advice, d, locked), styleCards(d, locked), advanced(d, locked), el('p', 'v2-page-hint', V2T.tacticsEffectiveLong), saveBar(state, d))
    return page
  }

  // ---- 推薦戰術 ----

  function adviceCard(a: TacticsAdvice, d: TacticSettings, locked: boolean): HTMLElement {
    const box = el('section', 'v2-card v2-advice')
    box.dataset.style = a.style
    box.setAttribute('aria-label', V2T.adviceTitle)
    const top = el('div', 'v2-advice-top')
    const ico = icon(STYLE_ICON[a.style], 28, 'v2-advice-ico')
    const text = el('div', 'v2-advice-text')
    text.append(el('span', 'v2-advice-kicker', V2T.adviceTitle), el('strong', 'v2-advice-style', V2T.adviceStyle(V2T.styleNames[a.style])))
    top.append(ico, text)
    const f = a.facts
    const reason =
      a.reason === 'power'
        ? V2T.adviceReason.power(f.power, f.batting)
        : a.reason === 'speed'
          ? V2T.adviceReason.speed(f.speed, f.batting)
          : a.reason === 'pitching'
            ? V2T.adviceReason.pitching(f.pitching, (f.contact + f.power) / 2)
            : V2T.adviceReason.none
    box.append(top, el('p', 'v2-advice-reason', reason))
    if (d.style === a.style) box.append(el('p', 'v2-advice-same', V2T.adviceSame))
    else {
      const b = el('button', 'btn-white v2-advice-try', V2T.adviceTry(V2T.styleNames[a.style]))
      b.type = 'button'
      b.dataset.action = 'try-advice'
      b.dataset.focusKey = 'try-advice'
      b.disabled = locked
      // 只是幫玩家選卡片（還是要按儲存）；不會自動儲存，也不會改掉玩家已經存好的戰術
      b.onclick = () => set(presetSettings(a.style))
      box.append(b)
    }
    box.append(el('p', 'v2-advice-note', V2T.adviceNote))
    return box
  }

  // ---- 風格卡片 ----

  function styleCards(d: TacticSettings, locked: boolean): HTMLElement {
    const grid = el('div', 'v2-style-grid')
    grid.setAttribute('role', 'radiogroup')
    grid.setAttribute('aria-label', V2T.tacticsTitle)
    for (const style of COACH_STYLES) {
      const selected = d.style === style
      const card = el('button', `v2-style-card${selected ? ' selected' : ''}`)
      card.type = 'button'
      card.dataset.style = style
      card.dataset.focusKey = `style-${style}`
      card.setAttribute('role', 'radio')
      card.setAttribute('aria-checked', String(selected))
      card.disabled = locked
      const head = el('div', 'v2-style-head')
      head.append(icon(STYLE_ICON[style], 26, 'v2-style-ico'), el('strong', 'v2-style-name', V2T.styleNames[style]))
      const badges = el('div', 'v2-style-badges')
      if (selected) badges.append(el('span', 'v2-style-badge on', V2T.styleSelected))
      if (dirty() && saved?.style === style && !selected) badges.append(el('span', 'v2-style-badge used', V2T.styleInUse))
      head.append(badges)
      const dl = el('dl', 'v2-style-facts')
      for (const [label, value, cls] of [
        [V2T.styleFitLabel, V2T.styleFit[style], 'fit'],
        [V2T.styleProsLabel, V2T.stylePros[style], 'pro'],
        [V2T.styleConsLabel, V2T.styleCons[style], 'con'],
      ] as const) {
        const row = el('div', `v2-style-fact ${cls}`)
        row.append(el('dt', '', label), el('dd', '', value))
        dl.append(row)
      }
      card.append(head, el('p', 'v2-style-line', V2T.styleOneLine[style]), dl)
      // 選卡片：進階設定換成那個風格的預設（同一張卡片再點一次不動）
      card.onclick = () => {
        if (d.style !== style) set(presetSettings(style))
      }
      grid.append(card)
    }
    return grid
  }

  // ---- 進階設定（預設收合） ----

  function advanced(d: TacticSettings, locked: boolean): HTMLElement {
    const box = el('details', 'v2-card v2-advanced') as HTMLDetailsElement
    box.open = advancedOpen
    box.ontoggle = () => (advancedOpen = box.open)
    const summary = el('summary', 'v2-advanced-summary')
    const custom = isCustom(d)
    summary.append(el('span', 'v2-advanced-title', V2T.advancedTitle))
    summary.append(el('span', `v2-advanced-state${custom ? ' custom' : ''}`, custom ? V2T.advancedCustom : V2T.advancedPreset(V2T.styleNames[d.style])))
    box.append(summary)

    const body = el('div', 'v2-advanced-body')
    // 跑壘：三檔分段按鈕；有變更時在原本的設定下面標「目前使用」
    const run = el('div', 'v2-field')
    run.append(el('h3', 'v2-card-title', V2T.baserunningLabel))
    const seg = el('div', 'v2-segment')
    seg.setAttribute('role', 'radiogroup')
    seg.setAttribute('aria-label', V2T.baserunningLabel)
    const current = baserunningOf(d.stealMin)
    for (const option of BASERUNNING_OPTIONS) {
      const b = el('button', 'v2-seg-btn', V2T.baserunningNames[option])
      b.type = 'button'
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(current === option))
      b.dataset.option = option
      b.dataset.focusKey = `run-${option}`
      if (dirty() && saved && baserunningOf(saved.stealMin) === option && current !== option) b.append(el('span', 'v2-seg-current', V2T.currentlyUsed))
      b.disabled = locked
      // 點同一檔不改原始值（舊存檔的 0.65 會保留）
      b.onclick = () => {
        if (current !== option) set({ ...d, stealMin: BASERUNNING_STEAL_MIN[option] })
      }
      seg.append(b)
    }
    const desc = el('div', 'v2-seg-desc')
    desc.append(el('strong', '', V2T.baserunningTitle[current]))
    const ul = el('ul', 'v2-bullets')
    for (const line of V2T.baserunningLines[current]) ul.append(el('li', '', line))
    desc.append(ul)
    run.append(seg, desc)

    const toggles = el('div', 'v2-toggles')
    toggles.append(
      toggle(V2T.platoonLabel, V2T.platoonDesc, d.latePlatoon, locked, 'platoon', (v) => set({ ...d, latePlatoon: v })),
      toggle(V2T.buntLabel, V2T.buntDesc, d.sacBunt, locked, 'bunt', (v) => set({ ...d, sacBunt: v })),
    )
    const foot = el('div', 'v2-advanced-foot')
    foot.append(el('span', 'v2-advanced-note', V2T.advancedNote))
    const restore = el('button', 'btn-white v2-restore', V2T.restoreDefaults)
    restore.type = 'button'
    restore.dataset.action = 'restore-defaults'
    restore.dataset.focusKey = 'restore-defaults'
    restore.disabled = locked || !custom
    restore.onclick = () => set(presetSettings(d.style))
    foot.append(restore)
    body.append(run, toggles, foot)
    box.append(body)
    return box
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
    const save = barButton(
      'btn-yellow',
      state.saving ? V2T.saving : V2T.saveTactics,
      'save-draft',
      async () => {
        save.disabled = true
        const res = await controller.saveTactics(d, base ?? '')
        if (res.message) toast(res.message, res.ok ? 'success' : 'error')
        if (res.ok && controller.state.club) {
          saved = fromCoachSettings(controller.state.club.strategy.coach)
          resetDraft(saved)
        }
        rerender()
      },
      'save',
    )
    save.disabled = !state.canWrite || state.saving
    return draftBar('dirty', V2T.unsavedCount(changes(d)), V2T.savedFromNext, [reset, save])
  }

  /** 草稿跟存檔差幾項（風格、跑壘、後段調度、觸擊） */
  function changes(d: TacticSettings): number {
    if (!saved) return 0
    return FIELDS.filter((k) => saved![k] !== d[k]).length
  }

  return { render, sync, hasUnsavedChanges: dirty }
}

function toggle(label: string, desc: string, value: boolean, locked: boolean, key: string, set: (v: boolean) => void): HTMLElement {
  const box = el('div', 'v2-toggle-row')
  const text = el('div', 'v2-toggle-text')
  text.append(el('span', 'v2-toggle-label', label), el('span', 'v2-toggle-desc', desc))
  const sw = el('button', 'v2-switch')
  sw.type = 'button'
  sw.dataset.focusKey = `switch-${key}`
  sw.dataset.toggle = key
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(value))
  sw.setAttribute('aria-label', label)
  sw.disabled = locked
  sw.append(el('span', 'v2-switch-knob'))
  sw.onclick = () => set(!value)
  box.append(text, sw)
  return box
}
