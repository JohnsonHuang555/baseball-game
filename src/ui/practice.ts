// 自由練習：只打一場、不記錄結果的沙盒。雙方可以是自製球隊或隨機球隊，自製球隊可以改名字、能力、特性、裝備、球種與秘寶
import { Game } from '../sim/game'
import { BASE_MEAN, allPlayers, generateRoster, teamName } from '../sim/generate'
import { EQUIPMENT, MAX_EQUIPMENT, RELICS, equippedTeam, type EquipmentId, type RelicId } from '../sim/items'
import { PITCH_TRAIT_IDS, PITCH_TYPES, isBreaking, repertoire, type PitchTraitId, type PitchType } from '../sim/pitches'
import { Rng } from '../sim/rng'
import { createSetup, getSlot, setSlot, type PregameSetup } from '../sim/setup'
import { TIERS, TIER_SLOPE, TIER_START, type Tier } from '../sim/tournament'
import { TRAITS, conflicts, type TraitId } from '../sim/traits'
import type { Bats, Batter, Hand, Pitcher, Player, Team, Tendency } from '../sim/types'
import { avatar, avatarSvg } from './avatar'
import { kitChip, rosterSlots } from './cards'
import { customTeams, deleteCustomTeam, saveCustomTeam, type CustomTeam } from './customTeams'
import { showGame } from './gameScreen'
import { gradeBadge } from './grades'
import { growthPanel } from './growthPanel'
import { kbd, setKeys } from './keys'
import { choiceModal, confirmModal, infoModal } from './modal'
import { el, traitTag } from './playerCard'
import { withSavedName } from './prefs'
import { legends, trophies } from './progress'
import { randomSeed, showRosterEditor } from './setupScreen'
import { EQUIPMENT_NAMES, PITCH_TRAIT_NAMES, RATING_FULL, RELIC_DESC, RELIC_NAMES, T } from './strings'
import { toast } from './visual'

const BACK_ICON =
  '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>'

/** 一方要用哪支隊伍：隨機或某支自製球隊 */
type Side = { kind: 'random' } | { kind: 'custom'; id: string }

/** 練習選單的選擇，離開再回來還記得（不存檔） */
let mine: Side = { kind: 'random' }
let theirs: Side = { kind: 'random' }
let level: Tier = 1

/** 隨機對手的強度：該難度錦標賽中段（第 6 場）的對手 */
function opponentMean(tier: Tier): number {
  return BASE_MEAN + TIER_START[tier] + TIER_SLOPE[tier] * 6
}

function header(title: string, hint: string, back: () => void): HTMLElement {
  const head = el('header', 'trophy-header')
  const b = el('button', 'icon-btn')
  b.type = 'button'
  b.innerHTML = BACK_ICON
  b.setAttribute('aria-label', T.backToTitle)
  b.onclick = back
  const titles = el('div', 'trophy-titles')
  titles.append(el('h1', 'trophy-title', title), el('span', 'trophy-best', hint))
  head.append(b, titles)
  return head
}

// ---- 練習選單 ----

