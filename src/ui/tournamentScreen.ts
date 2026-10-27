import { replay } from '../sim/game'
import { cardTier, teamAverage, type CardTier } from '../sim/generate'
import { gameGrowth } from '../sim/growth'
import { EQUIPMENT, MAX_EQUIPMENT, RELICS, type EquipmentId, type RelicId } from '../sim/items'
import { getSlot, type Slot } from '../sim/setup'
import {
  FINAL_WINS_NEEDED,
  MAX_SEASON_LOSSES,
  PLAYOFF_ROUNDS,
  SEASON_GAMES,
  TIERS,
  WINS_TO_ADVANCE,
  beginGame,
  canEquip,
  canLearnTrait,
  chooseStartingRelic,
  equipFromBag,
  finishGame,
  pickEquipment,
  pickPlayer,
  pickRelic,
  pickTrait,
  playoffSeed,
  relicsOf,
  rewardTier,
  saveProgress,
  seasonRecord,
  skipReward,
  startTournament,
  unequip,
  updateLineup,
  updateSetup,
  type RewardCard,
  type Tournament,
} from '../sim/tournament'
import { TRAITS } from '../sim/traits'
import type { Player, Roster } from '../sim/types'
import { recordChampion, type Trophy } from './progress'
import { avatar, avatarSvg } from './avatar'
import { showGame } from './gameScreen'
import { growthPanel } from './growthPanel'
import { gradeBadge, gradeOf, overallBadge } from './grades'
import { kbd, setKeys, type KeyMap } from './keys'
import { choiceModal } from './modal'
import { el, traitTag } from './playerCard'
import { applyCardState, handChip, pitchChip, sideTag, tendencyChip, toast } from './visual'
import { clearTournament, saveTournament } from './save'
import { play } from './sound'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { rays, showRosterEditor } from './setupScreen'
import {
  EQUIPMENT_NAMES,
  POSITION_FULL,
  RATING_FULL,
  RATING_LABELS,
  RELIC_DESC,
  RELIC_NAMES,
  T,
  TRAIT_DESC,
  TRAIT_NAMES,
  equipmentDesc,
} from './strings'

/** 依錦標賽目前的階段，打開對應的畫面。每次狀態改變都會存檔 */
export function openTournament(root: HTMLElement, t: Tournament, toTitle: () => void): void {
  const go = (next: Tournament) => openTournament(root, next, toTitle)
  if (t.phase === 'champion' || t.phase === 'eliminated') clearTournament()
  else saveTournament(t)
  // 奪冠：放進獎盃櫃（同一屆只記一次），第一次通過這個難度會解鎖裝扮
  if (t.phase === 'champion') recordChampion(t)

  switch (t.phase) {
    case 'pregame':
      return showRosterEditor(root, {
        setup: t.setup,
        opponent: () => t.opponent,
        heading: T.tournamentHeading(T.seasonGame(1)),
        allowReroll: true,
        allowPlayerReroll: false,
        startLabel: T.startTournament,
        onChange: (setup) => {
          t = updateSetup(t, setup)
          saveTournament(t)
        },
        onStart: (setup) => go(startTournament(updateSetup(t, setup))),
        onBack: toTitle,
      })
    case 'relic':
      return showRelicPick(root, t, go, toTitle)
    case 'playing':
      return playCurrentGame(root, t, go)
    case 'reward':
      return showReward(root, t, go, toTitle)
    case 'champion':
    case 'eliminated':
      return showTourEnd(root, t, toTitle)
    default:
      return showHub(root, t, go, toTitle)
  }
}

/** 計分板上方的小字：例行賽第幾場、季後賽哪一輪、決賽第幾戰 */
function gameSubtitle(t: Tournament): string {
  if (t.round === 'season') {
    const { wins, losses } = seasonRecord(t)
    return T.tournamentHeading(T.seasonGame(wins + losses + 1))
  }
  if (t.round !== 'final') return T.tournamentHeading(T.roundNames[t.round])
  return T.finalGame(t.series.user + t.series.opponent + 1, t.series.user, t.series.opponent)
}

function playCurrentGame(root: HTMLElement, t: Tournament, go: (t: Tournament) => void): void {
  const saved = t.currentGame!
  // 用種子和指令紀錄重播回中斷的那一步（ADR-0001）
  const game = replay(saved.setup, saved.commands, saved.stepIndex)
  // 成長照沒有裝備加成的原始能力算上限
  const growth = () => gameGrowth(game, 'home', t.setup.team.roster)
  showGame(root, {
    game,
    subtitle: gameSubtitle(t),
    onProgress: (g) => {
      t = saveProgress(t, g.commands, g.stepIndex)
      saveTournament(t)
    },
    // 成長名單：結果畫面顯示，按繼續時套用到陣容
    resultExtra: (g) => growthPanel(g, 'home', growth()),
    resultActions: (g) => [{ label: T.continue, primary: true, onClick: () => go(finishGame(t, g.score, growth())) }],
  })
}

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'
const CHECK_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

