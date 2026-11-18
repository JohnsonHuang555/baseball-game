// 陣容：看 9 位先發、板凳、先發投手、後援、預備名單的能力（含養成）、流派、特性；點兩位球員交換，改完按「儲存陣容」。
// 修改先放在畫面上的草稿，儲存時只送球員編號（ClubController.saveRoster → updateSettings：先結算到期的比賽、新陣容從下一場生效）。
// 每位球員都有「養成」按鈕，打開球員詳情升級
import { pitchChip, toast } from '../../ui/visual'
import { choiceModal } from '../../ui/modal'
import { el, traitTag } from '../../ui/playerCard'
import { captainIcon, synergyBadges } from '../../ui/synergyUi'
import { archetypeSvg } from '../../ui/synergyIcons'
import { avatar } from '../../ui/avatar'
import { gradeOf } from '../../ui/grades'
import { ARCHETYPE_NAMES, POSITION_FULL, POSITION_SPOT, RATING_LABELS } from '../../ui/strings'
import type { Position } from '../../sim/types'
import { getSlot, type Slot } from '../../sim/setup'
import { isOffPosition } from '../../sim/positions'
import type { Player } from '../../sim/types'
import type { ClubSave } from '../domain/club'
import { stableJson } from '../domain/fingerprint'
import {
  autoArrange,
  lineupIssues,
  setStartingPitcher,
  substitute,
  swapBattingOrder,
  swapFieldPositions,
  swapWithReserve,
  type DraftSlot,
  type LineupDraft,
} from '../domain/lineup'
import { recordOf, reserves as reservesOf, resolveRoster, toAssignment } from '../domain/roster'
import type { ClubController, ControllerState } from './clubController'
import { openPlayerDetail } from './playerView'
import { openRecruit } from './recruitView'
import { v2Modal } from './reportView'
import { V2T } from './strings'
import { icon } from './icons'
import { barButton, draftBar } from './draftBar'

export interface LineupView {
  render(state: ControllerState): HTMLElement
  /** 存檔變了（儲存成功、升級、招募、其他分頁改了）：沒有未儲存的修改就換成最新陣容；有的話草稿留著，並標示是根據舊陣容 */
  sync(state: ControllerState): void
  hasUnsavedChanges(): boolean
}

/** 從存檔做出草稿：養成後的陣容 + 預備名單 */
function draftOf(club: ClubSave): LineupDraft {
  return { roster: structuredClone(resolveRoster(club)), reserves: structuredClone(reservesOf(club)) }
}

