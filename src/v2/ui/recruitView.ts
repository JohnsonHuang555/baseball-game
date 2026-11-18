// 招募市場：選打者或投手 → 三位候選人（跟目前陣容比較）→ 選一位 → 確認簽約才扣資金 → 簽約完成。
// 候選人由 recruitCandidates 純函式推導（球團種子 + 招募次數 + 角色），所以關閉、重開、重新整理、切換角色都是同一批人，
// 瀏覽候選人不寫存檔。簽約只送「角色 + 候選位置 + 畫面上的招募次數」，球員資料由服務層重建。
// 新球員放進預備名單，不會自動上場；可以直接前往陣容把他排進去
import { overall } from '../../sim/generate'
import type { Player } from '../../sim/types'
import { gradeBadge, gradeOf } from '../../ui/grades'
import { el, traitTag } from '../../ui/playerCard'
import { ARCHETYPE_NAMES, POSITION_SPOT, RATING_FULL, RATING_LABELS } from '../../ui/strings'
import { archetypeChip } from '../../ui/synergyUi'
import { archetypeSvg } from '../../ui/synergyIcons'
import { avatar } from '../../ui/avatar'
import { pitchChip, toast } from '../../ui/visual'
import { icon } from './icons'
import type { ClubSave } from '../domain/club'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { compareCandidate, type CandidateComparison } from '../domain/recruitCompare'
import { recruitCandidates, recruitCost, rosterFull, type RecruitRole } from '../domain/recruitment'
import { recordOf } from '../domain/roster'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './dialog'

const fmt = (x: number) => x.toLocaleString('zh-Hant')
import { V2T } from './strings'

type View =
  | { kind: 'roles' }
  /** shownCount：畫面顯示這批候選人時的招募次數（簽約時交給服務層比對） */
  | { kind: 'candidates'; role: RecruitRole; shownCount: number; selected: number | null }
  | { kind: 'signed'; playerId: string; spent: number }

/** 候選人卡片上「跟誰比」的說明 */
function compareTarget(c: CandidateComparison): string {
  const t = c.target
  if (!t) return V2T.compareNone
  const who =
    t.kind === 'starter-at-position'
      ? V2T.compareStarterAt(POSITION_SPOT[t.position!])
      : t.kind === 'designated-hitter'
        ? V2T.compareDh
        : t.kind === 'starting-pitcher'
          ? V2T.compareSp
          : V2T.compareReliever
  return V2T.compareVs(who, t.name)
}

function ratingNames(keys: string[]): string {
  return keys.map((k) => RATING_FULL[k as keyof typeof RATING_FULL] ?? k).join('、')
}

/** 能力字母（候選人是主角：等級色照常顯示） */
function ratingBadges(p: Player): HTMLElement {
  const row = el('div', 'v2-cand-ratings')
  for (const [key, value] of Object.entries(p.ratings)) {
    const item = el('span', 'v2-cand-rating')
    item.append(el('span', 'v2-cand-rating-label', RATING_LABELS[key as keyof typeof RATING_LABELS]), gradeBadge(value, 'sm'))
    row.append(item)
  }
  return row
}

function faceOf(p: Player, size: 'md' | 'lg'): HTMLElement {
  const face = el('span', `v2-cand-face ${size}`)
  face.append(avatar(p.id, 'user', 'v2-cand-avatar'))
  if (p.role === 'batter') {
    const arch = el('span', 'v2-player-arch')
    arch.innerHTML = archetypeSvg(p.archetype, size === 'lg' ? 24 : 18)
    face.append(arch)
  }
  return face
}

function subText(p: Player): string {
  return p.role === 'batter'
    ? `${V2T.candidatePrimary(POSITION_SPOT[p.primary])}・${V2T.candidateBats[p.bats]}`
    : `${V2T.pitcherLabel}・${V2T.candidateThrows[p.throws]}`
}