const SVG_LINE = 'stroke="#141633" stroke-width="3" stroke-linejoin="round"'

/** 裝備的圖：球棒、釘鞋、手套、止滑粉袋、臂套 */
const GEAR_ICONS = {
  // 直立的球棒轉 45 度：上粗下細，握把和尾端左右對稱
  bat: `<svg aria-hidden="true" viewBox="0 0 64 64"><g transform="rotate(45 32 32)"><path d="M28 7 Q28 3 32 3 Q36 3 36 7 L36 30 L33.6 46 L33.6 53 L36.5 55 L36.5 59 L27.5 59 L27.5 55 L30.4 53 L30.4 46 L28 30 Z" fill="#E8B07A" ${SVG_LINE}/><path d="M30.4 44 H33.6 M30.4 48 H33.6" stroke="#141633" stroke-width="1.5"/></g></svg>`,
  shoe: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M14 54 L18 57 L22 54 M28 54 L32 57 L36 54 M44 54 L48 57 L52 54" fill="#141633" ${SVG_LINE}/><path d="M8 50 L10 20 Q18 21 23 28 L34 34 Q52 36 56 44 L56 50 Z" fill="#6FB6FF" ${SVG_LINE}/><path d="M20 30 L24 26 M25 33 L29 29 M30 35 L34 31" stroke="#141633" stroke-width="2"/></svg>`,
  glove: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M14 48 Q8 34 11 22 Q13 14 19 16 L22 28 L23 12 Q25 6 30 8 L32 26 L34 10 Q37 5 41 8 L41 28 L45 18 Q49 14 52 18 Q53 32 47 44 Q40 56 28 56 Q18 56 14 48 Z" fill="#C8763A" ${SVG_LINE}/><path d="M20 42 Q30 48 42 40" fill="none" stroke="#141633" stroke-width="2" stroke-dasharray="3 3"/></svg>`,
  pouch: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M20 24 Q12 50 22 57 H42 Q52 50 44 24 Z" fill="#F4F1E8" ${SVG_LINE}/><path d="M18 24 Q32 18 46 24" fill="none" ${SVG_LINE}/><path d="M27 20 L32 9 L37 20" fill="none" ${SVG_LINE}/><circle cx="28" cy="40" r="2" fill="#B4B9CC"/><circle cx="36" cy="46" r="2" fill="#B4B9CC"/><circle cx="34" cy="34" r="2" fill="#B4B9CC"/></svg>`,
  // 護腕：一圈布料，上面看得到開口
  sleeve: `<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M12 22 V42 Q32 54 52 42 V22" fill="#FF8A2A" ${SVG_LINE}/><ellipse cx="32" cy="22" rx="20" ry="8" fill="#FF8A2A" ${SVG_LINE}/><ellipse cx="32" cy="22" rx="12" ry="4" fill="#141633"/><path d="M12 34 Q32 46 52 34" fill="none" stroke="#FFFFFF" stroke-width="4"/></svg>`,
}

const GEAR_OF: Record<EquipmentId, keyof typeof GEAR_ICONS> = {
  trainingBat: 'bat',
  masterBat: 'bat',
  weightedBat: 'bat',
  compressedBat: 'bat',
  legendBat: 'bat',
  spikes: 'shoe',
  carbonSpikes: 'shoe',
  leatherGlove: 'glove',
  goldGlove: 'glove',
  fireballGlove: 'glove',
  gripBag: 'pouch',
  precisionSleeve: 'sleeve',
  elbowGuard: 'sleeve',
  enduranceBand: 'sleeve',
  goldenSleeve: 'sleeve',
}

/** 秘寶是寶石、特性是星星 */
const KIND_ICONS: Record<'relic' | 'trait', string> = {
  relic:
    '<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M20 10 H44 L56 26 L32 56 L8 26 Z" fill="#B57BFF" stroke="#141633" stroke-width="3" stroke-linejoin="round"/><path d="M8 26 H56 M20 10 L26 26 L32 56 L38 26 L44 10" fill="none" stroke="#141633" stroke-width="2"/></svg>',
  trait:
    '<svg aria-hidden="true" viewBox="0 0 64 64"><path d="M32 6 L39 24 L58 25 L43 37 L48 56 L32 45 L16 56 L21 37 L6 25 L25 24 Z" fill="#FFD23F" stroke="#141633" stroke-width="3" stroke-linejoin="round"/></svg>',
}

function backButton(onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-btn')
  b.type = 'button'
  b.innerHTML = BACK_ICON
  b.setAttribute('aria-label', T.backToTitle)
  b.onclick = onClick
  return b
}