export function createLineupView(controller: ClubController, goToLineup: () => void = () => undefined): LineupView {
  let club: ClubSave | null = null
  let draft: LineupDraft | null = null
  /** 草稿建立時的陣容版本：儲存時交給 updateSettings 在鎖內比對 */
  let base: string | null = null
  let selected: DraftSlot | null = null
  let lastState: ControllerState = controller.state
  let container: HTMLElement | null = null

  /** 草稿跟存檔的配置不同（只比球員編號與守位，能力變化不算修改） */
  const dirty = () => !!club && !!draft && stableJson(toAssignment(draft.roster)) !== stableJson(club.roster)
  const latestVersion = () => controller.settingsVersions()?.roster ?? null
  /** 草稿是根據舊陣容做的（別的分頁已經改過） */
  const stale = () => dirty() && base !== null && base !== latestVersion()

  function resetDraft(c: ClubSave): void {
    draft = draftOf(c)
    base = latestVersion()
    selected = null
  }

  function sync(state: ControllerState): void {
    const next = state.club
    if (!next) return
    const keep = !!club && dirty()
    club = next
    if (!keep || !draft) return resetDraft(next)
    // 草稿保留，但球員能力換成最新（例如剛升級），預備名單也補上剛招募的人
    try {
      const assignment = toAssignment(draft.roster)
      draft = { roster: structuredClone(resolveRoster({ players: next.players, roster: assignment })), reserves: structuredClone(reservesOf({ players: next.players, roster: assignment })) }
    } catch {
      // 草稿裡的球員不在名單上了（不該發生）：保留原本的草稿，儲存時會被驗證擋下
    }
  }

  function rerender(): void {
    if (container?.isConnected) container.replaceWith(render(lastState))
  }

  function apply(next: LineupDraft, message?: string): void {
    draft = next
    selected = null
    if (message) toast(message)
    rerender()
  }

  async function pick(slot: DraftSlot): Promise<void> {
    if (!draft) return
    if (!selected) {
      selected = slot
      return rerender()
    }
    const a = selected
    const b = slot
    if (sameSlot(a, b)) {
      selected = null
      return rerender()
    }
    const d = draft
    const r = d.roster
    const kinds = [a.kind, b.kind].sort().join('+')
    const index = (s: DraftSlot) => ('index' in s ? s.index : 0)
    try {
      if (a.kind === 'reserve' || b.kind === 'reserve') {
        const res = a.kind === 'reserve' ? a : b
        const other = (a.kind === 'reserve' ? b : a) as Slot | { kind: 'reserve' }
        if (other.kind === 'reserve') throw new RangeError(V2T.cannotSwap)
        const incoming = d.reserves[index(res)]
        const outgoing = getSlot(r, other as Slot)
        return apply(swapWithReserve(d, other as Slot, index(res)), V2T.substituted(incoming.name, outgoing.name))
      }
      if (kinds === 'lineup+lineup') {
        const sa = r.lineup[index(a)]
        const sb = r.lineup[index(b)]
        // 交換守位後各自守什麼、是不是本職（指定打擊不算非本職）
        const fit = (pl: (typeof sa)['player'], pos: Position) => (pos === 'DH' || !isOffPosition(pl, pos) ? '' : `（${V2T.offPosition}）`)
        const choice = await choiceModal<'pos' | 'order'>({
          title: `${sa.player.name} ↔ ${sb.player.name}`,
          message: V2T.swapChoiceTitle,
          options: [
            {
              value: 'pos',
              label: V2T.swapPositions,
              sub: `${sa.player.name} 守${POSITION_SPOT[sb.position]}${fit(sa.player, sb.position)}、${sb.player.name} 守${POSITION_SPOT[sa.position]}${fit(sb.player, sa.position)}`,
            },
            { value: 'order', label: V2T.swapOrder, sub: V2T.swapOrderSub(sa.player.name, index(b) + 1, sb.player.name, index(a) + 1) },
          ],
        })
        if (!choice) {
          selected = null
          return rerender()
        }
        return apply({ ...d, roster: choice === 'pos' ? swapFieldPositions(r, index(a), index(b)) : swapBattingOrder(r, index(a), index(b)) })
      }
      if (kinds === 'bench+lineup') {
        const l = a.kind === 'lineup' ? a : b
        const bn = a.kind === 'lineup' ? b : a
        const outName = r.lineup[index(l)].player.name
        const inName = r.bench[index(bn)].name
        return apply({ ...d, roster: substitute(r, index(l), index(bn)) }, V2T.substituted(inName, outName))
      }
      if (kinds === 'reliever+starter') {
        const rel = a.kind === 'reliever' ? a : b
        return apply({ ...d, roster: setStartingPitcher(r, index(rel)) }, V2T.pitcherSwapped(r.relievers[index(rel)].name))
      }
      throw new RangeError(V2T.cannotSwap)
    } catch (e) {
      // 打者 ↔ 投手、板凳 ↔ 板凳、後援 ↔ 後援、預備 ↔ 預備：沒有意義的交換，換成選這一位
      toast(e instanceof RangeError ? (e.message.startsWith('這個位置') ? e.message : V2T.cannotSwap) : V2T.cannotSwap)
      selected = slot
      rerender()
    }
  }

  /** 存檔裡這個位置原本是誰（換過的人用綠底標出來） */
  function savedIdAt(slot: DraftSlot): string | null {
    if (!club) return null
    try {
      const saved = resolveRoster(club)
      const i = 'index' in slot ? slot.index : 0
      if (slot.kind === 'lineup') return saved.lineup[i]?.player.id ?? null
      if (slot.kind === 'bench') return saved.bench[i]?.id ?? null
      if (slot.kind === 'starter') return saved.starter.id
      if (slot.kind === 'reliever') return saved.relievers[i]?.id ?? null
      return reservesOf(club)[i]?.id ?? null
    } catch {
      return null
    }
  }

  function row(slot: DraftSlot, chip: string, p: Player, opts: { order?: number; position?: Position; pitcher?: boolean } = {}): HTMLElement {
    const isSelected = !!selected && sameSlot(selected, slot)
    const changed = dirty() && savedIdAt(slot) !== p.id
    const item = el('div', `v2-player-item${isSelected ? ' selected' : changed ? ' changed' : ''}`)
    const b = el('button', 'v2-player')
    b.type = 'button'
    b.setAttribute('aria-pressed', String(isSelected))
    if (isSelected) b.classList.add('selected')
    b.disabled = !lastState.canWrite || lastState.saving
    const off = p.role === 'batter' && !!opts.position && opts.position !== 'DH' && isOffPosition(p, opts.position)
    const level = (club && recordOf(club, p.id)?.level) ?? 1

    if (opts.order) b.append(el('span', 'v2-player-order', String(opts.order)))
    b.append(el('span', `v2-player-slot${opts.pitcher ? ' pitcher' : ''}`, chip))
    const face = el('span', 'v2-player-face')
    face.append(avatar(p.id, 'user', 'v2-player-avatar'))
    if (p.role === 'batter') {
      const arch = el('span', 'v2-player-arch')
      arch.innerHTML = archetypeSvg(p.archetype, 15)
      arch.title = ARCHETYPE_NAMES[p.archetype]
      face.append(arch)
      if (draft?.roster.captain === p.id && slot.kind === 'lineup') face.append(captainIcon(15))
    }
    const main = el('span', 'v2-player-main')
    const name = el('span', 'v2-player-name')
    name.append(el('span', 'v2-player-name-text', p.name), el('span', 'v2-level', V2T.level(level)))
    const sub = el('span', 'v2-player-sub')
    if (off) sub.append(el('span', 'v2-offpos', V2T.offPositionNative(POSITION_SPOT[p.primary])))
    if (p.role === 'pitcher') sub.append(pitchChip(p))
    else if (p.traits.length && !off) sub.append(traitTag(p.traits[0]))
    else if (slot.kind === 'reserve' && !off) sub.append(el('span', 'v2-player-native', V2T.nativePosition(POSITION_SPOT[p.primary])))
    main.append(name, sub)
    b.append(face, main, gradeLetters(p, off))
    b.setAttribute('aria-label', `${chip} ${p.name} ${V2T.level(level)}${off ? `，${V2T.offPosition}` : ''}`)
    if (isSelected) b.append(el('span', 'v2-selected-note', V2T.selected))
    b.onclick = () => void pick(slot)
    const develop = el('button', 'v2-develop')
    develop.type = 'button'
    develop.dataset.player = p.id
    develop.setAttribute('aria-label', `${p.name} ${V2T.develop}`)
    develop.append(icon('upgrade', 16), V2T.develop)
    develop.onclick = () => openPlayerDetail(controller, p.id)
    item.append(b, develop)
    return item
  }

  /** 一組球員（一張卡片）：標題、人數說明、能力欄名 */
  function group(title: string, sub: string, pitcher: boolean, rows: HTMLElement[], cls = '', empty?: string): HTMLElement {
    const card = el('section', `v2-card v2-roster-card ${cls}`.trim())
    card.setAttribute('aria-label', title)
    const head = el('div', 'v2-roster-head')
    const cols = el('span', 'v2-roster-cols')
    cols.setAttribute('aria-hidden', 'true')
    for (const k of pitcher ? PITCHER_KEYS : BATTER_KEYS) cols.append(el('span', '', RATING_LABELS[k]))
    head.append(el('h3', 'v2-section-title', title), el('span', 'v2-roster-sub', sub), cols)
    card.append(head)
    if (empty && !rows.length) card.append(el('p', 'v2-roster-empty', empty))
    const list = el('div', 'v2-player-list')
    list.append(...rows)
    card.append(list)
    return card
  }

  function render(state: ControllerState): HTMLElement {
    lastState = state
    if (!draft) sync(state)
    const page = el('div', 'v2-page v2-lineup')
    container = page
    const d = draft
    if (!d) return page
    const r = d.roster

    const head = el('div', 'v2-page-head')
    head.append(el('h2', 'v2-page-title', V2T.lineupTitle))
    const actions = el('div', 'v2-head-actions')
    const auto = el('button', 'btn-white v2-head-btn v2-auto')
    auto.type = 'button'
    auto.append(icon('lineup', 18), V2T.autoArrange)
    auto.disabled = !state.canWrite || state.saving
    auto.onclick = () => openAutoArrange(d, (next) => apply(next))
    const recruitBtn = el('button', 'btn-white v2-head-btn')
    recruitBtn.type = 'button'
    recruitBtn.dataset.action = 'recruit'
    recruitBtn.append(icon('recruit', 18), V2T.recruitEntry)
    recruitBtn.onclick = () => openRecruit(controller, goToLineup)
    actions.append(auto, recruitBtn)
    head.append(actions)
    const bonds = el('div', 'v2-bond-row')
    bonds.append(el('span', 'v2-bond-label', V2T.bondsActive), synergyBadges(r.lineup, r.captain, [], { full: true }))
    page.append(head, bonds, el('p', 'v2-page-hint', V2T.lineupHint))

    const starters = group(
      V2T.starters,
      V2T.peopleCount(r.lineup.length),
      false,
      r.lineup.map((s, i) => row({ kind: 'lineup', index: i }, POS_SHORT[s.position], s.player, { order: i + 1, position: s.position })),
      'v2-starters',
    )
    const bench = group(V2T.bench, V2T.peopleCount(r.bench.length), false, r.bench.map((p, i) => row({ kind: 'bench', index: i }, V2T.benchChip, p)), 'v2-bench')
    const pitchers = group(
      V2T.pitchersTitle,
      V2T.pitchersSub(r.relievers.length),
      true,
      [row({ kind: 'starter' }, V2T.starterChip, r.starter, { pitcher: true }), ...r.relievers.map((p, i) => row({ kind: 'reliever', index: i }, V2T.relieverChip, p, { pitcher: true }))],
      'v2-pitchers',
    )
    const reserveCard = group(
      V2T.reserves,
      V2T.reservesSub(d.reserves.length),
      false,
      d.reserves.map((p, i) => row({ kind: 'reserve', index: i }, V2T.reserveChip, p, { pitcher: p.role === 'pitcher' })),
      'v2-reserves',
      V2T.reservesEmpty,
    )
    const grid = el('div', 'v2-lineup-grid')
    grid.append(starters, bench, pitchers, reserveCard)
    page.append(grid)
    page.append(saveBar(state, d))
    return page
  }

  /**
   * 儲存列：選取中（再點一位交換／取消）、有變更（還原／儲存陣容）、草稿過期（載入最新設定）、
   * 不合法（說明原因、不能存）；沒有變更時只顯示「已儲存」一行，不浮在畫面上
   */
  function saveBar(state: ControllerState, d: LineupDraft): HTMLElement {
    const r = d.roster
    const issues = lineupIssues(r)
    const isStale = stale()
    const isDirty = dirty()
    const resetToLatest = () => {
      if (club) resetDraft(club)
      rerender()
    }
    const save = barButton('btn-yellow', state.saving ? V2T.saving : V2T.saveLineup, 'save-draft', async () => {
      save.disabled = true
      const res = await controller.saveRoster(r, base ?? '')
      if (res.message) toast(res.message, res.ok ? 'success' : 'error')
      if (res.ok && controller.state.club) {
        club = controller.state.club
        resetDraft(club)
      }
      // 衝突：controller 已讀進最新存檔，草稿留著並標示過期
      rerender()
    })
    save.disabled = state.saving || !state.canWrite
    const reset = () => barButton('btn-white', V2T.resetDraft, 'reset-draft', resetToLatest, 'undo')
    if (isStale) {
      const load = barButton('btn-yellow', V2T.loadLatest, 'load-latest', resetToLatest)
      load.disabled = state.saving
      return draftBar('stale', V2T.draftStaleTitle, V2T.draftStale, [load])
    }
    if (selected) {
      const cancel = barButton('btn-white', V2T.cancel, 'cancel-select', () => {
        selected = null
        rerender()
      })
      return draftBar('selected', V2T.selectedWho(selectedPlayer(d)?.name ?? ''), isDirty ? V2T.unsavedChanges : '', isDirty && !issues.length ? [cancel, save] : [cancel])
    }
    if (issues.length) return draftBar('invalid', issues.join('；'), '', [reset()])
    if (isDirty) return draftBar('dirty', V2T.unsavedChanges, V2T.savedFromNext, [reset(), save])
    return draftBar('clean', V2T.lineupEffective, '', [])
  }

  function selectedPlayer(d: LineupDraft): Player | null {
    if (!selected) return null
    const i = 'index' in selected ? selected.index : 0
    if (selected.kind === 'lineup') return d.roster.lineup[i]?.player ?? null
    if (selected.kind === 'bench') return d.roster.bench[i] ?? null
    if (selected.kind === 'starter') return d.roster.starter
    if (selected.kind === 'reliever') return d.roster.relievers[i] ?? null
    return d.reserves[i] ?? null
  }

  return { render, sync, hasUnsavedChanges: dirty }
}

