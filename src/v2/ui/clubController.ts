// V2 畫面的控制器：不碰 DOM，畫面只負責把 state 畫出來、把玩家的操作轉成這裡的方法。
// 所有寫入都走 Phase 2 的 application 入口（createClubSafely、settleDue、claim、updateSettings），
// 不直接改 loadClub() 讀到的資料再存回去。
//
// - 結算同一時間只跑一個（single flight）：重複呼叫拿到同一個 Promise，畫面重繪不會多結算
// - dispose 之後，還在跑的 async 操作完成時不會再更新畫面；進行中的結算用 AbortSignal 中斷（已打完的場次照樣存檔）
// - revision 衝突：重新讀取最新存檔並提示，不會靜默覆蓋
// - 不支援 Web Locks 時，只有可寫分頁能寫入（WriterGuard），唯讀分頁的寫入一律拒絕
import { createClubSafely, openClubSafely, resetClubSafely } from '../application/clubLifecycle'
import { EconomyError, recruit, release, upgrade, type SpendOutcome } from '../application/economyService'
import { LeagueError, challengeNextLeague, type ChallengeOutcome } from '../application/leagueService'
import { dueMatches, type DueMatches } from '../application/idleEngine'
import { SettlementError, claim, settleDue, updateSettings, type SettlementReport } from '../application/settlementService'
import { markWatchedLive, setOnboarding } from '../application/onboardingService'
import type { ClubSave, PersistentRoster, SummaryHighlight } from '../domain/club'
import { settingsVersions } from '../domain/fingerprint'
import { LineupError, lineupIssues } from '../domain/lineup'
import type { RecruitRole } from '../domain/recruitment'
import { recordOf, toAssignment } from '../domain/roster'
import { toCoachSettings, type TacticSettings } from '../domain/tactics'
import { ClubSaveError } from '../infrastructure/clubRepository'
import type { V2Deps } from '../infrastructure/composition'
import { V2T } from './strings'
import { CLUB_STORAGE_KEY } from '../infrastructure/clubRepository'
import { guardStore, type StorageEventSource, type WriterGuard } from './writerGuard'

export type V2Status =
  | { kind: 'loading' }
  | { kind: 'no-club' }
  | { kind: 'ready' }
  /** 存檔壞掉、版本不相容或瀏覽器儲存不能用：不能繼續，也不會清掉存檔 */
  | { kind: 'broken'; reason: 'invalid' | 'unsupported-version' | 'storage-unavailable' | 'migration-failed' | 'migration-blocked'; message: string }

/** 離開期間完成的比賽摘要 */
export interface WelcomeSummary {
  key: string
  matches: number
  wins: number
  losses: number
  funds: number
  experience: number
  highlights: SummaryHighlight[]
}

export type RetryAction = 'settle' | 'claim'

export interface ControllerState {
  status: V2Status
  club: ClubSave | null
  creating: boolean
  /** 建立球團失敗的原因（重繪表單時要一直顯示，直到下一次嘗試） */
  createError: string | null
  settling: boolean
  claiming: boolean
  saving: boolean
  /** 正在升級、招募或釋出 */
  spending: boolean
  /** 正在打晉級挑戰賽 */
  challenging: boolean
  /** 最近一次挑戰的結果（畫面顯示結果對話框後清掉） */
  challengeResult: ChallengeOutcome | null
  /** 可以重試的錯誤（結算、領取失敗） */
  error: { message: string; retry?: RetryAction } | null
  /** 一次性的提示（顯示後由畫面清掉） */
  notice: string | null
  welcome: WelcomeSummary | null
  canWrite: boolean
  /** 互斥有沒有跨分頁保證；沒有時用 WriterGuard 限制單一可寫分頁 */
  crossTab: boolean
}

/** 升級、招募的結果；成功時附上存好的那一筆支出 */
export interface SpendResult extends ActionResult {
  outcome?: SpendOutcome
}

export type SettleTrigger = 'enter' | 'resume' | 'manual' | 'tick'

/** 寫入操作的結果：成功與否，以及要給玩家看的訊息 */
export interface ActionResult {
  ok: boolean
  message?: string
  /** 草稿是根據舊的設定做的，別的分頁已經改過：沒有覆寫，請重新載入 */
  conflict?: boolean
}