/** 斜切的小緞帶，給下一個對手、奪冠、淘汰用 */
function ribbon(text: string, tone: 'yellow' | 'lilac'): HTMLElement {
  const wrap = el('div', 'hub-ribbon-wrap')
  const r = el('span', `hub-ribbon ${tone}`)
  r.append(el('span', '', text))
  wrap.append(r)
  return wrap
}

function teamTile(name: string, team: 'user' | 'opponent'): HTMLElement {
  return el('span', `team-tile ${team}`, name.slice(0, 1))
}

/** 每一場的戰績：例行賽標第幾場，決賽三戰兩勝標第幾戰 */
function recordRows(t: Tournament): { round: string; won: boolean; score: string; opponent: string }[] {
  let season = 0
  let finals = 0
  return t.history.map((g) => ({
    round: g.round === 'season' ? T.seasonGame(++season) : g.round === 'final' ? T.finalNth(++finals) : T.roundNames[g.round],
    won: g.won,
    score: `${g.userRuns}:${g.opponentRuns}`,
    opponent: g.opponent ?? '',
  }))
}

function allPlayers(roster: Roster): Player[] {
  return [...roster.lineup.map((s) => s.player), ...roster.bench, roster.starter, ...roster.relievers]
}

/** 名單上每位球員的位置說明，例如「游擊手・第 3 棒」「後援投手」 */
function rosterSlots(roster: Roster): [Slot, string][] {
  return [
    ...roster.lineup.map((s, i): [Slot, string] => [{ kind: 'lineup', index: i }, `${POSITION_FULL[s.position]}・${T.orderNth(i + 1)}`]),
    ...roster.bench.map((_, i): [Slot, string] => [{ kind: 'bench', index: i }, T.bench]),
    [{ kind: 'starter' }, T.starter],
    ...roster.relievers.map((_, i): [Slot, string] => [{ kind: 'reliever', index: i }, T.reliever]),
  ]
}

// ---- 錦標賽主畫面 ----

/** 錦標賽主畫面：例行賽與季後賽的進度、秘寶與裝備、下一個對手 */
function showHub(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'hub-screen')

  const header = el('header', 'hub-header')
  const titles = el('div', 'team-titles')
  const eyebrow = el('span', 'eyebrow-light', t.setup.team.name)
  eyebrow.append(el('span', `level-tag level-${t.tier}`, T.levelNames[t.tier]))
  titles.append(eyebrow, el('h1', 'team-name', T.tournament))
  header.append(backButton(toTitle), titles)
  screen.append(header, seasonPanel(t), kitPanel(t, go))

  // 底部：下一個對手
  const bottom = el('section', 'hub-bottom')
  bottom.setAttribute('aria-label', T.nextOpponent)
  bottom.append(ribbon(`${gameSubtitle(t).replace(`${T.tournament}・`, '')}・${T.nextOpponent}`, 'yellow'))
  const vs = el('div', 'hub-vs')
  const side = (name: string, avg: number, team: 'user' | 'opponent') => {
    const box = el('div', `hub-side ${team}`)
    const words = el('span', 'hub-side-words')
    words.append(el('span', 'hub-side-name', name), gradeBadge(avg, 'sm'))
    if (team === 'user') words.append(sideTag(true))
    box.append(teamTile(name, team), words)
    return box
  }
  vs.append(
    side(t.setup.team.name, teamAverage(t.setup.team.roster), 'user'),
    el('span', 'hub-vs-mark', T.versus),
    side(t.opponent.name, teamAverage(t.opponent.roster), 'opponent'),
  )
  const next = el('button', 'btn-yellow btn-big', T.nextGame)
  next.append(kbd('ENTER'))
  setKeys({ Enter: () => next.click() })
  next.onclick = () =>
    showRosterEditor(root, {
      setup: t.setup,
      opponent: () => t.opponent,
      heading: gameSubtitle(t),
      allowReroll: false,
      allowPlayerReroll: false,
      startLabel: T.startGame,
      onChange: (setup) => {
        t = updateLineup(t, setup)
        saveTournament(t)
      },
      onStart: (setup) => go(beginGame(updateLineup(t, setup))),
      onBack: () => go(t),
    })
  bottom.append(vs, next)
  screen.append(bottom)
  root.append(screen)
  void maybeTutorial('hub', TUTORIAL_STEPS.hub)
}

