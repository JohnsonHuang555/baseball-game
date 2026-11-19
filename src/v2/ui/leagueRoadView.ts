// 聯盟之路（設計稿 p7 IdRoad）與聯盟詳情（IdLeague）。
// 手機：由上到下傳奇 → 新秀的爬梯，點一個聯盟從底部滑出詳情；電腦版：左邊五階台階、右邊 440px 詳情面板。
// 規則與數字從 LEAGUES／PROMOTION_CONFIG／RANKED_CONFIG 讀（見 leagueInfo.ts）；玩家的積分、位置、歷史最高聯盟只讀存檔（rankedView），不寫入。
import { el } from '../../ui/playerCard'
import type { ClubSave } from '../domain/club'
import { eligibility, leagueOf, rankedView } from '../domain/league'
import { LEAGUES, MAX_TIER } from '../domain/leagueConfig'
import { v2Modal, type CloseReason } from './dialog'
import { icon, type IconName } from './icons'
import { badgeStateFor, leagueBadge, type BadgeState } from './leagueBadge'
import {
  difficultyPips,
  LEAGUE_INTRO,
  linkText,
  multiplierText,
  officialConditions,
  rankedCard,
  rankedRules,
  relegationText,
  rewardText,
  riskLabel,
  riskOf,
} from './leagueInfo'

export interface RoadActions {
  lineup?: () => void
  recruit?: () => void
  /** 打開遊戲指南的某一章 */
  guide?: (chapter: string) => void
}

export interface RoadOptions {
  /** null：存檔還在讀取（只顯示規則，不顯示自己的位置） */
  club: ClubSave | null
  desk?: boolean
  owner?: unknown
  actions?: RoadActions
  onClose?: (reason: CloseReason) => void
  /** 一開始選哪個聯盟（電腦版詳情面板）；預設目前所在 */
  tier?: number
}

const STATE_LABEL: Record<BadgeState, string> = { reached: '已到達', current: '目前所在', locked: '尚未到達' }

function stateChip(state: BadgeState, tier: number): HTMLElement {
  const c = el('span', `v2-state-chip ${state}`, STATE_LABEL[state])
  if (state === 'current') c.style.background = leagueOf(tier).color
  return c
}

function riskTag(tier: number): HTMLElement {
  const box = el('span', `v2-risk-tag ${riskOf(tier)}`, riskLabel(tier))
  return box
}

function tierState(club: ClubSave | null, tier: number): BadgeState {
  return club ? badgeStateFor(tier, club.league.tier, club.league.highestTier) : 'reached'
}

/** 目前所在的位置卡：用正式的晉級條件畫進度（不顯示積分） */
function whereCard(club: ClubSave | null): HTMLElement {
  const card = el('section', 'v2-road-where')
  if (!club) {
    card.classList.add('loading')
    card.append(el('span', 'v2-skel v2-skel-badge'), el('span', 'v2-skel v2-skel-line'))
    card.append(el('p', 'v2-road-loading-note', '聯盟規則可以先看；你的位置讀取完成後才會顯示'))
    return card
  }
  const t = club.league.tier
  const def = leagueOf(t)
  const e = eligibility(club.league, club.idle.nextMatchIndex)
  const names = el('div', 'v2-road-where-names')
  names.append(el('span', 'v2-road-where-k', '你在'), el('strong', '', def.name))
  const head = el('div', 'v2-road-where-head')
  head.append(leagueBadge(t, 'current', 40), names)
  card.append(head)
  if (e.atMaxTier) {
    card.append(el('p', 'v2-road-where-line', '已經在最高的聯盟，繼續養成球隊、維持好成績。'))
  } else {
    const ratio = Math.min(1, e.matches.have / e.matches.need)
    const bar = el('span', 'v2-need-bar')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', '本聯盟場數')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', String(e.matches.need))
    bar.setAttribute('aria-valuenow', String(Math.min(e.matches.have, e.matches.need)))
    const fill = el('span', 'v2-need-fill')
    fill.style.width = `${Math.round(ratio * 100)}%`
    fill.style.background = def.color
    bar.append(fill)
    card.append(bar)
    const rate = Math.round(e.winRate.have * 100)
    card.append(el('p', 'v2-road-where-line', `本聯盟 ${e.matches.have} / ${e.matches.need} 場・最近 ${e.winRate.games} 場勝率 ${rate}%${e.ok ? '・可以挑戰晉級' : ''}`))
  }
  const ranked = rankedCard(rankedView(club.league), { compact: true })
  if (ranked) card.append(ranked)
  if (club.league.highestTier > t) card.append(el('p', 'v2-road-where-line', `歷史最高：${leagueOf(club.league.highestTier).name}`))
  return card
}

