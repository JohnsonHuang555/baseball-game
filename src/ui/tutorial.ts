// 新手教學：第一次進入某個畫面時，用聚光燈框出重點、旁邊放說明，一步一步帶過
import { kbd, setKeys } from './keys'
import { el } from './playerCard'
import { T } from './strings'

export interface TutorialStep {
  /** 要框起來的元素；給多個選擇器就用第一個看得到的。找不到就置中顯示 */
  target?: string | string[]
  title: string
  text: string
  /** 找不到目標就跳過這一步（例如這次沒有推薦指令） */
  optional?: boolean
}

const PREFIX = 'dice-baseball.tutorial.'
export const TUTORIALS = ['home', 'team', 'match', 'decision', 'alignment', 'hub', 'draft'] as const
export type TutorialId = (typeof TUTORIALS)[number]

function seen(id: TutorialId): boolean {
  try {
    return localStorage.getItem(PREFIX + id) === 'done'
  } catch {
    // 記不住的話就不要每次都跳出來
    return true
  }
}

function markSeen(id: TutorialId): void {
  try {
    localStorage.setItem(PREFIX + id, 'done')
  } catch {
    // 記不住就算了
  }
}

/** 重看教學：清掉紀錄，之後進入各畫面時會再顯示 */
export function resetTutorials(): void {
  try {
    for (const id of TUTORIALS) localStorage.removeItem(PREFIX + id)
  } catch {
    // 清不掉就算了
  }
}

function findTarget(target: TutorialStep['target']): HTMLElement | null {
  for (const sel of [target ?? []].flat()) {
    const node = document.querySelector<HTMLElement>(sel)
    if (node && node.getClientRects().length > 0 && node.getBoundingClientRect().width > 0) return node
  }
  return null
}

/** 沒看過這份教學就播放，看完（或跳過）才 resolve；看過就直接 resolve */
export function maybeTutorial(id: TutorialId, steps: TutorialStep[]): Promise<void> {
  if (seen(id)) return Promise.resolve()
  return new Promise((resolve) => {
    // 等畫面排版完成再量位置
    requestAnimationFrame(() => run(id, steps, resolve))
  })
}

function run(id: TutorialId, all: TutorialStep[], resolve: () => void): void {
  const steps = all.filter((s) => !s.optional || findTarget(s.target))
  if (steps.length === 0) {
    markSeen(id)
    return resolve()
  }
  const layer = el('div', 'tut-layer')
  layer.setAttribute('role', 'dialog')
  layer.setAttribute('aria-modal', 'true')
  const hole = el('div', 'tut-hole')
  const bubble = el('div', 'tut-bubble')
  layer.append(hole, bubble)
  document.body.append(layer)
  const previousKeys = setKeys({})
  let index = 0

  const finish = () => {
    markSeen(id)
    window.removeEventListener('resize', place)
    layer.remove()
    setKeys(previousKeys)
    resolve()
  }
  const next = () => {
    if (index >= steps.length - 1) return finish()
    index++
    show()
  }

  function place(): void {
    const target = findTarget(steps[index].target)
    const vw = window.innerWidth
    const vh = window.innerHeight
    const bw = Math.min(360, vw - 32)
    bubble.style.width = `${bw}px`
    if (!target) {
      hole.classList.add('none')
      bubble.style.left = `${(vw - bw) / 2}px`
      bubble.style.top = `${Math.max(16, (vh - bubble.offsetHeight) / 2)}px`
      return
    }
    hole.classList.remove('none')
    const pad = 6
    const r = target.getBoundingClientRect()
    const top = Math.max(4, r.top - pad)
    const bottom = Math.min(vh - 4, r.bottom + pad)
    hole.style.left = `${r.left - pad}px`
    hole.style.top = `${top}px`
    hole.style.width = `${r.width + pad * 2}px`
    hole.style.height = `${Math.max(0, bottom - top)}px`
    // 框的下方放得下就放下面，否則放上面；都放不下就蓋在框裡靠下
    const bh = bubble.offsetHeight
    let y = bottom + 12
    if (y + bh > vh - 12) y = top - 12 - bh
    if (y < 12) y = Math.min(vh - bh - 12, Math.max(12, bottom - bh - 12))
    const x = Math.min(vw - bw - 16, Math.max(16, r.left + r.width / 2 - bw / 2))
    bubble.style.left = `${x}px`
    bubble.style.top = `${y}px`
  }

  function show(): void {
    const step = steps[index]
    const target = findTarget(step.target)
    target?.scrollIntoView({ block: 'center', inline: 'nearest' })
    const last = index === steps.length - 1
    const head = el('div', 'tut-head')
    head.append(el('span', 'tut-count', `${index + 1} / ${steps.length}`), el('h2', 'tut-title', step.title))
    const buttons = el('div', 'tut-buttons')
    const skip = el('button', 'tut-skip', T.tutorialSkip)
    skip.type = 'button'
    skip.append(kbd('ESC'))
    skip.onclick = finish
    const go = el('button', 'btn-yellow tut-next', last ? T.tutorialDone : T.tutorialNext)
    go.type = 'button'
    go.append(kbd('ENTER'))
    go.onclick = next
    buttons.append(last ? el('span') : skip, go)
    bubble.replaceChildren(head, el('p', 'tut-text', step.text), buttons)
    place()
    go.focus({ preventScroll: true })
  }

  setKeys({ Enter: next, Space: next, Escape: finish })
  window.addEventListener('resize', place)
  // 點遮罩也算下一步，比較好按
  layer.addEventListener('click', (e) => {
    if (e.target === layer || e.target === hole) next()
  })
  show()
}