/** 例行賽 8 格（勝、敗、下一場、還沒打），下面是季後賽三輪 */
function seasonPanel(t: Tournament): HTMLElement {
  const panel = el('section', 'hub-panel season-panel')
  panel.setAttribute('aria-label', T.scheduleTitle)
  const { wins, losses } = seasonRecord(t)
  const head = el('div', 'season-head')
  head.append(el('h2', 'panel-title', T.roundNames.season), el('b', 'season-record', T.seasonRecord(wins, losses)))
  panel.append(head)
  if (t.round === 'season') panel.append(el('p', 'season-need', T.seasonNeed(Math.max(0, WINS_TO_ADVANCE - wins), MAX_SEASON_LOSSES - losses)))

  const season = t.history.filter((g) => g.round === 'season')
  const slots = el('ol', 'season-slots')
  for (let i = 0; i < SEASON_GAMES; i++) {
    const g = season[i]
    const state = g ? (g.won ? 'won' : 'lost') : i === season.length && t.round === 'season' ? 'next' : 'upcoming'
    const slot = el('li', `season-slot ${state}`)
    slot.append(el('span', 'season-mark', g ? (g.won ? T.winMark : T.loseMark) : String(i + 1)))
    slot.append(el('span', 'season-opp', t.teamNames[t.schedule[i]]))
    if (g) slot.append(el('span', 'season-score', `${g.userRuns}:${g.opponentRuns}`))
    slots.append(slot)
  }
  panel.append(slots)

  const playoffHead = el('div', 'season-head')
  playoffHead.append(el('h2', 'panel-title', T.playoffsTitle))
  if (t.round !== 'season') playoffHead.append(el('span', 'seed-tag', T.playoffSeed(playoffSeed(t))))
  else playoffHead.append(el('span', 'season-need', T.seedHint))
  panel.append(playoffHead)
  const ladder = el('ol', 'playoff-row')
  const current = t.round === 'season' ? -1 : PLAYOFF_ROUNDS.indexOf(t.round as (typeof PLAYOFF_ROUNDS)[number])
  PLAYOFF_ROUNDS.forEach((round, i) => {
    const games = t.history.filter((g) => g.round === round)
    const won = round === 'final' ? games.filter((g) => g.won).length >= FINAL_WINS_NEEDED : games.some((g) => g.won)
    const state = i < current || won ? 'won' : i === current ? 'next' : 'upcoming'
    const box = el('li', `playoff-box ${state}`)
    box.append(el('span', 'playoff-name', T.roundNames[round]))
    // 還沒打到的輪次不透露對手
    box.append(el('span', 'playoff-opp', i <= current ? t.teamNames[t.playoff[i]] : T.versus))
    if (round === 'final' && games.length) box.append(el('span', 'season-score', `${t.series.user}-${t.series.opponent}`))
    ladder.append(box)
  })
  panel.append(ladder)
  return panel
}

/** 秘寶、身上的裝備、背包；點背包裡的裝備裝上，點身上的裝備卸下 */
function kitPanel(t: Tournament, go: (t: Tournament) => void): HTMLElement {
  const panel = el('section', 'hub-panel kit-panel')
  panel.setAttribute('aria-label', `${T.relicsTitle}・${T.bagTitle}`)

  panel.append(el('h2', 'panel-title', T.relicsTitle))
  const relics = el('div', 'kit-chips')
  for (const id of relicsOf(t)) relics.append(kitChip(RELIC_NAMES[id], RELIC_DESC[id], RELICS[id].tier))
  panel.append(relics)

  const roster = t.setup.team.roster
  const wearers = allPlayers(roster).filter((p) => p.equipment?.length)
  panel.append(el('h2', 'panel-title', T.equippedTitle))
  const worn = el('div', 'kit-chips')
  if (!wearers.length) worn.append(el('span', 'kit-empty', T.noEquipped))
  for (const p of wearers) {
    p.equipment!.forEach((id, i) => {
      const chip = kitChip(`${p.name}・${EQUIPMENT_NAMES[id]}`, equipmentDesc(id), EQUIPMENT[id].tier, true)
      chip.onclick = () => {
        toast(T.unequipped(EQUIPMENT_NAMES[id], p.name))
        go(unequip(t, p.id, i))
      }
      worn.append(chip)
    })
  }
  panel.append(worn)

  panel.append(el('h2', 'panel-title', T.bagTitle))
  const bag = el('div', 'kit-chips')
  if (!t.bag.length) bag.append(el('span', 'kit-empty', T.bagEmpty))
  t.bag.forEach((id, i) => {
    const chip = kitChip(EQUIPMENT_NAMES[id], equipmentDesc(id), EQUIPMENT[id].tier, true)
    chip.onclick = async () => {
      const target = await chooseWearer(roster, id)
      if (!target) return
      toast(T.equipped(EQUIPMENT_NAMES[id], target.player.name))
      go(equipFromBag(t, i, target.player.id, target.replace))
    }
    bag.append(chip)
  })
  panel.append(bag)
  if (wearers.length || t.bag.length) panel.append(el('p', 'kit-hint', T.equipHint))
  return panel
}

/** 秘寶或裝備的小標籤，卡色當底色 */
function kitChip(label: string, desc: string, tier: CardTier, button = false): HTMLElement {
  const chip = el(button ? 'button' : 'span', `kit-chip tier-${tier}`)
  if (chip instanceof HTMLButtonElement) chip.type = 'button'
  chip.append(el('b', 'kit-chip-name', label), el('span', 'kit-chip-desc', desc))
  chip.title = desc
  return chip
}

