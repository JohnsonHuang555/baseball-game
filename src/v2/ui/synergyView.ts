// 羈絆說明（陣容頁的「羈絆說明」按鈕）：隊長規則與指定隊長、六種羈絆的條件、門檻、目前人數、兩階進度、
// 實際加成、未啟動原因、還差多少、參與球員、改善建議，以及「編輯後」跟已儲存陣容的差異。
// 只讀陣容草稿與存檔；指定隊長只改草稿（跟其他陣容修改一樣，要按「儲存陣容」才生效）。
import type { RelicId } from '../../sim/items'
import type { Batter, Roster } from '../../sim/types'
import { el } from '../../ui/playerCard'
import { ARCHETYPE_NAMES } from '../../ui/strings'
import { captainIcon, synergyIcon, synergyRows } from '../../ui/synergyUi'
import { captainOptions, captainRules, conditionText, synergyChanges, synergyDetails, type SynergyChange, type SynergyDetail } from '../../ui/synergyInfo'
import { captainIn, captainWeight, thresholds } from '../../sim/synergy'
import type { Archetype } from '../../sim/types'
import { v2Modal } from './dialog'

export interface SynergyGuideSource {
  /** 已儲存的陣容（沒有球團時 null） */
  saved: () => Roster | null
  /** 目前的草稿（畫面上正在編輯的陣容） */
  draft: () => Roster
  /** 不在先發、可以換上來的打者（板凳＋預備） */
  pool: () => Batter[]
  /** 指定隊長（只改草稿）；不能寫入時是 null */
  setCaptain: ((playerId: string) => void) | null
  owner?: unknown
}

const RELICS: readonly RelicId[] = []
const TIER_TEXT = ['未啟動', '已啟動', '已升級'] as const

export function changeText(c: SynergyChange): string {
  const positional = c.key === 'middle' || c.key === 'battery'
  const tierName = (t: number) => (positional ? '成立' : `${thresholds(c.key as Archetype, RELICS)[t === 2 ? 1 : 0]} 人階`)
  switch (c.kind) {
    case 'gained':
      return positional ? `＋ ${c.name} 成立` : `＋ ${c.name} 啟動（${tierName(c.after)}）`
    case 'lost':
      return `− ${c.name} 失效`
    case 'up':
      return `↑ ${c.name} 升到 ${tierName(c.after)}`
    case 'down':
      return `↓ ${c.name} 掉回 ${tierName(c.after)}`
  }
}

/** 陣容頁用：草稿跟存檔的羈絆差異（沒有差異回傳 null） */
export function draftChangesLine(saved: Roster | null, draft: Roster): HTMLElement | null {
  if (!saved) return null
  const changes = synergyChanges(synergyRows(saved.lineup, saved.captain, RELICS), synergyRows(draft.lineup, draft.captain, RELICS))
  const capChanged = captainIn(saved.lineup, saved.captain) !== captainIn(draft.lineup, draft.captain)
  if (!changes.length && !capChanged) return null
  const box = el('div', 'v2-syn-preview')
  box.setAttribute('role', 'status')
  box.append(el('span', 'v2-syn-preview-label', '儲存後'))
  if (!changes.length) box.append(el('span', 'v2-syn-change same', '羈絆不變'))
  for (const c of changes) box.append(el('span', `v2-syn-change ${c.kind}`, changeText(c)))
  if (capChanged) {
    const cap = captainIn(draft.lineup, draft.captain)
    box.append(el('span', 'v2-syn-change cap', cap ? `隊長換成 ${draft.lineup.find((s) => s.player.id === cap)!.player.name}` : '沒有隊長'))
  }
  return box
}

