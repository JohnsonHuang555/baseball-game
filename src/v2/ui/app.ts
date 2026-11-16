// V2 放置經營的畫面外殼：建立球團、首頁、陣容、戰術、戰報四個分頁與底部導覽。
// 狀態全部在 ClubController；這裡只負責畫出來、接上瀏覽器事件（回到分頁、其他分頁寫入、倒數計時）。
// 倒數只是畫面：每秒用時間錨點重算一次，真正的場次一律由 settleDue 依 Clock 決定
import './v2.css'
import { confirmModal } from '../../ui/modal'
import { el } from '../../ui/playerCard'
import { setKeys } from '../../ui/keys'
import { toast } from '../../ui/visual'
import { CLUB_STORAGE_KEY } from '../infrastructure/clubRepository'
import { createV2Deps, type V2Deps } from '../infrastructure/composition'
import { ClubController, type ControllerState } from './clubController'
import { renderDashboard, updateCountdown } from './dashboardView'
import { createLineupView, type LineupView } from './lineupView'
import { openMatchReport, renderReports, welcomeModal } from './reportView'
import { V2T } from './strings'
import { createTacticsView, type TacticsView } from './tacticsView'
import { createWriterGuard, randomTabId, type StorageEventSource } from './writerGuard'

export type V2Tab = 'home' | 'lineup' | 'tactics' | 'reports'
const TABS: V2Tab[] = ['home', 'lineup', 'tactics', 'reports']
const TAB_LABELS: Record<V2Tab, string> = { home: V2T.navHome, lineup: V2T.navLineup, tactics: V2T.navTactics, reports: V2T.navReports }
const TAB_ICONS: Record<V2Tab, string> = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  lineup: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M15 14.5c3.3-.4 6.5 1.5 6.5 5.5"/>',
  tactics: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  reports: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
}
const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'

export interface V2AppOptions {
  deps?: V2Deps
  /** 瀏覽器事件來源（window）；測試可以換掉 */
  events?: StorageEventSource & Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  tabId?: string
  /** 倒數更新的間隔（毫秒），0 代表不開計時器（測試用） */
  tickMs?: number
  initialTab?: V2Tab
}

export interface V2App {
  controller: ClubController
  show(tab: V2Tab): void
  close(): void
}