/** 選一位能帶這件裝備的球員；裝滿的人再選換下哪一件 */
async function chooseWearer(roster: Roster, id: EquipmentId): Promise<{ player: Player; replace?: number } | null> {
  const slots = rosterSlots(roster).filter(([slot]) => canEquip(getSlot(roster, slot), id))
  const player = await choiceModal<Player>({
    title: T.equipWho(EQUIPMENT_NAMES[id]),
    message: equipmentDesc(id),
    options: slots.map(([slot, label]) => {
      const p = getSlot(roster, slot)
      const items = (p.equipment ?? []).map((x) => EQUIPMENT_NAMES[x]).join('・')
      return { value: p, label: `${p.name}（${label}）`, sub: `${T.equipmentCount(p.equipment?.length ?? 0, MAX_EQUIPMENT)}${items ? `：${items}` : ''}`, icon: avatarSvg(p.id, 'user') }
    }),
  })
  if (!player) return null
  const current = player.equipment ?? []
  if (current.length < MAX_EQUIPMENT) return { player }
  const replace = await choiceModal<number>({
    title: T.pickReplace(player.name),
    options: current.map((x, i) => ({ value: i, label: T.replaceItem(EQUIPMENT_NAMES[x]), sub: equipmentDesc(x) })),
  })
  return replace === null ? null : { player, replace }
}

// ---- 起始秘寶 ----

/** 開打後第一件事：三個秘寶選一個 */
function showRelicPick(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  let chosen: number | null = null
  let firstRender = true
  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'draft-screen')
    screen.append(pickHeader(T.relicPickTitle, T.relicPickHint, toTitle))
    const cards = el('section', 'draft-cards')
    cards.setAttribute('aria-label', T.relicsTitle)
    t.relicOptions.forEach((id, i) => {
      const card = itemCard({ kind: 'relic', id }, chosen === i, firstRender, i)
      card.onclick = () => {
        chosen = chosen === i ? null : i
        render()
      }
      cards.append(card)
    })
    screen.append(cards)
    const side = el('div', 'draft-side')
    const footer = el('footer', 'draft-footer')
    const take = el('button', 'btn-yellow btn-wide', chosen === null ? T.pickFirstCard : T.relicTake(RELIC_NAMES[t.relicOptions[chosen]]))
    take.disabled = chosen === null
    take.append(kbd('ENTER'))
    take.onclick = () => {
      if (chosen === null) return
      toast(T.relicGained(RELIC_NAMES[t.relicOptions[chosen]]))
      go(chooseStartingRelic(t, chosen))
    }
    footer.append(take)
    side.append(footer)
    screen.append(side)
    root.append(screen)
    firstRender = false
    setKeys({ ...cardKeys(t.relicOptions.length, () => chosen, (i) => ((chosen = i), render())), Enter: () => take.click() })
  }
  render()
}

function pickHeader(title: string, hint: string, toTitle: () => void): HTMLElement {
  const header = el('header', 'draft-header')
  const top = el('div', 'draft-header-row')
  top.append(backButton(toTitle), el('h1', 'draft-title', title))
  const keyHints = el('span', 'draft-keys desk-only')
  keyHints.append(kbd('←'), kbd('→'), T.pickCard, kbd('ENTER'), T.confirmKey)
  header.append(top, el('p', 'draft-hint', hint), keyHints)
  return header
}

/** ← → 在卡片之間移動 */
function cardKeys(n: number, chosen: () => number | null, set: (i: number) => void): KeyMap {
  const move = (d: number) => {
    const c = chosen()
    set(c === null ? (d > 0 ? 0 : n - 1) : (c + d + n) % n)
  }
  return { ArrowLeft: () => move(-1), ArrowRight: () => move(1) }
}

// ---- 獎勵選擇 ----

