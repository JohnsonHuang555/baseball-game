// 招募市場：選打者或投手 → 三位候選人（跟目前陣容比較）→ 選一位 → 確認簽約才扣資金 → 簽約完成。
// 候選人由 recruitCandidates 純函式推導（球團種子 + 招募次數 + 角色），所以關閉、重開、重新整理、切換角色都是同一批人，
// 瀏覽候選人不寫存檔。簽約只送「角色 + 候選位置 + 畫面上的招募次數」，球員資料由服務層重建。
// 新球員放進預備名單，不會自動上場；可以直接前往陣容把他排進去
import { overall } from '../../sim/generate'
import type { Player } from '../../sim/types'
import { gradeBadge } from '../../ui/grades'
import { el, traitChips } from '../../ui/playerCard'
import { POSITION_SPOT, RATING_FULL } from '../../ui/strings'
import { archetypeChip } from '../../ui/synergyUi'
import { gradeLine, pitchChip, toast } from '../../ui/visual'
import type { ClubSave } from '../domain/club'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { compareCandidate, type CandidateComparison } from '../domain/recruitCompare'
import { recruitCandidates, recruitCost, rosterFull, type RecruitRole } from '../domain/recruitment'
import { recordOf } from '../domain/roster'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './reportView'
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

function candidateCard(p: Player, index: number, cmp: CandidateComparison, selected: boolean, onPick: () => void): HTMLElement {
  const card = el('button', `v2-cand ${selected ? 'selected' : ''}`)
  card.type = 'button'
  card.dataset.index = String(index)
  card.dataset.player = p.id
  card.setAttribute('aria-pressed', String(selected))
  card.onclick = onPick

  const head = el('div', 'v2-cand-head')
  const names = el('div', 'v2-cand-names')
  names.append(el('span', 'v2-cand-name', p.name))
  const sub =
    p.role === 'batter'
      ? `${V2T.candidatePrimary(POSITION_SPOT[p.primary])}・${V2T.candidateBats[p.bats]}`
      : `${V2T.pitcherLabel}・${V2T.candidateThrows[p.throws]}`
  names.append(el('span', 'v2-cand-sub', sub))
  const ovr = el('div', 'v2-cand-ovr')
  ovr.append(gradeBadge(overall(p), 'md'), el('span', 'v2-cand-ovr-num', `${V2T.candidateOverall} ${overall(p).toFixed(1)}`))
  head.append(names, ovr)

  const chips = el('div', 'v2-player-chips')
  chips.append(p.role === 'batter' ? archetypeChip(p) : pitchChip(p))
  if (p.traits.length) chips.append(traitChips(p))

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

  card.append(head, gradeLine(p), chips, compare)
  return card
}