/** 打開羈絆說明。回傳關閉函式 */
export function openSynergyGuide(src: SynergyGuideSource): () => void {
  const body = el('div', 'v2-syn-guide')
  const draw = (focusSel?: string) => {
    const draft = src.draft()
    const saved = src.saved()
    const details = synergyDetails(draft.lineup, draft.captain, RELICS, src.pool())
    body.replaceChildren(summary(details, saved, draft), captainSection(draft), ...details.map((d) => card(d, saved)))
    if (focusSel) body.querySelector<HTMLElement>(focusSel)?.focus({ preventScroll: true })
  }

  function summary(details: SynergyDetail[], saved: Roster | null, draft: Roster): HTMLElement {
    const sec = el('section', 'v2-syn-summary')
    const active = details.filter((d) => d.tier > 0)
    sec.append(el('p', 'v2-syn-summary-line', active.length ? `目前成立 ${active.length} 個：${active.map((d) => d.name).join('、')}` : '目前沒有成立的羈絆'))
    if (saved) {
      const changes = synergyChanges(synergyRows(saved.lineup, saved.captain, RELICS), synergyRows(draft.lineup, draft.captain, RELICS))
      const line = el('div', 'v2-syn-diff')
      line.dataset.changes = String(changes.length)
      line.append(el('strong', '', '跟已儲存的陣容比'))
      if (!changes.length) line.append(el('span', 'v2-syn-change same', '羈絆相同'))
      for (const c of changes) line.append(el('span', `v2-syn-change ${c.kind}`, changeText(c)))
      if (changes.length) line.append(el('span', 'v2-syn-note', '編輯中的陣容，按「儲存陣容」才會生效'))
      sec.append(line)
    }
    return sec
  }

  function captainSection(draft: Roster): HTMLElement {
    const sec = el('section', 'v2-syn-captain')
    sec.setAttribute('aria-label', '隊長')
    const head = el('div', 'v2-syn-captain-head')
    head.append(captainIcon(28), el('h3', '', '隊長（C = Captain）'))
    const rules = el('ul', 'v2-syn-rules')
    for (const r of captainRules(RELICS)) rules.append(el('li', '', r))
    const cap = captainIn(draft.lineup, draft.captain)
    const capName = cap ? draft.lineup.find((s) => s.player.id === cap)!.player : null
    sec.append(head, el('p', 'v2-syn-captain-now', capName ? `目前隊長：${capName.name}（${ARCHETYPE_NAMES[capName.archetype]}，在自己流派算 ${captainWeight(RELICS)} 人）` : '目前沒有隊長：先發打者沒有人多算'), rules)
    const list = el('div', 'v2-syn-cap-list')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', '指定隊長')
    for (const o of captainOptions(draft.lineup, draft.captain, RELICS)) {
      const b = el('button', `v2-syn-cap${o.current ? ' on' : ''}`)
      b.type = 'button'
      b.dataset.captain = o.id
      b.setAttribute('aria-pressed', String(o.current))
      // 目前的隊長不停用（停用的按鈕拿不到焦點）：按了不會有變化
      b.disabled = !src.setCaptain
      if (o.current) b.setAttribute('aria-current', 'true')
      const name = el('span', 'v2-syn-cap-name')
      name.append(el('strong', '', o.name), el('span', 'v2-syn-cap-type', ARCHETYPE_NAMES[o.archetype]))
      if (o.current) name.append(el('span', 'v2-captain-chip', '隊長'))
      const effect = el('span', 'v2-syn-cap-effect')
      if (o.current) effect.append('目前的隊長')
      else {
        // 人數變化一定列出；階級有變的另外標顏色
        effect.append(o.counts.length ? o.counts.map((c) => `${c.name} ${c.from}→${c.to} 人`).join('・') : '人數不變')
        for (const c of o.changes) effect.append(el('span', `v2-syn-change ${c.kind}`, changeText(c)))
        if (!o.changes.length) effect.append(el('span', 'v2-syn-cap-same', '（階級不變）'))
      }
      b.append(name, effect)
      if (src.setCaptain && !o.current) b.onclick = () => {
        src.setCaptain!(o.id)
        draw(`[data-captain="${o.id}"]`)
      }
      list.append(b)
    }
    sec.append(list, el('p', 'v2-syn-note', src.setCaptain ? '指定隊長只改編輯中的陣容；按「儲存陣容」才生效。' : '目前不能修改陣容（唯讀分頁或正在儲存）。'))
    return sec
  }

  function card(d: SynergyDetail, saved: Roster | null): HTMLElement {
    const c = el('section', `v2-syn-card ${d.tier ? (d.tier === 2 || d.position ? 'max' : 'on') : 'off'}`)
    c.dataset.synergy = d.key
    c.setAttribute('aria-label', `${d.name}：${d.position ? (d.tier ? '成立' : '未成立') : TIER_TEXT[d.tier]}`)
    const head = el('div', 'v2-syn-card-head')
    const status = d.position ? (d.tier ? '成立' : '未成立') : d.tier ? `${TIER_TEXT[d.tier]}・${d.tier === 2 ? d.high : d.low} 人階` : '未啟動'
    head.append(synergyIcon(d.key, 28, `syn-icon${d.tier ? '' : ' off'}`), el('h3', '', d.name), el('span', `v2-syn-status ${d.tier ? 'on' : 'off'}`, status))
    c.append(head, el('p', 'v2-syn-desc', d.desc), el('p', 'v2-syn-cond', `條件：${conditionText(d)}`))

    if (!d.position) {
      // 兩階進度：0 ～ 升級門檻，標出啟動門檻
      const prog = el('div', 'v2-syn-progress')
      const bar = el('div', 'v2-syn-bar')
      bar.setAttribute('role', 'meter')
      bar.setAttribute('aria-valuemin', '0')
      bar.setAttribute('aria-valuemax', String(d.high))
      bar.setAttribute('aria-valuenow', String(Math.min(d.count, d.high)))
      bar.setAttribute('aria-label', `${d.name} 目前 ${d.count} 人`)
      const fill = el('span', 'v2-syn-fill')
      fill.style.width = `${Math.min(100, (d.count / d.high) * 100)}%`
      const mark = el('span', 'v2-syn-mark')
      mark.style.left = `${(d.low / d.high) * 100}%`
      bar.append(fill, mark)
      const steps = el('div', 'v2-syn-steps')
      for (const [t, need] of [[1, d.low], [2, d.high]] as const) {
        const done = d.tier >= t
        steps.append(el('span', `v2-syn-step${done ? ' done' : ''}`, `${t === 1 ? '第一階' : '第二階'}（${need} 人）${done ? '✓ 達成' : `差 ${need - d.count} 人`}`))
      }
      prog.append(el('span', 'v2-syn-count', `目前 ${d.count} 人`), bar, steps)
      c.append(prog)
    }

    const effects = el('div', 'v2-syn-effects')
    const list = (title: string, items: string[], cls: string) => {
      const box = el('div', `v2-syn-effect ${cls}`)
      box.append(el('strong', '', title))
      const ul = el('ul')
      for (const x of items) ul.append(el('li', '', x))
      box.append(ul)
      return box
    }
    if (d.current.length) effects.append(list('目前加成', d.current, 'now'))
    else effects.append(el('p', 'v2-syn-none', '目前沒有加成'))
    if (d.next) effects.append(list(d.position ? '成立後的加成' : `下一階（再 ${d.next.missing} 人）的加成`, d.next.effects, 'next'))
    c.append(effects)

    const who = el('div', 'v2-syn-members')
    who.append(el('strong', '', d.position ? '守這些位置的人' : '算進來的球員'))
    if (!d.members.length) who.append(el('span', 'v2-syn-none', '沒有'))
    for (const m of d.members) {
      const chip = el('span', `v2-syn-member${m.captain ? ' captain' : ''}`)
      chip.append(m.name)
      if (m.captain) chip.append(captainIcon(14), el('span', 'v2-syn-weight', `隊長・算 ${m.weight} 人`))
      who.append(chip)
    }
    for (const x of d.excluded) who.append(el('span', 'v2-syn-member excluded', `${x.name}：${x.why}`))
    c.append(who)

    if (d.tier < (d.position ? 1 : 2)) c.append(el('p', `v2-syn-reason${d.tier ? ' partial' : ''}`, d.position ? `未成立：${d.reason}` : d.reason))
    if (d.tips.length) {
      const tips = el('div', 'v2-syn-tips')
      tips.append(el('strong', '', '怎麼改善'))
      const ul = el('ul')
      for (const t of d.tips) ul.append(el('li', '', t))
      tips.append(ul)
      c.append(tips)
    }
    if (saved) {
      const before = synergyRows(saved.lineup, saved.captain, RELICS).find((r) => r.key === d.key)!
      if (before.tier !== d.tier) c.append(el('p', 'v2-syn-was', `已儲存的陣容：${d.position ? (before.tier ? '成立' : '未成立') : TIER_TEXT[before.tier]}`))
    }
    return c
  }

  draw()
  return v2Modal('羈絆說明', body, undefined, { sheet: true, className: 'v2-syn-modal', owner: src.owner })
}

