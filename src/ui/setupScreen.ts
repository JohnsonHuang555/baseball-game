import { cardTier, isSpecial, overall, teamAverage, teamName } from '../sim/generate'
import { Rng } from '../sim/rng'
import {
  getSlot,
  isPitcherSlot,
  rerollPlayer,
  rerollTeam,
  setCaptain,
  swapPositions,
  swapSlots,
  type PregameSetup,
  type Slot,
} from '../sim/setup'
import { EQUIPMENT, MAX_EQUIPMENT, type EquipmentId } from '../sim/items'
import { fieldingAtPosition, isOffPosition } from '../sim/positions'
import { captainIn, captainWeight } from '../sim/synergy'
import { TRAITS } from '../sim/traits'
import type { Batter, Player, Position, Roster, Team } from '../sim/types'
import { avatar } from './avatar'
import { gradeBadge, gradeOf, overallBadge } from './grades'
import { el, traitTag } from './playerCard'
import { kbd, setKeys, type KeyMap } from './keys'
import { choiceModal, infoModal } from './modal'
import { TEAM_NAME_MAX, loadSynergyExpanded, saveSynergyExpanded, saveTeamName } from './prefs'
import { play } from './sound'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { ARCHETYPE_NAMES, CAPTAIN_TITLES, EQUIPMENT_NAMES, POSITION_FULL, POSITION_NAMES, POSITION_SPOT, RATING_FULL, RATING_LABELS, SYNERGY_NAMES, T, equipmentDesc } from './strings'
import { archetypeIcon, captainIcon, captainTag, diffTag, diffText, playerSynergies, synergyBadges, synergyDiff, synergyIcon, synergySheetBody, synergyTracker } from './synergyUi'
import { bestArrangement, offPositionCount, type ArrangeMove } from '../sim/arrange'
import { applyCardState, miniCard, offPosIcon, offPositionNote, playerHeader, ratingBars, toast, traitList } from './visual'

export interface RosterEditorOptions {
  setup: PregameSetup
  /** 每次重畫時取得；改隊名可能會讓對手換名字 */
  opponent?: () => Team
  /** 標題下的說明；沒給就依能不能重骰顯示預設的說明 */
  hint?: string
  /** 標題上方的小字，例如「我的球隊」或「錦標賽・八強」 */
  heading: string
  /** 開打前可以整隊重骰和改隊名；比賽之間只能調整陣容 */
  allowReroll: boolean
  /** 能不能重骰單一球員（錦標賽中用贏球得到的球員骰子）；沒給就跟 allowReroll 一樣 */
  allowPlayerReroll?: boolean
  startLabel: string
  /** 錦標賽兩場之間：點球員可以從背包裝上裝備、卸下身上的裝備 */
  gear?: GearOptions
  onChange?: (setup: PregameSetup) => void
  onStart: (setup: PregameSetup) => void
  onBack: () => void
}

/** 佈陣時管理裝備：裝上、卸下後回傳新的名單（呼叫端負責存檔） */
export interface GearOptions {
  bag: () => readonly EquipmentId[]
  /** 把背包第 bagIndex 件裝到球員身上；裝滿時 replace 指定換下哪一件 */
  equip: (playerId: string, bagIndex: number, replace?: number) => Roster
  unequip: (playerId: string, index: number) => Roster
}

/** 電腦版球場圖（366 × 286）上各守位的中心點，對照一般的守備位置圖 */
const FIELD_W = 366
const FIELD_H = 286
const SPOTS: Record<Position | 'P', [number, number]> = {
  CF: [183, 28],
  LF: [58, 50],
  RF: [308, 50],
  SS: [123, 104],
  '2B': [243, 104],
  '3B': [76, 166],
  '1B': [290, 166],
  P: [183, 176],
  C: [183, 240],
  DH: [104, 240],
}

/**
 * 手機版球場圖比較高（366 × 349），球場等比例縮小置中，上下留草地；
 * 球員排成錯開的四排，名字和標籤才不會壓到下一排的頭像
 */
const MOBILE_FIELD_H = 349
const MOBILE_SPOTS: Record<Position | 'P', [number, number]> = {
  LF: [50, 38],
  CF: [183, 38],
  RF: [316, 38],
  SS: [118, 114],
  '2B': [248, 114],
  '3B': [46, 196],
  '1B': [320, 196],
  P: [183, 216],
  C: [183, 278],
  DH: [70, 278],
}

const fieldSvg = (viewBox: string, className: string, pattern: string) => `<svg viewBox="${viewBox}" class="${className}" aria-hidden="true">
  <defs><pattern id="${pattern}" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="20" fill="#000" opacity="0.07"/></pattern></defs>
  <rect x="-40" y="-60" width="446" height="406" fill="#2E8C43"/>
  <path d="M183 262 L0 79 A259 259 0 0 1 366 79 Z" fill="#43B356"/>
  <path d="M183 262 L0 79 A259 259 0 0 1 366 79 Z" fill="url(#${pattern})"/>
  <path d="M0 79 A259 259 0 0 1 366 79" fill="none" stroke="#E3A867" stroke-width="10"/>
  <path d="M183 282 L279 190 L183 96 L87 190 Z" fill="#E3A867"/>
  <path d="M183 250 L241 190 L183 132 L125 190 Z" fill="#43B356"/>
  <path d="M183 262 L0 79 M183 262 L366 79" stroke="#FFF" stroke-width="2.5"/>
  <circle cx="183" cy="190" r="11" fill="#E3A867"/>
  <rect x="249" y="184" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 255 190)"/>
  <rect x="177" y="112" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 183 118)"/>
  <rect x="105" y="184" width="12" height="12" fill="#FFF" stroke="#141633" stroke-width="1.5" transform="rotate(45 111 190)"/>
</svg>`
const FIELD_SVG = fieldSvg('0 0 366 286', 'desk-only', 'mow-desk') + fieldSvg('-9.6 -40.6 385.3 367.3', 'mobile-only', 'mow-mobile')

const ICONS = {
  back: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  pencil: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  shuffle: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>',
  dice: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="16" cy="16" r="1.4" fill="currentColor"/></svg>',
  close: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  star: '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z"/></svg>',
}

function iconButton(className: string, icon: string, label: string): HTMLButtonElement {
  const b = el('button', className)
  b.type = 'button'
  b.innerHTML = icon
  b.setAttribute('aria-label', label)
  return b
}