function candidateCard(p: Player, index: number, cmp: CandidateComparison, selected: boolean, onPick: () => void): HTMLElement {
  const card = el('button', `v2-cand ${selected ? 'selected' : ''}`)
  card.type = 'button'
  card.dataset.index = String(index)
  card.dataset.player = p.id
  card.setAttribute('aria-pressed', String(selected))
  card.onclick = onPick

  const head = el('div', 'v2-cand-head')
  const names = el('div', 'v2-cand-names')
  const nameRow = el('span', 'v2-cand-name-row')
  nameRow.append(el('span', 'v2-cand-name', p.name), el('span', 'v2-level', V2T.level(1)))
  names.append(nameRow, el('span', 'v2-cand-sub', subText(p)))
  const ovr = el('div', 'v2-cand-ovr')
  ovr.setAttribute('aria-label', `${V2T.candidateOverall} ${overall(p).toFixed(1)}`)
  ovr.append(gradeBadge(overall(p), 'md'), el('span', 'v2-cand-ovr-num', overall(p).toFixed(1)))
  head.append(faceOf(p, 'md'), names, ovr)

  const chips = el('div', 'v2-cand-chips')
  chips.append(p.role === 'batter' ? archetypeChip(p) : pitchChip(p))
  if (p.traits.length) chips.append(traitTag(p.traits[0]))

  const compare = el('div', `v2-cand-compare ${cmp.verdict}`)
  compare.dataset.verdict = cmp.verdict
  const top = el('div', 'v2-cand-compare-top')
  top.append(el('span', 'v2-cand-vs', compareTarget(cmp)))
  if (cmp.target) top.append(el('span', `v2-cand-verdict ${cmp.verdict}`, `${V2T.compareVerdict[cmp.verdict]} ${V2T.compareDiff(cmp.diff)}`))
  // 標籤只說「能力」的差距，不寫「補強」「變強」：能力高不保證贏更多比賽
  compare.append(top)
  if (cmp.target?.kind === 'designated-hitter' && p.role === 'batter') compare.append(el('span', 'v2-cand-note', V2T.compareNoSpot(POSITION_SPOT[p.primary])))
  else if (cmp.target?.kind === 'starter-at-position' && cmp.position) compare.append(el('span', 'v2-cand-note', V2T.compareFieldingNote(POSITION_SPOT[cmp.position])))
  if (cmp.target) {
    if (cmp.strengths.length) compare.append(el('span', 'v2-cand-good', V2T.compareStrengths(ratingNames(cmp.strengths))))
    if (cmp.weaknesses.length) compare.append(el('span', 'v2-cand-bad', V2T.compareWeaknesses(ratingNames(cmp.weaknesses))))
    if (!cmp.strengths.length && !cmp.weaknesses.length) compare.append(el('span', 'v2-cand-note', V2T.compareEven))
  }

  card.append(head, ratingBadges(p), chips, compare)
  return card
}

