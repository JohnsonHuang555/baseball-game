// 球員詳情的「特性養成」（Phase 9 PR 3）：放在「球員能力」分頁裡，不新增底部分頁。
// 顯示原生特性、訓練習得、負面特性（已改善的劃掉）、個人潛能池、每一項的費用與所需出場數、不能訓練的原因；
// 選一項 → 確認（再看一次費用、所需場數與規則）→ 開始；訓練中顯示進度條、剩餘場數與取消（要再確認一次：不退款、進度不保留）。
// 剛完成的訓練在這裡顯示成果與生效場次。資料都來自存檔與 domain/traitTraining.ts，不另外計算
import { el, traitTag } from '../../ui/playerCard'
import { TRAIT_DESC, TRAIT_NAMES } from '../../ui/strings'
import { TRAITS, type TraitId } from '../../sim/traits'
import type { ClubSave, PlayerRecord } from '../domain/club'
import { assignedIds, recordOf } from '../domain/roster'
import { MAX_POSITIVE_TRAITS, positiveCount, trainingOptions, type TrainingOption } from '../domain/traitTraining'
import { icon } from './icons'
import { V2T } from './strings'

const fmt = (x: number) => x.toLocaleString('zh-Hant')

export interface TrainingPanelState {
  /** 正在確認的那一項（選了、還沒按確認） */
  picking: { trait: TraitId; kind: TrainingOption['kind'] } | null
  /** 正在確認取消 */
  cancelling: boolean
}

export interface TrainingPanelActions {
  locked: boolean
  pick(option: TrainingOption | null): void
  start(option: TrainingOption): void
  askCancel(on: boolean): void
  cancel(): void
}

export function trainingPanel(club: ClubSave, record: PlayerRecord, ui: TrainingPanelState, act: TrainingPanelActions): HTMLElement {
  const p = record.player
  const box = el('section', 'v2-training')
  box.setAttribute('aria-label', V2T.trainingTitle)
  const head = el('div', 'v2-training-head')
  head.append(el('h3', 'v2-detail-sub', V2T.trainingTitle), el('span', 'v2-training-count', V2T.trainingPositiveCount(positiveCount(record), MAX_POSITIVE_TRAITS)))
  box.append(head)

  // 三種特性分開列：原生（正面）、訓練習得、負面（已改善的劃掉）
  const learned = record.dev?.learned ?? []
  const removed = new Set(record.dev?.removed ?? [])
  const nativePositive = p.traits.filter((t) => TRAITS[t].tier !== 'red')
  const negatives = p.traits.filter((t) => TRAITS[t].tier === 'red')
  const groups = el('dl', 'v2-training-groups')
  const group = (label: string, key: string, traits: TraitId[], improved = false) => {
    const row = el('div', 'v2-training-group')
    row.dataset.group = key
    const dd = el('dd', '')
    if (!traits.length) dd.append(el('span', 'v2-training-none', V2T.trainingNone))
    for (const t of traits) {
      const tag = traitTag(t)
      if (improved && removed.has(t)) {
        tag.classList.add('improved')
        const wrap = el('span', 'v2-training-improved')
        wrap.append(tag, el('span', 'v2-training-improved-label', V2T.trainingImproved))
        dd.append(wrap)
      } else dd.append(tag)
    }
    row.append(el('dt', '', label), dd)
    groups.append(row)
  }
  group(V2T.trainingNative, 'native', nativePositive)
  group(V2T.trainingLearned, 'learned', learned)
  group(V2T.trainingNegative, 'negative', negatives, true)
  box.append(groups)

  // 剛完成（最近一筆是這位球員）：成果、效果、生效場次
  const done = [...club.training.recent].reverse().find((t) => t.playerId === p.id)
  if (done && done.effectiveFromMatch >= club.idle.nextMatchIndex - 50) {
    const ok = el('div', 'v2-training-done')
    ok.setAttribute('role', 'status')
    ok.append(icon('check', 20), el('strong', '', V2T.trainingDoneTitle(done.trait, done.kind)))
    ok.append(el('span', '', done.kind === 'learn' ? TRAIT_DESC[done.trait] : V2T.trainingImprovedEffect))
    ok.append(el('span', 'v2-training-from', V2T.trainingEffectiveFrom(done.effectiveFromMatch + 1)))
    box.append(ok)
  }

  const active = club.training.active
  if (active && active.playerId === p.id) {
    box.append(activeCard(club, record, active, ui, act))
    return box
  }
  if (active) {
    const other = recordOf(club, active.playerId)
    box.append(el('p', 'v2-training-other', V2T.trainingOther(other?.player.name ?? '', active.trait)))
  }

  // 潛能池＋負面特性的改善
  const options = trainingOptions(club.clubSeed, record, { active, assets: club.economy.assets })
  const list = el('ul', 'v2-training-options')
  list.setAttribute('aria-label', V2T.trainingPool)
  for (const o of options) {
    const li = el('li', `v2-training-option${o.block ? ' blocked' : ''}${ui.picking?.trait === o.trait ? ' picking' : ''}`)
    li.dataset.trait = o.trait
    li.dataset.kind = o.kind
    const top = el('div', 'v2-training-option-top')
    top.append(traitTag(o.trait), el('span', `v2-training-class ${o.cls}`, V2T.trainingClassNames[o.cls]))
    const desc = el('p', 'v2-training-desc', TRAIT_DESC[o.trait])
    const meta = el('div', 'v2-training-meta')
    const cost = el('span', 'v2-training-cost')
    cost.append(icon('coin', 16), fmt(o.cost.funds), icon('exp', 16), fmt(o.cost.experience))
    meta.append(cost, el('span', 'v2-training-need', V2T.trainingNeed(o.need)))
    li.append(top, desc, meta)
    if (o.block) {
      const why = o.block === 'conflict' && o.conflictWith ? V2T.trainingConflictWith(o.conflictWith) : V2T.trainingBlockText[o.block]
      const reason = el('p', 'v2-training-block', why)
      reason.dataset.block = o.block
      li.append(reason)
    } else {
      const b = el('button', 'btn-white v2-training-pick', o.kind === 'learn' ? `${V2T.trainingChoose}・${V2T.trainingLearnVerb}` : `${V2T.trainingChoose}・${V2T.trainingImproveVerb}`)
      b.type = 'button'
      b.dataset.action = 'training-pick'
      b.disabled = act.locked
      b.onclick = () => act.pick(o)
      li.append(b)
    }
    list.append(li)
  }
  box.append(el('h4', 'v2-training-sub', V2T.trainingPool), el('p', 'v2-hint', V2T.trainingPoolNote), list)

  // 確認：再看一次費用、所需場數與規則
  const pick = ui.picking && options.find((o) => o.trait === ui.picking!.trait && o.kind === ui.picking!.kind && !o.block)
  if (pick) {
    const c = el('div', 'v2-training-confirm')
    c.setAttribute('role', 'dialog')
    c.setAttribute('aria-label', V2T.trainingConfirmTitle(p.name, pick.trait, pick.kind))
    c.append(el('strong', 'v2-training-confirm-title', V2T.trainingConfirmTitle(p.name, pick.trait, pick.kind)))
    const facts = el('ul', 'v2-training-confirm-facts')
    const owned = club.economy.assets
    facts.append(
      el('li', '', `資金 ${fmt(pick.cost.funds)}（持有 ${fmt(owned.funds)}）`),
      el('li', '', `經驗 ${fmt(pick.cost.experience)}（持有 ${fmt(owned.experience)}）`),
      el('li', '', V2T.trainingNeed(pick.need)),
    )
    const rules = el('ul', 'v2-bullets')
    for (const r of V2T.trainingRules) rules.append(el('li', '', r))
    if (!assignedIds(club.roster).has(p.id)) rules.append(el('li', 'warn', V2T.trainingNotPlaying))
    const row = el('div', 'v2-training-confirm-row')
    const back = el('button', 'btn-white', V2T.trainingBack)
    back.type = 'button'
    back.onclick = () => act.pick(null)
    const go = el('button', 'btn-yellow', V2T.trainingConfirm)
    go.type = 'button'
    go.dataset.action = 'training-start'
    go.disabled = act.locked
    go.onclick = () => act.start(pick)
    row.append(back, go)
    c.append(facts, rules, row)
    box.append(c)
  }
  return box
}