export function showPractice(root: HTMLElement, toTitle: () => void): void {
  const redraw = () => showPractice(root, toTitle)
  const teams = customTeams()
  // 自製球隊被刪掉了就回到隨機
  if (mine.kind === 'custom' && !teams.some((x) => x.id === (mine as { id: string }).id)) mine = { kind: 'random' }
  if (theirs.kind === 'custom' && !teams.some((x) => x.id === (theirs as { id: string }).id)) theirs = { kind: 'random' }

  root.replaceChildren()
  const screen = el('div', 'trophy-screen practice-screen')
  screen.append(header(T.freePractice, T.practiceHint, toTitle))

  const option = (label: string, sub: string, selected: boolean, onClick: () => void) => {
    const b = el('button', `practice-option${selected ? ' selected' : ''}`)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(selected))
    b.append(el('b', '', label), el('span', '', sub))
    b.onclick = onClick
    return b
  }
  const sideBox = (title: string, side: Side, set: (s: Side) => void, random: HTMLElement) => {
    const box = el('section', 'practice-side')
    box.append(el('h2', 'opp-title', title), random)
    for (const ct of teams) {
      const picked = side.kind === 'custom' && side.id === ct.id
      box.append(option(ct.team.name, `${allPlayers(ct.team.roster).length} 人・${(ct.team.relics ?? []).length} 個秘寶`, picked, () => {
        set({ kind: 'custom', id: ct.id })
        redraw()
      }))
    }
    return box
  }

  const randomMine = option(T.randomTeam, T.randomTeamSub, mine.kind === 'random', () => {
    mine = { kind: 'random' }
    redraw()
  })
  // 隨機對手：可以選強度
  const randomTheirs = el('div', `practice-option${theirs.kind === 'random' ? ' selected' : ''}`)
  const pickRandom = el('button', 'practice-random', T.randomOpponent)
  pickRandom.type = 'button'
  pickRandom.onclick = () => {
    theirs = { kind: 'random' }
    redraw()
  }
  const levels = el('div', 'practice-levels')
  for (const tier of TIERS) {
    const b = el('button', `level-tag level-${tier}${tier === level ? ' current' : ''}`, T.levelNames[tier])
    b.type = 'button'
    b.setAttribute('aria-pressed', String(tier === level))
    b.onclick = () => {
      level = tier
      theirs = { kind: 'random' }
      redraw()
    }
    levels.append(b)
  }
  randomTheirs.append(pickRandom, el('span', '', T.opponentLevelSub(T.levelNames[level])), levels)

  const sides = el('div', 'practice-sides')
  sides.append(
    sideBox(T.practiceMine, mine, (s) => (mine = s), randomMine),
    sideBox(T.practiceOpponent, theirs, (s) => (theirs = s), randomTheirs),
  )
  const start = el('button', 'btn-yellow btn-big', T.startPractice)
  start.append(kbd('ENTER'))
  start.onclick = () => startPractice(root, toTitle)
  screen.append(sides, start, teamsPanel(root, teams, redraw))
  root.append(screen)
  setKeys({ Enter: () => start.click(), Escape: toTitle })
}

/** 我的球隊：編輯、刪除、新建、從冠軍匯入 */
function teamsPanel(root: HTMLElement, teams: CustomTeam[], redraw: () => void): HTMLElement {
  const box = el('section', 'practice-teams')
  box.append(el('h2', 'opp-title', T.myTeams))
  if (!teams.length) box.append(el('p', 'trophy-best', T.noCustomTeams))
  for (const ct of teams) {
    const row = el('div', 'practice-team')
    const edit = el('button', 'btn-small', T.edit)
    edit.onclick = () => showTeamEditor(root, ct, redraw)
    const del = el('button', 'btn-small btn-white-small', T.remove)
    del.onclick = async () => {
      if (!(await confirmModal({ title: T.remove, message: T.removeConfirm(ct.team.name), confirmLabel: T.remove, danger: true }))) return
      deleteCustomTeam(ct.id)
      toast(T.removed(ct.team.name))
      redraw()
    }
    row.append(el('b', 'practice-team-name', ct.team.name), overallLine(ct.team), edit, del)
    box.append(row)
  }
  const actions = el('div', 'practice-actions')
  const create = el('button', 'btn-white', T.newTeam)
  create.onclick = () => {
    const setup = withSavedName(createSetup(randomSeed()))
    const ct = saveCustomTeam({ ...setup.team, name: teamName(new Rng(randomSeed())) })
    showTeamEditor(root, ct, redraw)
  }
  const importBtn = el('button', 'btn-white', T.importChampion)
  importBtn.onclick = async () => {
    const list = trophies()
    if (!list.length) return toast(T.importNone)
    const trophy = await choiceModal({
      title: T.importWhich,
      options: list.map((t) => ({ value: t, label: t.teamName, sub: `${T.levelNames[t.tier]}・${new Date(t.at).toLocaleDateString('zh-TW')}` })),
    })
    if (!trophy) return
    saveCustomTeam({ name: trophy.teamName, roster: trophy.roster, relics: trophy.recap?.relics ?? [] })
    toast(T.imported(trophy.teamName))
    redraw()
  }
  actions.append(create, importBtn)
  box.append(actions)
  return box
}

function overallLine(team: Team): HTMLElement {
  const players = allPlayers(team.roster)
  const avg = players.reduce((s, p) => s + Object.values(p.ratings).reduce((a, b) => a + b, 0) / Object.values(p.ratings).length, 0) / players.length
  return gradeBadge(avg, 'sm')
}

