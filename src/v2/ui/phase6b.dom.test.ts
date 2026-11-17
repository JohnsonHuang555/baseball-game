// @vitest-environment happy-dom
// Phase 6B：直播的精彩時刻演出與「結果揭露時間」。用虛擬時鐘播完整場，記錄每一個特效、比分條更新出現的時間，
// 確認任何揭露結果的畫面都不早於那一格的正式提交時間（LiveSchedule.endOf），最終勝負不早於 endsAt。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateRoster } from '../../sim/generate'
import { Rng } from '../../sim/rng'
import type { SoundName } from '../../ui/sound'
import { planMatch } from '../application/batchRunner'
import { liveTimeline, type LiveTimeline } from '../application/liveMatch'
import type { LiveClock, LiveSource } from '../application/livePlayer'
import { clutchSituation, frameMoment, type FrameMoment } from '../application/matchMoments'
import type { ReplayState } from '../application/replayPlayer'
import { newClub } from '../domain/club'
import { CLUB_STORAGE_KEY, MemoryStorage } from '../infrastructure/clubRepository'
import { FakeLockManager, MINUTE, ManualClock, T0, tab } from '../testkit'
import { openV2, type V2App } from './app'
import { openMatchViewer, type MatchViewerHandle, type ReplayStage } from './replayView'

const START = 10_000_000
const club = newClub({ clubId: 'club-6b', clubName: '精彩隊', clubSeed: 61, roster: generateRoster(new Rng(61)), now: 0 })

interface Scan {
  index: number
  live: LiveTimeline
  moments: FrameMoment[]
  befores: ReplayState[]
}
const scans: Scan[] = []
function scan(i: number): Scan {
  if (!scans[i]) {
    const live = liveTimeline(planMatch(club, i))
    const befores = [live.timeline.initial, ...live.timeline.frames.map((f) => f.after)]
    scans[i] = { index: i, live, befores, moments: live.timeline.frames.map((f, j) => frameMoment(befores[j], f, live.timeline.userSide)) }
  }
  return scans[i]
}
/** 找第一場符合條件的比賽 */
function find(pred: (s: Scan) => boolean, limit = 400): Scan {
  for (let i = 0; i < limit; i++) if (pred(scan(i))) return scan(i)
  throw new Error('找不到符合條件的比賽')
}
const source = (s: Scan): LiveSource => ({ matchIndex: s.index, matchId: `m${s.index}`, startsAt: START, endsAt: START + 5 * MINUTE, timeline: s.live.timeline, schedule: s.live.schedule })

const stage = (): ReplayStage => {
  let alignment: ReplayStage['alignment'] = 'normal'
  const anim = () => Promise.resolve()
  return {
    elements: [document.createElement('canvas')],
    setColors: () => undefined,
    align: (a) => ((alignment = a), anim()),
    sync: () => undefined,
    pitch: anim,
    play: anim,
    run: anim,
    cancel: () => undefined,
    resize: () => undefined,
    get alignment() {
      return alignment
    },
  }
}

