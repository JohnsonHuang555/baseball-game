// 球團史：跨輪的紀錄，分成冠軍（奪冠回顧）、傳奇館、歷程（包含被淘汰的輪次）、衣櫃（裝扮）四頁
import type { Player } from '../sim/types'
import { avatar, avatarOutfit, avatarSpecies, avatarSvg, setAvatarOutfit } from './avatar'
import { TROPHY, kitChip } from './cards'
import { gradeBadge, overallBadge } from './grades'
import { kbd, setKeys } from './keys'
import { infoModal } from './modal'
import { el, traitTag } from './playerCard'
import { OUTFITS, OUTFIT_UNLOCK, clearedTier, isUnlocked, legends, runs, trophies, type Legend, type RunRecord, type Trophy } from './progress'
import { RELICS } from '../sim/items'
import { RELIC_DESC, RELIC_NAMES, T, TRAIT_NAMES } from './strings'
import { toast } from './visual'

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'

export type HistoryTab = keyof typeof T.historyTabs
const TABS: HistoryTab[] = ['champions', 'legends', 'runs', 'wardrobe']

export function showClubHistory(root: HTMLElement, back: () => void, tab: HistoryTab = 'champions'): void {
  root.replaceChildren()
  const screen = el('div', 'trophy-screen')
  const header = el('header', 'trophy-header')
  const backBtn = el('button', 'icon-btn')
  backBtn.type = 'button'
  backBtn.innerHTML = BACK_ICON
  backBtn.setAttribute('aria-label', T.backToTitle)
  backBtn.append(kbd('ESC'))
  backBtn.onclick = back
  const titles = el('div', 'trophy-titles')
  const cleared = clearedTier()
  titles.append(el('h1', 'trophy-title', T.clubHistory), el('span', 'trophy-best', cleared ? T.trophyBest(T.levelNames[cleared]) : T.trophyNone))
  header.append(backBtn, titles)

  // 分頁：數字鍵 1～4 也能切換
  const tabs = el('div', 'history-tabs')
  tabs.setAttribute('role', 'tablist')
  const keys: Record<string, () => void> = { Escape: back }
  TABS.forEach((id, i) => {
    const b = el('button', 'history-tab', T.historyTabs[id])
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', String(id === tab))
    b.onclick = () => showClubHistory(root, back, id)
    keys[String(i + 1)] = () => b.click()
    tabs.append(b)
  })
  screen.append(header, tabs)

  const body = el('section', 'history-body')
  body.setAttribute('role', 'tabpanel')
  if (tab === 'champions') body.append(championsTab())
  else if (tab === 'legends') body.append(legendsTab())
  else if (tab === 'runs') body.append(runsTab())
  else body.append(wardrobeTab(() => showClubHistory(root, back, 'wardrobe')))
  screen.append(body)
  root.append(screen)
  setKeys(keys)
}

function emptyBox(text: string): HTMLElement {
  const empty = el('div', 'trophy-empty')
  const icon = el('span', 'trophy-empty-icon')
  icon.innerHTML = TROPHY(64)
  empty.append(icon, el('p', '', text))
  return empty
}

// ---- 冠軍 ----

function championsTab(): HTMLElement {
  const list = trophies()
  if (!list.length) return emptyBox(T.trophyEmpty)
  const shelf = el('div', 'trophy-list')
  for (const t of list) shelf.append(trophyCard(t))
  return shelf
}

/** 一座冠軍：難度、隊名、日期、決賽比分、奪冠時的先發；點開看奪冠回顧 */
function trophyCard(t: Trophy): HTMLElement {
  const card = el('button', `trophy-card level-${t.tier}`)
  card.type = 'button'
  const top = el('div', 'trophy-card-top')
  const icon = el('span', 'trophy-card-icon')
  icon.innerHTML = TROPHY(40)
  const words = el('div', 'trophy-card-words')
  words.append(el('span', `level-tag level-${t.tier}`, T.levelNames[t.tier]), el('h2', 'trophy-team', t.teamName))
  const finals = t.history.filter((g) => g.round === 'final')
  const wins = finals.filter((g) => g.won).length
  words.append(el('span', 'trophy-meta', `${new Date(t.at).toLocaleDateString('zh-TW')}・${T.trophyFinal(wins, finals.length - wins)}`))
  top.append(icon, words)
  card.append(top)
  const faces = el('div', 'trophy-faces')
  for (const p of [...t.roster.lineup.map((s) => s.player), t.roster.starter]) {
    const face = avatar(p.id, 'user', 'trophy-face')
    face.title = p.name
    faces.append(face)
  }
  card.append(faces)
  if (t.unlocked) card.append(el('span', 'trophy-unlock', T.unlockOutfit(T.outfitNames[t.unlocked])))
  if (t.recap) card.append(el('span', 'trophy-open', T.recapOpen))
  card.onclick = () => showRecap(t)
  return card
}

