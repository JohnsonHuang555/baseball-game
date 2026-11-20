// 球員詳情：名稱、流派、特性、等級，以及每項能力的「原始 → 目前（比賽實際使用）→ 下一級」、升級成本與升級按鈕。
// 升級預覽（Phase 6A）：目前等級 → 下一級、會提升的能力與變化量、整體能力；數字全部由 progression.ts 的 leveled() 算出來，
// 沒有提升的能力不顯示增加。升級成功後在畫面上留一段回饋，說明新能力從下一場尚未開始的比賽生效。
// 預備球員另外有「釋出球員」：按下後要再確認一次才會釋出（不可復原、不退款）。
// 打開時跟著 controller 的狀態更新（升級、其他分頁改了都會重畫），關閉時取消訂閱
import { gradeBadge } from '../../ui/grades'
import { el } from '../../ui/playerCard'
import { RATING_FULL } from '../../ui/strings'
import { archetypeChip, captainIcon } from '../../ui/synergyUi'
import { captainIn, captainWeight } from '../../sim/synergy'
import { ARCHETYPE_NAMES } from '../../ui/strings'
import { resolveRoster } from '../domain/roster'
import { pitchChip, toast, traitList } from '../../ui/visual'
import { traitTag } from '../../ui/playerCard'
import { avatar } from '../../ui/avatar'
import { archetypeSvg } from '../../ui/synergyIcons'
import { POSITION_SPOT } from '../../ui/strings'
import { icon } from './icons'
import { overall } from '../../sim/generate'
import type { Player } from '../../sim/types'
import { canAfford } from '../application/economyService'
import { MAX_LEVEL, leveled, upgradeCost } from '../domain/progression'
import { assignedIds, recordOf } from '../domain/roster'
import { betterUpgrade, teamPower, teamPowerIf } from '../domain/growthInfo'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './dialog'
import { V2T } from './strings'
import { ST } from './statsStrings'
import { statsPanel } from './statsView'
import { trainingPanel, type TrainingPanelState } from './trainingPanel'
import { effectiveTraits } from '../domain/traitTraining'
import { openMatchReport } from './reportView'
import type { StatPeriod } from '../application/statsQuery'

const fmt = (x: number) => x.toLocaleString('zh-Hant')
const fmt2 = (x: number) => (Math.round(x * 100) / 100).toFixed(2)
const ratingsOf = (p: Player) => p.ratings as unknown as Record<string, number>

/** 從 before 到 after，每項能力的變化（只列有提升的）與整體能力 */
export function upgradeGains(before: Player, after: Player): { gains: { key: string; from: number; to: number }[]; overall: { from: number; to: number } } {
  const gains = Object.keys(before.ratings)
    .map((key) => ({ key, from: ratingsOf(before)[key], to: ratingsOf(after)[key] }))
    .filter((g) => Math.round((g.to - g.from) * 100) > 0)
  return { gains, overall: { from: overall(before), to: overall(after) } }
}

/** 球員現在在哪裡：先發第幾棒守什麼（本職）、板凳、先發投手、後援、預備名單 */
function whereText(club: ControllerState['club'] & object, p: Player): string {
  const a = club.roster
  const native = p.role === 'batter' ? POSITION_SPOT[p.primary] : ''
  const i = a.lineup.findIndex((s) => s.playerId === p.id)
  if (i >= 0) {
    const pos = a.lineup[i].position
    const off = p.role === 'batter' && pos !== 'DH' && pos !== p.primary
    return V2T.whereStarter(i + 1, POSITION_SPOT[pos], off ? native : null)
  }
  if (a.bench.includes(p.id)) return V2T.whereBench(native)
  if (a.starter === p.id) return V2T.starterPitcher
  if (a.relievers.includes(p.id)) return V2T.relievers
  return p.role === 'batter' ? V2T.whereReserve(native) : V2T.whereReservePitcher
}

export interface PlayerDetailOptions {
  /** 一開始停在哪個分頁：從養成入口進來是能力（預設），從數據入口（排行、戰報）進來是比賽數據 */
  tab?: 'ability' | 'stats'
  period?: StatPeriod
}

/**
 * 球員詳情（Phase 8 起分成「球員能力」「比賽數據」兩個分頁）。已釋出的球員沒有能力資料，只顯示比賽數據（唯讀）
 */
