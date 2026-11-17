// 球員詳情：名稱、流派、特性、等級，以及每項能力的「原始 → 目前（比賽實際使用）→ 下一級」、升級成本與升級按鈕。
// 升級預覽（Phase 6A）：目前等級 → 下一級、會提升的能力與變化量、整體能力；數字全部由 progression.ts 的 leveled() 算出來，
// 沒有提升的能力不顯示增加。升級成功後在畫面上留一段回饋，說明新能力從下一場尚未開始的比賽生效。
// 預備球員另外有「釋出球員」：按下後要再確認一次才會釋出（不可復原、不退款）。
// 打開時跟著 controller 的狀態更新（升級、其他分頁改了都會重畫），關閉時取消訂閱
import { gradeBadge } from '../../ui/grades'
import { el } from '../../ui/playerCard'
import { RATING_FULL } from '../../ui/strings'
import { archetypeChip } from '../../ui/synergyUi'
import { pitchChip, toast, traitList } from '../../ui/visual'
import { overall } from '../../sim/generate'
import type { Player } from '../../sim/types'
import { canAfford } from '../application/economyService'
import { MAX_LEVEL, leveled, upgradeCost } from '../domain/progression'
import { assignedIds, recordOf } from '../domain/roster'
import { betterUpgrade, teamPower, teamPowerIf } from '../domain/growthInfo'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './reportView'
import { V2T } from './strings'

const fmt1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1)
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