function withIcon(className: string, icon: string, text: string): HTMLButtonElement {
  const b = el('button', className)
  b.type = 'button'
  b.innerHTML = icon
  b.append(text)
  return b
}

function sameSlot(a: Slot | null, b: Slot): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 對手陣容：上方是對手的羈絆與隊長；下面打序（守位、流派、左右打、本職、四項能力）、投手、板凳。
 * 列表裡的字母不上色（S、A 例外），守非本職的守備改紅字
 */
export function opponentRoster(team: Team): HTMLElement {
  const r = team.roster
  const box = el('div', 'opp-roster')
  const captainId = captainIn(r.lineup, r.captain)
  const captain = r.lineup.find((s) => s.player.id === captainId)?.player

  const top = el('div', 'opp-synergies')
  top.append(el('span', 'opp-syn-label', T.synergyTitle), synergyBadges(r.lineup, r.captain, team.relics ?? [], { full: true }))
  if (captain) {
    const cap = el('span', 'opp-captain')
    cap.append(captainIcon(18), `${CAPTAIN_TITLES[captain.archetype]} ${captain.name}`)
    top.append(cap)
  }
  box.append(top)

  const row = (p: Player, mark: string, position: Position | null, kind: 'order' | 'pitcher' | 'bench') => {
    const line = el('div', `opp-row ${kind}`)
    const off = p.role === 'batter' && position !== null && isOffPosition(p, position)
    const who = el('span', 'opp-who')
    const name = el('span', 'opp-name-row')
    name.append(el('span', 'opp-name', p.name))
    if (p.id === captainId) name.append(captainIcon(16))
    const sub = el('span', `opp-sub${off ? ' off' : ''}`)
    if (p.role === 'batter') {
      sub.append(archetypeIcon(p.archetype, 14))
      if (off) sub.append(offPosIcon(12))
      sub.append([ARCHETYPE_NAMES[p.archetype].replace('型', ''), T.bats[p.bats], ...(off ? [T.primaryShort(POSITION_SPOT[p.primary])] : [])].join('・'))
    } else sub.append(T.throws[p.throws])
    const traits = el('span', 'opp-traits desk-only')
    traits.append(...p.traits.map(traitTag))
    sub.append(traits)
    who.append(name, sub)
    const grades = el('span', 'opp-grades')
    for (const [k, v] of Object.entries(p.ratings)) {
      const value = k === 'fielding' && p.role === 'batter' && position ? fieldingAtPosition(p, position) : v
      const g = gradeBadge(value, 'sm', true)
      if (k === 'fielding' && off) g.classList.add('off-outline')
      grades.append(g)
    }
    line.append(el('span', `opp-mark ${kind}`, mark), el('span', 'opp-pos', position ? POSITION_NAMES[position] : kind === 'pitcher' ? T.pitcherMark : T.benchMark), who, grades)
    return line
  }
  // 每一段的標題列，右邊對齊能力字母放欄位名稱
  const section = (title: string, sub: string, sample: Player, rows: HTMLElement[]) => {
    const sec = el('section', 'opp-section')
    const head = el('div', 'opp-head')
    const labels = el('span', 'opp-grades')
    for (const k of Object.keys(sample.ratings)) labels.append(el('span', 'opp-label', RATING_LABELS[k as keyof typeof RATING_LABELS]))
    const h = el('h3', 'opp-title', title)
    h.append(el('span', 'opp-title-sub', sub))
    head.append(h, labels)
    sec.append(head, ...rows)
    return sec
  }
  const columns = el('div', 'opp-columns')
  columns.append(section(T.battingOrder, T.oppOrderSub, r.lineup[0].player, r.lineup.map((s, i) => row(s.player, String(i + 1), s.position, 'order'))))
  const right = el('div', 'opp-side')
  right.append(section(T.pitcher, T.oppPitcherSub, r.starter, [row(r.starter, T.starter, null, 'pitcher'), ...r.relievers.map((p) => row(p, T.reliever, null, 'pitcher'))]))
  if (r.bench.length) right.append(section(T.bench, T.oppBenchSub, r.bench[0], r.bench.map((p) => row(p, T.benchMark, null, 'bench'))))
  columns.append(right)
  box.append(columns)
  return box
}

/** 「最多羈絆排法」的一項改動套用到名單上（逐步預告羈絆變化用） */
function applyMove(roster: Roster, move: ArrangeMove): Roster {
  const lineup = roster.lineup.map((s) => {
    if (move.type === 'in' && s.player.id === move.out.id) return { player: move.player, position: move.position }
    if (move.type === 'move' && s.player.id === move.player.id) return { ...s, position: move.to }
    return s
  })
  const captain = move.type === 'in' && roster.captain === move.out.id ? undefined : roster.captain
  return { ...roster, lineup, captain }
}

/** 打開對手陣容的視窗（佈陣畫面的對手標籤、錦標賽主畫面的「看對手陣容」） */
export function showOpponentRoster(team: Team): void {
  infoModal(T.opponentRosterOf(team.name), opponentRoster(team), true)
  const boxes = document.querySelectorAll('.info-box')
  boxes[boxes.length - 1]?.classList.add('opp-box')
}