/** 開打：我方進佈陣畫面（隨機球隊可以重骰），對手照選擇產生；比賽結果不記錄 */
function startPractice(root: HTMLElement, toTitle: () => void): void {
  const teams = customTeams()
  const find = (s: Side) => (s.kind === 'custom' ? teams.find((x) => x.id === s.id)?.team : undefined)
  const myCustom = find(mine)
  let setup: PregameSetup = myCustom
    ? { team: myCustom, teamRerollsLeft: 0, playerRerollsLeft: 0, rngState: randomSeed() }
    : withSavedName(createSetup(randomSeed()))
  let opponent: Team = find(theirs) ?? { name: teamName(new Rng(randomSeed())), roster: generateRoster(new Rng(randomSeed()), opponentMean(level)) }
  const again = () => startPractice(root, toTitle)
  showRosterEditor(root, {
    setup,
    opponent: () => {
      // 兩隊同名時，對手換個名字
      while (opponent.name === setup.team.name) opponent = { ...opponent, name: teamName(new Rng(randomSeed())) }
      return opponent
    },
    heading: T.freePractice,
    allowReroll: !myCustom,
    hint: myCustom ? T.practiceHint : undefined,
    startLabel: T.startGame,
    onChange: (next) => (setup = next),
    onStart: (final) =>
      showGame(root, {
        // 裝備在開賽時加進能力值，跟錦標賽一樣
        game: new Game({ home: equippedTeam(final.team), away: equippedTeam(opponent), seed: randomSeed(), userSide: 'home' }),
        resultLabel: T.practiceResult,
        manualToggle: true,
        resultExtra: (g) => growthPanel(g, g.userSide, null),
        resultActions: () => [
          { label: T.playAgain, primary: true, onClick: again },
          { label: T.freePractice, onClick: () => showPractice(root, toTitle) },
          { label: T.backToTitle, onClick: toTitle },
        ],
      }),
    onBack: () => showPractice(root, toTitle),
  })
}

// ---- 編輯球隊 ----

/** 編輯一支自製球隊；每次修改都自動存檔 */
function showTeamEditor(root: HTMLElement, entry: CustomTeam, back: () => void): void {
  let team = entry.team
  const update = (next: Team) => {
    team = next
    saveCustomTeam(team, entry.id)
    render()
  }

  function render(): void {
    root.replaceChildren()
    const screen = el('div', 'trophy-screen editor-screen')
    screen.append(header(T.editorTitle, T.autosaveHint, back))

    const name = el('input', 'rename-input editor-name')
    name.value = team.name
    name.maxLength = 10
    name.setAttribute('aria-label', T.teamNameLabel)
    name.onchange = () => {
      const v = name.value.trim()
      if (v) update({ ...team, name: v })
    }
    screen.append(name)

    // 秘寶：每一個都列出來，點一下裝上或拿掉
    const relics = el('section', 'editor-section')
    relics.append(el('h2', 'opp-title', `${T.relicsTitle}・${T.relicsHint}`))
    const chips = el('div', 'kit-chips')
    const owned = new Set(team.relics ?? [])
    for (const id of Object.keys(RELICS) as RelicId[]) {
      const chip = kitChip(RELIC_NAMES[id], RELIC_DESC[id], RELICS[id].tier, true)
      chip.classList.toggle('off', !owned.has(id))
      chip.setAttribute('aria-pressed', String(owned.has(id)))
      chip.onclick = () => {
        const next = owned.has(id) ? [...owned].filter((x) => x !== id) : [...owned, id]
        update({ ...team, relics: next })
      }
      chips.append(chip)
    }
    relics.append(chips)
    screen.append(relics)

    // 球員：點一下編輯
    const players = el('section', 'editor-section')
    players.append(el('h2', 'opp-title', T.playerColumn))
    for (const [slot, label] of rosterSlots(team.roster)) {
      const p = getSlot(team.roster, slot)
      const row = el('button', 'editor-player')
      row.type = 'button'
      const who = el('span', 'release-who')
      who.append(el('span', 'release-name', p.name), el('span', 'release-pos', label))
      const tags = el('span', 'release-traits')
      tags.append(...p.traits.map(traitTag))
      for (const id of p.equipment ?? []) tags.append(el('span', 'trait editor-equip', EQUIPMENT_NAMES[id]))
      who.append(tags)
      const grades = el('span', 'release-grades')
      for (const v of Object.values(p.ratings)) grades.append(gradeBadge(v, 'sm'))
      row.append(avatar(p.id, 'user', 'ring'), who, grades)
      row.onclick = () => editPlayer(p, (next) => update({ ...team, roster: setSlot(team.roster, slot, next) }))
      players.append(row)
    }
    screen.append(players)

    const actions = el('div', 'practice-actions')
    const arrange = el('button', 'btn-white', T.arrangeLineup)
    arrange.onclick = () =>
      showRosterEditor(root, {
        setup: { team, teamRerollsLeft: 0, playerRerollsLeft: 0, rngState: 0 },
        heading: T.editorTitle,
        allowReroll: false,
        hint: T.autosaveHint,
        startLabel: T.done,
        onChange: (next) => {
          team = next.team
          saveCustomTeam(team, entry.id)
        },
        onStart: (final) => update(final.team),
        onBack: render,
      })
    const legend = el('button', 'btn-white', T.addLegend)
    legend.onclick = async () => {
      const list = legends()
      if (!list.length) return toast(T.noLegends)
      const pick = await choiceModal({
        title: T.addLegend,
        options: list.map((l) => ({ value: l, label: l.player.name, sub: T.legendFrom(l.teamName, T.levelNames[l.tier]), icon: avatarSvg(l.player.id, 'user') })),
      })
      if (!pick) return
      const slots = rosterSlots(team.roster).filter(([s]) => getSlot(team.roster, s).role === pick.player.role)
      const slot = await choiceModal({
        title: T.legendReplaceWho(pick.player.name),
        options: slots.map(([s, label]) => ({ value: s, label: `${getSlot(team.roster, s).name}（${label}）`, icon: avatarSvg(getSlot(team.roster, s).id, 'user') })),
      })
      if (!slot) return
      toast(T.legendJoined(pick.player.name))
      update({ ...team, roster: setSlot(team.roster, slot, pick.player) })
    }
    actions.append(arrange, legend)
    screen.append(actions)
    root.append(screen)
    setKeys({ Escape: back })
  }
  render()
}

