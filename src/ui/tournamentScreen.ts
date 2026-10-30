import { replay } from '../sim/game'
import { allPlayers, teamAverage } from '../sim/generate'
import { gameGrowth } from '../sim/growth'
import { EQUIPMENT, MAX_EQUIPMENT, RELICS } from '../sim/items'
import { gameFunds, releaseValue } from '../sim/prices'
import { repertoire } from '../sim/pitches'
import { statOf } from '../sim/potential'
import { getSlot } from '../sim/setup'
import {
  FINAL_WINS_NEEDED,
  MAX_SEASON_LOSSES,
  PLAYOFF_ROUNDS,
  SEASON_GAMES,
  TIERS,
  WINS_TO_ADVANCE,
  beginGame,
  canEquip,
  canLearnPitch,
  canLearnPitchTrait,
  canLearnTrait,
  chooseStartingRelic,
  equipFromBag,
  finishGame,
  pickEquipment,
  pickNewPitch,
  pickPitchTrait,
  pickPlayer,
  pickRelic,
  pickTrait,
  playoffSeed,
  relicsOf,
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
import type { Player, Team } from '../sim/types'
import { induct, recordChampion, recordRun, type Trophy } from './progress'
import { showRecap } from './clubHistory'
import { avatar, avatarSvg } from './avatar'
import { TROPHY, backButton, cardKeys, chooseWearer, itemCard, kitChip, pickHeader, playerCard, rosterSlots } from './cards'
import { showGame } from './gameScreen'
import { growthPanel } from './growthPanel'
import { showEvent, showRest, showShop, showTraining } from './restScreen'
import { gradeBadge, overallBadge } from './grades'
import { kbd, setKeys } from './keys'
import { el, potentialTag, traitTag } from './playerCard'
import { pitchChip, sideTag, toast } from './visual'
import { clearTournament, saveTournament } from './save'
import { play } from './sound'
import { maybeTutorial } from './tutorial'
import { TUTORIAL_STEPS } from './tutorialSteps'
import { rays, showOpponentRoster, showRosterEditor } from './setupScreen'
import { CAPTAIN_TITLES, EQUIPMENT_NAMES, PITCH_TRAIT_NAMES, RELIC_DESC, RELIC_NAMES, T, TRAIT_NAMES, equipmentDesc } from './strings'
import { captainIcon, relicPreview, synergyBadges, synergyCountText, synergyScouting } from './synergyUi'
import { synergyRelicSvg } from './synergyIcons'
import { addGainLine, replaceList } from './replaceList'
import { captainIn } from '../sim/synergy'

/** 依錦標賽目前的階段，打開對應的畫面。每次狀態改變都會存檔 */
export function openTournament(root: HTMLElement, t: Tournament, toTitle: () => void): void {
  const go = (next: Tournament) => openTournament(root, next, toTitle)
  if (t.phase === 'champion' || t.phase === 'eliminated') clearTournament()
  else saveTournament(t)
  // 奪冠：放進獎盃櫃（同一屆只記一次），第一次通過這個難度會解鎖裝扮
  if (t.phase === 'champion') recordChampion(t)
  // 不論奪冠或淘汰，這一輪都記進球團史的歷程
  if (t.phase === 'champion' || t.phase === 'eliminated') recordRun(t)

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
    case 'rest':
      return showRest(root, t, go, toTitle)
    case 'shop':
      return showShop(root, t, go, toTitle)
    case 'training':
      return showTraining(root, t, go, toTitle)
    case 'event':
      return showEvent(root, t, go, toTitle)
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
    // 結果畫面：成長名單、這場覺醒的球員、賺到的球團資金；按繼續時才套用到陣容
    resultExtra: (g) => {
      const box = growthPanel(g, 'home', growth())
      for (const p of allPlayers(t.setup.team.roster)) {
        const pot = p.potential
        if (pot && pot.progress + statOf(g.box[p.id], pot.stat) >= pot.need) box.append(el('p', 'growth-awaken', T.awakened(p.name, TRAIT_NAMES[pot.trait])))
      }
      box.append(el('p', 'growth-funds', T.fundsEarned(gameFunds(g.winner === 'home', g.score.home))))
      return box
    },
    resultActions: (g) => [{ label: T.continue, primary: true, onClick: () => go(finishGame(t, g.score, growth(), g.box)) }],
  })
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

// ---- 錦標賽主畫面 ----