export function openRecruit(controller: ClubController, goToLineup: () => void): () => void {
  const body = el('div', 'v2-recruit')
  const header = el('div', 'v2-recruit-head')
  const title = el('span', 'v2-recruit-title', V2T.recruitMarket)
  header.append(icon('recruit', 26), title)
  const footer = el('div', 'v2-recruit-foot')
  let view: View = { kind: 'roles' }
  /** 自己的簽約請求進行中：成功時招募次數會變，這不是「別的分頁搶先」，不要提示名單過期 */
  let signing = false
  let close: () => void = () => undefined

  /** 資訊列：球團人數、資金、本次簽約；不夠的那格變紅 */
  const info = (club: ClubSave) => {
    const cost = recruitCost(club.recruitment.count)
    const affordable = club.economy.assets.funds >= cost.funds
    const full = rosterFull(club)
    const box = el('div', 'v2-recruit-info')
    const cell = (cls: string, label: string, value: string, aria: string, bad: boolean) => {
      const c = el('div', `v2-info-cell ${cls}${bad ? ' short' : ''}`)
      c.setAttribute('aria-label', aria)
      c.append(el('span', 'v2-info-label', label), el('span', 'v2-info-value', value))
      return c
    }
    box.append(
      cell('v2-recruit-count', V2T.rosterLabel, `${club.players.length} / ${RECRUIT_CONFIG.maxPlayers}`, V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers), full),
      cell('v2-recruit-funds', V2T.funds, fmt(club.economy.assets.funds), V2T.recruitFunds(club.economy.assets.funds), !affordable),
      cell('v2-recruit-cost', V2T.recruitCostLabel, fmt(cost.funds), V2T.recruitCost(cost.funds), !affordable),
    )
    return box
  }

  /** 不能簽約的原因（名單已滿、資金不足）；可以簽就是 null */
  const blocker = (club: ClubSave): HTMLElement | null => {
    const box = (cls: string, head: string, text: string) => {
      const b = el('div', `v2-recruit-warn ${cls}`)
      b.setAttribute('role', 'status')
      const words = el('span', 'v2-recruit-warn-words')
      words.append(el('strong', '', head), el('span', 'v2-recruit-block', text))
      b.append(icon('alert', 20), words)
      return b
    }
    if (rosterFull(club)) return box('full', V2T.rosterFullTitle(RECRUIT_CONFIG.maxPlayers), V2T.recruitFullHint)
    const need = recruitCost(club.recruitment.count).funds - club.economy.assets.funds
    if (need > 0) return box('short', V2T.notEnoughFunds, V2T.recruitShort(need))
    return null
  }

  const pickRole = (role: RecruitRole) => {
    const club = controller.state.club
    if (!club) return
    // 切換角色：選擇清掉，但同一個角色的候選人不變（純函式推導）
    view = { kind: 'candidates', role, shownCount: club.recruitment.count, selected: null }
    draw(controller.state)
  }

  const footButton = (cls: string, label: string, run: () => void) => {
    const b = el('button', cls, label)
    b.type = 'button'
    b.onclick = run
    return b
  }

  const draw = (state: ControllerState) => {
    const club = state.club
    if (!club) {
      footer.replaceChildren()
      body.replaceChildren(el('p', 'v2-empty', V2T.noClubAnymore))
      return
    }
    // 別的分頁剛招募過：候選名單跟著招募次數換了，選擇作廢，提示重新選
    if (view.kind === 'candidates' && !signing && view.shownCount !== club.recruitment.count) {
      view = { ...view, shownCount: club.recruitment.count, selected: null }
      toast(V2T.recruitStale)
    }
    body.dataset.step = view.kind

    if (view.kind === 'signed') {
      title.textContent = V2T.recruitSigned
      const record = recordOf(club, view.playerId)
      const box = el('div', 'v2-recruit-card')
      box.append(el('span', 'v2-recruit-done-title', V2T.recruitSigned))
      if (record) {
        const p = record.player
        const card = el('div', 'v2-signed-card')
        const name = el('div', 'v2-player-name')
        name.append(el('span', '', p.name), el('span', 'v2-level', V2T.level(record.level)))
        const sub = [subText(p), p.role === 'batter' ? ARCHETYPE_NAMES[p.archetype] : '', `${V2T.candidateOverall} ${gradeOf(overall(p))} ${overall(p).toFixed(1)}`].filter(Boolean).join('・')
        card.append(faceOf(p, 'lg'), name, el('span', 'v2-signed-sub', sub), ratingBadges(p))
        box.append(card)
      }
      const money = el('div', 'v2-stats two v2-recruit-money')
      const tile = (cls: string, label: string, value: string, aria: string) => {
        const t = el('div', `v2-stat ${cls}`)
        t.setAttribute('aria-label', aria)
        t.append(el('span', 'v2-stat-label', label), el('span', 'v2-stat-value', value))
        return t
      }
      money.append(
        tile('v2-recruit-spent', V2T.recruitSpentLabel, fmt(view.spent), V2T.recruitSpent(view.spent)),
        tile('v2-recruit-remain', V2T.recruitRemainLabel, fmt(club.economy.assets.funds), V2T.recruitRemain(club.economy.assets.funds)),
      )
      box.append(money, el('p', 'v2-recruit-next', V2T.recruitNextNote(recruitCost(club.recruitment.count).funds)))
      const go = footButton('btn-yellow v2-recruit-go', V2T.goLineup, () => {
        close()
        goToLineup()
      })
      go.dataset.action = 'go-lineup'
      const again = footButton('btn-white v2-recruit-again', V2T.recruitAgain, () => {
        view = { kind: 'roles' }
        draw(controller.state)
      })
      footer.replaceChildren(again, go)
      footer.className = 'v2-recruit-foot two'
      body.replaceChildren(info(club), box)
      return
    }

    if (view.kind === 'roles') {
      title.textContent = V2T.recruitMarket
      const buttons = el('div', 'v2-recruit-buttons')
      for (const role of ['batter', 'pitcher'] as RecruitRole[]) {
        const b = el('button', 'v2-role-card')
        b.type = 'button'
        b.dataset.role = role
        b.disabled = state.spending
        const face = el('span', 'v2-role-face')
        face.append(avatar(`recruit-${role}`, 'user'))
        b.append(face, el('span', 'v2-role-title', role === 'batter' ? V2T.recruitBatter : V2T.recruitPitcher), el('span', 'v2-role-sub', V2T.recruitRoleSub))
        b.onclick = () => pickRole(role)
        buttons.append(b)
      }
      const parts: HTMLElement[] = [info(club), buttons]
      const block = blocker(club)
      if (block) parts.push(block)
      parts.push(el('p', 'v2-hint', V2T.recruitHint))
      body.replaceChildren(...parts)
      footer.replaceChildren(footButton('btn-white v2-modal-bottom', V2T.close, () => close()))
      footer.className = 'v2-recruit-foot'
      return
    }

    const v = view
    title.textContent = V2T.recruitCandidatesHead
    const roles = el('div', 'v2-recruit-roles')
    roles.setAttribute('role', 'radiogroup')
    roles.setAttribute('aria-label', V2T.recruitRoleLabel)
    for (const role of ['batter', 'pitcher'] as RecruitRole[]) {
      const b = el('button', 'v2-role-tab', role === 'batter' ? V2T.batterLabel : V2T.pitcherLabel)
      b.type = 'button'
      b.dataset.role = role
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(role === v.role))
      b.disabled = state.spending
      b.onclick = () => pickRole(role)
      roles.append(b)
    }
    const candidates = recruitCandidates(club, v.role)
    const list = el('div', 'v2-cand-list')
    candidates.forEach((p, i) => {
      list.append(
        candidateCard(p, i, compareCandidate(club, p), v.selected === i, () => {
          view = { ...v, selected: i }
          draw(controller.state)
        }),
      )
    })
    const cost = recruitCost(club.recruitment.count)
    const block = blocker(club)
    const confirm = el('button', 'btn-yellow v2-recruit-confirm', state.spending ? V2T.recruiting : v.selected === null ? V2T.recruitPickFirst : V2T.recruitConfirm(cost.funds))
    confirm.type = 'button'
    confirm.dataset.action = 'recruit-confirm'
    confirm.disabled = v.selected === null || !!block || state.spending || !state.canWrite
    confirm.onclick = async () => {
      if (v.selected === null) return
      confirm.disabled = true
      signing = true
      let res
      try {
        res = await controller.recruit(v.role, v.selected, v.shownCount)
      } finally {
        signing = false
      }
      if (res.message) toast(res.message, res.ok ? 'success' : 'error')
      if (res.ok && res.outcome) view = { kind: 'signed', playerId: res.outcome.op.playerId, spent: res.outcome.op.cost.funds }
      draw(controller.state)
    }
    const back = footButton('btn-white v2-recruit-back', V2T.recruitBack, () => {
      view = { kind: 'roles' }
      draw(controller.state)
    })
    footer.className = 'v2-recruit-foot two'
    footer.replaceChildren(back, confirm)
    // 不能簽約的原因放在卡片上面：手機上一打開就看得到
    const notes = el('div', 'v2-recruit-notes')
    notes.append(el('span', '', V2T.recruitPickHint), el('span', 'v2-cand-disclaimer', V2T.compareDisclaimer))
    const parts: HTMLElement[] = [info(club), roles]
    if (block) parts.push(block)
    parts.push(notes, list)
    body.replaceChildren(...parts)
  }

  draw(controller.state)
  const unsubscribe = controller.subscribe(draw)
  close = v2Modal(V2T.recruitTitle, body, unsubscribe, { sheet: true, noCloseButton: true, header, footer, className: 'v2-recruit-modal' })
  return close
}