function leagueCardButton(tier: number, club: ClubSave | null, onPick: (t: number) => void, selected: boolean): HTMLElement {
  const def = leagueOf(tier)
  const state = tierState(club, tier)
  const b = el('button', `v2-road-card ${state} ${selected ? 'selected' : ''}`.trim())
  b.type = 'button'
  b.dataset.tier = String(tier)
  b.setAttribute('aria-label', `${def.name}，${STATE_LABEL[state]}，查看詳細規則`)
  if (state === 'current') b.style.borderColor = def.color
  const top = el('span', 'v2-road-card-top')
  top.append(el('strong', 'v2-road-card-name', def.name), stateChip(state, tier), el('span', 'v2-road-mult', multiplierText(tier)))
  const mid = el('span', 'v2-road-card-mid')
  mid.append(difficultyPips(tier), el('span', 'v2-road-reward', tier ? `首次晉級 ${rewardText(tier)}` : '起點'))
  const risk = el('span', 'v2-road-card-risk')
  risk.append(riskTag(tier))
  b.append(top, mid, risk)
  if (state === 'current') b.append(el('span', 'v2-road-card-mine', '查看我的位置與晉級條件 ›'))
  b.onclick = () => {
    // Safari 點按鈕不會給焦點：先聚焦，關掉詳情時焦點才回得到這張卡
    b.focus({ preventScroll: true })
    onPick(tier)
  }
  return b
}

/** 一個聯盟的詳細規則（手機底部面板、電腦版右側面板共用） */
export function leagueDetail(tier: number, club: ClubSave | null, actions: RoadActions = {}, close?: () => void): HTMLElement {
  const def = leagueOf(tier)
  const state = tierState(club, tier)
  const box = el('div', `v2-league-detail risk-${riskOf(tier)}`)
  box.dataset.tier = String(tier)
  const head = el('div', 'v2-ld-head')
  head.style.setProperty('--lg', def.color)
  const titles = el('div', 'v2-ld-titles')
  const nameRow = el('div', 'v2-ld-name-row')
  nameRow.append(el('h3', 'v2-ld-name', def.name), stateChip(state, tier))
  titles.append(nameRow, el('p', 'v2-ld-intro', LEAGUE_INTRO[tier]))
  head.append(leagueBadge(tier, state, 60), titles)
  box.append(head)

  const stats = el('div', 'v2-ld-stats')
  const stat = (label: string, value: HTMLElement | string) => {
    const s = el('div', 'v2-ld-stat')
    s.append(el('span', 'v2-ld-stat-k', label))
    if (typeof value === 'string') s.append(el('strong', '', value))
    else s.append(value)
    stats.append(s)
  }
  stat('對手難度', difficultyPips(tier, true))
  stat('比賽收益', multiplierText(tier))
  stat('首次晉級獎勵', !tier ? '—' : club?.league.rewardedTiers.includes(tier) ? `已領取（${rewardText(tier)}）` : rewardText(tier))
  box.append(stats)

  const section = (title: string, ...children: HTMLElement[]) => {
    const s = el('section', 'v2-ld-section')
    s.append(el('h4', 'v2-ld-h', title), ...children)
    box.append(s)
    return s
  }

  const conds = el('ol', 'v2-ld-conds')
  for (const c of officialConditions(tier)) conds.append(el('li', '', c))
  section(tier >= MAX_TIER ? '晉級條件' : `晉級到${leagueOf(tier + 1).name}（目前規則）`, conds)

  if (state === 'current' && club) {
    const mine = rankedCard(rankedView(club.league))
    if (mine) section('你在這裡・競技積分', mine)
  }

  const rules = rankedRules(tier)
  if (rules.length) {
    const list = el('ul', 'v2-ld-ranked-rules')
    for (const c of rules) list.append(el('li', '', c))
    section('競技積分', list)
  }

  const rel = relegationText(tier)
  const relBox = el('div', `v2-ld-rel ${rel.risk}`)
  const relHead = el('div', 'v2-ld-rel-head')
  relHead.append(el('strong', '', rel.title))
  relBox.append(relHead, el('p', '', rel.text))
  section('降級規則', relBox)

  const rel2 = el('div', 'v2-ld-rel-nodes')
  const node = (t: number, label: string) => {
    const nd = el('span', 'v2-ld-node')
    nd.append(leagueBadge(t, tierState(club, t), 28), el('span', '', `${label}${leagueOf(t).name}`))
    return nd
  }
  if (tier > 0) rel2.append(node(tier - 1, '低一級　'), el('span', 'v2-ld-node-arrow', '→'))
  rel2.append(node(tier, '這一級　'))
  if (tier < MAX_TIER) rel2.append(el('span', 'v2-ld-node-arrow', '→'), node(tier + 1, '高一級　'))
  section('與上下級的關係', rel2)

  if (state === 'current') {
    const links = el('div', 'v2-ld-links')
    const link = (label: string, ic: IconName, run?: () => void) => {
      if (!run) return
      const b = el('button', 'btn-white v2-ld-link')
      b.type = 'button'
      b.append(icon(ic, 18), el('span', '', label), icon('chev', 12))
      b.onclick = () => {
        close?.()
        run()
      }
      links.append(b)
    }
    link('檢查陣容與守位', 'lineup', actions.lineup)
    link('招募新球員', 'recruit', actions.recruit)
    link('看晉級規則', 'league', actions.guide && (() => actions.guide!('promotion')))
    if (links.childNodes.length) section('可以優先看看', links)
  }
  return box
}