export function openV2(root: HTMLElement, onExit: () => void, opts: V2AppOptions = {}): V2App {
  const deps = opts.deps ?? createV2Deps()
  const win = opts.events ?? (globalThis.window as V2AppOptions['events'])
  const doc = opts.doc ?? globalThis.document
  const guard = createWriterGuard({ crossTab: deps.lock.crossTab, storage: deps.storage, events: win, tabId: opts.tabId ?? randomTabId() })
  const controller = new ClubController(deps, guard, win)

  let tab: V2Tab = opts.initialTab ?? 'home'
  let closed = false
  let shownWelcome: string | null = null
  let lineup: LineupView | null = null
  let tactics: TacticsView | null = null
  /** 建立表單裡輸入的名稱：重繪表單（例如建立失敗）時保留，重試不用重打 */
  let draftName = ''

  const screen = el('div', 'v2-screen')
  const header = el('header', 'v2-header')
  const back = el('button', 'icon-btn v2-back')
  back.type = 'button'
  back.innerHTML = BACK_ICON
  back.setAttribute('aria-label', V2T.backToTitle)
  back.onclick = () => void leave()
  const titles = el('div', 'v2-titles')
  const title = el('h1', 'v2-title', V2T.modeTitle)
  const subtitle = el('span', 'v2-subtitle', V2T.modeBadge)
  titles.append(title, subtitle)
  header.append(back, titles)
  const banner = el('div', 'v2-banner-slot')
  const main = el('main', 'v2-main')
  const nav = el('nav', 'v2-nav')
  nav.setAttribute('aria-label', V2T.modeTitle)
  screen.append(header, banner, main, nav)
  root.replaceChildren(screen)
  setKeys({ Escape: () => void leave() })

  function exit(): void {
    close()
    onExit()
  }

  /** 離開 V2：陣容或戰術有未儲存的草稿就先問，不讓草稿無聲消失 */
  async function leave(): Promise<void> {
    if (lineup?.hasUnsavedChanges() || tactics?.hasUnsavedChanges()) {
      const ok = await confirmModal({ title: V2T.leaveUnsavedTitle, message: V2T.leaveUnsavedMessage, confirmLabel: V2T.leaveUnsavedConfirm, danger: true })
      if (!ok || closed) return
    }
    exit()
  }

  function show(next: V2Tab): void {
    tab = next
    main.scrollTop = 0
    render(controller.state)
    globalThis.scrollTo?.(0, 0)
  }

  function renderNav(state: ControllerState): void {
    nav.replaceChildren()
    nav.hidden = state.status.kind !== 'ready'
    for (const id of TABS) {
      const b = el('button', 'v2-nav-btn')
      b.type = 'button'
      b.setAttribute('aria-current', String(id === tab))
      b.dataset.tab = id
      b.innerHTML = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[id]}</svg>`
      b.append(el('span', '', TAB_LABELS[id]))
      b.onclick = () => show(id)
      nav.append(b)
    }
  }

  function renderBanner(state: ControllerState): void {
    banner.replaceChildren()
    if (state.status.kind !== 'ready' && state.status.kind !== 'no-club') return
    if (!state.canWrite) {
      const box = el('div', 'v2-banner warn')
      box.setAttribute('role', 'status')
      const take = el('button', 'btn-small', V2T.takeOver)
      take.type = 'button'
      take.onclick = () => controller.takeOver()
      box.append(el('span', '', V2T.readOnlyBanner), take)
      banner.append(box)
    }
    if (state.error) {
      const box = el('div', 'v2-banner error')
      box.setAttribute('role', 'alert')
      box.append(el('span', '', state.error.message))
      const retry = state.error.retry
      if (retry) {
        const b = el('button', 'btn-small', V2T.retry)
        b.type = 'button'
        b.onclick = () => (retry === 'settle' ? void controller.settle('manual') : void claimWithToast())
        box.append(b)
      }
      banner.append(box)
    }
  }

  async function claimWithToast(): Promise<void> {
    const res = await controller.claim()
    if (!closed && res.message) toast(res.message)
  }

  function render(state: ControllerState): void {
    if (closed) return
    title.textContent = state.club?.clubName ?? V2T.modeTitle
    subtitle.textContent = state.club ? V2T.record(state.club.record.wins, state.club.record.losses) : V2T.modeBadge
    renderBanner(state)
    renderNav(state)
    const s = state.status
    if (s.kind === 'loading') main.replaceChildren(el('p', 'v2-loading', V2T.loading))
    else if (s.kind === 'no-club') main.replaceChildren(createScreen(state))
    else if (s.kind === 'broken') main.replaceChildren(brokenScreen(s.message, s.reason))
    else if (tab === 'home') {
      main.replaceChildren(
        renderDashboard(state, controller, {
          claim: () => void claimWithToast(),
          refresh: () => void controller.settle('manual'),
          openReport: (m) => openMatchReport(m, state.club!),
          allReports: () => show('reports'),
        }),
      )
    } else if (tab === 'lineup') {
      lineup ??= createLineupView(controller)
      main.replaceChildren(lineup.render(state))
    } else if (tab === 'tactics') {
      tactics ??= createTacticsView(controller)
      main.replaceChildren(tactics.render(state))
    } else main.replaceChildren(renderReports(state, (m) => openMatchReport(m, state.club!)))

    if (state.notice) {
      toast(state.notice)
      controller.clearNotice()
    }
    if (state.welcome && state.welcome.key !== shownWelcome) {
      shownWelcome = state.welcome.key
      welcomeModal(state.welcome, () => controller.dismissWelcome())
    }
  }

  /** 建立球團畫面：名稱不能空，建立中按鈕停用，Enter 也能送出 */
  function createScreen(state: ControllerState): HTMLElement {
    const box = el('section', 'v2-card v2-create')
    box.append(el('h2', 'v2-create-title', V2T.createTitle), el('p', 'v2-create-intro', V2T.createIntro))
    const points = el('ul', 'v2-create-points')
    for (const p of V2T.createPoints) points.append(el('li', '', p))
    const form = el('form', 'v2-create-form')
    const label = el('label', 'v2-label', V2T.clubNameLabel)
    const input = el('input', 'v2-input')
    input.id = 'v2-club-name'
    label.htmlFor = input.id
    input.maxLength = 12
    input.placeholder = V2T.clubNamePlaceholder
    input.autocomplete = 'off'
    input.value = draftName
    input.oninput = () => (draftName = input.value)
    const error = el('p', 'v2-form-error', state.createError ?? '')
    error.setAttribute('role', 'alert')
    const submit = el('button', 'btn-yellow btn-big v2-create-btn', state.creating ? V2T.creating : V2T.createButton)
    submit.type = 'submit'
    submit.disabled = state.creating || !state.canWrite
    form.append(label, input, error, submit)
    form.onsubmit = async (e) => {
      e.preventDefault()
      draftName = input.value
      submit.disabled = true
      // 失敗原因放在 controller 的 createError，表單重繪時也會顯示；輸入的名稱保留在 draftName
      const res = await controller.createClub(draftName)
      if (closed) return
      if (res.ok) {
        draftName = ''
        if (res.message) toast(res.message)
      }
    }
    box.append(points, form)
    queueMicrotask(() => {
      if (!input.isConnected) return
      input.focus()
      input.setSelectionRange?.(input.value.length, input.value.length)
    })
    return box
  }

  /** 存檔壞掉、版本不相容、儲存不能用：說明清楚，不自動清除；玩家可以下載備份，確認後才刪除重來 */
  function brokenScreen(message: string, reason: string): HTMLElement {
    const box = el('section', 'v2-card v2-broken')
    box.setAttribute('role', 'alert')
    box.append(el('h2', '', V2T.brokenTitle), el('p', '', message))
    const raw = readRaw(deps)
    if (raw !== null && reason !== 'storage-unavailable') {
      const download = el('button', 'btn-white', V2T.downloadBackup)
      download.type = 'button'
      download.onclick = () => downloadText(`dice-baseball-club-backup-${Date.now()}.json`, raw)
      const reset = el('button', 'btn-danger', V2T.resetBroken)
      reset.type = 'button'
      reset.onclick = async () => {
        const ok = await confirmModal({ title: V2T.resetConfirmTitle, message: V2T.resetConfirmMessage, confirmLabel: V2T.resetConfirm, danger: true })
        if (!ok || closed) return
        const res = await controller.resetClub()
        if (!res.ok && res.message) toast(res.message)
      }
      const buttons = el('div', 'v2-broken-actions')
      buttons.append(download, reset)
      box.append(buttons)
    }
    const backBtn = el('button', 'btn-white', V2T.backToTitle)
    backBtn.type = 'button'
    backBtn.onclick = () => exit()
    box.append(backBtn)
    return box
  }

  // ---- 瀏覽器事件：回到分頁就結算，倒數每秒更新 ----
  const onVisible = () => {
    if (doc?.visibilityState === 'visible') void controller.settle('resume')
  }
  const onFocus = () => void controller.settle('resume')
  doc?.addEventListener('visibilitychange', onVisible)
  win?.addEventListener('focus', onFocus)
  const tickMs = opts.tickMs ?? 1000
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : null
  function tick(): void {
    if (closed) return
    const due = controller.due()
    updateCountdown(main, due, controller.state)
    if (due && due.matches > 0 && !controller.state.settling && controller.state.canWrite) void controller.settle('tick')
  }

  const unsubscribe = controller.subscribe((s) => {
    lineup?.sync(s)
    tactics?.sync(s)
    render(s)
  })
  render(controller.state)
  void controller.start()

  function close(): void {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    doc?.removeEventListener('visibilitychange', onVisible)
    win?.removeEventListener('focus', onFocus)
    unsubscribe()
    controller.dispose()
    guard.dispose()
    document.querySelectorAll('.v2-modal-overlay').forEach((n) => n.remove())
  }

  return { controller, show, close }
}

/** 讀原始存檔文字（只讀，給「下載存檔備份」用） */
function readRaw(deps: V2Deps): string | null {
  try {
    return deps.storage?.getItem(CLUB_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = el('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
