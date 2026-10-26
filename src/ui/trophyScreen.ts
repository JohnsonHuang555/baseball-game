// 獎盃櫃：每一座冠軍獎盃一張卡，列出難度、隊名、日期、決賽比分和奪冠時的先發陣容
import { avatar } from './avatar'
import { kbd, setKeys } from './keys'
import { el } from './playerCard'
import { clearedTier, trophies, type Trophy } from './progress'
import { T } from './strings'
import { TROPHY } from './tournamentScreen'

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'

export function showTrophyCase(root: HTMLElement, back: () => void): void {
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
  titles.append(el('h1', 'trophy-title', T.trophyCase), el('span', 'trophy-best', cleared ? T.trophyBest(T.levelNames[cleared]) : T.trophyNone))
  header.append(backBtn, titles)
  screen.append(header)

  const list = trophies()
  if (list.length === 0) {
    const empty = el('div', 'trophy-empty')
    const icon = el('span', 'trophy-empty-icon')
    icon.innerHTML = TROPHY(64)
    empty.append(icon, el('p', '', T.trophyEmpty))
    screen.append(empty)
  } else {
    const shelf = el('section', 'trophy-list')
    shelf.setAttribute('aria-label', T.trophyCase)
    for (const t of list) shelf.append(trophyCard(t))
    screen.append(shelf)
  }
  root.append(screen)
  setKeys({ Escape: back })
}

function trophyCard(t: Trophy): HTMLElement {
  const card = el('article', `trophy-card level-${t.tier}`)
  const top = el('div', 'trophy-card-top')
  const icon = el('span', 'trophy-card-icon')
  icon.innerHTML = TROPHY(40)
  const words = el('div', 'trophy-card-words')
  words.append(el('span', `level-tag level-${t.tier}`, T.levelNames[t.tier]), el('h2', 'trophy-team', t.teamName))
  const finals = t.history.filter((g) => g.round === 'final')
  const wins = finals.filter((g) => g.won).length
  const meta = el('span', 'trophy-meta', `${new Date(t.at).toLocaleDateString('zh-TW')}・${T.trophyFinal(wins, finals.length - wins)}`)
  words.append(meta)
  top.append(icon, words)
  card.append(top)

  // 奪冠時的先發九人加先發投手
  const faces = el('div', 'trophy-faces')
  const players = [...t.roster.lineup.map((s) => s.player), t.roster.starter]
  for (const p of players) {
    const face = avatar(p.id, 'user', 'trophy-face')
    face.title = p.name
    faces.append(face)
  }
  card.append(faces)
  if (t.unlocked) card.append(el('span', 'trophy-unlock', T.unlockOutfit(T.outfitNames[t.unlocked])))
  return card
}
