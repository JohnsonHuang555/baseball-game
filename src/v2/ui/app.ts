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
import type { ClubSave } from '../domain/club'
import { currentLiveMatch, liveTimeline, type LiveTimeline } from '../application/liveMatch'
import { systemLiveClock, type LiveClock, type LiveSource } from '../application/livePlayer'
import type { LiveCard } from './dashboardView'
import { ClubController, type ControllerState } from './clubController'
import { renderDashboard, updateCountdown } from './dashboardView'
import { createLineupView, type LineupView } from './lineupView'
import { challengeResultModal, challengeStartModal, relegationModal } from './leagueView'
import { championshipConfirmModal, championshipGameDoneModal, championshipResultModal } from './championshipCard'
import { parseSeen, pendingRelegation } from './relegationNotice'
import { openMatchReport, renderReports, welcomeModal } from './reportView'
import { openRecruit } from './recruitView'
import { openPlayerDetail } from './playerView'
import { V2T } from './strings'
import { closeDialogs, refocusTopDialog } from './dialog'
import { icon, iconSvg, type IconName } from './icons'
import { leagueOf, rankedView } from '../domain/league'
import { RANKED_CONFIG } from '../domain/leagueConfig'
import { createTacticsView, type TacticsView } from './tacticsView'
import { openGuide } from './guideView'
import { openLeagueRoad } from './leagueRoadView'
import { createWriterGuard, randomTabId, type StorageEventSource } from './writerGuard'

export type V2Tab = 'home' | 'lineup' | 'tactics' | 'reports'
const TABS: V2Tab[] = ['home', 'lineup', 'tactics', 'reports']
const TAB_LABELS: Record<V2Tab, string> = { home: V2T.navHome, lineup: V2T.navLineup, tactics: V2T.navTactics, reports: V2T.navReports }
const TAB_ICONS: Record<V2Tab, IconName> = { home: 'club', lineup: 'lineup', tactics: 'tactics', reports: 'report' }

export interface V2AppOptions {
  deps?: V2Deps
  /** 瀏覽器事件來源（window）；測試可以換掉 */
  events?: StorageEventSource & Pick<Window, 'addEventListener' | 'removeEventListener'>
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  tabId?: string
  /** 倒數更新的間隔（毫秒），0 代表不開計時器（測試用） */
  tickMs?: number
  initialTab?: V2Tab
  /** 測試用：觀戰畫面的球場（測試環境沒有 Canvas） */
  replayStage?: () => import('./replayView').ReplayStage
  /** 測試用：觀戰的等待時間倍率（0 = 不等待） */
  replayTimeScale?: number
  /** 測試用：直播的時鐘（虛擬時間） */
  liveClock?: LiveClock
}

export interface V2App {
  controller: ClubController
  show(tab: V2Tab): void
  /** 關閉：移除監聽器與計時器、中斷進行中的結算、釋放可寫分頁的標記；重複呼叫不會出錯 */
  close(): void
  /** 已經 close() 過 */
  readonly closed: boolean
}

/**
 * 開啟 V2（整個網站就是 V2，沒有可以「離開」的上一層）。
 * close() 只給測試與重新掛載用：畫面上沒有任何會呼叫它的按鈕或按鍵
 */
/** 已經通知過幾次降級（localStorage，跟存檔分開的 UI 狀態） */
export const SEEN_RELEGATIONS_KEY = `${CLUB_STORAGE_KEY}.seen-relegations`