/** 獎勵選擇：卡片並排，選一張後在右邊決定給誰（球員卡選換掉誰、裝備選誰帶、特性選誰學） */
function showReward(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  let chosen: number | null = null
  let firstRender = true
  const won = t.history[t.history.length - 1]?.won ?? true

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'draft-screen')
    const justAdvanced = t.round === 'qf' && t.history.filter((g) => g.round === 'qf').length === 0
    screen.append(pickHeader(justAdvanced ? T.advanced : T.rewardTitle(won), T.rewardHint(won, t.rewards.length), toTitle))

    const cards = el('section', 'draft-cards')
    cards.setAttribute('aria-label', T.rewardCandidates)
    t.rewards.forEach((card, i) => {
      const node = card.kind === 'player' ? playerCard(card.player, chosen === i, firstRender, i) : itemCard(card, chosen === i, firstRender, i)
      node.onclick = () => {
        chosen = chosen === i ? null : i
        render()
      }
      cards.append(node)
    })
    screen.append(cards)

    const target = el('section', 'draft-release')
    const card = chosen === null ? null : t.rewards[chosen]
    const list = el('div', 'draft-release-list')
    if (!card) target.append(el('div', 'draft-release-head', T.pickFirstCard))
    else target.append(...rewardTargets(t, chosen!, card, list, go))
    target.append(list)

    const footer = el('footer', 'draft-footer')
    const skip = el('button', 'btn-outline-light btn-wide', T.skipReward)
    skip.append(kbd('ESC'))
    skip.onclick = () => {
      toast(T.rewardSkipped)
      go(skipReward(t))
    }
    footer.append(skip)
    const side = el('div', 'draft-side')
    side.append(target, footer)
    screen.append(side)
    root.append(screen)
    if (firstRender) void maybeTutorial('draft', TUTORIAL_STEPS.draft)
    firstRender = false

    // Enter 先跳到右邊的名單，在名單上再按 Enter 就選那一位
    setKeys({
      ...cardKeys(t.rewards.length, () => chosen, (i) => ((chosen = i), render())),
      Escape: () => skip.click(),
      Enter: () => {
        const active = document.activeElement
        if (active instanceof HTMLButtonElement && target.contains(active)) active.click()
        else target.querySelector<HTMLButtonElement>('button')?.focus()
      },
    })
  }
  render()
}

/** 選了一張卡之後，右邊要列出的東西 */
function rewardTargets(t: Tournament, index: number, card: RewardCard, list: HTMLElement, go: (t: Tournament) => void): HTMLElement[] {
  const roster = t.setup.team.roster
  const row = (p: Player, label: string, extra: HTMLElement[], note?: HTMLElement) => {
    const r = el('div', 'release-row')
    const who = el('span', 'release-who')
    who.append(el('span', 'release-name', p.name), el('span', 'release-pos', label))
    if (note) who.append(note)
    const grades = el('span', 'release-grades')
    for (const v of Object.values(p.ratings)) grades.append(gradeBadge(v, 'sm'))
    const actions = el('span', 'release-actions')
    actions.append(...extra)
    r.append(avatar(p.id, 'user', 'ring'), who, grades, actions)
    list.append(r)
  }
  const button = (label: string, onClick: () => void) => {
    const b = el('button', 'btn-small', label)
    b.onclick = onClick
    return b
  }

  switch (card.kind) {
    case 'player': {
      const pick = card.player
      for (const [slot, label] of rosterSlots(roster)) {
        const p = getSlot(roster, slot)
        if (p.role !== pick.role) continue
        row(p, label, [
          button(T.replace, () => {
            toast(T.joined(pick.name, p.name))
            go(pickPlayer(t, index, slot))
          }),
        ])
      }
      return [el('div', 'draft-release-head', T.replaceWho(pick.name, pick.role === 'pitcher' ? T.pitcher : T.batter))]
    }
    case 'equipment': {
      const name = EQUIPMENT_NAMES[card.id]
      for (const [slot, label] of rosterSlots(roster)) {
        const p = getSlot(roster, slot)
        if (!canEquip(p, card.id)) continue
        const current = p.equipment ?? []
        const items = current.map((x) => EQUIPMENT_NAMES[x]).join('・')
        const actions =
          current.length < MAX_EQUIPMENT
            ? [
                button(T.equip, () => {
                  toast(T.equipped(name, p.name))
                  go(pickEquipment(t, index, p.id))
                }),
              ]
            : current.map((x, i) =>
                button(T.replaceItem(EQUIPMENT_NAMES[x]), () => {
                  toast(T.equipped(name, p.name))
                  go(pickEquipment(t, index, p.id, i))
                }),
              )
        row(p, items ? `${label}・${items}` : label, actions)
      }
      const stash = el('button', 'btn-white panel-action', T.toBag)
      stash.onclick = () => {
        toast(T.stashed(name))
        go(pickEquipment(t, index, null))
      }
      return [el('div', 'draft-release-head', T.equipWho(name)), stash]
    }
    case 'trait': {
      const name = TRAIT_NAMES[card.id]
      const id = card.id
      // 列出同角色的每一位球員和他已經會的特性；不能學的也列出來，寫明原因
      for (const [slot, label] of rosterSlots(roster)) {
        const p = getSlot(roster, slot)
        if (p.role !== TRAITS[id].role) continue
        const traits = el('span', 'release-traits')
        if (p.traits.length) traits.append(...p.traits.map(traitTag))
        else traits.append(el('span', 'kit-empty', T.noTraits))
        if (canLearnTrait(p, id)) {
          row(p, label, [
            button(T.learn, () => {
              toast(T.learned(p.name, name))
              go(pickTrait(t, index, p.id))
            }),
          ], traits)
        } else {
          const blocked = el('button', 'btn-small', p.traits.includes(id) ? T.traitHas : T.traitFull)
          blocked.disabled = true
          row(p, label, [blocked], traits)
        }
      }
      if (!list.querySelector('button:not(:disabled)')) list.prepend(el('p', 'kit-empty', T.noEligible))
      return [el('div', 'draft-release-head', T.traitWho(name))]
    }
    case 'relic': {
      const take = el('button', 'btn-yellow panel-action', T.relicTake(RELIC_NAMES[card.id]))
      take.onclick = () => {
        toast(T.relicGained(RELIC_NAMES[card.id]))
        go(pickRelic(t, index))
      }
      return [el('div', 'draft-release-head', RELIC_DESC[card.id]), take]
    }
  }
}

