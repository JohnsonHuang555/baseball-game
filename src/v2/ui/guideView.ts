// 遊戲指南（設計稿 p7 IdGuide）：首頁標題列「?」打開的全畫面視窗。
// 手機：上方搜尋＋橫向章節；電腦版：左側 300px 章節欄、右側內容。關閉（✕、Esc）後焦點回到「?」按鈕（dialog.ts 的 opener）
import { el } from '../../ui/playerCard'
import { gradeBadge } from '../../ui/grades'
import { LEAGUES } from '../domain/leagueConfig'
import { v2Modal, type CloseReason } from './dialog'
import { guideChapters, searchGuide, type GuideChapter, type GuideVisual } from './guideContent'
import { icon } from './icons'
import { leagueBadge } from './leagueBadge'
import { pointsBar } from './leagueInfo'
import { RANKED_CONFIG } from '../domain/leagueConfig'

export interface GuideOptions {
  desk?: boolean
  owner?: unknown
  /** 一開始顯示哪一章（id） */
  chapter?: string
  onClose?: (reason: CloseReason) => void
}

function visual(v: GuideVisual): HTMLElement {
  const box = el('div', `v2-guide-visual ${v.kind}`)
  if (v.kind === 'flow') {
    v.steps.forEach((s, i) => {
      if (i) box.append(el('span', 'v2-guide-arrow', '→'))
      const node = el('span', 'v2-guide-node')
      node.append(icon(s.icon, 22), el('span', '', s.label))
      box.append(node)
    })
  } else if (v.kind === 'stats') {
    for (const s of v.items) {
      const cell = el('span', 'v2-guide-stat')
      cell.append(el('strong', '', s.value), el('span', '', s.label))
      box.append(cell)
    }
  } else if (v.kind === 'grades') {
    for (const g of [9, 8, 7, 6, 5, 4, 3, 2]) box.append(gradeBadge(g, 'md'))
  } else if (v.kind === 'leagues') {
    LEAGUES.forEach((l, i) => {
      if (i) box.append(el('span', 'v2-guide-arrow', '→'))
      const node = el('span', 'v2-guide-node league')
      node.append(leagueBadge(i, 'reached', 36), el('span', '', l.name.replace('聯盟', '')))
      box.append(node)
    })
  } else {
    const r = RANKED_CONFIG
    const t = r.relegationTiers[0]
    const head = el('div', 'v2-guide-points-head')
    head.append(el('span', '', `例：${LEAGUES[t].name} ${r.initialPoints} / ${r.maxPoints}（剛晉級的起始積分）`))
    const legend = el('div', 'v2-guide-points-legend')
    legend.append(el('span', 'danger', `危險區 ≤ ${r.dangerThreshold}`), el('span', '', `勝 +${r.winPoints}／敗 −${-r.lossPoints}`), el('span', '', `歸零降級・${LEAGUES[r.relegationFloorTier].name}保底`))
    box.append(head, pointsBar(t, r.initialPoints, `例：${LEAGUES[t].name}積分 ${r.initialPoints} / ${r.maxPoints}`), legend)
  }
  return box
}

function chapterView(c: GuideChapter, index: number, total: number, go: (i: number) => void, desk: boolean): HTMLElement {
  const wrap = el('div', 'v2-guide-chapter')
  wrap.dataset.chapter = c.id
  const hero = el('section', 'v2-guide-hero')
  const ic = el('span', 'v2-guide-hero-icon')
  ic.append(icon(c.icon, 32))
  const titles = el('div', 'v2-guide-hero-titles')
  titles.append(el('span', 'v2-guide-no', `CHAPTER ${String(index + 1).padStart(2, '0')}`), el('h3', 'v2-guide-title', c.title))
  const top = el('div', 'v2-guide-hero-top')
  top.append(ic, titles)
  hero.append(top, el('p', 'v2-guide-summary', c.summary))
  if (c.visual) hero.append(visual(c.visual))
  wrap.append(hero)

  if (c.cards.length) {
    const grid = el('div', `v2-guide-cards ${desk ? 'two' : ''}`.trim())
    for (const card of c.cards) {
      const item = el('article', `v2-guide-card ${card.tag ?? ''}`.trim())
      const ci = el('span', 'v2-guide-card-icon')
      ci.append(icon(card.icon, 20))
      const head = el('div', 'v2-guide-card-head')
      head.append(el('strong', '', card.title))
      if (card.tag === 'key') head.append(el('span', 'v2-key-tag', '重點'))
      const text = el('div', 'v2-guide-card-text')
      text.append(head, el('p', '', card.text))
      item.append(ci, text)
      grid.append(item)
    }
    wrap.append(grid)
  }

  if (c.faq?.length) {
    const list = el('div', 'v2-guide-faq')
    const items: { btn: HTMLButtonElement; ans: HTMLElement; row: HTMLElement }[] = []
    c.faq.forEach((f, i) => {
      const row = el('div', 'v2-faq-item')
      const btn = el('button', 'v2-faq-q')
      btn.type = 'button'
      btn.setAttribute('aria-expanded', 'false')
      const ans = el('p', 'v2-faq-a', f.a)
      ans.id = `v2-faq-${c.id}-${i}`
      ans.hidden = true
      btn.setAttribute('aria-controls', ans.id)
      btn.append(el('span', '', f.q), icon('chev', 14, 'v2-faq-chev'))
      // 一次只展開一題
      btn.onclick = () => {
        const open = btn.getAttribute('aria-expanded') !== 'true'
        for (const it of items) {
          const me = it.btn === btn && open
          it.btn.setAttribute('aria-expanded', String(me))
          it.ans.hidden = !me
          it.row.classList.toggle('open', me)
        }
      }
      row.append(btn, ans)
      items.push({ btn, ans, row })
      list.append(row)
    })
    wrap.append(list)
  }

  const pager = el('div', 'v2-guide-pager')
  const prev = el('button', 'btn-white v2-guide-prev', '‹ 上一章')
  prev.type = 'button'
  prev.disabled = index === 0
  prev.onclick = () => go(index - 1)
  const next = el('button', 'btn-white v2-guide-next', '下一章 ›')
  next.type = 'button'
  next.disabled = index === total - 1
  next.onclick = () => go(index + 1)
  pager.append(prev, next)
  wrap.append(pager)
  return wrap
}