export class ClubController {
  private current: ControllerState
  private readonly listeners = new Set<(s: ControllerState) => void>()
  private settleFlight: Promise<void> | null = null
  private claimFlight: Promise<ActionResult> | null = null
  private spendFlight: Promise<SpendResult> | null = null
  private challengeFlight: Promise<ActionResult> | null = null
  private createFlight: Promise<ActionResult> | null = null
  private abort: AbortController | null = null
  private disposed = false
  private lastWelcomeKey: string | null = null
  private readonly unsubscribeGuard: () => void
  /** 其他分頁寫入 V2 存檔時（storage 事件）重新讀取，例如別的分頁先領了收益 */
  private readonly onStorage = (e: { key: string | null }) => {
    if ((e.key === CLUB_STORAGE_KEY || e.key === null) && !this.current.settling) this.reload()
  }

  private readonly deps: V2Deps

  constructor(
    deps: V2Deps,
    private readonly guard: WriterGuard,
    private readonly events?: StorageEventSource,
  ) {
    // 所有寫入在寫進儲存的前一刻再確認一次可寫分頁身分
    this.deps = { ...deps, store: guardStore(deps.store, guard) }
    this.current = {
      status: { kind: 'loading' },
      club: null,
      creating: false,
      createError: null,
      settling: false,
      claiming: false,
      saving: false,
      spending: false,
      challenging: false,
      challengeResult: null,
      error: null,
      notice: null,
      welcome: null,
      canWrite: guard.canWrite(),
      crossTab: deps.lock.crossTab,
    }
    this.unsubscribeGuard = guard.subscribe(() => {
      // 別的分頁接手：盡量中斷還沒完成的批次結算（之後的存檔也會被 guardStore 擋下）
      if (!guard.canWrite()) this.abort?.abort()
      this.set({ canWrite: guard.canWrite() })
      // 變成唯讀時，畫面要換成別的分頁寫進去的最新狀態
      this.reload()
    })
    events?.addEventListener('storage', this.onStorage)
  }

  get state(): ControllerState {
    return this.current
  }

