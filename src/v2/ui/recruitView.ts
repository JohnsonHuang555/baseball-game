// 招募：成本、球團人數／上限、招募打者或投手，以及剛招募到的球員卡片。
// 招募到的人放進預備名單，不會自動上場；可以直接前往陣容把他排進去
import { gradeLine, pitchChip, toast } from '../../ui/visual'
import { el, traitChips } from '../../ui/playerCard'
import { archetypeChip } from '../../ui/synergyUi'
import { RECRUIT_CONFIG } from '../domain/progressionConfig'
import { recruitCost, rosterFull, type RecruitRole } from '../domain/recruitment'
import { recordOf } from '../domain/roster'
import type { ClubController, ControllerState } from './clubController'
import { v2Modal } from './reportView'
import { V2T } from './strings'

const fmt = (x: number) => x.toLocaleString('zh-Hant')

export function openRecruit(controller: ClubController, goToLineup: () => void): () => void {
  const body = el('div', 'v2-recruit')
  let lastRecruitId: string | null = null
  let close: () => void = () => undefined
  const draw = (state: ControllerState) => {
    const club = state.club
    if (!club) {
      body.replaceChildren(el('p', 'v2-empty', V2T.noClubAnymore))
      return
    }
    const cost = recruitCost(club.recruitment.count)
    const full = rosterFull(club)
    const affordable = club.economy.assets.funds >= cost.funds
    const info = el('div', 'v2-recruit-info')
    info.append(
      el('span', 'v2-recruit-count', V2T.rosterCount(club.players.length, RECRUIT_CONFIG.maxPlayers)),
      el('span', `v2-recruit-cost ${affordable ? '' : 'short'}`, `${V2T.recruitCost(cost.funds)}（${V2T.owned} ${fmt(club.economy.assets.funds)}）`),
    )
    const buttons = el('div', 'v2-recruit-buttons')
    for (const role of ['batter', 'pitcher'] as RecruitRole[]) {
      const b = el('button', 'btn-yellow', state.spending ? V2T.recruiting : role === 'batter' ? V2T.recruitBatter : V2T.recruitPitcher)
      b.type = 'button'
      b.dataset.role = role
      b.disabled = full || !affordable || state.spending || !state.canWrite
      b.onclick = async () => {
        b.disabled = true
        const res = await controller.recruit(role)
        if (res.message) toast(res.message)
        if (res.ok && res.outcome) {
          lastRecruitId = res.outcome.op.playerId
          draw(controller.state)
        }
      }
      buttons.append(b)
    }
    const parts: HTMLElement[] = [el('p', 'v2-hint', V2T.recruitHint), info]
    if (full) parts.push(el('p', 'v2-empty', V2T.rosterFull))
    else if (!affordable) parts.push(el('p', 'v2-hint short', V2T.notEnoughFunds))
    parts.push(buttons)
    const recruited = lastRecruitId ? recordOf(club, lastRecruitId) : undefined
    if (recruited) {
      const card = el('div', 'v2-recruit-card')
      const p = recruited.player
      const name = el('div', 'v2-player-name')
      name.append(el('span', '', p.name), el('span', 'v2-level', V2T.level(recruited.level)))
      const chips = el('div', 'v2-player-chips')
      chips.append(p.role === 'batter' ? archetypeChip(p) : pitchChip(p))
      if (p.traits.length) chips.append(traitChips(p))
      const go = el('button', 'btn-white', V2T.goLineup)
      go.type = 'button'
      go.onclick = () => {
        close()
        goToLineup()
      }
      card.append(el('span', 'v2-section-title', V2T.recruitResult), name, gradeLine(p), chips, go)
      parts.push(card)
    }
    body.replaceChildren(...parts)
  }
  draw(controller.state)
  const unsubscribe = controller.subscribe(draw)
  close = v2Modal(V2T.recruitTitle, body, unsubscribe)
  return close
}