export function openGuide(opts: GuideOptions = {}): () => void {
  const chapters = guideChapters()
  const desk = !!opts.desk
  let current = Math.max(0, chapters.findIndex((c) => c.id === opts.chapter))
  let query = ''

  const body = el('div', `v2-guide ${desk ? 'desk' : ''}`.trim())
  const side = el('div', 'v2-guide-side')
  const search = el('label', 'v2-guide-search')
  search.append(icon('search', 18))
  const input = el('input', 'v2-guide-input')
  input.type = 'search'
  input.placeholder = '搜尋規則，例如：降級、離線'
  input.setAttribute('aria-label', '搜尋遊戲指南')
  search.append(input)
  const tabs = el('div', 'v2-guide-tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '章節')
  tabs.setAttribute('aria-orientation', desk ? 'vertical' : 'horizontal')
  const panel = el('div', 'v2-guide-panel')
  panel.setAttribute('role', 'tabpanel')
  panel.id = `v2-guide-panel-${Math.random().toString(36).slice(2)}`
  panel.tabIndex = -1
  const tabButtons = chapters.map((c, i) => {
    const b = el('button', 'v2-guide-tab')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-controls', panel.id)
    b.dataset.chapter = c.id
    b.append(el('span', 'v2-guide-tab-no', String(i + 1).padStart(2, '0')), el('span', '', desk ? c.title : c.short))
    b.onclick = () => go(i)
    b.onkeydown = (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
      if (!d) return
      e.preventDefault()
      const j = (i + d + chapters.length) % chapters.length
      go(j)
      tabButtons[j].focus()
    }
    tabs.append(b)
    return b
  })
  side.append(search, tabs)
  body.append(side, panel)

  function render(): void {
    tabButtons.forEach((b, i) => {
      const on = !query && i === current
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on || (query && i === 0) ? 0 : -1
      b.classList.toggle('on', on)
    })
    if (query) {
      const hits = searchGuide(chapters, query)
      const box = el('div', 'v2-guide-results')
      box.append(el('h3', 'v2-guide-results-title', `「${query}」找到 ${hits.length} 筆`))
      if (!hits.length) box.append(el('p', 'v2-empty', '找不到相關的規則，換個關鍵字試試看'))
      for (const h of hits) {
        const r = el('button', 'v2-guide-hit')
        r.type = 'button'
        r.append(el('span', 'v2-guide-hit-ch', h.chapter.title), el('strong', '', h.title), el('span', 'v2-guide-hit-text', h.text))
        r.onclick = () => {
          input.value = ''
          query = ''
          go(chapters.indexOf(h.chapter))
        }
        box.append(r)
      }
      panel.replaceChildren(box)
      return
    }
    panel.setAttribute('aria-labelledby', tabButtons[current].id || '')
    panel.replaceChildren(chapterView(chapters[current], current, chapters.length, go, desk))
  }
  function go(i: number): void {
    current = Math.max(0, Math.min(chapters.length - 1, i))
    query = ''
    render()
    panel.scrollTop = 0
    body.closest('.v2-modal-body')?.scrollTo?.(0, 0)
    if (!desk) tabButtons[current].scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }
  input.oninput = () => {
    query = input.value.trim()
    render()
  }
  tabButtons.forEach((b, i) => (b.id = `${panel.id}-tab-${i}`))
  render()

  const head = el('div', 'v2-full-head')
  const q = el('span', 'v2-guide-q', '?')
  q.setAttribute('aria-hidden', 'true')
  head.append(q, el('span', 'v2-full-title', '遊戲指南'))
  return v2Modal('遊戲指南', body, opts.onClose, { full: true, header: head, noCloseButton: true, className: 'v2-guide-modal', owner: opts.owner })
}