function activeCard(club: ClubSave, record: PlayerRecord, a: NonNullable<ClubSave['training']['active']>, ui: TrainingPanelState, act: TrainingPanelActions): HTMLElement {
  const card = el('div', 'v2-training-active')
  card.dataset.trait = a.trait
  const top = el('div', 'v2-training-active-top')
  top.append(el('span', 'v2-training-badge', V2T.trainingActive), el('span', 'v2-training-target-label', V2T.trainingTarget), traitTag(a.trait))
  if (a.kind === 'improve') top.append(el('span', 'v2-training-class improve', V2T.trainingClassNames.improve))
  const bar = el('div', 'v2-training-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-label', V2T.trainingProgressLabel)
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', String(a.need))
  bar.setAttribute('aria-valuenow', String(a.progress))
  const fill = el('span', 'v2-training-fill')
  fill.style.width = `${Math.round((a.progress / a.need) * 100)}%`
  bar.append(fill)
  const nums = el('div', 'v2-training-nums')
  nums.append(el('strong', 'v2-training-progress', V2T.trainingProgress(a.progress, a.need)), el('span', 'v2-training-remain', V2T.trainingRemain(a.need - a.progress)))
  card.append(top, el('p', 'v2-training-desc', a.kind === 'learn' ? TRAIT_DESC[a.trait] : `${TRAIT_NAMES[a.trait]}：${V2T.trainingImprovedEffect}`), bar, nums)
  const r = club.roster
  const where = r.lineup.some((s) => s.playerId === record.player.id) || r.starter === record.player.id ? 'regular' : assignedIds(r).has(record.player.id) ? 'bench' : 'reserve'
  if (where !== 'regular') card.append(el('p', `v2-training-note ${where}`, where === 'reserve' ? V2T.trainingNotPlaying : V2T.trainingBenchNote))
  const rules = el('ul', 'v2-bullets')
  for (const line of V2T.trainingRules.slice(0, 2)) rules.append(el('li', '', line))
  card.append(rules)
  if (ui.cancelling) {
    const c = el('div', 'v2-training-cancel-confirm')
    c.setAttribute('role', 'alertdialog')
    c.setAttribute('aria-label', V2T.trainingCancel)
    c.append(icon('alert', 22), el('p', '', V2T.trainingCancelConfirm))
    const row = el('div', 'v2-training-confirm-row')
    const no = el('button', 'btn-white', V2T.trainingCancelNo)
    no.type = 'button'
    no.onclick = () => act.askCancel(false)
    const yes = el('button', 'btn-danger solid', V2T.trainingCancelYes)
    yes.type = 'button'
    yes.dataset.action = 'training-cancel-confirm'
    yes.disabled = act.locked
    yes.onclick = () => act.cancel()
    row.append(no, yes)
    c.append(row)
    card.append(c)
  } else {
    const b = el('button', 'btn-white v2-training-cancel', V2T.trainingCancel)
    b.type = 'button'
    b.dataset.action = 'training-cancel'
    b.disabled = act.locked
    b.onclick = () => act.askCancel(true)
    card.append(b)
  }
  return card
}