/** 球員卡：頭像、能力長條、第一個特性 */
function playerCard(p: Player, selected: boolean, reveal: boolean, i: number): HTMLButtonElement {
  const card = el('button', 'draft-pick')
  card.type = 'button'
  card.setAttribute('aria-pressed', String(selected))
  applyCardState(card, p, { selected, reveal })
  card.style.setProperty('--delay', `${i * 120}ms`)
  const inner = el('span', 'draft-inner')
  const topRow = el('span', 'draft-top')
  topRow.append(el('span', 'tier-tag', T.tierNames[cardTier(p)]), overallBadge(p, 'md'))
  inner.append(topRow, avatar(p.id, 'user', 'draft-avatar'), el('span', 'draft-name', p.name))
  inner.append(el('span', 'draft-role', `${T.rewardKinds.player}・${p.role === 'pitcher' ? T.pitcher : T.batter}`))
  const chips = el('span', 'draft-chips')
  chips.append(handChip(p))
  if (p.role === 'batter') chips.append(tendencyChip(p.tendency, true))
  else chips.append(pitchChip(p, true))
  inner.append(chips)
  const stats = el('span', 'draft-stats')
  Object.entries(p.ratings).forEach(([k, v]) => {
    const row = el('span', 'draft-stat')
    const bar = el('span', 'draft-bar')
    const g = gradeOf(v)
    const fill = el('span', `bar-fill fill-${g}`)
    fill.style.width = `${v * 10}%`
    bar.append(fill)
    // 手機版：短標籤、長條、字母；電腦版：完整標籤、等級徽章、長條
    const key = k as keyof typeof RATING_FULL
    row.append(
      el('span', 'draft-stat-label mobile-only', RATING_LABELS[key]),
      el('span', 'draft-stat-label desk-only', RATING_FULL[key]),
      gradeBadge(v, 'sm'),
      bar,
      el('span', 'draft-stat-grade', g),
    )
    stats.append(row)
  })
  inner.append(stats)
  if (p.traits.length) inner.append(traitTag(p.traits[0]), el('span', 'draft-trait-desc', TRAIT_DESC[p.traits[0]]))
  card.append(inner)
  if (selected) card.append(checkMark())
  return card
}

/** 裝備、秘寶、特性卡：卡色、種類、圖、名稱、效果 */
function itemCard(card: Exclude<RewardCard, { kind: 'player' }>, selected: boolean, reveal: boolean, i: number): HTMLButtonElement {
  const tier = rewardTier(card)
  const node = el('button', `draft-pick item-pick tier-${tier}`)
  node.type = 'button'
  node.setAttribute('aria-pressed', String(selected))
  if (selected) node.classList.add('selected')
  if (reveal) node.classList.add(tier === 'rainbow' ? 'reveal-special' : 'reveal')
  node.style.setProperty('--delay', `${i * 120}ms`)
  const inner = el('span', 'draft-inner')
  const topRow = el('span', 'draft-top')
  topRow.append(el('span', 'tier-tag', T.tierNames[tier]), el('span', 'item-kind', T.rewardKinds[card.kind]))
  const icon = el('span', 'item-icon')
  icon.innerHTML = card.kind === 'equipment' ? GEAR_ICONS[GEAR_OF[card.id]] : KIND_ICONS[card.kind]
  inner.append(topRow, icon)
  if (card.kind === 'equipment') {
    const role = EQUIPMENT[card.id].role === 'pitcher' ? T.pitcher : T.batter
    inner.append(el('span', 'draft-name', EQUIPMENT_NAMES[card.id]), el('span', 'draft-role', role), el('span', 'item-desc', equipmentDesc(card.id)))
  } else if (card.kind === 'relic') {
    inner.append(el('span', 'draft-name', RELIC_NAMES[card.id]), el('span', 'draft-role', T.relicsTitle), el('span', 'item-desc', RELIC_DESC[card.id as RelicId]))
  } else {
    const role = TRAITS[card.id].role === 'pitcher' ? T.pitcher : T.batter
    inner.append(traitTag(card.id), el('span', 'draft-role', role), el('span', 'item-desc', TRAIT_DESC[card.id]))
  }
  node.append(inner)
  if (selected) node.append(checkMark())
  return node
}