/** 錦標賽主畫面：例行賽與季後賽的進度、秘技與裝備、下一個對手 */
function showHub(root: HTMLElement, t: Tournament, go: (t: Tournament) => void, toTitle: () => void): void {
  root.replaceChildren()
  const screen = el('div', 'hub-screen')

  const header = el('header', 'hub-header')
  const titles = el('div', 'team-titles')
  const eyebrow = el('span', 'eyebrow-light', t.setup.team.name)
  eyebrow.append(el('span', `level-tag level-${t.tier}`, T.levelNames[t.tier]))
  eyebrow.append(el('span', 'funds-chip', T.funds(t.funds)))
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
      // 點球員可以從背包裝上、卸下裝備；名單隨後由 onChange 同步回錦標賽
      gear: {
        bag: () => t.bag,
        equip: (playerId, bagIndex, replace) => {
          t = equipFromBag(t, bagIndex, playerId, replace)
          saveTournament(t)
          return t.setup.team.roster
        },
        unequip: (playerId, index) => {
          t = unequip(t, playerId, index)
          saveTournament(t)
          return t.setup.team.roster
        },
      },
      onChange: (setup) => {
        t = updateLineup(t, setup)
        saveTournament(t)
      },
      onStart: (setup) => go(beginGame(updateLineup(t, setup))),
      onBack: () => go(t),
    })
  bottom.append(vs, opponentScout(t.opponent), next)
  screen.append(bottom)
  root.append(screen)
  void maybeTutorial('hub', TUTORIAL_STEPS.hub)
}

/** 下一個對手的羈絆與隊長、一句話描述他們的打法，加上「看對手陣容」（AI 沒有秘技） */
function opponentScout(opponent: Team): HTMLElement {
  const { lineup, captain } = opponent.roster
  const box = el('div', 'hub-scout')
  const line = el('div', 'hub-scout-line')
  line.append(el('span', 'hub-scout-label', T.opponentSynergies), synergyBadges(lineup, captain, [], { full: true }))
  const cap = lineup.find((s) => s.player.id === captainIn(lineup, captain))?.player
  if (cap) {
    const tag = el('span', 'hub-scout-captain')
    tag.append(captainIcon(16), `${CAPTAIN_TITLES[cap.archetype]} ${cap.name}`)
    line.append(tag)
  }
  box.append(line)
  const scouting = synergyScouting(lineup, captain, [])
  if (scouting) box.append(el('p', 'hub-scout-text', scouting))
  const view = el('button', 'btn-white hub-scout-btn', T.viewOpponent)
  view.type = 'button'
  view.onclick = () => showOpponentRoster(opponent)
  box.append(view)
  return box
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

/** 秘技、身上的裝備、背包；點背包裡的裝備裝上，點身上的裝備卸下 */
function kitPanel(t: Tournament, go: (t: Tournament) => void): HTMLElement {
  const panel = el('section', 'hub-panel kit-panel')
  panel.setAttribute('aria-label', `${T.relicsTitle}・${T.bagTitle}`)

  const relicHead = el('div', 'panel-head')
  relicHead.append(el('h2', 'panel-title', T.relicsTitle), el('span', 'panel-count', T.relicCount(relicsOf(t).length)))
  panel.append(relicHead)
  const relics = el('div', 'kit-chips')
  for (const id of relicsOf(t)) {
    const chip = kitChip(RELIC_NAMES[id], RELIC_DESC[id], RELICS[id].tier)
    // 羈絆秘技在名稱前面加旗子圖示
    const gem = synergyRelicSvg(id, 18)
    if (gem) chip.querySelector('.kit-chip-name')?.insertAdjacentHTML('afterbegin', gem)
    relics.append(chip)
  }
  panel.append(relics)

  // 我方羈絆：已啟動的加上最接近啟動的一個
  const roster = t.setup.team.roster
  const synergies = el('div', 'hub-synergies')
  const synHead = el('div', 'panel-head')
  synHead.append(el('h2', 'panel-title', T.mySynergies), el('span', 'panel-count', synergyCountText(roster.lineup, roster.captain, relicsOf(t))))
  synergies.append(synHead, synergyBadges(roster.lineup, roster.captain, relicsOf(t), { full: true, near: true }))
  panel.append(synergies)
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
      if (!target?.player) return
      toast(T.equipped(EQUIPMENT_NAMES[id], target.player.name))
      go(equipFromBag(t, i, target.player.id, target.replace))
    }
    bag.append(chip)
  })
  panel.append(bag)
  if (wearers.length || t.bag.length) panel.append(el('p', 'kit-hint', T.equipHint))
  return panel
}

// ---- 起始秘技 ----