export function openRecruit(controller: ClubController, goToLineup: () => void): () => void {
  const body = el('div', 'v2-recruit')
  let view: View = { kind: 'roles' }
  /** 自己的簽約請求進行中：成功時招募次數會變，這不是「別的分頁搶先」，不要提示名單過期 */
  let signing = false
  let close: () => void = () => undefined

  const info = (club: ClubSave) => {
    const cost = recruitCost(club.recruitment.count)
    const affordable = club.economy.assets.funds >= cost.funds
    const box = el('div', 'v2-recruit-info')
    box.append(
      el('span', 'v2-recruit-count', V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers)),
      el('span', 'v2-recruit-funds', V2T.recruitFunds(club.economy.assets.funds)),
      el('span', `v2-recruit-cost ${affordable ? '' : 'short'}`, V2T.recruitCost(cost.funds)),
    )
    return box
  }

  /** 不能簽約的原因（名單已滿、資金不足）；可以簽就是 null */
  const blocker = (club: ClubSave): HTMLElement | null => {
    if (rosterFull(club)) return el('p', 'v2-recruit-block full', V2T.recruitFullHint)
    const need = recruitCost(club.recruitment.count).funds - club.economy.assets.funds
    if (need > 0) return el('p', 'v2-recruit-block short', V2T.recruitShort(need))
    return null
  }

  const roleButtons = (state: ControllerState, current?: RecruitRole) => {
    const buttons = el('div', current ? 'v2-seg v2-recruit-roles' : 'v2-recruit-buttons')
    for (const role of ['batter', 'pitcher'] as RecruitRole[]) {
      const b = el('button', current ? 'v2-seg-btn' : 'btn-yellow', role === 'batter' ? V2T.recruitBatter : V2T.recruitPitcher)
      b.type = 'button'
      b.dataset.role = role
      if (current) b.setAttribute('aria-pressed', String(role === current))
      b.disabled = state.spending
      b.onclick = () => {
        const club = controller.state.club
        if (!club) return
        // 切換角色：選擇清掉，但同一個角色的候選人不變（純函式推導）
        view = { kind: 'candidates', role, shownCount: club.recruitment.count, selected: null }
        draw(controller.state)
      }
      buttons.append(b)
    }
    return buttons
  }

  const draw = (state: ControllerState) => {
    const club = state.club
    if (!club) {
      body.replaceChildren(el('p', 'v2-empty', V2T.noClubAnymore))
      return
    }
    // 別的分頁剛招募過：候選名單跟著招募次數換了，選擇作廢，提示重新選
    if (view.kind === 'candidates' && !signing && view.shownCount !== club.recruitment.count) {
      view = { ...view, shownCount: club.recruitment.count, selected: null }
      toast(V2T.recruitStale)
    }

    if (view.kind === 'signed') {
      const record = recordOf(club, view.playerId)
      const box = el('div', 'v2-recruit-card')
      if (record) {
        const p = record.player
        const name = el('div', 'v2-player-name')
        name.append(el('span', '', p.name), el('span', 'v2-level', V2T.level(record.level)))
        const chips = el('div', 'v2-player-chips')
        chips.append(p.role === 'batter' ? archetypeChip(p) : pitchChip(p))
        if (p.traits.length) chips.append(traitChips(p))
        box.append(el('span', 'v2-section-title', V2T.recruitSigned), name, gradeLine(p), chips)
      }
      const money = el('div', 'v2-recruit-money')
      money.append(el('span', 'v2-recruit-spent', V2T.recruitSpent(view.spent)), el('span', 'v2-recruit-remain', V2T.recruitRemain(club.economy.assets.funds)))
      const go = el('button', 'btn-yellow v2-recruit-go', V2T.goLineup)
      go.type = 'button'
      go.dataset.action = 'go-lineup'
      go.onclick = () => {
        close()
        goToLineup()
      }
      const again = el('button', 'btn-white v2-recruit-again', V2T.recruitAgain)
      again.type = 'button'
      again.onclick = () => {
        view = { kind: 'roles' }
        draw(controller.state)
      }
      const actions = el('div', 'v2-recruit-actions')
      actions.append(again, go)
      box.append(money, el('p', 'v2-hint', V2T.recruitHint), actions)
      body.replaceChildren(info(club), box)
      return
    }

    if (view.kind === 'roles') {
      const parts: HTMLElement[] = [el('p', 'v2-hint', V2T.recruitHint), info(club)]
      const block = blocker(club)
      if (block) parts.push(block)
      parts.push(roleButtons(state))
      body.replaceChildren(...parts)
      return
    }

    const v = view
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
    const confirm = el('button', 'btn-yellow btn-big v2-recruit-confirm', state.spending ? V2T.recruiting : v.selected === null ? V2T.recruitPickFirst : V2T.recruitConfirm(cost.funds))
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
      if (res.message) toast(res.message)
      if (res.ok && res.outcome) view = { kind: 'signed', playerId: res.outcome.op.playerId, spent: res.outcome.op.cost.funds }
      draw(controller.state)
    }
    const back = el('button', 'btn-white v2-recruit-back', V2T.recruitBack)
    back.type = 'button'
    back.onclick = () => {
      view = { kind: 'roles' }
      draw(controller.state)
    }
    const foot = el('div', 'v2-recruit-foot')
    foot.append(back, confirm)
    // 不能簽約的原因放在卡片上面：手機上一打開就看得到
    const parts: HTMLElement[] = [info(club), roleButtons(state, v.role)]
    if (block) parts.push(block)
    parts.push(el('span', 'v2-section-title', V2T.recruitCandidatesTitle(v.role)), el('p', 'v2-hint', V2T.recruitPickHint), el('p', 'v2-hint v2-cand-disclaimer', V2T.compareDisclaimer), list, foot)
    body.replaceChildren(...parts)
  }

  draw(controller.state)
  const unsubscribe = controller.subscribe(draw)
  close = v2Modal(V2T.recruitTitle, body, unsubscribe)
  return close
}