/** 最多羈絆排法（只在先發與板凳之間排）：先列出會改的人，玩家確認才套用到草稿 */
function openAutoArrange(draft: LineupDraft, apply: (d: LineupDraft) => void): void {
  const best = autoArrange(draft.roster)
  const body = el('div', 'v2-auto-body')
  body.append(el('p', 'v2-hint', V2T.autoArrangeHint))
  if (!best) {
    body.append(el('p', 'v2-empty', V2T.autoArrangeNone))
    v2Modal(V2T.autoArrange, body)
    return
  }
  const ul = el('ul', 'v2-moves')
  for (const m of best.moves) {
    ul.append(el('li', '', m.type === 'in' ? `${V2T.substituted(m.player.name, m.out.name)}（${POSITION_FULL[m.position]}）` : `${m.player.name}：${POSITION_FULL[m.from]} → ${POSITION_FULL[m.to]}`))
  }
  body.append(synergyBadges(best.roster.lineup, best.roster.captain, []), ul)
  const applyBtn = el('button', 'btn-yellow', V2T.autoArrangeApply)
  applyBtn.type = 'button'
  body.append(applyBtn)
  const close = v2Modal(V2T.autoArrange, body)
  applyBtn.onclick = () => {
    close()
    apply({ ...draft, roster: best.roster })
  }
}