/** 開打後第一件事：三個秘技選一個 */
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
      // 羈絆秘技：卡片底下寫拿了以後你的隊伍會怎樣
      const preview = relicPreview(id, t.setup.team.roster, relicsOf(t))
      if (preview) card.querySelector('.draft-inner')?.append(preview)
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
      // 球員卡：換掉最適合的人時最好的羈絆結果；羈絆秘技：拿了以後你的隊伍會怎樣
      if (card.kind === 'player') addGainLine(node, t.setup.team.roster, card.player, relicsOf(t))
      if (card.kind === 'relic') {
        const preview = relicPreview(card.id, t.setup.team.roster, relicsOf(t))
        if (preview) node.querySelector('.draft-inner')?.append(preview)
      }
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
      // 簡化版「要換掉誰」：推薦 3 人、能力淨變化、羈絆變化，其他人收起來
      const pick = card.player
      list.append(
        replaceList(roster, pick, relicsOf(t), rosterSlots(roster), (slot, out) => {
          toast(`${T.joined(pick.name, out.name)}・${T.fundsEarned(releaseValue(out))}`)
          go(pickPlayer(t, index, slot))
        }),
      )
      return []
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
        const pot = potentialTag(p)
        if (pot) traits.append(pot)
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
    case 'pitchTrait':
    case 'newPitch': {
      // 列出每位投手會的球種，不能學的寫明原因
      const name =
        card.kind === 'pitchTrait' ? T.pitchTraitName(PITCH_TRAIT_NAMES[card.id], T.pitchNames[card.pitch]) : T.pitchNames[card.pitch]
      for (const [slot, label] of rosterSlots(roster)) {
        const p = getSlot(roster, slot)
        if (p.role !== 'pitcher') continue
        const pitches = el('span', 'release-traits')
        pitches.append(pitchChip(p, true))
        const ok = card.kind === 'pitchTrait' ? canLearnPitchTrait(p, card.pitch) : canLearnPitch(p, card.pitch)
        if (ok) {
          row(p, label, [
            button(T.learn, () => {
              toast(T.pitchLearned(p.name, name))
              go(card.kind === 'pitchTrait' ? pickPitchTrait(t, index, p.id) : pickNewPitch(t, index, p.id))
            }),
          ], pitches)
        } else {
          const reason =
            card.kind === 'newPitch' ? T.pitchHas : repertoire(p).includes(card.pitch) ? T.pitchTraitTaken : T.pitchMissing
          const blocked = el('button', 'btn-small', reason)
          blocked.disabled = true
          row(p, label, [blocked], pitches)
        }
      }
      if (!list.querySelector('button:not(:disabled)')) list.prepend(el('p', 'kit-empty', T.noPitcherEligible))
      return [el('div', 'draft-release-head', T.pitchWho(name))]
    }
  }
}

// ---- 結束 ----


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
  const trophy = champ ? recordChampion(t) : null
  const rewards = trophy ? championRewards(trophy) : null
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
  main.append(icon, title, team, ...(rewards ? [rewards] : []))
  if (trophy) {
    const recap = el('button', 'btn-white end-recap', T.recapOpen)
    recap.onclick = () => showRecap(trophy)
    main.append(legendPanel(t, trophy), recap)
  }
  main.append(words, home)
  inner.append(main, record)
  screen.append(inner)
  root.replaceChildren(screen)
  setKeys({ Enter: toTitle })
}

/** 奪冠後挑一位球員送進傳奇館；選過之後換成一句「某某 進入傳奇館」 */
function legendPanel(t: Tournament, trophy: Trophy): HTMLElement {
  const box = el('section', 'end-legend')
  const players = allPlayers(t.setup.team.roster)
  const render = (chosenId: string | undefined) => {
    box.replaceChildren(el('h2', 'end-legend-title', T.legendInductTitle))
    const chosen = players.find((p) => p.id === chosenId)
    if (chosen) {
      box.append(el('p', 'end-legend-done', T.inducted(chosen.name)))
      return
    }
    box.append(el('p', 'end-legend-hint', T.legendInductHint))
    const grid = el('div', 'end-legend-grid')
    for (const p of players) {
      const b = el('button', 'end-legend-pick')
      b.type = 'button'
      b.title = p.name
      b.append(avatar(p.id, 'user', 'ring'), el('span', 'end-legend-name', p.name), overallBadge(p, 'sm'))
      b.onclick = () => {
        if (!induct(trophy.key, p)) return
        toast(T.inducted(p.name))
        render(p.id)
      }
      grid.append(b)
    }
    box.append(grid)
  }
  render(trophy.legendId)
  return box
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