/** 虛擬時鐘：sleep 推進時間；stopAt 之後停住 */
function clock(t: number) {
  const c = {
    t,
    stopAt: Infinity,
    now: () => c.t,
    async sleep(ms: number, signal: AbortSignal) {
      if (signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' })
      c.t = Math.min(c.t + Math.max(0, ms), Math.max(c.t, c.stopAt))
      await new Promise((r) => setTimeout(r, 0))
      if (signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' })
    },
  }
  return c as typeof c & LiveClock
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

interface Rec {
  t: number
  kind: string
  label: string
}

let viewer: MatchViewerHandle | null = null
let app: V2App | null = null
afterEach(() => {
  viewer?.close()
  viewer = null
  app?.close()
  app = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function watch(s: Scan, at: number, o: { stopAt?: number; reduced?: boolean } = {}) {
  const c = clock(at)
  if (o.stopAt !== undefined) c.stopAt = o.stopAt
  const recs: Rec[] = []
  const sounds: { t: number; name: SoundName }[] = []
  viewer = openMatchViewer({
    mode: 'live',
    title: 'test',
    source: source(s),
    clock: c,
    createStage: stage,
    timeScale: 0,
    reducedMotion: o.reduced ?? false,
    sound: (name) => sounds.push({ t: c.now(), name }),
    onEffect: (e) => recs.push({ t: c.now(), ...e }),
  })
  return { c, recs, sounds, player: () => viewer!.live()! }
}
async function untilEnded(): Promise<void> {
  for (let i = 0; i < 3000 && viewer?.live()?.view.status !== 'ended'; i++) await flush(2)
}

/** 開賽後 t 毫秒時已經正式提交的格數 */
const committed = (s: Scan, t: number) => (t >= START + 5 * MINUTE ? s.live.timeline.frames.length : s.live.schedule.positionAt(t - START))
const stateAt = (s: Scan, p: number) => s.befores[Math.min(p, s.befores.length - 1)]

describe('結果揭露時間（P0）', () => {
  it('整場：每一個大字、橫幅、轉場都屬於「已經提交的最後一格」；比分條永遠不超過已提交的比分；勝負只在 endsAt 之後', async () => {
    const s = find((x) => x.moments.some((m) => m.homeRun) && x.moments.some((m) => m.strikeout) && x.moments.some((m) => m.kinds.includes('tieGame') || m.kinds.includes('takeLead')))
    const { recs } = watch(s, START)
    await untilEnded()
    const end = START + 5 * MINUTE
    const frames = s.live.timeline.frames
    let checked = 0
    for (const r of recs) {
      const p = committed(s, r.t)
      if (r.kind === 'board') {
        const [away, home] = r.label.split(':').map(Number)
        const ok = stateAt(s, p)
        expect(away).toBeLessThanOrEqual(ok.score.away)
        expect(home).toBeLessThanOrEqual(ok.score.home)
        if (r.label.endsWith('over')) expect(r.t).toBeGreaterThanOrEqual(end)
        continue
      }
      if (r.kind === 'final') {
        expect(r.t).toBeGreaterThanOrEqual(end)
        continue
      }
      if (r.kind === 'clutch') continue
      // 揭曉的一定是已經提交的最後一格（第 p − 1 格），不會是還沒提交的那一格
      const j = p - 1
      expect(j).toBeGreaterThanOrEqual(0)
      const m = s.moments[j]
      const ev = frames[j].events
      if (r.label.includes('全壘打')) expect(m.homeRun).not.toBeNull()
      else if (r.label === 'K') expect(m.strikeout).not.toBeNull()
      else if (r.label.includes('雙殺')) expect(m.doublePlay).not.toBeNull()
      else if (/追平|超前|逆轉|得 \d 分/.test(r.label)) expect(m.runs).toBeGreaterThan(0)
      else if (r.label.includes('再見')) {
        expect(m.walkOff).toBe(true)
        expect(r.t).toBeGreaterThanOrEqual(end)
      } else if (r.kind === 'transition') expect(ev.some((e) => e.type === 'halfInningEnd')).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(10)
    // 一路看到底：每一支全壘打、每一次三振都有演出，而且只演一次
    const hrFrames = s.moments.filter((m) => m.homeRun && !m.walkOff).length
    expect(recs.filter((r) => r.kind === 'callout' && r.label.includes('全壘打'))).toHaveLength(hrFrames)
    expect(recs.filter((r) => r.kind === 'callout' && r.label === 'K')).toHaveLength(s.moments.filter((m) => m.strikeout).length)
    expect(recs.filter((r) => r.kind === 'final')).toHaveLength(1)
  })

  it('全壘打大字不早於那一格的提交時間；提交前（懸念段）畫面上沒有任何揭曉', async () => {
    const s = find((x) => x.moments.some((m) => m.homeRun && !m.walkOff))
    const j = s.moments.findIndex((m) => m.homeRun && !m.walkOff)
    const commitAt = START + s.live.schedule.endOf(j)
    // 從這一格開始前一點點進來，時間停在提交前 1 毫秒
    const { c, recs } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: commitAt - 1 })
    await flush(60)
    expect(c.now()).toBe(commitAt - 1)
    expect(recs.filter((r) => r.kind === 'callout' && r.label.includes('全壘打'))).toEqual([])
    const before = stateAt(s, j)
    expect(document.querySelector('[data-score="us"]')!.textContent).toBe(String(before.score[s.live.timeline.userSide]))
    expect(document.querySelector('.v2-replay-last')!.textContent).not.toContain('全壘打')
    // 時間到：提交、揭曉
    c.stopAt = Infinity
    for (let i = 0; i < 200 && !recs.some((r) => r.label.includes('全壘打')); i++) await flush(2)
    const hr = recs.find((r) => r.kind === 'callout' && r.label.includes('全壘打'))!
    expect(hr.t).toBeGreaterThanOrEqual(commitAt)
    expect(hr.t).toBeLessThan(START + s.live.schedule.endOf(j + 1))
  })

  it('落後時同步：跳過的格不補演（沒有舊的大字），暫停後繼續也不重演已經演過的特效與音效', async () => {
    const s = find((x) => x.moments.filter((m) => m.homeRun && !m.walkOff).length >= 1)
    const j = s.moments.findIndex((m) => m.homeRun && !m.walkOff)
    const { c, recs, sounds, player } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: START + s.live.schedule.endOf(j + 1) - 1 })
    for (let i = 0; i < 200 && !recs.some((r) => r.label.includes('全壘打')); i++) await flush(2)
    expect(recs.filter((r) => r.label.includes('全壘打'))).toHaveLength(1)
    const roars = sounds.filter((x) => x.name === 'roar' || x.name === 'pop').length
    player().pause()
    player().resume()
    await flush(30)
    player().pause()
    player().resume()
    await flush(30)
    expect(recs.filter((r) => r.label.includes('全壘打'))).toHaveLength(1)
    expect(sounds.filter((x) => x.name === 'roar' || x.name === 'pop').length).toBe(roars)
    // 時間一口氣跳到 2 分鐘後：直接同步，中間的格不演
    const jump = START + 4 * MINUTE
    const before = recs.length
    c.t = jump
    c.stopAt = jump + 1
    player().pause()
    player().resume()
    await flush(40)
    const after = recs.slice(before).filter((r) => r.kind === 'callout' || r.kind === 'banner' || r.kind === 'transition')
    const p = committed(s, jump)
    for (const r of after) expect(r.t).toBeGreaterThanOrEqual(START + s.live.schedule.endOf(p - 1))
    expect(after.length).toBeLessThanOrEqual(1)
  })
})

describe('精彩時刻的演出', () => {
  it('我方再見：endsAt 之後才演「再見」，同一個大型演出只演一次，接著顯示勝負', async () => {
    const s = find((x) => x.moments.at(-1)!.walkOff && x.moments.at(-1)!.ours, 600)
    const last = s.live.timeline.frames.length - 1
    const { recs, sounds } = watch(s, START + s.live.schedule.startOf(last) + 1)
    await untilEnded()
    const walk = recs.filter((r) => r.kind === 'callout' && r.label.includes('再見'))
    expect(walk).toHaveLength(1)
    expect(walk[0].t).toBeGreaterThanOrEqual(START + 5 * MINUTE)
    expect(recs.filter((r) => r.kind === 'celebrate' && r.label.startsWith('huge'))).toHaveLength(1)
    expect(sounds.filter((x) => x.name === 'champion')).toHaveLength(1)
    const finalAt = recs.findIndex((r) => r.kind === 'final')
    expect(finalAt).toBeGreaterThan(recs.indexOf(walk[0]))
    expect(document.querySelector('.v2-replay-verdict')!.textContent).toBe('勝')
  })

  it('對手全壘打：客觀播報，不放我方的勝利效果與歡呼', async () => {
    const s = find((x) => x.moments.some((m) => m.homeRun && !m.ours && !m.walkOff))
    const j = s.moments.findIndex((m) => m.homeRun && !m.ours && !m.walkOff)
    const { recs, sounds } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: START + s.live.schedule.endOf(j + 1) - 1 })
    for (let i = 0; i < 200 && !recs.some((r) => r.label.includes('全壘打')); i++) await flush(2)
    const hr = recs.find((r) => r.label.includes('全壘打'))!
    expect(hr.label).toMatch(/^對手/)
    expect(recs.some((r) => r.kind === 'celebrate' && r.label.includes('good'))).toBe(false)
    expect(sounds.some((x) => x.name === 'roar' || x.name === 'cheer' || x.name === 'champion')).toBe(false)
  })

  it('滿貫全壘打：滿貫大字、更強的效果、打點 4 分', async () => {
    const s = find((x) => x.moments.some((m) => m.kinds.includes('grandSlam') && m.ours && !m.walkOff), 2000)
    const j = s.moments.findIndex((m) => m.kinds.includes('grandSlam') && m.ours && !m.walkOff)
    const { recs } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: START + s.live.schedule.endOf(j + 1) - 1 })
    for (let i = 0; i < 200 && !recs.some((r) => r.label.includes('全壘打')); i++) await flush(2)
    expect(recs.find((r) => r.kind === 'callout')!.label).toBe('滿貫全壘打！')
    expect(recs.some((r) => r.kind === 'celebrate' && r.label === 'huge:good')).toBe(true)
    expect(document.querySelector('.callout-sub')!.textContent).toContain('4 分打點')
  })

  it('關鍵打席：在投球前（提交前）就顯示，判定只用之前的狀態；同一個打席只響一次提示音', async () => {
    const s = find((x) => x.befores.slice(0, -1).some((b) => clutchSituation(b, x.live.timeline.userSide)?.level === 'high'))
    const j = s.befores.slice(0, -1).findIndex((b) => clutchSituation(b, s.live.timeline.userSide)?.level === 'high')
    const { c, recs, sounds } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: START + s.live.schedule.endOf(j) - 1 })
    await flush(40)
    expect(c.now()).toBeLessThan(START + s.live.schedule.endOf(j))
    expect(recs.some((r) => r.kind === 'clutch' && r.label === 'high')).toBe(true)
    expect(document.querySelector('.v2-fx-clutch')!.hasAttribute('hidden')).toBe(false)
    expect(sounds.filter((x) => x.name === 'alert')).toHaveLength(1)
  })

  it('降低動態效果：不閃光、不撒彩帶，但大字與資訊照樣顯示', async () => {
    const s = find((x) => x.moments.some((m) => m.homeRun && m.ours && !m.walkOff))
    const j = s.moments.findIndex((m) => m.homeRun && m.ours && !m.walkOff)
    const { recs } = watch(s, START + s.live.schedule.startOf(j) + 1, { stopAt: START + s.live.schedule.endOf(j + 1) - 1, reduced: true })
    for (let i = 0; i < 200 && !recs.some((r) => r.label.includes('全壘打')); i++) await flush(2)
    expect(document.querySelector('.v2-replay')!.classList.contains('reduced-motion')).toBe(true)
    expect(recs.find((r) => r.kind === 'celebrate')!.label).toContain(':reduced')
    expect(document.querySelector('.v2-fx-confetti')!.children).toHaveLength(0)
    expect(document.querySelector('.v2-fx-flash')!.className).toBe('v2-fx-flash')
    expect(recs.some((r) => r.kind === 'callout' && r.label.includes('全壘打'))).toBe(true)
  })
})