export function openV2(root: HTMLElement, opts: V2AppOptions = {}): V2App {
  const deps = opts.deps ?? createV2Deps()
  const win = opts.events ?? (globalThis.window as V2AppOptions['events'])
  const doc = opts.doc ?? globalThis.document
  const guard = createWriterGuard({ crossTab: deps.lock.crossTab, storage: deps.storage, events: win, tabId: opts.tabId ?? randomTabId() })
  const controller = new ClubController(deps, guard, win)

  let tab: V2Tab = opts.initialTab ?? 'home'
  let closed = false
  let shownWelcome: string | null = null
  /** 正在顯示的挑戰結果（序號）：重繪時不重複開對話框，關閉後清掉 */
  let shownChallenge: number | null = null
  let shownChampionship: string | null = null
  let lineup: LineupView | null = null
  let tactics: TacticsView | null = null
  /** 開著的觀戰畫面（同一時間只有一個） */
  let viewer: { close(): void } | null = null
  /** 正在載入觀戰畫面（動態 import 中）：連點不會開兩個 */
  let viewerLoading = false
  /** 建立表單裡輸入的名稱：重繪表單（例如建立失敗）時保留，重試不用重打 */
  let draftName = ''
  /** 降級對話框開著（Phase 7B）：重畫時不會再開第二個 */
  let relegationOpen = false
  /** localStorage 不能用時，這個 App 內已經通知過的降級次數 */
  const sessionSeen = new Map<string, number>()
  /** 上一次畫面時的競技狀態（危險區 Toast 用） */
  let lastZone: { key: string; zone: string; points: number | null } | null = null

  const screen = el('div', 'v2-screen')
  const body = el('div', 'v2-body')
  const header = el('header', 'v2-header')
  const titles = el('div', 'v2-titles')
  const title = el('h1', 'v2-title', V2T.modeTitle)
  const subtitle = el('span', 'v2-subtitle', V2T.modeBadge)
  titles.append(title, subtitle)
  const resources = el('div', 'v2-resources')
  // 遊戲指南（設計稿 p7）：首頁標題列的「?」，關閉後焦點回到這顆按鈕
  const help = el('button', 'v2-help-btn', '?')
  help.type = 'button'
  help.dataset.action = 'open-guide'
  help.setAttribute('aria-label', V2T.guideOpen)
  help.onclick = () => {
    help.focus({ preventScroll: true })
    openGuideFrom()
  }
  header.append(titles, resources, help)
  const banner = el('div', 'v2-banner-slot')
  const main = el('main', 'v2-main')
  const nav = el('nav', 'v2-nav')
  nav.setAttribute('aria-label', V2T.navLabel)
  body.append(header, banner, main)
  screen.append(nav, body)
  root.replaceChildren(screen)
  // V2 是整個網站：Escape 不會關掉 App（只有觀戰畫面、對話框各自用 Escape 關閉，關閉後還原成這裡的空設定）
  setKeys({})

  function openGuideFrom(chapter?: string): void {
    openGuide({ desk: isDesk(), owner: controller, chapter })
  }

  function openRoad(): void {
    openLeagueRoad({
      club: controller.state.club,
      desk: isDesk(),
      owner: controller,
      actions: {
        lineup: () => show('lineup'),
        recruit: () => openRecruit(controller, () => show('lineup')),
        guide: (chapter) => openGuideFrom(chapter),
      },
    })
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
    screen.classList.toggle('has-nav', !nav.hidden)
    nav.append(el('span', 'v2-rail-logo', 'DICE BALL'))
    for (const id of TABS) {
      const b = el('button', 'v2-nav-btn')
      b.type = 'button'
      b.setAttribute('aria-current', id === tab ? 'page' : 'false')
      b.dataset.tab = id
      b.innerHTML = iconSvg(TAB_ICONS[id], 22)
      b.append(el('span', '', TAB_LABELS[id]))
      b.onclick = () => show(id)
      nav.append(b)
    }
  }

  /** 頁首：隊名、聯盟與總戰績，右邊是資金與經驗（切到任何分頁都看得到） */
  function renderHeader(state: ControllerState): void {
    const club = state.club
    title.textContent = club?.clubName ?? V2T.modeTitle
    resources.replaceChildren()
    if (!club || state.status.kind !== 'ready') {
      subtitle.textContent = club ? V2T.record(club.record.wins, club.record.losses) : V2T.modeBadge
      return
    }
    const def = leagueOf(club.league.tier)
    const pill = el('span', 'v2-league-pill', def.name)
    pill.style.background = def.color
    const rec = el('span', 'v2-head-record', `${club.record.wins}-${club.record.losses}`)
    rec.setAttribute('aria-label', V2T.record(club.record.wins, club.record.losses))
    subtitle.replaceChildren(pill, rec, el('span', '', V2T.totalRecord))
    const res = (name: IconName, label: string, value: number, key: string) => {
      const box = el('span', 'v2-res')
      box.dataset.res = key
      box.setAttribute('aria-label', `${label} ${value.toLocaleString('zh-Hant')}`)
      box.append(icon(name, 20), el('span', 'v2-res-value', value.toLocaleString('zh-Hant')))
      return box
    }
    resources.append(
      res('coin', V2T.funds, club.economy.assets.funds, 'funds'),
      res('exp', V2T.experience, club.economy.assets.experience, 'exp'),
    )
  }

  function renderBanner(state: ControllerState): void {
    banner.replaceChildren()
    if (state.status.kind !== 'ready' && state.status.kind !== 'no-club') return
    if (!state.canWrite) {
      const box = el('div', 'v2-banner readonly')
      box.setAttribute('role', 'status')
      const take = el('button', 'btn-white v2-banner-btn', V2T.takeOver)
      take.type = 'button'
      take.onclick = () => controller.takeOver()
      const text = el('span', 'v2-banner-text')
      text.append(el('strong', '', V2T.readOnlyTitle), el('span', '', V2T.readOnlyWhy))
      box.append(icon('lock', 22), text, take)
      banner.append(box)
    }
    if (state.error) {
      const box = el('div', 'v2-banner error')
      box.setAttribute('role', 'alert')
      const text = el('span', 'v2-banner-text')
      text.append(el('strong', '', state.error.message))
      box.append(icon('alert', 22), text)
      const retry = state.error.retry
      if (retry) {
        const b = el('button', 'btn-white v2-banner-btn', V2T.retry)
        b.type = 'button'
        b.onclick = () => (retry === 'settle' ? void controller.settle('manual') : void claimWithToast())
        box.append(b)
      }
      banner.append(box)
    }
  }

  // ---- 觀戰 ----

  /** 首頁「目前比賽」用的直播時間軸快取：同一場、同一個存檔版本只算一次（每秒更新不重算） */
  let liveCache: { key: string; data: LiveTimeline } | null = null
  function liveOf(club: ClubSave, now: number): LiveCard {
    const info = currentLiveMatch(club, now)
    const key = `${info.matchId}:${club.revision}`
    if (liveCache?.key !== key) liveCache = { key, data: liveTimeline(info.plan) }
    const { timeline, schedule } = liveCache.data
    const position = schedule.positionAt(now - info.startsAt)
    const state = position <= 0 ? timeline.initial : position >= timeline.frames.length ? timeline.final : timeline.frames[position - 1].after
    return { info, state, userSide: timeline.userSide, teamNames: timeline.teamNames, now }
  }
  const liveCard = (): LiveCard | null => {
    const club = controller.state.club
    return club ? liveOf(club, deps.clock.now()) : null
  }

  /** 直播的時鐘：正式環境用系統時間，測試可以換成虛擬時鐘 */
  const liveClock = (): LiveClock => opts.liveClock ?? systemLiveClock(() => deps.clock.now())

  /**
   * 觀看進行中的比賽：先把到期的比賽結算掉（可寫分頁），再用最新的存檔推算現在是哪一場、打到哪裡。
   * 觀戰不經過 controller、不寫入任何東西；比賽結束後由一般的放置流程結算，獎勵只在那時發放
   */
  async function watchLive(): Promise<void> {
    if (viewer || viewerLoading || closed) return
    viewerLoading = true
    try {
      const first = await nextLive()
      if (closed || !first) return
      const mod = await import('./replayView')
      if (closed) return
      viewer = mod.openMatchViewer({
        mode: 'live',
        source: first.source,
        title: first.title,
        clock: liveClock(),
        next: nextLive,
        createStage: opts.replayStage,
        timeScale: opts.replayTimeScale,
        onClose: () => {
          viewer = null
          if (!closed) render(controller.state)
        },
      })
      // 新手任務「觀看第一場比賽」：成功進入直播才算（不要求看完）；已經記過就不會再寫入
      void controller.markWatchedLive()
    } catch {
      toast(V2T.replayLoadFailed)
    } finally {
      viewerLoading = false
    }
  }

  /** 現在進行中的那一場（先結算到期的比賽） */
  async function nextLive(): Promise<{ source: LiveSource; title: string } | null> {
    if (controller.state.canWrite) await controller.settle('manual')
    const club = deps.store.loadClub()
    if (!club) return null
    const now = deps.clock.now()
    const info = currentLiveMatch(club, now)
    const { timeline, schedule } = liveTimeline(info.plan)
    const opponent = timeline.teamNames[timeline.userSide === 'home' ? 'away' : 'home']
    return {
      source: { matchIndex: info.matchIndex, matchId: info.matchId, startsAt: info.startsAt, endsAt: info.endsAt, timeline, schedule },
      title: `${V2T.matchNo(info.matchIndex + 1)}・${V2T.vs(opponent)}`,
    }
  }

  /**
   * 觀看晉級挑戰賽：結果已經在按下挑戰時確定並存檔，這裡從存檔複製一份 Replay 播出來（不先揭曉）。
   * onFinished：播完或直接看結果時呼叫（顯示挑戰結果）；中途離開也會呼叫，結果不會消失
   */
  async function watchChallenge(onFinished?: () => void): Promise<void> {
    const club = controller.state.club
    const kept = club?.challengeReplay
    const record = kept && club!.league.challenges.find((c) => c.seq === kept.seq)
    if (!kept || !record) {
      toast(V2T.replayNotKept)
      onFinished?.()
      return
    }
    if (viewer || viewerLoading || closed) return
    const expected = { userSide: kept.replay.setup.userSide, runsFor: record.runsFor, runsAgainst: record.runsAgainst, won: record.won, innings: record.innings }
    const snapshot = structuredClone(kept.replay)
    viewerLoading = true
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      onFinished?.()
    }
    try {
      const mod = await import('./replayView')
      if (closed) return
      viewer = mod.openMatchViewer({
        mode: 'challenge',
        replay: snapshot,
        expected,
        title: `${V2T.challengeTitle}・${V2T.vs(record.opponentName)}`,
        createStage: opts.replayStage,
        timeScale: opts.replayTimeScale,
        onFinished: finish,
        onClose: () => {
          viewer = null
          finish()
          // 從挑戰結果打開的觀戰：關閉後焦點回到結果對話框
          refocusTopDialog()
        },
      })
    } catch {
      toast(V2T.replayLoadFailed)
      finish()
    } finally {
      viewerLoading = false
    }
  }

  /**
   * 觀看最近一場冠軍賽：結果已經在按下按鈕時確定並存檔，這裡從存檔複製一份 Replay 播出來（不先揭曉）。
   * onFinished：播完、直接看結果、或中途離開時呼叫
   */
  async function watchChampionship(onFinished?: () => void): Promise<void> {
    const last = controller.state.club?.championship.lastGame
    if (!last) {
      toast(V2T.champReplayGone)
      onFinished?.()
      return
    }
    if (viewer || viewerLoading || closed) return
    const g = last.game
    const expected = { userSide: g.userSide, runsFor: g.runsFor, runsAgainst: g.runsAgainst, won: g.won, innings: g.innings }
    const snapshot = structuredClone(last.replay)
    viewerLoading = true
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      onFinished?.()
    }
    try {
      const mod = await import('./replayView')
      if (closed) return
      viewer = mod.openMatchViewer({
        mode: 'challenge',
        label: V2T.champTitle,
        replay: snapshot,
        expected,
        title: `${V2T.champTitle}・${V2T.champGameDot(g.game)}`,
        createStage: opts.replayStage,
        timeScale: opts.replayTimeScale,
        onFinished: finish,
        onClose: () => {
          viewer = null
          finish()
          refocusTopDialog()
        },
      })
    } catch {
      toast(V2T.replayLoadFailed)
      finish()
    } finally {
      viewerLoading = false
    }
  }

  const toastFail = (res: { ok: boolean; message?: string }) => {
    if (!closed && !res.ok && res.message) toast(res.message)
  }

  async function claimWithToast(): Promise<void> {
    const res = await controller.claim()
    if (!closed && res.message) toast(res.message)
  }

  function render(state: ControllerState): void {
    if (closed) return
    renderHeader(state)
    renderBanner(state)
    screen.dataset.tab = state.status.kind === 'ready' ? tab : state.status.kind
    renderNav(state)
    const s = state.status
    header.hidden = s.kind !== 'ready'
    help.hidden = s.kind !== 'ready' || tab !== 'home'
    if (s.kind === 'loading') main.replaceChildren(loadingScreen())
    else if (s.kind === 'no-club') main.replaceChildren(createScreen(state))
    else if (s.kind === 'broken') main.replaceChildren(brokenScreen(s.message, s.reason))
    else if (tab === 'home') {
      main.replaceChildren(
        renderDashboard(state, controller, {
          claim: () => void claimWithToast(),
          openReport: (m) => openMatchReport(m, state.club!, controller, (id) => void openPlayerDetail(controller, id, { tab: 'stats' }), (id) => void openPlayerDetail(controller, id)),
          watchLive: () => void watchLive(),
          liveCard,
          allReports: () => show('reports'),
          recruit: () => openRecruit(controller, () => show('lineup')),
          lineup: () => show('lineup'),
          openPlayer: (id) => void openPlayerDetail(controller, id),
          toggleOnboarding: (collapsed) =>
            void controller.setOnboardingCollapsed(collapsed).then((res) => {
              if (!closed && !res.ok && res.message) toast(res.message)
            }),
          watchChallenge: state.club?.challengeReplay ? () => void watchChallenge() : null,
          desk: isDesk(),
          openRoad,
          challenge: (expected) =>
            void controller.challenge(expected).then((res) => {
              if (!closed && !res.ok && res.message) toast(res.message)
            }),
          championship: {
            start: (expected) => {
              championshipConfirmModal(() => void controller.startChampionship(expected).then(toastFail), controller)
            },
            play: (expected) => void controller.playChampionshipGame(expected).then(toastFail),
            watch: state.club?.championship.lastGame ? () => void watchChampionship() : null,
          },
        }),
      )
    } else if (tab === 'lineup') {
      lineup ??= createLineupView(controller, () => show('lineup'))
      main.replaceChildren(lineup.render(state))
    } else if (tab === 'tactics') {
      tactics ??= createTacticsView(controller)
      main.replaceChildren(tactics.render(state))
    } else main.replaceChildren(renderReports(state, (m) => openMatchReport(m, state.club!, controller, (id) => void openPlayerDetail(controller, id, { tab: 'stats' }), (id) => void openPlayerDetail(controller, id)), deps.clock.now()))

    if (state.notice) {
      toast(state.notice)
      controller.clearNotice()
    }
    if (state.challengeResult && state.challengeResult.challenge.seq !== shownChallenge) {
      shownChallenge = state.challengeResult.challenge.seq
      const result = state.challengeResult
      const reveal = () => {
        if (closed) return
        // 這次挑戰有保留 Replay：結果對話框多一個「觀看挑戰過程」（觀戰蓋在對話框上方，返回後回到這裡）
        const kept = result.club.challengeReplay?.seq === result.challenge.seq
        challengeResultModal(
          result,
          result.club.clubName,
          (reason) => {
            shownChallenge = null
            // App 關閉時（dispose）只清掉對話框，不改狀態、不重畫
            if (reason === 'user') controller.dismissChallengeResult()
          },
          kept ? () => void watchChallenge() : undefined,
          controller,
        )
      }
      // 結果已經確定並存檔；先問要不要看比賽過程（不先揭曉），不想看就直接看結果
      if (result.club.challengeReplay?.seq === result.challenge.seq && !result.duplicate) {
        challengeStartModal(result, () => void watchChallenge(reveal), reveal, controller)
      } else reveal()
    }
    const champ = state.championshipResult
    if (champ?.kind === 'start') queueMicrotask(() => controller.dismissChampionshipResult())
    if (champ?.kind === 'game') {
      const out = champ.out
      const key = `${out.game.matchId}`
      if (key !== shownChampionship) {
        shownChampionship = key
        const kept = () => controller.state.club?.championship.lastGame?.game.matchId === out.game.matchId
        const reveal = () => {
          if (closed) return
          championshipResultModal(
            out,
            out.club,
            (reason) => {
              shownChampionship = null
              if (reason === 'user') controller.dismissChampionshipResult()
            },
            kept() ? () => void watchChampionship() : undefined,
            controller,
          )
        }
        // 結果已經確定並存檔；先問要不要看比賽過程（不先揭曉），不想看就直接看結果
        if (kept() && !out.duplicate) championshipGameDoneModal(out, () => void watchChampionship(reveal), reveal, controller)
        else reveal()
      }
    }
    if (state.welcome && state.welcome.key !== shownWelcome) {
      shownWelcome = state.welcome.key
      welcomeModal(state.welcome, (reason) => reason === 'user' && controller.dismissWelcome(), controller, (id) => void openPlayerDetail(controller, id))
    }
    if (state.status.kind === 'ready' && state.club) {
      notifyDanger(state.club)
      // 通知順序：挑戰結果 → 歡迎回來（離線摘要）→ 降級。前面兩個還開著時先不開降級，關掉後重畫時再開
      if (!state.challengeResult && !state.championshipResult && !state.welcome) notifyRelegation(state.club)
    }
  }

  // ---- 降級通知（Phase 7B） ----
  // 通知內容由 relegationNotice.ts 從存檔裡可驗證的事件決定（不從目前聯盟與累計次數反推）。
  // 已讀紀錄（已經通知到第幾次降級）存在 localStorage，跟存檔分開；只在玩家真的關掉對話框時寫入，
  // App 關閉（dispose）時不寫，所以還沒看到的事件下次會再通知。localStorage 不能用時，同一個 App 內用記憶體記，不會重複彈出
  function seenRelegations(clubId: string): number | null {
    let stored: number | null = null
    try {
      stored = parseSeen(deps.storage?.getItem(SEEN_RELEGATIONS_KEY) ?? null, clubId)
    } catch {
      stored = null
    }
    const mem = sessionSeen.get(clubId)
    return mem === undefined ? stored : Math.max(mem, stored ?? 0)
  }
  function markRelegationsSeen(clubId: string, count: number): void {
    sessionSeen.set(clubId, Math.max(count, sessionSeen.get(clubId) ?? 0))
    try {
      const prev = parseSeen(deps.storage?.getItem(SEEN_RELEGATIONS_KEY) ?? null, clubId) ?? 0
      deps.storage?.setItem(SEEN_RELEGATIONS_KEY, JSON.stringify({ clubId, count: Math.max(prev, count) }))
    } catch {
      // 寫不進去：這個 App 內已經用記憶體記住，重新整理後會再通知一次
    }
  }
  function notifyRelegation(club: ClubSave): void {
    if (relegationOpen || closed) return
    const seen = seenRelegations(club.clubId)
    const notice = pendingRelegation(club, seen)
    if (!notice) {
      // 這個裝置第一次看到這個球團、而且沒有要通知的事：把目前的降級次數記成基準，之後的降級都能算出確切的次數
      if (seen === null) markRelegationsSeen(club.clubId, club.league.relegations)
      return
    }
    relegationOpen = true
    relegationModal(
      club,
      notice,
      { openRoad: () => openRoad() },
      (reason) => {
        relegationOpen = false
        if (reason === 'user') markRelegationsSeen(club.clubId, notice.seq)
      },
      controller,
    )
  }

  // 危險區提示：同一個聯盟裡，積分從危險區以上掉進危險區、或離開危險區時 Toast 一次（第一次畫面不提示，卡片已經顯示）
  function notifyDanger(club: ClubSave): void {
    const v = rankedView(club.league)
    const key = `${club.clubId}:${club.league.tier}:${club.league.relegations}:${club.league.promotions}`
    const prev = lastZone
    lastZone = { key, zone: v.zone, points: v.points }
    if (!prev || prev.key !== key || !v.canRelegate || v.points === null || prev.zone === v.zone) return
    if (v.zone === 'danger') toast(V2T.dangerEnter(v.points, RANKED_CONFIG.maxPoints))
    else if (prev.zone === 'danger') toast(V2T.dangerLeave(v.points, RANKED_CONFIG.maxPoints))
  }

  /** 首次進入、讀取中、錯誤畫面上方的標誌 */
  function logo(sub: string): HTMLElement {
    const box = el('div', 'v2-logo')
    box.append(el('span', 'v2-logo-mark', 'DICE BALL'), el('span', 'v2-logo-sub', sub))
    return box
  }

  /** 讀取中：標誌、轉動的球、進度條（減少動態效果時不動） */
  function loadingScreen(): HTMLElement {
    const box = el('div', 'v2-loading')
    box.setAttribute('role', 'status')
    box.setAttribute('aria-live', 'polite')
    const ball = el('span', 'v2-loading-ball')
    ball.innerHTML =
      '<svg aria-hidden="true" width="56" height="56" viewBox="0 0 56 56"><circle cx="28" cy="28" r="24" fill="#fff" stroke="#141633" stroke-width="3"/><path d="M12 14 C20 22 20 34 12 42 M44 14 C36 22 36 34 44 42" fill="none" stroke="#E5383B" stroke-width="2.5" stroke-dasharray="3 3"/></svg>'
    const bar = el('span', 'v2-loading-bar')
    bar.append(el('span', ''))
    box.append(logo(''), ball, bar, el('strong', 'v2-loading-text', V2T.loading), el('span', 'v2-loading-sub', V2T.loadingSub))
    return box
  }

  /** 建立球團畫面：名稱不能空，建立中按鈕停用，Enter 也能送出 */
  function createScreen(state: ControllerState): HTMLElement {
    const wrap = el('div', 'v2-create-wrap')
    const box = el('section', 'v2-card v2-create')
    const form = el('form', 'v2-create-form')
    const label = el('label', 'v2-label', V2T.clubNameLabel)
    const input = el('input', 'v2-input')
    input.id = 'v2-club-name'
    label.htmlFor = input.id
    input.maxLength = 12
    input.placeholder = V2T.clubNamePlaceholder
    input.autocomplete = 'off'
    input.value = draftName
    input.setAttribute('aria-describedby', 'v2-club-name-hint')
    const hint = el('p', 'v2-input-hint', V2T.nameHint)
    hint.id = 'v2-club-name-hint'
    const nameError = state.createError === V2T.nameRequired
    if (nameError) {
      input.setAttribute('aria-invalid', 'true')
      hint.textContent = V2T.nameRequired
      hint.classList.add('v2-form-error')
    }
    input.oninput = () => (draftName = input.value)
    const points = el('ul', 'v2-create-points')
    const icons: IconName[] = ['clock', 'play', 'claim']
    V2T.createPoints.forEach((p, i) => {
      const li = el('li')
      li.append(icon(icons[i] ?? 'check', 22), el('span', '', p))
      points.append(li)
    })
    form.append(label, input, hint)
    box.append(el('h2', 'v2-create-title', V2T.createTitle), form, el('p', 'v2-create-intro', V2T.createIntro), points)

    const parts: HTMLElement[] = [logo(V2T.logoSub), box]
    // 寫入失敗：輸入的名稱保留，按鈕變成「再試一次」
    const writeError = state.createError && !nameError ? state.createError : null
    if (writeError) {
      const err = el('div', 'v2-create-error')
      err.setAttribute('role', 'alert')
      const words = el('span', 'v2-create-error-words')
      words.append(el('strong', '', V2T.createFailedTitle), el('span', 'v2-form-error', writeError))
      err.append(icon('alert', 20), words)
      parts.push(err)
    }
    const submit = el('button', 'btn-yellow btn-big v2-create-btn', state.creating ? V2T.creating : writeError ? V2T.tryAgain : V2T.createButton)
    submit.type = 'submit'
    submit.setAttribute('form', 'v2-create-form')
    form.id = 'v2-create-form'
    submit.disabled = state.creating || !state.canWrite
    const foot = el('div', 'v2-create-foot')
    foot.append(submit, el('p', 'v2-create-note', V2T.createNote))
    parts.push(foot)
    form.onsubmit = async (e) => {
      e.preventDefault()
      draftName = input.value
      submit.disabled = true
      // 失敗原因放在 controller 的 createError，表單重繪時也會顯示；輸入的名稱保留在 draftName
      const res = await controller.createClub(draftName)
      if (closed) return
      if (res.ok) {
        draftName = ''
        if (res.message) toast(res.message, 'success')
      }
    }
    wrap.append(...parts)
    queueMicrotask(() => {
      if (!input.isConnected) return
      input.focus()
      input.setSelectionRange?.(input.value.length, input.value.length)
    })
    return wrap
  }

  /** 存檔壞掉、版本不相容、儲存不能用：說明清楚，不自動清除；玩家可以下載備份，確認後才刪除重來 */
  function brokenScreen(message: string, reason: string): HTMLElement {
    const wrap = el('div', 'v2-broken-wrap')
    const box = el('section', 'v2-card v2-broken')
    box.setAttribute('role', 'alert')
    box.append(icon('alert', 32, 'v2-broken-icon'), el('h2', '', V2T.brokenTitle), el('p', 'v2-broken-msg', message), el('p', 'v2-broken-code', V2T.errorCode(reason)))
    const raw = readRaw(deps)
    if (raw !== null && reason !== 'storage-unavailable') {
      const download = el('button', 'btn-yellow', V2T.downloadBackup)
      download.type = 'button'
      download.onclick = () => downloadText(`dice-baseball-club-backup-${Date.now()}.json`, raw)
      const reset = el('button', 'btn-danger', V2T.resetBroken)
      reset.type = 'button'
      reset.onclick = async () => {
        const ok = await confirmModal({ title: V2T.resetConfirmTitle, message: V2T.resetConfirmMessage, confirmLabel: V2T.resetConfirm, danger: true })
        if (!ok || closed) return
        const res = await controller.resetClub()
        if (!res.ok && res.message) toast(res.message, 'error')
      }
      const buttons = el('div', 'v2-broken-actions')
      buttons.append(download, reset, el('p', 'v2-hint', V2T.resetNote))
      box.append(buttons)
    }
    wrap.append(box)
    return wrap
  }

  // ---- 電腦版版面：首頁改成三欄，寬度跨過門檻時重畫一次 ----
  const deskQuery = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(min-width: 1024px)') : null
  function isDesk(): boolean {
    return !!deskQuery?.matches
  }
  const onDeskChange = () => render(controller.state)
  deskQuery?.addEventListener?.('change', onDeskChange)

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
    updateCountdown(main, due, controller.state, liveCard())
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
    viewer?.close()
    // 這個 App 開的對話框都走正式的關閉流程（離開堆疊、還原快捷鍵、移除鍵盤監聽、取消訂閱）；
    // closed 已經是 true，onClose 收到 'dispose'，不會再揭曉結果、重畫或改狀態。別的 App 的對話框不受影響
    closeDialogs(controller)
    deskQuery?.removeEventListener?.('change', onDeskChange)
    doc?.removeEventListener('visibilitychange', onVisible)
    win?.removeEventListener('focus', onFocus)
    unsubscribe()
    controller.dispose()
    guard.dispose()
  }

  return {
    controller,
    show,
    close,
    get closed() {
      return closed
    },
  }
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