const POS_SHORT: Record<Position, string> = { C: '捕', '1B': '一', '2B': '二', '3B': '三', SS: '游', LF: '左', CF: '中', RF: '右', DH: '指' }
const BATTER_KEYS = ['contact', 'power', 'speed', 'fielding'] as const
const PITCHER_KEYS = ['stuff', 'control', 'stamina'] as const

/** 列表用的能力字母：只有 S、A 上色（強項提示），其他是黑字；守非本職時「守」標紅底線 */
function gradeLetters(p: Player, off: boolean): HTMLElement {
  const box = el('span', 'v2-grades')
  const ratings = p.ratings as unknown as Record<string, number>
  const keys = p.role === 'pitcher' ? PITCHER_KEYS : BATTER_KEYS
  for (const k of keys) {
    const g = gradeOf(ratings[k])
    const cell = el('span', `v2-g${g === 'S' || g === 'A' ? ` hi grade-${g}` : ''}${off && k === 'fielding' ? ' warn' : ''}`, g)
    cell.title = `${RATING_LABELS[k]} ${g}`
    box.append(cell)
  }
  return box
}

function sameSlot(a: DraftSlot, b: DraftSlot): boolean {
  return a.kind === b.kind && ('index' in a ? a.index : -1) === ('index' in b ? b.index : -1)
}