/** 手機：從底部滑出的聯盟詳情 */
export function openLeagueDetail(tier: number, club: ClubSave | null, actions: RoadActions = {}, owner?: unknown, closeRoad?: () => void): () => void {
  let close: () => void = () => {}
  const body = leagueDetail(tier, club, actions, () => {
    close()
    closeRoad?.()
  })
  close = v2Modal(`${leagueOf(tier).name}的規則`, body, undefined, { sheet: true, noCloseButton: true, className: 'v2-league-detail-modal', owner })
  return close
}

export function openLeagueRoad(o: RoadOptions): () => void {
  const { club } = o
  const desk = !!o.desk
  const actions = o.actions ?? {}
  let close: () => void = () => {}
  const body = el('div', `v2-road ${desk ? 'desk' : ''}`.trim())
  const intro = el('p', 'v2-road-path', LEAGUES.map((l) => l.name.replace('聯盟', '')).join(' → '))
  body.append(intro, whereCard(club))

  let selected = o.tier ?? club?.league.tier ?? 0
  const panel = el('aside', 'v2-road-panel')
  panel.setAttribute('aria-live', 'polite')
  const renderPanel = () => panel.replaceChildren(leagueDetail(selected, club, actions, () => close()))

  if (desk) {
    const stage = el('div', 'v2-road-stage')
    const legend = el('div', 'v2-road-legend')
    const lg1 = el('span', 'v2-road-zone safe', '新手養成區・只升不降')
    const lg2 = el('span', 'v2-road-zone ranked')
    lg2.append('競技區・積分升降級（挑戰者起）')
    legend.append(lg1, lg2)
    const steps = el('div', 'v2-road-steps')
    const cards: HTMLElement[] = []
    const pick = (t: number) => {
      selected = t
      cards.forEach((c, i) => c.classList.toggle('selected', i === t))
      renderPanel()
    }
    LEAGUES.forEach((_, t) => {
      const col = el('div', 'v2-road-step')
      const card = leagueCardButton(t, club, pick, t === selected)
      cards.push(card)
      const block = el('span', 'v2-road-block')
      block.style.height = `${40 + t * 70}px`
      block.style.background = leagueOf(t).color
      block.append(el('span', '', t === MAX_TIER ? '頂點' : t === 2 ? '保底' : t > 2 ? '↕' : '↑'))
      col.append(card, block)
      steps.append(col)
    })
    stage.append(legend, steps)
    const layout = el('div', 'v2-road-layout')
    renderPanel()
    layout.append(stage, panel)
    body.append(layout)
  } else {
    const ladder = el('div', 'v2-road-ladder')
    const zone = (text: string, ranked: boolean) => {
      const z = el('div', `v2-road-zone ${ranked ? 'ranked' : 'safe'}`)
      z.append(text)
      return z
    }
    for (let t = MAX_TIER; t >= 0; t--) {
      if (t === MAX_TIER) ladder.append(zone('競技區・積分升降級（挑戰者起）', true))
      if (t === 1) ladder.append(zone('新手養成區・只升不降', false))
      const row = el('div', 'v2-road-row')
      const rail = el('span', 'v2-road-rail')
      rail.style.setProperty('--lg', leagueOf(t).color)
      rail.append(leagueBadge(t, tierState(club, t), 44))
      row.append(rail, leagueCardButton(t, club, (x) => openLeagueDetail(x, club, actions, o.owner, () => close()), false))
      ladder.append(row)
      if (t > 0) {
        const l = linkText(t)
        const link = el('div', `v2-road-link ${l.tone}`)
        link.append(el('span', '', l.text))
        ladder.append(link)
      }
    }
    body.append(ladder)
  }
  body.append(el('p', 'v2-road-foot', '點任一聯盟看詳細規則・競技積分只影響保級，晉級一律看場數、勝率與挑戰賽'))

  const head = el('div', 'v2-full-head')
  head.append(icon('league', 32), el('span', 'v2-full-title', '聯盟之路'))
  close = v2Modal('聯盟之路', body, o.onClose, { full: true, header: head, noCloseButton: true, className: 'v2-road-modal', owner: o.owner })
  return close
}