function checkMark(): HTMLElement {
  const check = el('span', 'draft-check')
  check.innerHTML = CHECK_ICON
  return check
}

// ---- 結束 ----

export const TROPHY = (size: number, label = '') =>
  `<svg ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'} width="${size}" height="${size}" viewBox="0 0 24 24" fill="#FFD23F" stroke="#141633" stroke-width="1.2" stroke-linejoin="round"><path d="M7 3h10v4a5 5 0 0 1-10 0z"/><path d="M7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4" fill="none" stroke-width="1.4"/><path d="M10 12h4v4h-4z"/><path d="M8 20h8v-2H8z"/></svg>`

/** 彩色紙花，用固定的種子撒，每次一樣 */
function confetti(width: number, height: number, count: number, seed: number): string {
  const colors = ['#FF4F7B', '#FFD23F', '#5FE3A1', '#6FB6FF', '#B57BFF', '#FF8A2A']
  let s = seed
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  let out = ''
  for (let k = 0; k < count; k++) {
    const x = Math.round(rnd() * (width - 10))
    const y = Math.round(rnd() * (height - 20))
    const w = 6 + Math.round(rnd() * 7)
    const h = 10 + Math.round(rnd() * 10)
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colors[k % 6]}" transform="rotate(${Math.round(rnd() * 360)} ${x} ${y})"/>`
  }
  return `<svg class="end-confetti" aria-hidden="true" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin slice">${out}</svg>`
}

const BALL_ICON = `<svg role="img" aria-label="${T.ballLabel}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#D9DCF2" stroke="#141633" stroke-width="3"/><path d="M18 10c8 10 8 34 0 44M46 10c-8 10-8 34 0 44" fill="none" stroke="#8A8FD8" stroke-width="2.5" stroke-dasharray="4 4"/></svg>`

/** 錦標賽結束：奪冠（獎盃、光芒、紙花）或止步某個階段，列出這一輪每一場 */
function showTourEnd(root: HTMLElement, t: Tournament, toTitle: () => void): void {
  const champ = t.phase === 'champion'
  play(champ ? 'champion' : 'lose')
  const screen = el('div', `end-screen ${champ ? 'champ' : 'out'}`)
  if (champ) {
    screen.insertAdjacentHTML('afterbegin', `<svg class="end-rays" aria-hidden="true" viewBox="-700 -700 1400 1400">${rays(700)}</svg>${confetti(1440, 420, 60, 11)}`)
  }
  const inner = el('div', 'end-inner')
  const main = el('div', 'end-main')
  const icon = el('div', 'end-icon')
  icon.innerHTML = champ ? TROPHY(120, T.trophyLabel) : BALL_ICON
  const title = el('h1', 'end-title', champ ? T.champion : T.eliminated(T.roundNames[t.round]))
  const team = el('div', 'end-team')
  team.append(teamTile(t.setup.team.name, 'user'), el('span', 'end-team-name', t.setup.team.name))
  const words = el('p', 'end-words', T.tournamentOver)
  team.append(el('span', `level-tag level-${t.tier}`, T.levelNames[t.tier]))
  const rewards = champ ? championRewards(recordChampion(t)) : null
  const home = el('button', 'btn-yellow btn-big end-home', T.backToTitle)
  home.append(kbd('ENTER'))
  home.onclick = toTitle

  const record = el('section', 'end-record')
  record.setAttribute('aria-label', T.historyTitle)
  record.append(el('h2', 'panel-title desk-only', T.thisRun))
  for (const r of recordRows(t)) {
    const row = el('div', 'end-row')
    row.append(
      el('span', 'end-round', r.round),
      el('span', `record-mark ${r.won ? 'won' : 'lost'}`, r.won ? T.winMark : T.loseMark),
      el('span', 'end-score', r.score),
      el('span', 'end-opponent', r.opponent),
    )
    record.append(row)
  }
  main.append(icon, title, team, ...(rewards ? [rewards] : []), words, home)
  inner.append(main, record)
  screen.append(inner)
  root.replaceChildren(screen)
  setKeys({ Enter: toTitle })
}

/** 奪冠的收穫：解鎖的裝扮、開放的下一級難度（第一次通過這個難度才有） */
function championRewards(trophy: Trophy): HTMLElement | null {
  if (!trophy.unlocked) return null
  const box = el('div', 'end-rewards')
  const face = el('span', 'end-reward-face')
  face.innerHTML = avatarSvg('p-reward-sample', 'user', undefined, trophy.unlocked)
  const lines = el('div', 'end-reward-lines')
  lines.append(el('span', 'end-reward-line', T.unlockOutfit(T.outfitNames[trophy.unlocked])))
  const next = TIERS.find((x) => x === trophy.tier + 1)
  if (next) lines.append(el('span', 'end-reward-line', T.unlockTier(T.levelNames[next])))
  box.append(face, lines)
  return box
}