/** 組隊畫面：球場上的先發、板凳與後援、打序表；點球員看詳細資料、重骰或交換 */
export function showRosterEditor(root: HTMLElement, opts: RosterEditorOptions): void {
  let setup = opts.setup
  const { allowReroll } = opts
  const allowPlayerReroll = opts.allowPlayerReroll ?? allowReroll
  /** 正在選交換對象時，記住第一個人 */
  let swapFrom: Slot | null = null
  let revealed: Slot[] | 'all' = 'all'
  let renaming = false

  function update(next: PregameSetup): void {
    setup = next
    opts.onChange?.(setup)
  }

  function rename(name: string): void {
    update({ ...setup, team: { ...setup.team, name } })
    toast(T.renamed(name))
    renaming = false
    revealed = []
    render()
  }

  function isRevealed(slot: Slot): boolean {
    return revealed === 'all' || revealed.some((s) => sameSlot(s, slot))
  }

  function slotLabel(slot: Slot): string {
    switch (slot.kind) {
      case 'lineup': {
        const spot = setup.team.roster.lineup[slot.index]
        return T.orderAndPosition(slot.index + 1, POSITION_FULL[spot.position])
      }
      case 'bench':
        return T.bench
      case 'starter':
        return T.starter
      case 'reliever':
        return T.reliever
    }
  }

  function header(): HTMLElement {
    const head = el('header', 'team-header')
    const top = el('div', 'team-header-row')
    const back = iconButton('icon-btn', ICONS.back, T.backToTitle)
    back.onclick = opts.onBack
    top.append(back)

    if (allowReroll && renaming) {
      const box = el('div', 'rename')
      const label = el('label', 'sr-only', T.teamNamePlaceholder)
      label.htmlFor = 'team-name'
      const input = el('input', 'rename-input')
      input.id = 'team-name'
      input.value = setup.team.name
      input.maxLength = TEAM_NAME_MAX
      input.placeholder = T.teamNamePlaceholder
      const save = el('button', 'btn-small btn-yellow', T.confirm)
      save.onclick = () => {
        const name = input.value.trim().slice(0, TEAM_NAME_MAX)
        if (!name) return input.focus()
        saveTeamName(name)
        rename(name)
      }
      input.onkeydown = (e) => {
        if (e.key === 'Enter') save.click()
        if (e.key === 'Escape') {
          renaming = false
          render()
        }
      }
      box.append(label, input, save)
      top.append(box)
      queueMicrotask(() => input.focus())
    } else {
      const titles = el('div', 'team-titles')
      titles.append(el('span', 'eyebrow-light', opts.heading), el('h1', 'team-name', setup.team.name))
      top.append(titles)
    }
    const ovr = el('div', 'team-ovr')
    ovr.append(el('span', 'eyebrow-light', T.overallLabel), gradeBadge(teamAverage(setup.team.roster), 'xl'))
    top.append(ovr)

    const sub = el('div', 'team-header-row')
    if (allowReroll) {
      if (!renaming) {
        const edit = withIcon('pill-btn', ICONS.pencil, T.rename)
        edit.onclick = () => {
          renaming = true
          render()
        }
        sub.append(edit)
      }
      const random = withIcon('pill-btn', ICONS.shuffle, T.randomName)
      random.onclick = () => {
        // 選隨機隊名代表不再沿用自訂的名字
        saveTeamName(null)
        let name = setup.team.name
        while (name === setup.team.name) name = teamName(new Rng(randomSeed()))
        rename(name)
      }
      sub.append(random)
    } else {
      sub.append(el('span', 'lineup-hint', opts.hint ?? (allowPlayerReroll ? T.lineupDiceHint(setup.playerRerollsLeft) : T.lineupOnlyHint)))
    }
    // 對手：點一下看完整陣容，佈陣時可以對照（自由練習編輯球隊時沒有對手）
    const opponent = opts.opponent?.()
    if (opponent) {
      const vs = el('button', 'vs-pill')
      vs.type = 'button'
      vs.title = T.opponentRoster
      vs.append(el('span', 'vs-mark', T.versus), el('span', 'vs-name', opponent.name), gradeBadge(teamAverage(opponent.roster), 'sm'), el('span', 'vs-more', T.viewRoster))
      vs.onclick = () => showOpponentRoster(opponent)
      sub.append(vs)
    }
    head.append(top, sub)
    return head
  }

  /** 球場圖：九個守位加上指定打擊，重骰時依打序一張張翻開 */
  function field(): HTMLElement {
    const r = setup.team.roster
    const box = el('section', 'pitch')
    box.setAttribute('aria-label', '守備位置')
    box.innerHTML = FIELD_SVG
    const place = (slot: Slot, spot: Position | 'P', order: number | null) => {
      const p = getSlot(r, slot)
      const node = el('button', 'field-node')
      node.type = 'button'
      node.dataset.pid = p.id
      const [x, y] = SPOTS[spot]
      const [mx, my] = MOBILE_SPOTS[spot]
      node.style.setProperty('--dx', `${(x / FIELD_W) * 100}%`)
      node.style.setProperty('--dy', `${(y / FIELD_H) * 100}%`)
      node.style.setProperty('--mx', `${(mx / FIELD_W) * 100}%`)
      node.style.setProperty('--my', `${(my / MOBILE_FIELD_H) * 100}%`)
      applyCardState(node, p, { selected: sameSlot(swapFrom, slot), reveal: isRevealed(slot) })
      if (swapFrom && !sameSlot(swapFrom, slot) && isPitcherSlot(swapFrom) === isPitcherSlot(slot)) node.classList.add('target')
      if (isRevealed(slot)) node.style.setProperty('--delay', `${(order ?? 0) * 60}ms`)
      const ring = el('span', 'node-ring')
      ring.append(avatar(p.id, 'user'), overallBadge(p, 'sm', true))
      // 流派徽章掛在頭像右上角，隊長標記在左下角
      if (p.role === 'batter') {
        const arch = archetypeIcon(p.archetype, 18)
        arch.classList.add('node-arch')
        ring.append(arch)
        if (p.id === captainIn(r.lineup, r.captain)) {
          const cap = captainIcon(18)
          cap.classList.add('node-captain')
          ring.append(cap)
        }
      }
      ring.append(el('span', order === null ? 'node-tag-p' : 'node-order', order === null ? T.pitcherMark : String(order)))
      const name = el('span', 'node-name', p.name)
      node.append(ring, name)
      const off = p.role === 'batter' && spot !== 'P' && spot !== 'DH' && isOffPosition(p, spot)
      if (off) {
        // 守非本職：名牌換紅框、加警示三角
        name.classList.add('off')
        name.prepend(offPosIcon(11))
      }
      const preview = swapPreview(slot, 'field')
      if (preview) node.append(...preview)
      else if (spot === 'DH') node.append(el('span', 'node-dh', T.designatedHitter))
      else if (off && p.role === 'batter') {
        // 標出打折後的守備
        const from = gradeOf(p.ratings.fielding)
        const to = gradeOf(fieldingAtPosition(p, spot))
        node.append(el('span', 'node-off', from === to ? T.offPosition : T.fieldingDrop(from, to)))
      }
      node.setAttribute('aria-label', `${slotLabel(slot)} ${p.name}`)
      node.onclick = () => onTap(slot, 'field')
      box.append(node)
    }
    r.lineup.forEach((s, i) => place({ kind: 'lineup', index: i }, s.position, i + 1))
    place({ kind: 'starter' }, 'P', null)
    return box
  }

  function reserves(): HTMLElement {
    const r = setup.team.roster
    const sec = el('section', 'reserves')
    const labels = el('div', 'reserve-labels')
    labels.append(el('span', '', T.benchNoSynergy), el('span', '', T.relievers))
    const grid = el('div', 'reserve-grid')
    const slots: Slot[] = [
      ...r.bench.map((_, i): Slot => ({ kind: 'bench', index: i })),
      ...r.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i })),
    ]
    for (const slot of slots) {
      // 身分標籤只在電腦版顯示；手機版改用上方的「板凳／後援投手」標題
      const role = slot.kind === 'bench' ? T.bench : T.relievers
      const p = getSlot(r, slot)
      const card = miniCard(p, role, 'user', { selected: sameSlot(swapFrom, slot), reveal: isRevealed(slot) })
      card.querySelector('.mini-top .grade')?.replaceWith(overallBadge(p, 'sm', true))
      // 板凳打者在名字後面標本職，例如「黃志偉 本職游」
      const nameNode = card.querySelector('.mini-name')
      if (p.role === 'batter') card.querySelector('.mini-top')?.append(archetypeIcon(p.archetype, 16))
      if (p.role === 'batter' && nameNode) {
        const line = el('span', 'mini-name-row')
        nameNode.replaceWith(line)
        line.append(nameNode, el('span', 'mini-primary', T.primaryShort(POSITION_NAMES[p.primary])))
      }
      const preview = swapPreview(slot, 'reserve')
      if (preview) card.append(...preview)
      card.onclick = () => onTap(slot, 'reserve')
      grid.append(card)
    }
    sec.append(labels, grid)
    return sec
  }

  /** 交換模式中點這一格會得到的名單：球場上的人互換守位，其他情況（板凳換上先發、打序列表）互換位置 */
  function swapResult(slot: Slot, source: 'field' | 'list' | 'reserve'): Roster | null {
    if (!swapFrom || sameSlot(swapFrom, slot) || isPitcherSlot(swapFrom) !== isPitcherSlot(slot)) return null
    const roster = setup.team.roster
    if (swapFrom.kind === 'lineup' && slot.kind === 'lineup' && source === 'field') return swapPositions(roster, swapFrom.index, slot.index)
    return swapSlots(roster, swapFrom, slot)
  }

  /**
   * 交換模式的預告，掛在球場上的人和板凳上（打序列表交換棒次不影響羈絆，所以不掛）：
   * 羈絆的啟動、升級、失效，以及交換後誰會守非本職；最多兩個標籤
   */
  function swapPreview(slot: Slot, source: 'field' | 'reserve'): HTMLElement[] | null {
    if (!swapFrom || isPitcherSlot(swapFrom) || isPitcherSlot(slot)) return null
    if (sameSlot(swapFrom, slot)) return [el('span', 'node-preview sel', T.swapping)]
    const before = setup.team.roster
    const after = swapResult(slot, source)
    if (!after) return null
    const tags: HTMLElement[] = synergyDiff(before, after, setup.team.relics ?? [])
      .filter((d) => d.kind !== 'count')
      .map((d) => {
        const tag = el('span', `node-preview ${d.kind}`, diffText(d, true))
        return tag
      })
    const ids = [getSlot(before, swapFrom).id, getSlot(before, slot).id]
    const offNow = after.lineup.filter((s) => ids.includes(s.player.id) && isOffPosition(s.player, s.position)).map((s) => s.player.name)
    if (offNow.length) tags.push(el('span', 'node-preview warn', offNow.length > 1 ? T.bothOffPosition : T.nameOffPosition(offNow[0])))
    return tags.slice(0, 2)
  }

  /** 名單改了之後：如果羈絆有變，把最重要的變化接在提示後面，例如「A 與 B 交換守位・黃金二遊 成立」 */
  function toastWithSynergy(message: string, before: Roster, after: Roster): void {
    const change = synergyDiff(before, after, setup.team.relics ?? []).find((d) => d.kind !== 'count')
    toast(change ? `${message}・${diffText(change)}` : message)
  }

  /** 手機版用短標籤（打），電腦版用全名（打擊） */
  function dualLabel(short: string, full: string): HTMLElement {
    const s = el('span')
    s.append(el('span', 'mobile-only', short), el('span', 'desk-only', full))
    return s
  }

  /**
   * 打序表。電腦版是右欄的表格（多出流派、守位兩欄與先發投手列），點一列跟點球場上的人一樣；
   * 手機版放在「我方打序」底部面板裡，給了 sheet 時點兩列交換棒次、點頭像看球員資料
   */
  function orderTable(sheet?: { picked: number | null; onRow: (index: number) => void; onAvatar: (index: number) => void }): { section: HTMLElement; list: HTMLElement } {
    const sec = el('section', `order-panel${sheet ? ' in-sheet' : ''}`)
    sec.setAttribute('aria-label', T.battingOrder)
    const head = el('div', 'order-head')
    head.append(dualLabel(T.orderColumn, T.orderColumnFull), el('span'), el('span', 'left', T.playerColumn))
    if (!sheet) head.append(el('span', 'left desk-only', T.archetypeLabel), el('span', 'left desk-only', T.positionColumn))
    for (const k of ['contact', 'power', 'speed', 'fielding'] as const) head.append(dualLabel(RATING_SHORT[k], RATING_FULL[k]))
    const list = el('div', 'order-list')
    const roster = setup.team.roster
    const captain = captainIn(roster.lineup, roster.captain)
    roster.lineup.forEach((spot, i) => {
      const slot: Slot = { kind: 'lineup', index: i }
      const p = spot.player
      const off = isOffPosition(p, spot.position)
      const selected = sheet ? sheet.picked === i : sameSlot(swapFrom, slot)
      const row = el('div', `order-row ${selected ? 'selected' : ''}${off ? ' off' : ''}`)
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      const who = el('span', 'order-who')
      const name = el('span', 'order-name-row')
      name.append(el('span', 'order-name', p.name))
      if (p.id === captain) name.append(captainIcon(16))
      who.append(name)
      // 手機版第二行：流派、守位與本職；電腦版拆成流派、守位兩欄
      const line = orderPosition(p, spot.position)
      if (!sheet) line.classList.add('mobile-only')
      who.append(line)
      const face = avatar(p.id, 'user', 'ring')
      if (sheet) {
        const button = el('button', 'order-face')
        button.type = 'button'
        button.setAttribute('aria-label', T.playerDetailOf(p.name))
        button.append(face)
        button.onclick = (e) => {
          e.stopPropagation()
          sheet.onAvatar(i)
        }
        row.append(el('span', 'order-num', String(i + 1)), button, who)
      } else row.append(el('span', 'order-num', String(i + 1)), face, who)
      if (!sheet) {
        const arch = el('span', 'order-arch desk-only')
        arch.append(archetypeIcon(p.archetype, 18), ARCHETYPE_NAMES[p.archetype])
        const pos = orderPosition(p, spot.position, false)
        pos.classList.add('desk-only')
        row.append(arch, pos)
      }
      for (const k of ['contact', 'power', 'speed'] as const) row.append(gradeBadge(p.ratings[k], 'md', true))
      const fielding = gradeBadge(fieldingAtPosition(p, spot.position), 'md', true)
      if (off) fielding.classList.add('off-outline')
      row.append(fielding)
      row.setAttribute('aria-label', `第 ${i + 1} 棒 ${p.name}`)
      const tap = () => (sheet ? sheet.onRow(i) : onTap(slot, 'list'))
      row.onclick = tap
      row.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          tap()
        }
      }
      list.append(row)
    })
    sec.append(head, list)
    if (sheet) return { section: sec, list }

    // 電腦版：表格底部的先發投手列，三項能力對齊在打擊、力量、速度下面
    const starter = roster.starter
    const pitcherRow = el('button', 'order-pitcher desk-only')
    pitcherRow.type = 'button'
    const who = el('span', 'order-who')
    who.append(el('span', 'order-name', starter.name), el('span', 'order-pos', `${T.pitcher}・${T.throws[starter.throws]}`))
    pitcherRow.append(el('span', 'order-num-label', T.starter), avatar(starter.id, 'user', 'ring'), who)
    Object.entries(starter.ratings).forEach(([k, v], i) => {
      const cell = el('span', `pitcher-stat${i === 0 ? ' first' : ''}`)
      cell.append(el('span', 'pitcher-stat-label', RATING_FULL[k as keyof typeof RATING_FULL]), gradeBadge(v, 'md', true))
      pitcherRow.append(cell)
    })
    pitcherRow.onclick = () => onTap({ kind: 'starter' }, 'list')
    sec.append(pitcherRow)
    return { section: sec, list }
  }

  /** 手機版的「我方打序」按鈕：9 個小頭像（流派、隊長、守非本職紅框）加棒次，點開打序面板 */
  function orderButton(): HTMLElement {
    const roster = setup.team.roster
    const captain = captainIn(roster.lineup, roster.captain)
    const button = el('button', 'order-open')
    button.type = 'button'
    button.setAttribute('aria-label', T.openBattingOrder)
    const head = el('span', 'order-open-head')
    head.append(el('span', 'order-open-title', T.myBattingOrder), el('span', 'order-open-sub', T.battingOrderHint))
    head.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#141633" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>')
    const minis = el('span', 'order-minis')
    roster.lineup.forEach((spot, i) => {
      const p = spot.player
      const mini = el('span', `order-mini${isOffPosition(p, spot.position) ? ' off' : ''}`)
      const face = el('span', 'order-mini-face')
      face.append(avatar(p.id, 'user'))
      const arch = archetypeIcon(p.archetype, 12)
      arch.classList.add('order-mini-arch')
      face.append(arch)
      if (p.id === captain) {
        const cap = captainIcon(12)
        cap.classList.add('order-mini-cap')
        face.append(cap)
      }
      mini.append(face, el('span', 'order-mini-num', String(i + 1)))
      minis.append(mini)
    })
    button.append(head, minis)
    button.onclick = openOrderSheet
    return button
  }

  /** 手機版的打序面板：點兩個人交換棒次（不影響羈絆），點頭像打開球員資料 */
  function openOrderSheet(): void {
    let picked: number | null = null
    const sheet = el('div', 'sheet order-sheet')
    const panel = el('section', 'sheet-panel paper order-sheet-panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', T.myBattingOrder)
    let previousKeys: KeyMap = {}
    const close = () => {
      sheet.remove()
      setKeys(previousKeys)
    }
    sheet.onclick = (e) => {
      if (e.target === sheet) close()
    }
    const draw = () => {
      const head = el('header', 'order-sheet-head')
      const titles = el('span', 'order-sheet-titles')
      titles.append(el('span', 'order-sheet-team', setup.team.name), el('span', 'order-sheet-title', T.myBattingOrder))
      const x = iconButton('icon-btn', ICONS.close, T.close)
      x.onclick = close
      head.append(titles, x)
      const { section } = orderTable({
        picked,
        onRow: (i) => {
          if (picked === null) picked = i
          else if (picked === i) picked = null
          else {
            const roster = swapSlots(setup.team.roster, { kind: 'lineup', index: picked }, { kind: 'lineup', index: i })
            if (roster) {
              const a = setup.team.roster.lineup[picked].player.name
              const b = setup.team.roster.lineup[i].player.name
              update({ ...setup, team: { ...setup.team, roster } })
              toast(T.swappedOrder(a, b))
              render()
            }
            picked = null
          }
          draw()
        },
        onAvatar: (i) => {
          close()
          openDetail({ kind: 'lineup', index: i })
        },
      })
      panel.replaceChildren(el('span', 'sheet-handle'), head, section, el('footer', 'order-sheet-foot', T.battingOrderSheetHint))
    }
    draw()
    sheet.append(panel)
    root.append(sheet)
    previousKeys = setKeys({ Escape: close })
  }

  /** 羈絆追蹤欄：手機版在球場圖上方、可以收合；電腦版在板凳下方 */
  function tracker(): HTMLElement {
    const relics = setup.team.relics ?? []
    return synergyTracker(setup.team.roster, relics, {
      expanded: loadSynergyExpanded(),
      onToggle: (expanded) => {
        saveSynergyExpanded(expanded)
        render()
      },
      onOpen: (row) => infoModal(SYNERGY_NAMES[row.key], synergySheetBody(row, setup.team.roster, relics)),
      extra: autoButton('syn-auto'),
    })
  }

  /** 「最多羈絆排法」按鈕 */
  function autoButton(className: string): HTMLElement {
    const b = el('button', `btn-white ${className}`)
    b.type = 'button'
    b.append(synergyIcon('power', 22), el('span', '', T.bestArrangement))
    b.onclick = openBestArrangement
    return b
  }

  /**
   * 最多羈絆排法：從先發加板凳排出羈絆最多、盡量沒人守非本職的陣容。
   * 先預覽「現在 → 排完」和每一項改動，按「套用」才生效
   */
  function openBestArrangement(): void {
    const relics = setup.team.relics ?? []
    const before = setup.team.roster
    const best = bestArrangement(before, relics)
    if (!best) {
      toast(T.alreadyBest)
      return
    }
    const body = el('div', 'auto-sheet')
    body.append(el('p', 'auto-sub', T.bestArrangementHint))
    const compare = (label: string, roster: Roster, after: boolean) => {
      const line = el('div', `auto-compare${after ? ' after' : ''}`)
      line.append(el('span', 'auto-compare-label', label), synergyBadges(roster.lineup, roster.captain, relics))
      return line
    }
    body.append(compare(T.arrangeNow, before, false), compare(T.arrangeAfter, best.roster, true))
    body.append(el('h3', 'auto-title', T.arrangeChanges(best.moves.length)))
    // 依序套用每一項改動，標出這一步讓羈絆怎麼變
    let step = before
    for (const move of best.moves) {
      const item = el('div', 'auto-move')
      const next = applyMove(step, move)
      const text = move.type === 'in' ? T.arrangeIn(move.player.name, move.position === 'DH' ? T.designatedHitter : POSITION_SPOT[move.position], move.native, move.out.name) : T.arrangeMove(move.player.name, POSITION_SPOT[move.from], POSITION_SPOT[move.to], move.native)
      item.append(el('span', 'auto-move-text', text))
      const tags = el('span', 'auto-move-tags')
      tags.append(...synergyDiff(step, next, relics).slice(0, 2).map((d) => diffTag(d)))
      item.append(tags)
      body.append(item)
      step = next
    }
    const offBefore = offPositionCount(before.lineup)
    const offAfter = offPositionCount(best.roster.lineup)
    if (offBefore !== offAfter) body.append(el('span', 'auto-off', T.offPositionChange(offBefore, offAfter)))
    if (before.captain && !best.roster.captain) body.append(el('span', 'auto-off warn', T.arrangeLosesCaptain))
    body.append(el('p', 'auto-note', T.arrangeNote))
    // 取消用視窗本身的關閉鈕
    const apply = el('button', 'btn-yellow auto-apply', T.applyArrangement)
    body.append(apply)
    const close = infoModal(T.bestArrangement, body)
    apply.onclick = () => {
      close()
      update({ ...setup, team: { ...setup.team, roster: best.roster } })
      toastWithSynergy(T.arrangeApplied, before, best.roster)
      render()
    }
  }

  /** 打序表的守位：「游擊（本職二壘）」；守非本職時紅字加警示，指定打擊用灰字標出本職。withArchetype 時前面加流派徽章 */
  function orderPosition(p: Batter, position: Position, withArchetype = true): HTMLElement {
    const off = isOffPosition(p, position)
    const pos = el('span', `order-pos${off ? ' off' : ''}`)
    if (withArchetype) pos.append(archetypeIcon(p.archetype, 14))
    if (off) pos.append(offPosIcon(12))
    pos.append(POSITION_SPOT[position])
    if (off || position === 'DH') pos.append(el('span', 'order-primary', T.primaryNote(POSITION_SPOT[p.primary])))
    return pos
  }

  /** 電腦版右欄上方的提示列：平常是操作說明，交換時變成黃底並有取消鍵 */
  function hintBar(): HTMLElement {
    const bar = el('div', `hint-bar desk-only ${swapFrom ? 'swapping' : ''}`)
    if (!swapFrom) {
      bar.append(el('span', 'hint-text', T.swapGuide))
      return bar
    }
    bar.append(el('span', 'hint-title', T.swapPick(getSlot(setup.team.roster, swapFrom).name)))
    const cancel = el('button', 'btn-small btn-white-small', T.cancel)
    cancel.append(kbd('ESC'))
    cancel.onclick = cancelSwap
    bar.append(cancel)
    return bar
  }

  function cancelSwap(): void {
    swapFrom = null
    render()
  }

  function startGame(): void {
    opts.onStart(setup)
  }

  function rerollWholeTeam(): void {
    if (!allowReroll) return
    const before = new Set(allIds())
    play('dice')
    update(rerollTeam(setup))
    toast(T.rerolledTeam)
    revealed = 'all'
    render()
    celebrate(newPlayers(before))
  }

  /** 底部按鈕列（電腦版移到頂部右側）。手機版交換時改顯示交換提示；電腦版交換提示在右欄 */
  function footer(): HTMLElement {
    const bar = el('footer', `team-footer ${swapFrom ? 'swapping' : ''}`)
    if (swapFrom) {
      const words = el('div', 'swap-words mobile-only')
      words.append(el('span', 'swap-title', T.swapPick(getSlot(setup.team.roster, swapFrom).name)))
      if (swapFrom.kind === 'lineup') words.append(el('span', 'swap-hint', T.swapHintLineup))
      const cancel = el('button', 'btn-outline-light mobile-only', T.cancel)
      cancel.onclick = cancelSwap
      bar.append(words, cancel)
    }
    const row = el('div', 'footer-buttons')
    if (allowReroll) {
      const rerollAll = withIcon('btn-indigo', ICONS.dice, T.rerollTeam)
      rerollAll.append(kbd('R'))
      rerollAll.onclick = rerollWholeTeam
      row.append(rerollAll)
    }
    const start = el('button', 'btn-yellow btn-big', opts.startLabel)
    start.append(kbd('ENTER'))
    start.onclick = startGame
    row.append(start)
    bar.append(row)
    return bar
  }

  function allIds(): string[] {
    const r = setup.team.roster
    return [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].map((p) => p.id)
  }

  function newPlayers(before: Set<string>): Player[] {
    const r = setup.team.roster
    return [...r.lineup.map((s) => s.player), ...r.bench, r.starter, ...r.relievers].filter((p) => !before.has(p.id))
  }

  function render(): void {
    // 記下球場上每個人的位置，重畫後讓換位置的人滑過去（FLIP）
    const before = new Map<string, DOMRect>()
    root.querySelectorAll<HTMLElement>('.field-node').forEach((n) => before.set(n.dataset.pid!, n.getBoundingClientRect()))
    const scrollTop = root.querySelector('.order-list')?.scrollTop ?? 0

    root.replaceChildren()
    const screen = el('div', 'team-screen')
    const { section, list } = orderTable()
    // 手機版 team-side 不參與排版（display: contents）；電腦版是右欄
    const side = el('div', 'team-side')
    side.append(hintBar(), section)
    const orderRow = el('div', 'order-open-row mobile-only')
    orderRow.append(orderButton(), autoButton('order-auto'))
    screen.append(header(), tracker(), field(), reserves(), orderRow, side, footer())
    root.append(screen)
    list.scrollTop = scrollTop
    setKeys({
      Enter: () => {
        if (!swapFrom && !renaming) startGame()
      },
      r: () => {
        if (!swapFrom && !renaming) rerollWholeTeam()
      },
      Escape: () => {
        if (swapFrom) cancelSwap()
        else if (renaming) {
          renaming = false
          render()
        }
      },
    })

    if (revealed.length === 0) {
      root.querySelectorAll<HTMLElement>('.field-node').forEach((n) => {
        const old = before.get(n.dataset.pid!)
        if (!old) return
        const now = n.getBoundingClientRect()
        const dx = old.left - now.left
        const dy = old.top - now.top
        if (dx || dy) n.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 280, easing: 'ease-out' })
      })
    }
    revealed = []
  }

  function onTap(slot: Slot, source: 'field' | 'list' | 'reserve'): void {
    if (!swapFrom) return openDetail(slot)
    if (sameSlot(swapFrom, slot)) swapFrom = null
    else if (isPitcherSlot(swapFrom) === isPitcherSlot(slot)) {
      const roster = setup.team.roster
      const a = getSlot(roster, swapFrom)
      const b = getSlot(roster, slot)
      const swapped = swapResult(slot, source)
      if (swapped) {
        update({ ...setup, team: { ...setup.team, roster: swapped } })
        const bothStarters = swapFrom.kind === 'lineup' && slot.kind === 'lineup'
        const message = bothStarters && source === 'field' ? T.swappedPositions(a.name, b.name) : bothStarters ? T.swappedOrder(a.name, b.name) : T.swapped(a.name, b.name)
        toastWithSynergy(message, roster, swapped)
      }
      swapFrom = null
    } else return
    render()
  }

  /** 點球員：卡色外框的大頭像、能力值字母與長條、特性說明，加上交換與重骰 */
  function openDetail(slot: Slot): void {
    const p = getSlot(setup.team.roster, slot)
    // 手機版是底部面板；電腦版是畫面中央的彈出視窗（player-modal）
    const sheet = el('div', 'sheet player-modal')
    const panel = el('section', 'sheet-panel paper')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', p.name)
    let previousKeys: KeyMap = {}
    const close = () => {
      sheet.remove()
      setKeys(previousKeys)
    }
    sheet.onclick = (e) => {
      if (e.target === sheet) close()
    }
    const x = iconButton('icon-btn sheet-close', ICONS.close, T.close)
    x.append(kbd('ESC'))
    x.onclick = close
    const stats = el('div', 'stat-box')
    const position = slot.kind === 'lineup' ? setup.team.roster.lineup[slot.index].position : undefined
    stats.append(ratingBars(p, position))
    panel.append(el('span', 'sheet-handle'), x, playerHeader(p, slotLabel(slot)))
    const note = p.role === 'batter' && position ? offPositionNote(p, position) : null
    if (note) panel.append(note)
    panel.append(stats)
    const roster = setup.team.roster
    const captain = captainIn(roster.lineup, roster.captain)
    if (p.role === 'batter' && p.id === captain) panel.querySelector('.detail-name')?.after(captainTag(p))
    if (p.traits.length || p.potential) panel.append(traitList(p))
    if (p.role === 'batter') panel.append(playerSynergies(p, roster, setup.team.relics ?? []))
    if (opts.gear) panel.append(gearSection(p, opts.gear, () => {
      close()
      render()
      openDetail(slot)
    }))

    const row = el('div', 'detail-buttons')
    const swap = el('button', 'btn-white', slot.kind === 'lineup' ? T.swapPositionOrder : T.swap)
    swap.append(kbd('X'))
    const startSwap = () => {
      close()
      swapFrom = slot
      render()
    }
    swap.onclick = startSwap
    row.append(swap)
    // 設為隊長：只有先發打者可以；比賽之間隨時免費更換
    if (p.role === 'batter' && slot.kind === 'lineup') {
      const isCap = p.id === captain
      const capBtn = el('button', 'btn-yellow captain-btn', isCap ? T.isCaptain : T.setCaptain)
      capBtn.prepend(captainIcon(20))
      capBtn.disabled = isCap
      capBtn.onclick = () => {
        update({ ...setup, team: { ...setup.team, roster: setCaptain(setup.team.roster, p.id) } })
        toast(T.captainSet(p.name, CAPTAIN_TITLES[p.archetype]))
        close()
        render()
        openDetail(slot)
      }
      row.append(capBtn)
      const capNote = el('p', 'captain-note')
      const current = roster.lineup.find((s) => s.player.id === captain)?.player
      capNote.append(captainIcon(16), current && !isCap ? T.captainNow(current.name, CAPTAIN_TITLES[current.archetype]) : T.captainRule(captainWeight(setup.team.relics ?? [])))
      panel.append(capNote)
    }
    let rerollThis: (() => void) | null = null
    if (allowPlayerReroll) {
      const reroll = el('button', 'btn-indigo', T.rerollPlayer)
      reroll.append(el('span', 'count-pill', String(setup.playerRerollsLeft)), kbd('R'))
      reroll.disabled = setup.playerRerollsLeft <= 0
      rerollThis = () => {
        if (setup.playerRerollsLeft <= 0) return
        play('dice')
        update(rerollPlayer(setup, slot))
        const fresh = getSlot(setup.team.roster, slot)
        toast(T.rerolledPlayer(p.name, fresh.name))
        close()
        revealed = [slot]
        render()
        celebrate([fresh])
      }
      reroll.onclick = rerollThis
      row.append(reroll)
    }
    row.classList.add(['single', 'double', 'triple'][row.children.length - 1])
    panel.append(row)
    sheet.append(panel)
    root.append(sheet)
    previousKeys = setKeys({ Escape: close, x: startSwap, ...(rerollThis ? { r: rerollThis } : {}) })
  }

  /** 球員詳細資料裡的裝備：身上的可以卸下，背包裡同角色能用的可以裝上（裝滿時選換下哪一件） */
  function gearSection(p: Player, gear: GearOptions, refresh: () => void): HTMLElement {
    const box = el('div', 'gear-box')
    const apply = (roster: Roster, message: string) => {
      update({ ...setup, team: { ...setup.team, roster } })
      toast(message)
      refresh()
    }
    const worn = p.equipment ?? []
    box.append(el('span', 'gear-title', `${T.equippedTitle}（${worn.length}/${MAX_EQUIPMENT}）`))
    const wornList = el('div', 'gear-list')
    if (!worn.length) wornList.append(el('span', 'gear-empty', T.noneOption))
    worn.forEach((id, i) => {
      const b = el('button', `gear-item tier-${EQUIPMENT[id].tier}`)
      b.type = 'button'
      b.append(el('b', '', EQUIPMENT_NAMES[id]), el('span', '', equipmentDesc(id)), el('span', 'gear-action', T.unequip))
      b.onclick = () => apply(gear.unequip(p.id, i), T.unequipped(EQUIPMENT_NAMES[id], p.name))
      wornList.append(b)
    })
    box.append(wornList)

    // 背包：只列這位球員能帶的（打者的不給投手）
    const usable = gear.bag().map((id, i) => [id, i] as const).filter(([id]) => EQUIPMENT[id].role === p.role)
    box.append(el('span', 'gear-title', T.bagTitle))
    const bagList = el('div', 'gear-list')
    if (!usable.length) bagList.append(el('span', 'gear-empty', T.bagNoneUsable))
    for (const [id, bagIndex] of usable) {
      const b = el('button', `gear-item tier-${EQUIPMENT[id].tier}`)
      b.type = 'button'
      b.append(el('b', '', EQUIPMENT_NAMES[id]), el('span', '', equipmentDesc(id)), el('span', 'gear-action', T.equip))
      b.onclick = async () => {
        let replace: number | undefined
        if (worn.length >= MAX_EQUIPMENT) {
          const picked = await choiceModal<number>({
            title: T.pickReplace(p.name),
            options: worn.map((x, i) => ({ value: i, label: T.replaceItem(EQUIPMENT_NAMES[x]), sub: equipmentDesc(x) })),
          })
          if (picked === null) return
          replace = picked
        }
        apply(gear.equip(p.id, bagIndex, replace), T.equipped(EQUIPMENT_NAMES[id], p.name))
      }
      bagList.append(b)
    }
    box.append(bagList)
    return box
  }

  /** 抽到彩虹卡或帶金特的球員：全螢幕登場特效，挑最強的一位 */
  function celebrate(players: Player[]): void {
    const special = players.filter(isSpecial).sort((a, b) => overall(b) - overall(a))[0]
    if (!special) return
    const r = setup.team.roster
    const slot = (
      [
        ...r.lineup.map((_, i): Slot => ({ kind: 'lineup', index: i })),
        ...r.bench.map((_, i): Slot => ({ kind: 'bench', index: i })),
        { kind: 'starter' } as Slot,
        ...r.relievers.map((_, i): Slot => ({ kind: 'reliever', index: i })),
      ] as Slot[]
    ).find((s) => getSlot(r, s).id === special.id)!

    const overlay = el('div', 'reveal-overlay')
    overlay.innerHTML = `<svg class="rays" aria-hidden="true" viewBox="-380 -380 760 760">${rays(380)}</svg>`
    const tier = cardTier(special)
    // 彩虹卡用彩虹框；因為金特而稀有的其他卡色用金框
    const card = el('div', `reveal-card ${tier === 'rainbow' ? 'frame-rainbow' : 'frame-gold'}`)
    const inner = el('div', 'reveal-inner')
    const top = el('div', 'reveal-top')
    top.append(el('span', 'tier-tag', T.tierNames[tier]), overallBadge(special, 'lg'))
    inner.append(el('span', 'sheen'), top, avatar(special.id, 'user', 'reveal-avatar'), el('span', 'reveal-name', special.name))
    inner.append(el('span', 'reveal-label', slotLabel(slot)), ratingBars(special))
    const gold = special.traits.filter((t) => TRAITS[t].tier === 'gold')
    if (gold.length) {
      const tags = el('div', 'traits')
      tags.append(...gold.map(traitTag))
      inner.append(tags)
    }
    card.append(inner)
    const ok = el('button', 'btn-yellow btn-big reveal-ok', T.accept)
    ok.onclick = () => overlay.remove()
    overlay.append(el('p', 'reveal-title', T.rareArrived), card, ok)
    // 等翻牌跑完再登場
    window.setTimeout(() => {
      root.append(overlay)
      play('sparkle')
    }, 700)
  }

  render()
  // 組隊教學看完再介紹羈絆
  void maybeTutorial('team', TUTORIAL_STEPS.team).then(() => maybeTutorial('synergy', TUTORIAL_STEPS.synergy))
}

const RATING_SHORT = { contact: '打', power: '力', speed: '速', fielding: '守' } as const

/** 放射狀的光芒，給登場特效和勝利畫面用 */
export function rays(radius: number): string {
  let d = ''
  for (let i = 0; i < 12; i++) {
    const a0 = ((i * 30 - 6) * Math.PI) / 180
    const a1 = ((i * 30 + 6) * Math.PI) / 180
    d += `<path d="M0 0 L${(radius * Math.cos(a0)).toFixed(1)} ${(radius * Math.sin(a0)).toFixed(1)} L${(radius * Math.cos(a1)).toFixed(1)} ${(radius * Math.sin(a1)).toFixed(1)} Z"/>`
  }
  return d
}

/** 介面層產生種子，模擬內部不碰 Math.random()（ADR-0001） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32)
}