/** 奪冠回顧：秘寶、每一場、覺醒、每位球員的總評變化 */
export function showRecap(t: Trophy): void {
  const box = el('div', 'recap')
  if (!t.recap) {
    box.append(el('p', 'recap-none', T.recapNone))
    return infoModal(T.recapTitle(t.teamName), box, true)
  }
  const { recap } = t
  const section = (title: string, ...children: HTMLElement[]) => box.append(el('h3', 'opp-title', title), ...children)

  const relics = el('div', 'kit-chips')
  for (const id of recap.relics) relics.append(kitChip(RELIC_NAMES[id], RELIC_DESC[id], RELICS[id].tier))
  section(T.relicsTitle, relics)

  const games = el('div', 'recap-games')
  let season = 0
  let finals = 0
  for (const g of t.history) {
    const row = el('div', 'recap-game')
    const label = g.round === 'season' ? T.seasonGame(++season) : g.round === 'final' ? T.finalNth(++finals) : T.roundNames[g.round]
    row.append(
      el('span', 'recap-round', label),
      el('span', `record-mark ${g.won ? 'won' : 'lost'}`, g.won ? T.winMark : T.loseMark),
      el('b', 'recap-score', `${g.userRuns}:${g.opponentRuns}`),
      el('span', 'recap-opp', g.opponent ?? ''),
    )
    if (g.mvp) row.append(el('span', 'recap-mvp', T.mvpTag(g.mvp)))
    games.append(row)
  }
  section(T.recapGames, games)

  const awaken = el('div', 'recap-list')
  if (!recap.awakenings.length) awaken.append(el('span', 'kit-empty', T.recapNoAwaken))
  for (const a of recap.awakenings) awaken.append(el('span', 'recap-line', T.awakenLine(a.game, a.name, TRAIT_NAMES[a.trait])))
  section(T.recapAwaken, awaken)

  // 成長：進步最多的排前面
  const growth = el('div', 'recap-list')
  for (const g of [...recap.growth].sort((a, b) => b.to - b.from - (a.to - a.from))) {
    const row = el('div', 'recap-growth')
    const delta = g.to - g.from
    row.append(
      avatar(g.id, 'user', 'ring'),
      el('span', 'recap-name', g.name),
      gradeBadge(g.from, 'sm'),
      el('span', 'recap-arrow', '→'),
      gradeBadge(g.to, 'sm'),
      el('span', `recap-delta ${delta > 0.05 ? 'up' : ''}`, `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`),
    )
    growth.append(row)
  }
  section(T.recapGrowth, growth)
  infoModal(T.recapTitle(t.teamName), box, true)
}

// ---- 傳奇館 ----

function legendsTab(): HTMLElement {
  const list = legends()
  if (!list.length) return emptyBox(T.legendsEmpty)
  const grid = el('div', 'trophy-list')
  for (const l of list) grid.append(legendCard(l))
  return grid
}

function legendCard(l: Legend): HTMLElement {
  const p = l.player
  const card = el('article', `trophy-card legend-card level-${l.tier}`)
  const top = el('div', 'trophy-card-top')
  const words = el('div', 'trophy-card-words')
  words.append(el('span', `level-tag level-${l.tier}`, T.levelNames[l.tier]), el('h2', 'trophy-team', p.name))
  words.append(el('span', 'trophy-meta', `${p.role === 'pitcher' ? T.pitcher : T.batter}・${T.legendFrom(l.teamName, T.levelNames[l.tier])}`))
  top.append(avatar(p.id, 'user', 'legend-face'), words, overallBadge(p, 'md'))
  const traits = el('div', 'kit-chips')
  traits.append(...p.traits.map(traitTag))
  card.append(top, ratingLine(p), traits)
  return card
}

function ratingLine(p: Player): HTMLElement {
  const line = el('div', 'legend-ratings')
  for (const v of Object.values(p.ratings)) line.append(gradeBadge(v, 'sm'))
  return line
}

// ---- 歷程 ----

function runsTab(): HTMLElement {
  const list = runs()
  if (!list.length) return emptyBox(T.runsEmpty)
  const box = el('div', 'run-list')
  for (const r of list) box.append(runRow(r))
  return box
}

function runRow(r: RunRecord): HTMLElement {
  const row = el('article', `run-row ${r.outcome === 'champion' ? 'champ' : ''}`)
  const outcome = r.outcome === 'champion' ? T.runChampion : T.eliminated(T.roundNames[r.outcome])
  const head = el('div', 'run-head')
  head.append(
    el('span', `level-tag level-${r.tier}`, T.levelNames[r.tier]),
    el('b', 'run-team', r.teamName),
    el('span', 'run-outcome', outcome),
    el('span', 'run-meta', `${T.runRecord(r.wins, r.losses)}・${new Date(r.at).toLocaleDateString('zh-TW')}`),
  )
  const relics = el('div', 'kit-chips')
  for (const id of r.relics) relics.append(kitChip(RELIC_NAMES[id], RELIC_DESC[id], RELICS[id].tier))
  row.append(head, relics)
  return row
}

// ---- 衣櫃 ----

function wardrobeTab(redraw: () => void): HTMLElement {
  const box = el('div', 'wardrobe')
  box.append(el('p', 'trophy-best', T.wardrobeHint))
  const grid = el('div', 'wardrobe-grid')
  const current = avatarOutfit()
  const sample = avatarSpecies() === 'cat' ? 'p-cat-sample' : 'p-dog-sample'
  for (const o of OUTFITS) {
    const unlocked = isUnlocked(o)
    const b = el('button', `wardrobe-item${o === current ? ' current' : ''}`)
    b.type = 'button'
    b.disabled = !unlocked
    b.setAttribute('aria-pressed', String(o === current))
    const face = el('span', 'wardrobe-face')
    face.innerHTML = avatarSvg(sample, 'user', avatarSpecies(), o)
    b.append(face, el('b', '', T.outfitNames[o]))
    b.append(el('span', 'wardrobe-sub', unlocked ? (o === current ? T.current : '') : T.outfitLocked(T.levelNames[OUTFIT_UNLOCK[o]])))
    b.onclick = () => {
      setAvatarOutfit(o)
      toast(T.outfitPicked(T.outfitNames[o]))
      redraw()
    }
    grid.append(b)
  }
  box.append(grid)
  return box
}