describe('生命週期', () => {
  it('快速開關 10 次：不留下計時器、監聽器、播放迴圈；關閉後不再有任何特效或音效', async () => {
    const s = scan(0)
    const addDoc = vi.spyOn(document, 'addEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const setI = vi.spyOn(globalThis, 'setInterval')
    const clearI = vi.spyOn(globalThis, 'clearInterval')
    const all: Rec[] = []
    const sounds: SoundName[] = []
    for (let i = 0; i < 10; i++) {
      const c = clock(START + i * 20_000)
      const v = openMatchViewer({ mode: 'live', title: 't', source: source(s), clock: c, createStage: stage, timeScale: 0, sound: (n) => sounds.push(n), onEffect: (e) => all.push({ t: c.now(), ...e }) })
      await flush(i % 3)
      v.close()
      expect(v.live()!.view.status).toBe('disposed')
    }
    const count = all.length
    const soundCount = sounds.length
    await flush(60)
    expect(all.length).toBe(count)
    expect(sounds.length).toBe(soundCount)
    expect(document.querySelectorAll('.v2-replay-overlay')).toHaveLength(0)
    const vis = (spy: typeof addDoc) => spy.mock.calls.filter(([type]) => type === 'visibilitychange').length
    expect(vis(addDoc)).toBe(vis(removeDoc))
    expect(setI.mock.calls.length).toBe(clearI.mock.calls.length)
  })
})

describe('資料安全：觀戰只是播放', () => {
  it('看兩分鐘直播（含揭曉與特效）再離開：revision、戰績、經濟、聯盟、球員、陣容、放置進度、固定計畫、近期比賽一個字都沒變', async () => {
    const storage = new MemoryStorage()
    const clockM = new ManualClock(T0)
    const locks = new FakeLockManager()
    const deps = tab(storage, clockM, locks)
    await (await import('../application/clubLifecycle')).createClubSafely(deps, { clubName: '安全隊', clubSeed: 7, clubId: 'club-safe' })
    // 新手任務的觀戰旗標先記好（Phase 6A 只在第一次觀戰寫一次），這裡驗證之後的觀戰完全不寫入
    const c0 = deps.store.loadClub()!
    deps.store.saveClub({ ...c0, onboarding: { ...c0.onboarding, watchedLive: true } }, c0.revision)
    clockM.set(T0 + 12 * MINUTE)
    const root = document.createElement('div')
    document.body.append(root)
    const live = clock(T0 + 12 * MINUTE)
    live.stopAt = T0 + 14 * MINUTE
    app = openV2(root, () => undefined, { deps: tab(storage, clockM, locks), tickMs: 0, tabId: 'safe', replayStage: stage, replayTimeScale: 0, liveClock: live })
    await flush(40)
    const before = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    document.querySelector<HTMLButtonElement>('[data-action="watch-live"]')!.click()
    for (let i = 0; i < 100 && !document.querySelector('.v2-replay-overlay'); i++) await flush(2)
    for (let i = 0; i < 2000 && live.now() < T0 + 14 * MINUTE; i++) await flush(2)
    expect(live.now()).toBe(T0 + 14 * MINUTE)
    document.querySelector<HTMLButtonElement>('[data-action="replay-back"]')!.click()
    await flush(10)
    const after = JSON.parse(storage.getItem(CLUB_STORAGE_KEY)!)
    for (const key of ['revision', 'record', 'economy', 'league', 'players', 'roster', 'idle', 'liveMatch', 'recentMatches', 'onboarding']) expect(after[key]).toEqual(before[key])
    expect(storage.getItem(CLUB_STORAGE_KEY)).toBe(JSON.stringify(before))
  })
})