// ---- 編輯球員 ----

const MAX_TRAITS = 3

/** 編輯一位球員：名字、慣用手、擊球方向、能力、特性、裝備；投手另外有新球種與球種特性 */
function editPlayer(original: Player, apply: (p: Player) => void): void {
  const draft = structuredClone(original) as Player
  const form = el('div', 'player-editor')

  const field = (label: string, ...children: HTMLElement[]) => {
    const box = el('div', 'pe-field')
    box.append(el('span', 'pe-label', label), ...children)
    form.append(box)
  }
  /** 一排互斥的按鈕 */
  const segmented = <V extends string>(options: [V, string][], current: V, set: (v: V) => void) => {
    const box = el('div', 'pe-seg')
    for (const [value, label] of options) {
      const b = el('button', 'pe-seg-btn', label)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(value === current))
      b.onclick = () => {
        set(value)
        box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      }
      box.append(b)
    }
    return box
  }

  const name = el('input', 'rename-input')
  name.value = draft.name
  name.maxLength = 10
  name.setAttribute('aria-label', T.playerName)
  name.oninput = () => (draft.name = name.value.trim() || original.name)
  field(T.playerName, name)

  if (draft.role === 'batter') {
    const b = draft as Batter
    field(T.handLabel, segmented<Bats>([['R', T.bats.R], ['L', T.bats.L], ['S', T.bats.S]], b.bats, (v) => (b.bats = v)))
    field(
      T.tendencyLabel,
      segmented<Tendency>([['left', T.tendencyShort.left], ['even', T.tendencyShort.even], ['right', T.tendencyShort.right]], b.tendency, (v) => (b.tendency = v)),
    )
  } else {
    const p = draft as Pitcher
    field(T.handLabel, segmented<Hand>([['R', T.throws.R], ['L', T.throws.L]], p.throws, (v) => (p.throws = v)))
  }

  // 能力：1～10，每格 0.5，旁邊即時顯示字母等級
  const ratings = el('div', 'pe-ratings')
  const values = draft.ratings as unknown as Record<string, number>
  for (const key of Object.keys(values)) {
    const row = el('label', 'pe-rating')
    const input = el('input', 'pe-range')
    input.type = 'range'
    input.min = '1'
    input.max = '10'
    input.step = '0.5'
    input.value = String(values[key])
    const badge = el('span', 'pe-badge')
    const num = el('span', 'pe-num', values[key].toFixed(1))
    badge.append(gradeBadge(values[key], 'sm'))
    input.oninput = () => {
      values[key] = Number(input.value)
      num.textContent = values[key].toFixed(1)
      badge.replaceChildren(gradeBadge(values[key], 'sm'))
    }
    row.append(el('span', 'pe-rating-label', RATING_FULL[key as keyof typeof RATING_FULL]), input, num, badge)
    ratings.append(row)
  }
  field(T.ratingsLabel, ratings)

  // 特性：同角色的全部特性，選了會取代互斥的，最多 3 個
  const traitBox = el('div', 'pe-chips')
  const renderTraits = () => {
    traitBox.replaceChildren()
    for (const id of Object.keys(TRAITS) as TraitId[]) {
      if (TRAITS[id].role !== draft.role) continue
      const on = draft.traits.includes(id)
      const chip = traitTag(id)
      const b = el('button', `pe-trait${on ? ' on' : ''}`)
      b.type = 'button'
      b.setAttribute('aria-pressed', String(on))
      b.append(chip)
      const remaining = draft.traits.filter((x) => !conflicts(x, id))
      b.disabled = !on && remaining.length >= MAX_TRAITS
      b.onclick = () => {
        draft.traits = on ? draft.traits.filter((x) => x !== id) : [...remaining, id]
        renderTraits()
      }
      traitBox.append(b)
    }
  }
  renderTraits()
  field(T.traitsLabel, traitBox)

  // 裝備：兩格，可以留空
  const equipBox = el('div', 'pe-equips')
  const pool = (Object.keys(EQUIPMENT) as EquipmentId[]).filter((id) => EQUIPMENT[id].role === draft.role)
  const slots: (EquipmentId | '')[] = [...(draft.equipment ?? []), '' as const, '' as const].slice(0, MAX_EQUIPMENT)
  slots.forEach((current, i) => {
    const select = el('select', 'pe-select')
    select.setAttribute('aria-label', `${T.equipLabel} ${i + 1}`)
    select.append(new Option(T.noneOption, ''))
    for (const id of pool) select.append(new Option(EQUIPMENT_NAMES[id], id, false, id === current))
    select.onchange = () => {
      slots[i] = select.value as EquipmentId | ''
      draft.equipment = slots.filter((x): x is EquipmentId => !!x)
    }
    equipBox.append(select)
  })
  field(T.equipLabel, equipBox)

  if (draft.role === 'pitcher') {
    const p = draft as Pitcher
    const base = repertoire({ ...p, extraPitches: [] })
    // 新球種：原本不會的變化球
    const extraBox = el('div', 'pe-chips')
    const traitsBox = el('div', 'pe-ratings')
    const renderPitches = () => {
      extraBox.replaceChildren()
      for (const pitch of PITCH_TYPES.filter((x) => isBreaking(x) && !base.includes(x))) {
        const on = p.extraPitches?.includes(pitch) ?? false
        const b = el('button', `pe-seg-btn${on ? ' on' : ''}`, T.pitchNames[pitch])
        b.type = 'button'
        b.setAttribute('aria-pressed', String(on))
        b.onclick = () => {
          p.extraPitches = on ? (p.extraPitches ?? []).filter((x) => x !== pitch) : [...(p.extraPitches ?? []), pitch]
          // 拿掉的球種，特性也一起拿掉
          if (on && p.pitchTraits) delete p.pitchTraits[pitch]
          renderPitches()
        }
        extraBox.append(b)
      }
      // 球種特性：目前會的每個球種一格
      traitsBox.replaceChildren()
      for (const pitch of repertoire(p)) {
        const row = el('label', 'pe-rating')
        const select = el('select', 'pe-select')
        select.append(new Option(T.noneOption, ''))
        for (const id of PITCH_TRAIT_IDS) select.append(new Option(T.pitchTraitName(PITCH_TRAIT_NAMES[id], T.pitchNames[pitch]), id, false, p.pitchTraits?.[pitch] === id))
        select.onchange = () => {
          const next = { ...p.pitchTraits }
          if (select.value) next[pitch] = select.value as PitchTraitId
          else delete next[pitch]
          p.pitchTraits = next
        }
        row.append(el('span', 'pe-rating-label', T.pitchNames[pitch as PitchType]), select)
        traitsBox.append(row)
      }
    }
    renderPitches()
    field(T.newPitchesLabel, extraBox)
    field(T.pitchTraitsLabel, traitsBox)
  }

  const applyBtn = el('button', 'btn-yellow', T.savePlayer)
  applyBtn.type = 'button'
  form.append(applyBtn)
  const close = infoModal(T.editPlayer(original.name), form, true)
  applyBtn.onclick = () => {
    close()
    apply(draft)
  }
}