export function openPlayerDetail(controller: ClubController, playerId: string): () => void {
  const body = el('div', 'v2-player-detail')
  /** 已經按過「釋出球員」、正在等第二次確認 */
  let confirming = false
  /** 剛完成的升級（顯示成功回饋）：升到幾級、哪些能力提升、從第幾場生效 */
  let done: { level: number; gains: ReturnType<typeof upgradeGains>; fromMatch: number } | null = null
  let close: () => void = () => {}
  const draw = (state: ControllerState) => {
    const club = state.club
    const record = club ? recordOf(club, playerId) : undefined
    if (!club || !record) {
      body.replaceChildren(el('p', 'v2-empty', V2T.noClubAnymore))
      return
    }
    const base = record.player
    const current = leveled(base, record.level)
    const cost = upgradeCost(record.level)
    const next = cost ? leveled(base, record.level + 1) : null

    const head = el('div', 'v2-detail-head')
    const titleLine = el('div', 'v2-detail-name')
    titleLine.append(el('strong', '', base.name), el('span', 'v2-level big', V2T.level(record.level)))
    const chips = el('div', 'v2-player-chips')
    chips.append(base.role === 'batter' ? archetypeChip(base) : pitchChip(base))
    head.append(titleLine, chips)

    // 能力表：原始（Lv.1）、目前（比賽實際用的）、下一級
    const table = el('table', 'v2-rating-table')
    const hr = el('tr')
    hr.append(el('th', '', ''), el('th', '', V2T.baseRating), el('th', 'current', V2T.currentRating), el('th', '', next ? V2T.nextRating : ''))
    table.append(hr)
    for (const key of Object.keys(base.ratings)) {
      const tr = el('tr')
      tr.dataset.rating = key
      const b = ratingsOf(base)[key]
      const c = ratingsOf(current)[key]
      const cur = el('td', 'current')
      cur.append(gradeBadge(c, 'sm'), el('span', 'v2-num', fmt1(c)))
      const nx = el('td', 'next')
      if (next) {
        const n = ratingsOf(next)[key]
        const diff = Math.round((n - c) * 100) / 100
        // 沒有提升（已達上限）就照實顯示，不放假的增加
        nx.append(el('span', 'v2-num', fmt1(n)), el('span', diff > 0 ? 'v2-diff up' : 'v2-diff', diff > 0 ? `+${diff.toFixed(2)}` : c >= 10 ? V2T.ratingCapped : '±0'))
      }
      tr.append(el('th', '', RATING_FULL[key as keyof typeof RATING_FULL]), el('td', 'base', fmt1(b)), cur, nx)
      table.append(tr)
    }

    // 升級預覽：Lv.N → Lv.N+1、會提升的能力（變化量）、整體能力
    const preview = el('div', 'v2-upgrade-preview')
    if (next) {
      const g = upgradeGains(current, next)
      const top = el('div', 'v2-preview-head')
      top.append(el('span', 'v2-preview-title', V2T.upgradePreview), el('strong', 'v2-preview-levels', V2T.upgradeLevels(record.level, record.level + 1)))
      const list = el('ul', 'v2-preview-list')
      for (const x of g.gains) {
        const li = el('li')
        li.dataset.gain = x.key
        li.append(el('span', 'v2-preview-name', RATING_FULL[x.key as keyof typeof RATING_FULL]), el('span', 'v2-preview-val', `${fmt2(x.from)} → ${fmt2(x.to)}`), el('span', 'v2-diff up', `+${fmt2(x.to - x.from)}`))
        list.append(li)
      }
      if (!g.gains.length) list.append(el('li', 'v2-hint', V2T.upgradeNoGain))
      const ov = el('li', 'v2-preview-overall')
      ov.append(el('span', 'v2-preview-name', V2T.upgradeOverall), el('span', 'v2-preview-val', `${fmt2(g.overall.from)} → ${fmt2(g.overall.to)}`))
      list.append(ov)
      // 球隊戰力（上場 14 人的平均能力）的變化；預備球員升級不會改變目前的戰力
      const tp = el('li', 'v2-preview-team')
      tp.dataset.teamPower = ''
      const after = teamPowerIf(club, playerId, record.level + 1)
      tp.append(el('span', 'v2-preview-name', V2T.teamPower), el('span', 'v2-preview-val', after === null ? V2T.upgradeReserveTeam : `${fmt2(teamPower(club))} → ${fmt2(after)}`))
      list.append(tp)
      preview.append(top, list, el('p', 'v2-hint', V2T.upgradeEffective))
      // 同樣的經驗升別人明顯划算時提醒（只是資訊，不阻止升級）
      const better = assignedIds(club.roster).has(playerId) ? betterUpgrade(club, playerId) : null
      if (better) {
        const tip = el('p', 'v2-hint v2-better-upgrade', V2T.betterUpgrade(better.name, better.level, better.ratio))
        tip.dataset.better = better.playerId
        preview.append(tip)
      }
    }

    const costBox = el('div', 'v2-upgrade')
    const button = el('button', 'btn-yellow v2-upgrade-btn')
    button.type = 'button'
    if (!cost) {
      costBox.append(el('p', 'v2-hint', V2T.maxLevel))
      button.textContent = V2T.maxLevel
      button.disabled = true
    } else {
      const affordable = canAfford(club, cost)
      const line = el('div', 'v2-cost')
      line.append(el('span', 'v2-cost-label', V2T.upgradeCostLabel))
      const fundsOk = club.economy.assets.funds >= cost.funds
      const expOk = club.economy.assets.experience >= cost.experience
      line.append(
        el('span', `v2-cost-item funds ${fundsOk ? '' : 'short'}`, `${V2T.funds} ${fmt(cost.funds)}（${V2T.owned} ${fmt(club.economy.assets.funds)}）`),
        el('span', `v2-cost-item exp ${expOk ? '' : 'short'}`, `${V2T.experience} ${fmt(cost.experience)}（${V2T.owned} ${fmt(club.economy.assets.experience)}）`),
      )
      costBox.append(line)
      button.textContent = state.spending ? V2T.upgrading : affordable ? V2T.upgradeButton(record.level + 1) : V2T.notEnoughResources
      button.disabled = !affordable || state.spending || !state.canWrite
      button.onclick = async () => {
        button.disabled = true
        const before = current
        const res = await controller.upgrade(playerId, record.level)
        const saved = res.ok && res.outcome ? recordOf(res.outcome.club, playerId) : undefined
        if (saved && res.outcome) {
          // 進行中那一場已經固定（用升級前的能力）：新能力從下一場開始，也就是第 nextMatchIndex + 2 場（從 1 數）
          done = { level: saved.level, gains: upgradeGains(before, leveled(base, saved.level)), fromMatch: res.outcome.club.idle.nextMatchIndex + 2 }
          draw(controller.state)
        } else if (res.message) toast(res.message)
      }
    }
    costBox.append(button)
    body.replaceChildren(head)
    if (done) body.append(doneBox(base.name, done))
    if (next) body.append(preview)
    body.append(table, costBox, el('p', 'v2-hint', V2T.progressionNote), traitList(base))

    // 釋出：只有預備名單的球員；用存檔裡最新的陣容判斷，按下後還會在鎖內再檢查一次
    const isReserve = !assignedIds(club.roster).has(playerId)
    const releaseBox = el('div', 'v2-release')
    if (!isReserve) {
      confirming = false
      releaseBox.append(el('p', 'v2-hint', V2T.releaseOnlyReserve))
    } else if (!confirming) {
      const b = el('button', 'btn-white v2-release-btn', V2T.releaseButton)
      b.type = 'button'
      b.dataset.action = 'release'
      b.disabled = state.spending || !state.canWrite
      b.onclick = () => {
        confirming = true
        draw(controller.state)
      }
      releaseBox.append(b)
    } else {
      const confirmBox = el('div', 'v2-release-confirm')
      confirmBox.setAttribute('role', 'alertdialog')
      const yes = el('button', 'btn-danger v2-release-yes', state.spending ? V2T.releasing : V2T.releaseYes)
      yes.type = 'button'
      yes.dataset.action = 'release-confirm'
      yes.disabled = state.spending || !state.canWrite
      yes.onclick = async () => {
        yes.disabled = true
        const res = await controller.release(playerId)
        if (res.message) toast(res.message)
        confirming = false
        if (res.ok) close()
        else draw(controller.state)
      }
      const no = el('button', 'btn-white v2-release-no', V2T.releaseCancel)
      no.type = 'button'
      no.onclick = () => {
        confirming = false
        draw(controller.state)
      }
      const row = el('div', 'v2-release-row')
      row.append(no, yes)
      confirmBox.append(el('p', 'v2-release-warn', V2T.releaseConfirm), row)
      releaseBox.append(confirmBox)
    }
    body.append(releaseBox)
    if (record.level >= MAX_LEVEL) body.classList.add('max')
  }
  draw(controller.state)
  const unsubscribe = controller.subscribe(draw)
  close = v2Modal(V2T.playerTitle, body, unsubscribe)
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