export function openPlayerDetail(controller: ClubController, playerId: string, opts: PlayerDetailOptions = {}): () => void {
  let tab: 'ability' | 'stats' = opts.tab ?? 'ability'
  let period: StatPeriod = opts.period ?? 'last30'
  const body = el('div', 'v2-player-detail')
  const header = el('div', 'v2-detail-head')
  const footer = el('div', 'v2-detail-foot')
  /** 已經按過「釋出球員」、正在等第二次確認 */
  let confirming = false
  /** 特性養成：正在確認哪一項、是否正在確認取消 */
  const trainingUi: TrainingPanelState = { picking: null, cancelling: false }
  /** 剛完成的升級（顯示成功回饋）：升到幾級、哪些能力提升、從第幾場生效 */
  let done: { level: number; gains: ReturnType<typeof upgradeGains>; fromMatch: number } | null = null
  let close: () => void = () => {}
  /** 取消第二次確認：回到面板，焦點放回「釋出球員」 */
  const cancelConfirm = () => {
    confirming = false
    draw(controller.state)
    body.querySelector<HTMLButtonElement>('[data-action="release"]')?.focus({ preventScroll: true })
  }
  /** 分頁列：球員能力／比賽數據；已釋出的球員沒有能力分頁 */
  const tabsBar = (released: boolean) => {
    const bar = el('div', 'v2-detail-tabs')
    bar.setAttribute('role', 'tablist')
    bar.setAttribute('aria-label', ST.tabsLabel)
    for (const [key, label] of [['stats', ST.tabStats], ['ability', ST.tabAbility]] as const) {
      const b = el('button', `v2-detail-tab${tab === key ? ' on' : ''}`, label)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(tab === key))
      b.dataset.tab = key
      b.disabled = released && key === 'ability'
      b.onclick = () => {
        if (tab === key) return
        tab = key
        draw(controller.state)
        body.querySelector<HTMLButtonElement>(`[data-tab="${key}"]`)?.focus({ preventScroll: true })
      }
      bar.append(b)
    }
    return bar
  }
  const statsBody = (club: NonNullable<ControllerState['club']>) =>
    statsPanel(club, playerId, {
      period,
      onPeriod: (p) => {
        period = p
        draw(controller.state)
        body.querySelector<HTMLButtonElement>(`.v2-period [data-value="${p}"]`)?.focus({ preventScroll: true })
      },
      onOpenMatch: (m) => void openMatchReport(m, club, controller, (id) => void openPlayerDetail(controller, id, { tab: 'stats', period })),
    })
  const draw = (state: ControllerState) => {
    const club = state.club
    const record = club ? recordOf(club, playerId) : undefined
    const career = club?.stats.players[playerId]
    if (club && !record && career) {
      // 已釋出：名字、狀態，只有比賽數據
      tab = 'stats'
      const face = el('span', 'v2-detail-face released')
      face.append(avatar(playerId, 'user', 'v2-detail-avatar'))
      const words = el('span', 'v2-detail-words')
      const titleLine = el('span', 'v2-detail-name')
      titleLine.append(el('strong', '', career.name))
      words.append(titleLine, el('span', 'v2-detail-where', ST.releasedStatus))
      header.replaceChildren(face, words)
      footer.replaceChildren()
      body.replaceChildren(tabsBar(true), statsBody(club), el('p', 'v2-hint', ST.releasedNoAbility))
      return
    }
    if (!club || !record) {
      header.replaceChildren()
      footer.replaceChildren()
      body.replaceChildren(el('p', 'v2-empty', V2T.noClubAnymore))
      return
    }
    const base = record.player
    const current = leveled(base, record.level)
    const cost = upgradeCost(record.level)
    const next = cost ? leveled(base, record.level + 1) : null

    // 標題列：頭像（流派標在右上）、名字與等級、現在在哪裡、流派與特性
    const face = el('span', 'v2-detail-face')
    face.append(avatar(base.id, 'user', 'v2-detail-avatar'))
    if (base.role === 'batter') {
      const arch = el('span', 'v2-player-arch')
      arch.innerHTML = archetypeSvg(base.archetype, 20)
      face.append(arch)
    }
    const words = el('span', 'v2-detail-words')
    const titleLine = el('span', 'v2-detail-name')
    titleLine.append(el('strong', '', base.name), el('span', 'v2-level big', V2T.level(record.level)))
    const chips = el('span', 'v2-detail-chips')
    chips.append(base.role === 'batter' ? archetypeChip(base) : pitchChip(base))
    // 特性：比賽實際用的（原生去掉已改善的、加上訓練習得的）
    const effTraits = effectiveTraits(record)
    if (effTraits.length) chips.append(traitTag(effTraits[0]))
    // 隊長（存檔裡的陣容）：頭像上的 C，加上看得懂的中文說明
    const isCaptain = base.role === 'batter' && captainIn(resolveRoster(club).lineup, club.roster.captain) === base.id
    if (isCaptain) {
      face.append(captainIcon(18))
      chips.append(el('span', 'v2-captain-chip', '隊長 C'))
    }
    words.append(titleLine, el('span', 'v2-detail-where', whereText(club, base)), chips)
    header.replaceChildren(face, words)

    if (tab === 'stats') {
      footer.replaceChildren()
      body.classList.remove('max')
      body.replaceChildren(tabsBar(false), statsBody(club))
      return
    }

    // 能力表：原始（Lv.1）、目前（比賽實際用的）、下一級
    const table = el('table', 'v2-rating-table')
    const hr = el('tr')
    hr.append(el('th', '', V2T.ratingCol), el('th', '', V2T.baseRating), el('th', 'current', V2T.currentRatingLong), el('th', '', next ? V2T.nextRating : ''))
    const thead = el('thead')
    thead.append(hr)
    const tbody = el('tbody')
    table.append(thead, tbody)
    for (const key of Object.keys(base.ratings)) {
      const tr = el('tr')
      tr.dataset.rating = key
      const b = ratingsOf(base)[key]
      const c = ratingsOf(current)[key]
      const cur = el('td', 'current')
      cur.append(gradeBadge(c, 'sm'), el('span', 'v2-num', fmt2(c)))
      const nx = el('td', 'next')
      if (next) {
        const n = ratingsOf(next)[key]
        const diff = Math.round((n - c) * 100) / 100
        // 沒有提升（已達上限）就照實顯示，不放假的增加
        nx.append(el('span', diff > 0 ? 'v2-num up' : 'v2-num', diff > 0 ? fmt2(n) : c >= 10 ? V2T.ratingCapped : fmt2(n)))
      }
      tr.append(el('th', '', RATING_FULL[key as keyof typeof RATING_FULL]), el('td', 'base', fmt2(b)), cur, nx)
      tbody.append(tr)
    }

    // 升級預覽：Lv.N → Lv.N+1、會提升的能力（變化量）、整體能力、球隊戰力
    const preview = el('section', 'v2-upgrade-preview')
    preview.setAttribute('aria-label', V2T.upgradePreview)
    let better: ReturnType<typeof betterUpgrade> = null
    if (next) {
      const g = upgradeGains(current, next)
      const top = el('div', 'v2-preview-head')
      const levels = el('strong', 'v2-preview-levels')
      levels.setAttribute('aria-label', V2T.upgradeLevels(record.level, record.level + 1))
      levels.append(el('span', '', V2T.level(record.level)), ' → ', el('span', 'to', V2T.level(record.level + 1)))
      top.append(el('span', 'v2-preview-title', V2T.upgradePreview), levels)
      const list = el('ul', 'v2-preview-list')
      for (const x of g.gains) {
        const li = el('li')
        li.dataset.gain = x.key
        li.append(el('span', 'v2-preview-name', RATING_FULL[x.key as keyof typeof RATING_FULL]), el('span', 'v2-preview-val', `${fmt2(x.from)} → ${fmt2(x.to)}`), el('span', 'v2-diff up', `+${fmt2(x.to - x.from)}`))
        list.append(li)
      }
      if (!g.gains.length) list.append(el('li', 'v2-hint', V2T.upgradeNoGain))
      const sum = el('ul', 'v2-preview-sum')
      const ov = el('li', 'v2-preview-overall')
      ov.append(el('span', 'v2-preview-name', V2T.upgradeOverall), el('span', 'v2-preview-val', `${fmt2(g.overall.from)} → ${fmt2(g.overall.to)}`))
      // 球隊戰力（上場 14 人的平均能力）的變化；預備球員升級不會改變目前的戰力
      const tp = el('li', 'v2-preview-team')
      tp.dataset.teamPower = ''
      const after = teamPowerIf(club, playerId, record.level + 1)
      tp.append(el('span', 'v2-preview-name', V2T.teamPower), el('span', 'v2-preview-val', after === null ? V2T.unchanged : `${fmt2(teamPower(club))} → ${fmt2(after)}`))
      sum.append(ov, tp)
      preview.append(top, list, sum, el('p', 'v2-preview-note', after === null ? `${V2T.upgradeReserveTeam}。${V2T.upgradeEffective}` : V2T.upgradeEffective))
      // 同樣的經驗升別人明顯划算時提醒（只是資訊，不阻止升級）
      better = assignedIds(club.roster).has(playerId) ? betterUpgrade(club, playerId) : null
    }

    // 底部：成本（需要多少、持有多少，不夠的那格變紅）與升級按鈕
    const button = el('button', 'btn-yellow v2-upgrade-btn')
    button.type = 'button'
    const foot: HTMLElement[] = []
    if (!cost) {
      button.textContent = V2T.maxLevel
      button.disabled = true
    } else {
      const affordable = canAfford(club, cost)
      const line = el('div', 'v2-cost')
      line.setAttribute('aria-label', V2T.upgradeCostLabel)
      const have = club.economy.assets
      const item = (kind: 'funds' | 'exp', need: number, owned: number) => {
        const box = el('div', `v2-cost-item ${kind} ${owned >= need ? '' : 'short'}`)
        box.setAttribute('aria-label', `${kind === 'funds' ? V2T.funds : V2T.experience} ${fmt(need)}（${V2T.owned} ${fmt(owned)}）`)
        const t = el('span', 'v2-cost-text')
        t.append(el('span', 'v2-cost-need', fmt(need)), el('span', 'v2-cost-have', `${V2T.owned} ${fmt(owned)}`))
        box.append(icon(kind === 'funds' ? 'coin' : 'exp', 20), t)
        return box
      }
      line.append(item('funds', cost.funds, have.funds), item('exp', cost.experience, have.experience))
      foot.push(line)
      if (!affordable) {
        foot.push(el('p', 'v2-cost-short', V2T.lackText(Math.max(0, cost.experience - have.experience), Math.max(0, cost.funds - have.funds))))
      }
      button.textContent = state.spending ? V2T.upgrading : V2T.upgradeButton(record.level + 1)
      button.disabled = !affordable || state.spending || !state.canWrite
      button.onclick = async () => {
        button.disabled = true
        const before = current
        const res = await controller.upgrade(playerId, record.level)
        const saved = res.ok && res.outcome ? recordOf(res.outcome.club, playerId) : undefined
        if (saved && res.outcome) {
          // 進行中那一場已經固定（用升級前的能力）：新能力從下一場開始，也就是第 nextMatchIndex + 2 場（從 1 數）
          done = { level: saved.level, gains: upgradeGains(before, leveled(base, saved.level)), fromMatch: res.outcome.club.idle.nextMatchIndex + 2 }
          toast(V2T.upgradeToast(base.name, saved.level), 'success')
          draw(controller.state)
        } else if (res.message) toast(res.message, 'error')
      }
    }
    foot.push(button)
    footer.replaceChildren(...foot)

    body.replaceChildren(tabsBar(false))
    if (isCaptain) {
      const note = el('p', 'v2-captain-note')
      note.append(captainIcon(16), `隊長（Captain）：在${ARCHETYPE_NAMES[base.archetype as keyof typeof ARCHETYPE_NAMES]}的人數算 ${captainWeight([])} 人，可能讓羈絆啟動或升級。換到板凳或預備就沒有隊長，可以在陣容頁的「羈絆說明」重新指定。`)
      body.append(note)
    }
    if (done) body.append(doneBox(base.name, done))
    if (next) body.append(preview)
    else body.append(el('p', 'v2-hint', V2T.maxLevel))
    const tableBox = el('section', 'v2-rating-box')
    tableBox.setAttribute('aria-label', V2T.ratingTable)
    tableBox.append(table, el('p', 'v2-hint', V2T.progressionNote), el('p', 'v2-hint v2-ability-note', ST.abilityNote))
    body.append(tableBox)
    if (better) {
      const tip = el('p', 'v2-tip v2-better-upgrade')
      tip.dataset.better = better.playerId
      tip.append(icon('alert', 18), V2T.betterUpgrade(better.name, better.level, better.ratio))
      body.append(tip)
    }
    if (effTraits.length) {
      const traits = el('section', 'v2-detail-traits')
      traits.append(el('h3', 'v2-detail-sub', V2T.traitsTitle), traitList({ ...base, traits: effTraits }))
      body.append(traits)
    }
    // 特性養成（Phase 9 PR 3）
    const locked = state.spending || !state.canWrite
    body.append(
      trainingPanel(club, record, trainingUi, {
        locked,
        pick: (o) => {
          trainingUi.picking = o ? { trait: o.trait, kind: o.kind } : null
          draw(controller.state)
          body.querySelector<HTMLButtonElement>(o ? '[data-action="training-start"]' : `.v2-training-option[data-trait] [data-action="training-pick"]`)?.focus({ preventScroll: true })
        },
        start: async (o) => {
          const res = await controller.startTraining(playerId, o.trait, o.kind)
          if (res.message) toast(res.message, res.ok ? 'success' : 'error')
          trainingUi.picking = null
          draw(controller.state)
        },
        askCancel: (on) => {
          trainingUi.cancelling = on
          draw(controller.state)
          body.querySelector<HTMLButtonElement>(on ? '.v2-training-cancel-confirm .btn-white' : '[data-action="training-cancel"]')?.focus({ preventScroll: true })
        },
        cancel: async () => {
          const a = controller.state.club?.training.active
          if (!a) return
          const res = await controller.cancelTraining(playerId, a.trait)
          if (res.message) toast(res.message, res.ok ? 'success' : 'error')
          trainingUi.cancelling = false
          draw(controller.state)
        },
      }),
    )

    // 釋出：只有預備名單的球員；用存檔裡最新的陣容判斷，按下後還會在鎖內再檢查一次
    const isReserve = !assignedIds(club.roster).has(playerId)
    const training = club.training.active?.playerId === playerId
    const releaseBox = el('section', 'v2-release')
    const b = el('button', 'btn-danger v2-release-btn')
    b.type = 'button'
    b.dataset.action = 'release'
    b.append(icon('release', 18), V2T.releaseButton)
    b.disabled = !isReserve || training || state.spending || !state.canWrite
    b.onclick = () => {
      confirming = true
      draw(controller.state)
    }
    releaseBox.append(b, el('p', 'v2-hint', !isReserve ? V2T.releaseOnlyReserve : training ? V2T.releaseTraining : V2T.releaseWarnShort))
    if (!isReserve || training) confirming = false
    body.append(releaseBox)
    if (isReserve && !training && confirming) {
      // 第二次確認：蓋在面板上的小對話框（不可復原、不退款）
      const scrim = el('div', 'v2-release-scrim')
      const confirmBox = el('div', 'v2-release-confirm')
      confirmBox.setAttribute('role', 'alertdialog')
      confirmBox.setAttribute('aria-label', V2T.releaseYes)
      const yes = el('button', 'btn-danger solid v2-release-yes', state.spending ? V2T.releasing : V2T.releaseYes)
      yes.type = 'button'
      yes.dataset.action = 'release-confirm'
      yes.disabled = state.spending || !state.canWrite
      yes.onclick = async () => {
        yes.disabled = true
        const res = await controller.release(playerId)
        if (res.message) toast(res.message, res.ok ? 'success' : 'error')
        confirming = false
        if (res.ok) close()
        else draw(controller.state)
      }
      const no = el('button', 'btn-white v2-release-no', V2T.releaseCancel)
      no.type = 'button'
      no.onclick = () => cancelConfirm()
      const row = el('div', 'v2-release-row')
      row.append(no, yes)
      confirmBox.append(icon('alert', 32, 'v2-release-icon'), el('h3', 'v2-release-title', V2T.releaseTitle(base.name)), el('p', 'v2-release-warn', V2T.releaseConfirm), row)
      body.append(scrim, confirmBox)
      queueMicrotask(() => no.focus({ preventScroll: true }))
    }
    if (record.level >= MAX_LEVEL) body.classList.add('max')
  }
  draw(controller.state)
  const unsubscribe = controller.subscribe(draw)
  close = v2Modal(V2T.playerTitle, body, unsubscribe, {
    sheet: true,
    noCloseButton: true,
    header,
    footer,
    className: 'v2-player-sheet',
    owner: controller,
    // 第二次確認開著時，Escape 只取消確認，不關閉整個面板
    onEscape: () => {
      if (trainingUi.picking || trainingUi.cancelling) {
        trainingUi.picking = null
        trainingUi.cancelling = false
        draw(controller.state)
        return true
      }
      if (!confirming) return false
      cancelConfirm()
      return true
    },
  })
  return close
}

/** 升級成功的回饋：升到幾級、哪些能力提升多少、什麼時候生效 */
function doneBox(name: string, d: { level: number; gains: ReturnType<typeof upgradeGains>; fromMatch: number }): HTMLElement {
  const box = el('div', 'v2-upgrade-done')
  box.setAttribute('role', 'status')
  box.append(el('strong', '', V2T.upgradeDone(name, d.level)))
  const parts = d.gains.gains.map((g) => `${RATING_FULL[g.key as keyof typeof RATING_FULL]} +${fmt2(g.to - g.from)}`)
  if (parts.length) box.append(el('span', 'v2-upgrade-gains', parts.join('・')))
  box.append(el('span', '', `${V2T.upgradeEffective}${V2T.upgradeEffectiveFrom(d.fromMatch)}`))
  return box
}