  subscribe(listener: (s: ControllerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 進入 V2：讀取存檔（舊格式就在鎖內升級），有球團就結算到期的比賽 */
  async start(): Promise<void> {
    if (this.disposed) return
    try {
      const { value } = await openClubSafely(this.deps)
      if (this.disposed) return
      this.set({ club: value.club, status: value.club ? { kind: 'ready' } : { kind: 'no-club' }, ...(value.migrated ? { notice: V2T.migrated } : {}) })
    } catch (e) {
      if (this.disposed) return
      // 沒有 Web Locks 時被別的分頁搶先遷移：重新讀取就是新格式
      if (e instanceof ClubSaveError && e.code === 'conflict') this.reload()
      else this.set({ club: null, status: brokenStatus(e) })
    }
    if (this.current.status.kind === 'ready') await this.settle('enter')
  }

  /** 重新讀取最新存檔（其他分頁寫入、衝突之後） */
  reload(): void {
    if (this.disposed) return
    try {
      const club = this.deps.store.loadClub()
      this.set({ club, status: club ? { kind: 'ready' } : { kind: 'no-club' } })
    } catch (e) {
      // 存檔還是舊格式（例如唯讀分頁沒辦法遷移）：交給 start 在鎖內遷移
      if (e instanceof ClubSaveError && e.code === 'needs-migration' && this.guard.canWrite()) {
        void this.start()
        return
      }
      this.set({ club: null, status: brokenStatus(e) })
    }
  }

  /** 距離下一場、目前可以結算幾場（畫面倒數用；真正的進度只看時間錨點） */
  due(): DueMatches | null {
    const club = this.current.club
    return club ? dueMatches(club.idle, this.deps.clock.now()) : null
  }

  /** 結算到期的比賽。同一時間只會跑一個，重複呼叫拿到同一個 Promise */
  settle(trigger: SettleTrigger): Promise<void> {
    if (this.settleFlight) return this.settleFlight
    if (this.disposed || this.current.status.kind !== 'ready' || !this.guard.canWrite()) return Promise.resolve()
    this.settleFlight = this.runSettle(trigger).finally(() => {
      this.settleFlight = null
    })
    return this.settleFlight
  }

  private async runSettle(trigger: SettleTrigger): Promise<void> {
    const due = this.due()
    if (!due || due.matches === 0) return
    this.abort = new AbortController()
    this.set({ settling: true, error: null })
    try {
      const report = await settleDue(this.deps, { signal: this.abort.signal })
      if (this.disposed) return
      // 存檔與歡迎回來摘要在同一次更新：畫面不會先看到「降級了、卻還沒有摘要」的中間狀態（降級通知排在摘要之後）
      this.afterSettle(report, trigger, { club: report.club, status: { kind: 'ready' } })
    } catch (e) {
      if (this.disposed) return
      // 模擬失敗時，失敗前的場次已經存檔
      if (e instanceof SettlementError && e.report) this.set({ club: e.report.club })
      this.handleError(e, 'settle')
    } finally {
      this.abort = null
      if (!this.disposed) this.set({ settling: false })
    }
  }

  private afterSettle(report: SettlementReport, trigger: SettleTrigger, base: Partial<ControllerState>): void {
    const settled = report.settled
    if (settled.length === 0) {
      this.set(base)
      return
    }
    const key = `${settled[0].matchId}..${settled[settled.length - 1].matchId}`
    // 剛進入或回到這個分頁：顯示離開期間的摘要；同一份摘要只顯示一次
    if ((trigger === 'enter' || trigger === 'resume') && key !== this.lastWelcomeKey) {
      this.lastWelcomeKey = key
      const wins = settled.filter((m) => m.result.won).length
      this.set({
        ...base,
        welcome: {
          key,
          matches: settled.length,
          wins,
          losses: settled.length - wins,
          funds: settled.reduce((s, m) => s + m.earnedFunds, 0),
          experience: settled.reduce((s, m) => s + m.earnedExperience, 0),
          highlights: settled
            .flatMap((m) => m.result.highlights.filter((h) => h.ours))
            .sort((a, b) => Number(b.kind === 'walkOff') - Number(a.kind === 'walkOff') || b.runs - a.runs)
            .slice(0, 3),
        },
      })
    } else {
      this.set({ ...base, notice: V2T.matchesFinished(settled.length) })
    }
    if (report.status === 'aborted') this.set({ notice: V2T.settleInterrupted })
  }

  dismissWelcome(): void {
    this.set({ welcome: null })
  }

  clearNotice(): void {
    this.set({ notice: null })
  }

  /** 建立球團：名稱不能空，連點只會建立一次 */
  createClub(rawName: string): Promise<ActionResult> {
    if (this.createFlight) return this.createFlight
    const name = rawName.trim()
    const fail = (message: string): Promise<ActionResult> => {
      this.set({ createError: message })
      return Promise.resolve({ ok: false, message })
    }
    if (!name) return fail(V2T.nameRequired)
    if (name.length > 12) return fail(V2T.nameTooLong)
    if (!this.guard.canWrite()) return fail(V2T.readOnly)
    this.createFlight = (async (): Promise<ActionResult> => {
      this.set({ creating: true, createError: null, error: null })
      try {
        const { value } = await createClubSafely(this.deps, { clubName: name })
        if (this.disposed) return { ok: true }
        this.set({ club: value, status: { kind: 'ready' } })
        return { ok: true }
      } catch (e) {
        if (this.disposed) return { ok: false }
        // 別的分頁剛建好：讀進來就好
        if (e instanceof ClubSaveError && e.code === 'already-exists') {
          this.reload()
          if (this.current.status.kind === 'ready') return { ok: true, message: V2T.createdElsewhere }
          // 已經有存檔但讀不出來（壞掉、版本不相容）：reload 會切到錯誤畫面
          return { ok: false, message: V2T.alreadyExists }
        }
        const message = e instanceof ClubSaveError && e.code === 'write-failed' ? V2T.createWriteFailed : this.handleError(e)
        this.set({ createError: message, error: null })
        return { ok: false, message }
      } finally {
        this.createFlight = null
        if (!this.disposed) this.set({ creating: false })
      }
    })()
    return this.createFlight
  }

  /** 領取收益：先讀最新存檔決定序號；別的分頁已經領過就只更新畫面。連點只會送一次 */
  claim(): Promise<ActionResult> {
    if (this.claimFlight) return this.claimFlight
    if (!this.guard.canWrite()) return Promise.resolve({ ok: false, message: V2T.readOnly })
    this.claimFlight = (async (): Promise<ActionResult> => {
      this.set({ claiming: true, error: null })
      try {
        const shown = this.current.club
        const latest = this.deps.store.loadClub()
        if (!latest) {
          this.reload()
          return { ok: false }
        }
        if (shown && latest.economy.nextClaimSeq !== shown.economy.nextClaimSeq) {
          // 畫面上看到的收益已經被別的分頁領走
          this.set({ club: latest })
          return { ok: false, message: V2T.claimedElsewhere }
        }
        if (latest.economy.unclaimed.funds === 0 && latest.economy.unclaimed.experience === 0) {
          this.set({ club: latest })
          return { ok: false, message: V2T.nothingToClaim }
        }
        const out = await claim(this.deps, latest.economy.nextClaimSeq)
        if (this.disposed) return { ok: true }
        if (out.duplicate) {
          this.reload()
          return { ok: false, message: V2T.claimedElsewhere }
        }
        this.set({ club: out.club })
        return { ok: true, message: V2T.claimed(out.claimed.funds, out.claimed.experience) }
      } catch (e) {
        if (this.disposed) return { ok: false }
        return { ok: false, message: this.handleError(e, 'claim') }
      } finally {
        this.claimFlight = null
        if (!this.disposed) this.set({ claiming: false })
      }
    })()
    return this.claimFlight
  }

  /** 目前畫面上這份存檔的設定版本：草稿建立時記下來，儲存時交回來比對 */
  settingsVersions() {
    return this.current.club ? settingsVersions(this.current.club) : null
  }

  /**
   * 儲存陣容：先檢查合法，再交給 updateSettings（會先用舊陣容結算到期的比賽）。
   * baseVersion 是草稿建立時的陣容版本：別的分頁已經改過陣容就拒絕，不覆蓋
   */
  saveRoster(roster: PersistentRoster, baseVersion: string): Promise<ActionResult> {
    const issues = lineupIssues(roster)
    if (issues.length) return Promise.resolve({ ok: false, message: issues.join('；') })
    // 存檔只存球員編號：等級、能力以永久名單為準，畫面上的草稿不會蓋掉別人剛升的級
    return this.saveSettings({ roster: toAssignment(roster) }, { roster: baseVersion })
  }

  /**
   * 升級球員一級。expectedLevel 是畫面上看到的等級：別的分頁剛升過就拒絕，不會一次升兩級。
   * 操作序號取自最新存檔；連點只會送一次
   */
  upgrade(playerId: string, expectedLevel: number): Promise<SpendResult> {
    return this.spend((opSeq) => upgrade(this.deps, { opSeq, playerId, expectedLevel }), (out) => {
      const name = recordOf(out.club, playerId)?.player.name ?? ''
      return V2T.upgraded(name, out.op.toLevel ?? expectedLevel + 1)
    })
  }

  /**
   * 簽下候選名單裡的一位球員：加入預備名單，不會自動上場。
   * expectedCount 是畫面顯示候選名單時的招募次數（不從最新存檔重新取）：別的分頁剛招募過，服務會拒絕並要求重新選擇。
   * 只傳角色與候選位置，球員資料由服務層用最新存檔重建；連點只會送一次
   */
  recruit(role: RecruitRole, candidateIndex: number, expectedCount: number): Promise<SpendResult> {
    return this.spend(
      (opSeq) => recruit(this.deps, { opSeq, role, candidateIndex, expectedCount }),
      (out) => V2T.recruited(recordOf(out.club, out.op.playerId)?.player.name ?? ''),
    )
  }

  /**
   * 釋出一位預備球員（不可復原、不退款）。用最新存檔的陣容判斷：別的分頁剛把他排進陣容會被拒絕。
   * 畫面必須先讓玩家二次確認才呼叫
   */
  release(playerId: string): Promise<SpendResult> {
    const name = (this.current.club && recordOf(this.current.club, playerId)?.player.name) ?? ''
    return this.spend((opSeq) => release(this.deps, { opSeq, playerId }), () => V2T.released(name))
  }

  /**
   * 挑戰下一級聯盟。expected 是按鈕「畫面顯示時」的聯盟與挑戰序號：不從最新存檔重新取值，
   * 所以別的分頁已經晉級或挑戰過時，服務會在鎖內拒絕（stale-request），畫面重新載入，不會挑戰到玩家沒預期的聯盟。
   * 每次呼叫產生一個 requestId；連點只會送一次（single flight）。結果放在 state.challengeResult，畫面顯示後呼叫 dismissChallengeResult
   */
  challenge(expected: { fromTier: number; challengeSeq: number }): Promise<ActionResult> {
    if (this.challengeFlight) return this.challengeFlight
    if (!this.guard.canWrite()) return Promise.resolve({ ok: false, message: V2T.readOnly })
    this.challengeFlight = (async (): Promise<ActionResult> => {
      this.set({ challenging: true, error: null })
      try {
        const out = await challengeNextLeague(this.deps, { challengeSeq: expected.challengeSeq, fromTier: expected.fromTier, requestId: newRequestId() })
        if (this.disposed) return { ok: true }
        this.set({ club: out.club, challengeResult: out })
        return { ok: true }
      } catch (e) {
        if (this.disposed) return { ok: false }
        if (e instanceof LeagueError) {
          if (e.settled) this.set({ club: e.settled.club })
          if (e.code === 'stale-request') {
            this.reload()
            return { ok: false, message: V2T.challengeStale }
          }
          return { ok: false, message: e.code === 'not-eligible' ? V2T.challengeNotReady : e.message }
        }
        if (e instanceof SettlementError && e.code === 'simulation-failed') {
          this.reload()
          return { ok: false, message: V2T.challengeFailedToRun }
        }
        return { ok: false, message: this.handleError(e) }
      } finally {
        this.challengeFlight = null
        if (!this.disposed) this.set({ challenging: false })
      }
    })()
    return this.challengeFlight
  }

  /**
   * 新手任務「觀看第一場比賽」：成功進入直播後呼叫。已經記過、或這個分頁不能寫入就什麼都不做；
   * 失敗（例如別的分頁同時寫入）不打擾玩家，下次進入直播會再記一次
   */
  async markWatchedLive(): Promise<void> {
    if (this.disposed || !this.guard.canWrite() || this.current.club?.onboarding.watchedLive !== false) return
    try {
      const out = await markWatchedLive(this.deps)
      if (!this.disposed && out.changed) this.set({ club: out.club })
    } catch (e) {
      if (!this.disposed && e instanceof ClubSaveError && e.code === 'conflict') this.reload()
    }
  }

  /** 收合／展開新手任務區塊（存在球團存檔，重新整理、換分頁都一樣） */
  async setOnboardingCollapsed(collapsed: boolean): Promise<ActionResult> {
    if (!this.guard.canWrite()) return { ok: false, message: V2T.readOnly }
    if (this.current.club?.onboarding.collapsed === collapsed) return { ok: true }
    try {
      const out = await setOnboarding(this.deps, { collapsed })
      if (!this.disposed) this.set({ club: out.club })
      return { ok: true }
    } catch (e) {
      if (this.disposed) return { ok: false }
      return { ok: false, message: this.handleError(e) }
    }
  }

  dismissChallengeResult(): void {
    if (this.current.challengeResult) this.set({ challengeResult: null })
  }

  private spend(run: (opSeq: number) => Promise<SpendOutcome>, success: (out: SpendOutcome) => string): Promise<SpendResult> {
    if (this.spendFlight) return this.spendFlight
    if (!this.guard.canWrite()) return Promise.resolve({ ok: false, message: V2T.readOnly })
    this.spendFlight = (async (): Promise<SpendResult> => {
      this.set({ spending: true, error: null })
      try {
        const latest = this.deps.store.loadClub()
        if (!latest) {
          this.reload()
          return { ok: false, message: V2T.noClubAnymore }
        }
        const out = await run(latest.economy.nextOpSeq)
        if (this.disposed) return { ok: true, outcome: out }
        this.set({ club: out.club })
        return { ok: true, outcome: out, message: success(out) }
      } catch (e) {
        if (this.disposed) return { ok: false }
        if (e instanceof EconomyError) {
          // 支出被拒絕，但到期的比賽已經結算存檔：畫面換成存好的球團
          if (e.settled) this.set({ club: e.settled.club })
          // 畫面資料過期：讀進最新的，讓玩家看清楚再操作
          if (e.code === 'stale-request' || e.code === 'stale-candidates' || e.code === 'level-mismatch' || e.code === 'not-reserve') this.reload()
          return { ok: false, message: e.message }
        }
        return { ok: false, message: this.handleError(e) }
      } finally {
        this.spendFlight = null
        if (!this.disposed) this.set({ spending: false })
      }
    })()
    return this.spendFlight
  }

  /** 儲存戰術；baseVersion 是草稿建立時的戰術版本 */
  saveTactics(settings: TacticSettings, baseVersion: string): Promise<ActionResult> {
    let coach
    try {
      coach = toCoachSettings(settings)
    } catch (e) {
      return Promise.resolve({ ok: false, message: (e as Error).message })
    }
    return this.saveSettings({ coach }, { coach: baseVersion })
  }

  private async saveSettings(change: Parameters<typeof updateSettings>[1], expected: Parameters<typeof updateSettings>[2]): Promise<ActionResult> {
    if (this.current.saving) return { ok: false }
    if (!this.guard.canWrite()) return { ok: false, message: V2T.readOnly }
    this.set({ saving: true, error: null })
    try {
      const club = await updateSettings(this.deps, change, expected)
      if (this.disposed) return { ok: true }
      this.set({ club })
      return { ok: true, message: V2T.settingsSaved(club.strategy.effectiveFromMatch + 1) }
    } catch (e) {
      if (this.disposed) return { ok: false }
      if (e instanceof LineupError || e instanceof RangeError) return { ok: false, message: e.message }
      if (e instanceof SettlementError && e.code === 'settings-conflict') {
        // 讀進別的分頁存的最新設定；草稿留在畫面上，由玩家決定要不要捨棄
        this.reload()
        return { ok: false, conflict: true, message: V2T.settingsConflict }
      }
      return { ok: false, message: this.handleError(e) }
    } finally {
      if (!this.disposed) this.set({ saving: false })
    }
  }

  /**
   * 刪除 V2 存檔重新開始：只在存檔壞掉、版本不相容時由玩家明確確認後呼叫（畫面會先建議下載備份）。
   * 走上鎖的 resetClubSafely，只動 V2 的 key
   */
  async resetClub(): Promise<ActionResult> {
    if (!this.guard.canWrite()) return { ok: false, message: V2T.readOnly }
    try {
      await resetClubSafely(this.deps)
      this.reload()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: e instanceof ClubSaveError ? V2T.writeFailed : V2T.unknownError }
    }
  }

  /** 讓這個分頁變成可寫分頁（沒有 Web Locks 時） */
  takeOver(): void {
    this.guard.takeOver()
    this.reload()
    void this.settle('resume')
  }

  /** 離開畫面：中斷進行中的結算，之後的 async 結果都不再更新畫面 */
  dispose(): void {
    this.abort?.abort()
    this.disposed = true
    this.unsubscribeGuard()
    this.events?.removeEventListener('storage', this.onStorage)
    this.listeners.clear()
  }

  /** 把錯誤轉成玩家看得懂的狀態；回傳訊息 */
  private handleError(e: unknown, retry?: RetryAction): string {
    if (e instanceof ClubSaveError) {
      switch (e.code) {
        case 'conflict':
          this.reload()
          this.set({ notice: V2T.conflictReloaded })
          return V2T.conflictReloaded
        case 'read-only':
          // 別的分頁剛接手：這次沒有寫入，畫面換成唯讀
          this.reload()
          this.set({ canWrite: this.guard.canWrite(), notice: V2T.lostWriter })
          return V2T.lostWriter
        case 'write-failed':
          this.set({ error: { message: V2T.writeFailed, retry } })
          return V2T.writeFailed
        default: {
          const status = brokenStatus(e)
          this.set({ status, club: null })
          return status.kind === 'broken' ? status.message : V2T.unknownError
        }
      }
    }
    if (e instanceof SettlementError) {
      if (e.code === 'no-club') {
        this.reload()
        return V2T.noClubAnymore
      }
      this.set({ error: { message: V2T.simulationFailed, retry } })
      return V2T.simulationFailed
    }
    const message = V2T.unknownError
    this.set({ error: { message, retry } })
    return message
  }

  private set(patch: Partial<ControllerState>): void {
    if (this.disposed) return
    this.current = { ...this.current, ...patch }
    for (const l of this.listeners) l(this.current)
  }
}

/** 一次挑戰操作的識別碼：只用來分辨重送與不同的請求，不需要密碼學強度 */
function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function brokenStatus(e: unknown): V2Status {
  if (e instanceof ClubSaveError) {
    if (e.code === 'migration-failed') return { kind: 'broken', reason: 'migration-failed', message: `${V2T.migrationFailed}（${e.message}）` }
    if (e.code === 'read-only' || e.code === 'needs-migration') return { kind: 'broken', reason: 'migration-blocked', message: V2T.migrationBlocked }
    if (e.code === 'unsupported-version') return { kind: 'broken', reason: 'unsupported-version', message: V2T.unsupportedVersion }
    if (e.code === 'storage-unavailable') return { kind: 'broken', reason: 'storage-unavailable', message: V2T.storageUnavailable }
    if (e.code === 'invalid-json' || e.code === 'invalid-schema') return { kind: 'broken', reason: 'invalid', message: V2T.corruptSave }
  }
  return { kind: 'broken', reason: 'invalid', message: V2T.unknownError }
}
