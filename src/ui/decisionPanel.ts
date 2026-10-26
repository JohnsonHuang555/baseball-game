// 決策面板：標題緞帶、局勢條、打者對投手、重點調度、其他指令格、詳細資訊
import { ALIGNMENTS, sameTactic, type Alignment, type Game, type Side, type Tactic } from '../sim/game'
import type { Batter, Player } from '../sim/types'
import { avatar, type AvatarTeam } from './avatar'
import { gradeBadge } from './grades'
import { kbd, setKeys, type KeyMap } from './keys'
import { zoneWidthLabel } from './meter'
import { el } from './playerCard'
import { POSITION_FULL, RATING_FULL, T, runnersText } from './strings'
import { handChip, tendencyChip } from './visual'

export type SheetReason = 'leverage' | 'fatigue' | 'pause'

/** 面板上可以切換的狀態，重畫時保留 */
export interface PanelState {
  showOthers: boolean
  showDetails: boolean
  /** 在其他指令格裡點了某類指令，正在選人 */
  picking: Tactic['type'] | null
}

export interface PanelHandlers {
  choose(t: Tactic): void
  /** 親自出手：打開計量條 */
  takeOver(kind: 'swing' | 'aimPitch'): void
  handOver(): void
  rerender(): void
}

const RIBBONS: Record<SheetReason, { title: string; className: string; icon: string }> = {
  leverage: {
    title: T.reasonLeverage,
    className: 'ribbon-alert',
    icon: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v6"/><path d="M12 17h.01"/></svg>',
  },
  fatigue: {
    title: T.reasonFatigue,
    className: 'ribbon-fatigue',
    icon: '<svg aria-hidden="true" width="24" height="22" viewBox="0 0 26 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><rect x="2" y="6" width="19" height="12" rx="2.5"/><path d="M24 10v4"/><rect x="5" y="9" width="4" height="6" fill="currentColor" stroke="none"/></svg>',
  },
  pause: {
    title: T.reasonPause,
    className: 'ribbon-pause',
    icon: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1.5"/><rect x="14" y="4" width="5" height="16" rx="1.5"/></svg>',
  },
}

const CHEVRON_RIGHT =
  '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>'
const CHEVRON_DOWN =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
const CLIPBOARD =
  '<svg aria-hidden="true" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11h6M9 15h4"/></svg>'

/** 進攻與防守各自能用的指令類型，依常用程度排列 */
const OFFENSE_TYPES: Tactic['type'][] = ['steal', 'bunt', 'hitAndRun', 'pinchHit', 'pinchRun']
const DEFENSE_TYPES: Tactic['type'][] = ['changePitcher', 'intentionalWalk', 'defensiveSub']

const BASE_NAMES = ['一', '二', '三']

/** 親自出手卡的圖示：球棒或棒球 */
const TAKEOVER_ICONS = {
  swing:
    '<svg aria-hidden="true" width="34" height="34" viewBox="0 0 32 32"><path d="M6 27 L24 6 Q27 3 29 5 Q31 7 28 10 L9 29 Z" fill="#E3A867" stroke="#141633" stroke-width="2.2" stroke-linejoin="round"/><circle cx="6" cy="28" r="2.6" fill="#141633"/></svg>',
  aimPitch:
    '<svg aria-hidden="true" width="34" height="34" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12.5" fill="#fff" stroke="#141633" stroke-width="2.4"/><path d="M9 6c4 5 4 15 0 20M23 6c-4 5-4 15 0 20" fill="none" stroke="#E5383B" stroke-width="2" stroke-dasharray="3 2.5"/></svg>',
}

/** 一張選項卡要顯示的內容 */
interface OptionCard {
  tactic: Tactic
  tag: string
  sub: string
  main: string
  who: Player
  team: AvatarTeam
  diffs: HTMLElement[]
}

/** 畫出面板，並把面板的快捷鍵換上去（1～3 選項、O 其他指令、I 詳細資訊、Esc 收起、Space 交給球員） */
export function renderDecisionPanel(game: Game, reason: SheetReason, state: PanelState, h: PanelHandlers): HTMLElement {
  const keys: KeyMap = { Space: h.handOver }
  setKeys(keys)
  const userSide = game.userSide
  const teamOf = (side: Side): AvatarTeam => (side === userSide ? 'user' : 'opponent')
  const tactics = game.over ? [] : game.availableTactics()
  const has = (t: Tactic) => tactics.some((x) => sameTactic(x, t))
  const battingValue = (b: Batter) => (b.ratings.contact * 2 + b.ratings.power) / 3

  // ---- 小元件 ----

  /** 對比：舊字母 → 新字母 */
  function compare(label: string, from: number, to: number): HTMLElement {
    const c = el('span', 'diff')
    c.append(el('span', 'diff-label', label), gradeBadge(from, 'sm'), el('span', 'diff-arrow', '→'), gradeBadge(to, 'sm'))
    return c
  }

  function textDiff(label: string, ...parts: (string | HTMLElement)[]): HTMLElement {
    const c = el('span', 'diff')
    c.append(el('span', 'diff-label', label))
    for (const p of parts) c.append(typeof p === 'string' ? el('span', 'diff-text', p) : p)
    return c
  }

  function staminaPct(): number {
    return Math.round(game.staminaLeft(game.fielding) * 100)
  }

  // ---- 每種指令的選項卡 ----

  function optionFor(t: Tactic): OptionCard {
    const batTeam = game.batting
    const fieldTeam = game.fielding
    switch (t.type) {
      case 'pinchHit': {
        const p = batTeam.bench[t.benchIndex]
        const out = game.batter
        return {
          tactic: t, tag: T.tagPinchHit, sub: T.replaces(out.name), main: p.name, who: p, team: teamOf(game.battingSide),
          diffs: [
            compare(RATING_FULL.contact, out.ratings.contact, p.ratings.contact),
            compare(RATING_FULL.power, out.ratings.power, p.ratings.power),
            ...(out.tendency !== p.tendency ? [textDiff(T.tendencyLabel, tendencyChip(out.tendency), el('span', 'diff-arrow', '→'), tendencyChip(p.tendency))] : []),
            ...(game.platoonOn && game.matchup(out) !== game.matchup(p)
              ? [textDiff(T.matchupLabel, handChip(out, game.matchup(out)), el('span', 'diff-arrow', '→'), handChip(p, game.matchup(p)))]
              : []),
          ],
        }
      }
      case 'pinchRun': {
        const p = batTeam.bench[t.benchIndex]
        const runner = game.bases[t.base - 1]!
        return {
          tactic: t, tag: T.tagPinchRun, sub: T.runnerOut(BASE_NAMES[t.base - 1], runner.name), main: p.name, who: p, team: teamOf(game.battingSide),
          diffs: [compare(RATING_FULL.speed, runner.ratings.speed, p.ratings.speed)],
        }
      }
      case 'steal': {
        const runner = game.bases[t.from - 1]!
        return {
          tactic: t, tag: T.tagSteal, sub: T.stealTarget(BASE_NAMES[t.from]), main: runner.name, who: runner, team: teamOf(game.battingSide),
          diffs: [textDiff(RATING_FULL.speed, gradeBadge(runner.ratings.speed, 'sm')), textDiff(T.successRate, `${Math.round(game.stealChance(t.from) * 100)}%`)],
        }
      }
      case 'bunt': {
        const b = game.batter
        return {
          tactic: t, tag: T.tagBunt, sub: T.batterIs, main: b.name, who: b, team: teamOf(game.battingSide),
          diffs: [textDiff(RATING_FULL.contact, gradeBadge(b.ratings.contact, 'sm')), textDiff(T.successRate, `${Math.round(game.buntChance() * 100)}%`)],
        }
      }
      case 'hitAndRun': {
        const runner = game.bases[0]!
        return {
          tactic: t, tag: T.tagHitAndRun, sub: T.hitAndRunSub, main: runner.name, who: runner, team: teamOf(game.battingSide),
          diffs: [textDiff(RATING_FULL.speed, gradeBadge(runner.ratings.speed, 'sm')), textDiff(T.batter, gradeBadge(game.batter.ratings.contact, 'sm'))],
        }
      }
      case 'changePitcher': {
        const p = fieldTeam.relievers[t.relieverIndex]
        const pct = el('span', `pct ${staminaPct() < 25 ? 'low' : ''}`, `${staminaPct()}%`)
        return {
          tactic: t, tag: T.tagPitcher, sub: T.replaces(game.pitcher.name), main: p.name, who: p, team: teamOf(game.fieldingSide),
          diffs: [
            textDiff(T.stamina, pct, el('span', 'diff-arrow', '→'), el('span', 'pct', '100%')),
            textDiff(`${RATING_FULL.stuff}/${RATING_FULL.control}`, gradeBadge(p.ratings.stuff, 'sm'), gradeBadge(p.ratings.control, 'sm')),
            // 對目前打者：換成同手的投手就變成同側，打者不利
            ...(game.platoonOn
              ? [textDiff(T.matchupLabel, handChip(game.pitcher, game.matchup(game.batter, game.pitcher)), el('span', 'diff-arrow', '→'), handChip(p, game.matchup(game.batter, p)))]
              : []),
          ],
        }
      }
      case 'intentionalWalk': {
        const b = game.batter
        const next = game.batting.lineup[(game.batting.battingIndex + 1) % 9].player
        const c = el('span', 'diff')
        c.append(
          el('span', 'diff-label', T.batter), gradeBadge(battingValue(b), 'sm'),
          el('span', 'diff-arrow', '→'),
          el('span', 'diff-label', T.onDeck), gradeBadge(battingValue(next), 'sm'),
        )
        return { tactic: t, tag: T.tagWalk, sub: T.walkSub, main: b.name, who: b, team: teamOf(game.battingSide), diffs: [c] }
      }
      case 'alignment': {
        const b = game.batter
        const pct = Math.round(game.alignmentEffect(t.alignment) * 100)
        return {
          tactic: t, tag: T.tagAlignment, sub: T.alignmentSub(T.tendencyNames[b.tendency]), main: T.alignmentNames[t.alignment], who: b, team: teamOf(game.battingSide),
          diffs: [textDiff(T.alignmentTitle, el('span', `pct ${pct < 0 ? 'good' : pct > 0 ? 'low' : ''}`, T.hitChange(pct)))],
        }
      }
      case 'swing':
      case 'aimPitch':
        throw new Error('親自出手不用選項卡')
      case 'defensiveSub': {
        const spot = fieldTeam.lineup[t.lineupIndex]
        const p = fieldTeam.bench[t.benchIndex]
        return {
          tactic: t, tag: T.tagDefense, sub: T.runnerOut(POSITION_FULL[spot.position], spot.player.name), main: p.name, who: p, team: teamOf(game.fieldingSide),
          diffs: [compare(RATING_FULL.fielding, spot.player.ratings.fielding, p.ratings.fielding), compare(RATING_FULL.contact, spot.player.ratings.contact, p.ratings.contact)],
        }
      }
    }
  }

  /** 守備替補的組合很多，只留下守備有變好的，依提升幅度排序 */
  function defensiveSubs() {
    const team = game.fielding
    return tactics
      .flatMap((t) => (t.type === 'defensiveSub' ? [t] : []))
      .map((t) => ({ tactic: t, gain: team.bench[t.benchIndex].ratings.fielding - team.lineup[t.lineupIndex].player.ratings.fielding }))
      .filter((d) => d.gain > 0)
      .sort((a, b) => b.gain - a.gain)
  }

  /** 這個時刻最有意義的兩三個調度（不標示推薦，只給對比，判斷留給教練） */
  function keyTactics(): Tactic[] {
    const picks: Tactic[] = []
    if (game.battingSide === userSide) {
      const team = game.batting
      const batter = game.batter
      // 代打：板凳裡打擊最好的人，明顯比現任打者強才提
      const bestHit = team.bench.map((p, i) => ({ p, i })).sort((a, b) => battingValue(b.p) - battingValue(a.p))[0]
      if (bestHit && battingValue(bestHit.p) - battingValue(batter) >= 1) picks.push({ type: 'pinchHit', benchIndex: bestHit.i })
      // 左右相剋：同側對決時，板凳有對側、打擊不輸太多的人就建議代打
      if (game.platoonOn && game.matchup() === 'same' && !picks.some((t) => t.type === 'pinchHit')) {
        const platoonBat = team.bench
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => game.matchup(p) === 'opposite' && battingValue(p) >= battingValue(batter) - 0.5)
          .sort((a, b) => battingValue(b.p) - battingValue(a.p))[0]
        if (platoonBat) picks.push({ type: 'pinchHit', benchIndex: platoonBat.i })
      }
      // 盜壘：成功率夠高才提
      for (const from of [2, 1] as const) {
        if (game.bases[from - 1] && has({ type: 'steal', from }) && game.stealChance(from) >= 0.6) picks.push({ type: 'steal', from })
      }
      // 代跑：得點圈的慢腳跑者，換成板凳最快的人
      for (const base of [3, 2] as const) {
        const runner = game.bases[base - 1]
        const fastest = team.bench.map((p, i) => ({ p, i })).sort((a, b) => b.p.ratings.speed - a.p.ratings.speed)[0]
        if (runner && fastest && fastest.p.ratings.speed - runner.ratings.speed >= 2) {
          picks.push({ type: 'pinchRun', base, benchIndex: fastest.i })
          break
        }
      }
      // 觸擊：無人出局、打者打擊弱，把跑者送上得點圈；對手偏移佈陣時觸擊成功率提高，也值得考慮
      const shiftedAgainst = (game.alignment === 'shiftLeft' || game.alignment === 'shiftRight') && game.alignmentEffect() < 0
      if (has({ type: 'bunt' }) && !game.bases[2] && ((game.outs === 0 && batter.ratings.contact <= 5) || shiftedAgainst)) picks.push({ type: 'bunt' })
    } else {
      const team = game.fielding
      // 換投：體力快見底時，提球威加控球最好的後援
      const best = team.relievers.map((p, i) => ({ p, i })).sort((a, b) => b.p.ratings.stuff + b.p.ratings.control - (a.p.ratings.stuff + a.p.ratings.control))[0]
      if (best && game.staminaLeft(team) < 0.25) picks.push({ type: 'changePitcher', relieverIndex: best.i })
      // 左右相剋：後段對方打者是對側，後援有同手、能力不差的人就建議換投（例如左投對左打）
      if (game.platoonOn && game.inning >= 7 && game.matchup() === 'opposite' && !picks.some((t) => t.type === 'changePitcher')) {
        const now = game.pitcher.ratings.stuff + game.pitcher.ratings.control
        const specialist = team.relievers
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => game.matchup(game.batter, p) === 'same' && p.ratings.stuff + p.ratings.control >= now - 1)
          .sort((a, b) => b.p.ratings.stuff + b.p.ratings.control - (a.p.ratings.stuff + a.p.ratings.control))[0]
        if (specialist) picks.push({ type: 'changePitcher', relieverIndex: specialist.i })
      }
      // 故意四壞：一壘空著、強打者後面接弱打者
      const next = game.batting.lineup[(game.batting.battingIndex + 1) % 9].player
      if (has({ type: 'intentionalWalk' }) && !game.bases[0] && battingValue(game.batter) >= 6.5 && battingValue(game.batter) - battingValue(next) >= 2) {
        picks.push({ type: 'intentionalWalk' })
      }
      // 守備替補：後段領先或平手時守住比分，板凳有守備明顯更好的人才提
      // 佈陣：打者有明顯的擊球方向就建議往那邊移；後段比分接近、三壘有人時建議內野前進
      const toward: Alignment | null = game.batter.tendency === 'left' ? 'shiftLeft' : game.batter.tendency === 'right' ? 'shiftRight' : null
      if (toward && game.alignment === 'normal') picks.push({ type: 'alignment', alignment: toward })
      const close = Math.abs(game.score.home - game.score.away) <= 1
      if (game.bases[2] && game.outs < 2 && game.inning >= 7 && close && game.alignment === 'normal') picks.push({ type: 'alignment', alignment: 'infieldIn' })
      const ahead = game.score[userSide] >= game.score[game.battingSide]
      const top = defensiveSubs()[0]
      if (game.inning >= 7 && ahead && top && top.gain >= 3) picks.push(top.tactic)
    }
    return picks.filter(has).slice(0, 3)
  }

  /** 選項卡：頭像加指令標籤、換下誰、換上誰、前後對比 */
  function optionButton(t: Tactic, index: number): HTMLElement {
    const o = optionFor(t)
    const key = index < 9 ? String(index + 1) : ''
    const btn = el('button', 'option-card')
    btn.type = 'button'
    const face = el('span', 'option-face')
    face.append(avatar(o.who.id, o.team, `team-ring ${o.team}`), el('span', 'option-tag', o.tag))
    const body = el('span', 'option-body')
    const diffs = el('span', 'option-diffs')
    diffs.append(...o.diffs)
    body.append(el('span', 'option-sub', o.sub), el('span', 'option-main', o.main), diffs)
    const arrow = el('span', 'option-arrow')
    arrow.innerHTML = CHEVRON_RIGHT
    btn.append(face, body, arrow)
    if (key) {
      btn.append(kbd(key))
      keys[key] = () => h.choose(t)
    }
    btn.setAttribute('aria-label', `${o.tag} ${o.main}，${o.sub}`)
    btn.onclick = () => h.choose(t)
    return btn
  }

  /** 親自出手卡：放在推薦指令上面，顯示這次黃色區有多寬 */
  function takeOverCard(kind: 'swing' | 'aimPitch'): HTMLElement {
    const zone = game.meterZone(kind)
    const btn = el('button', `takeover-card ${kind}`)
    btn.type = 'button'
    const icon = el('span', 'takeover-icon')
    icon.innerHTML = TAKEOVER_ICONS[kind]
    const body = el('span', 'takeover-body')
    const preview = el('span', 'takeover-preview')
    const band = el('span', 'takeover-band')
    band.style.left = `${(zone.center - zone.good) * 100}%`
    band.style.width = `${zone.good * 200}%`
    preview.append(band)
    body.append(
      el('span', 'takeover-title', T.takeOverNames[kind]),
      el('span', 'takeover-sub', T.takeOverSub[kind]),
      preview,
      el('span', 'takeover-zone', T.takeOverZone(kind, zoneWidthLabel(zone))),
    )
    btn.append(icon, body, kbd('ENTER'))
    btn.onclick = () => h.takeOver(kind)
    keys.Enter = () => h.takeOver(kind)
    return btn
  }

  /**
   * 守備佈陣列：五種站位一字排開，每格標出對這位打者的被安打率變化。
   * 像戰棋攻擊前的預覽，讓教練看得到猜對、猜錯的代價
   */
  function alignmentBar(): HTMLElement {
    const box = el('section', 'alignment-bar')
    box.setAttribute('aria-label', T.alignmentTitle)
    const head = el('div', 'alignment-head')
    head.append(el('span', 'section-label', T.alignmentTitle), tendencyChip(game.batter.tendency, true))
    const row = el('div', 'alignment-options')
    for (const a of ALIGNMENTS) {
      const pct = Math.round(game.alignmentEffect(a) * 100)
      const btn = el('button', `alignment-option ${a}`)
      btn.type = 'button'
      btn.setAttribute('aria-pressed', String(game.alignment === a))
      btn.title = T.alignmentNotes[a]
      btn.append(
        el('span', 'alignment-name', T.alignmentShort[a]),
        el('span', `alignment-effect ${pct < 0 ? 'good' : pct > 0 ? 'bad' : ''}`, pct === 0 ? '±0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`),
      )
      btn.onclick = () => {
        if (game.alignment !== a) h.choose({ type: 'alignment', alignment: a })
      }
      row.append(btn)
    }
    box.append(head, row, el('span', 'alignment-note', T.alignmentNotes[game.alignment]))
    return box
  }

  /** 進攻時對手的佈陣：佈什麼陣、對這位打者的影響、可以怎麼應對 */
  function enemyAlignmentNote(): HTMLElement {
    const a = game.alignment
    const pct = Math.round(game.alignmentEffect() * 100)
    const box = el('section', 'enemy-alignment')
    const head = el('div', 'enemy-alignment-head')
    head.append(
      el('span', 'enemy-alignment-title', T.enemyAlignment(T.alignmentNames[a])),
      el('span', `alignment-effect ${pct < 0 ? 'bad' : pct > 0 ? 'good' : ''}`, T.enemyAlignmentEffect(pct)),
    )
    const tip = a === 'shiftLeft' || a === 'shiftRight' ? T.enemyAlignmentTip.shift : a === 'infieldIn' ? T.enemyAlignmentTip.infieldIn : T.enemyAlignmentTip.outfieldBack
    box.append(head, el('span', 'alignment-note', tip))
    return box
  }

  // ---- 其他指令格：每種指令一格，不能用的變灰並寫原因 ----

  function commandReason(type: Tactic['type'], list: Tactic[]): string {
    const batTeam = game.batting
    const fieldTeam = game.fielding
    if (list.length > 0) {
      if (type === 'pinchHit' || type === 'pinchRun' || type === 'defensiveSub') return T.benchLeft(game.battingSide === userSide ? batTeam.bench.length : fieldTeam.bench.length)
      if (type === 'changePitcher') return T.relieversLeft(fieldTeam.relievers.length)
      if (type === 'steal') return list.length > 1 ? T.choices(list.length) : T.stealTarget(BASE_NAMES[(list[0] as { from: 1 | 2 }).from])
      return ''
    }
    const anyRunner = game.bases.some(Boolean)
    switch (type) {
      case 'steal':
        return !anyRunner ? T.noRunners : game.bases.every(Boolean) ? T.basesFull : T.baseAhead
      case 'bunt':
        return !anyRunner ? T.noRunners : T.twoOuts
      case 'hitAndRun':
        return T.needFirst
      case 'pinchHit':
      case 'defensiveSub':
        return T.benchEmpty
      case 'pinchRun':
        return batTeam.bench.length === 0 ? T.benchEmpty : T.noRunners
      case 'changePitcher':
        return T.relieversEmpty
      case 'intentionalWalk':
        return T.onlyAtStart
      default:
        return ''
    }
  }

  function commandGrid(): HTMLElement {
    const types = game.battingSide === userSide ? OFFENSE_TYPES : DEFENSE_TYPES
    const grid = el('div', 'command-grid')
    for (const type of types) {
      let list = tactics.filter((t) => t.type === type)
      if (type === 'defensiveSub') list = defensiveSubs().map((d) => d.tactic)
      const btn = el('button', 'command-cell')
      btn.type = 'button'
      btn.append(el('span', 'command-name', T.commandNames[type]), el('span', 'command-note', commandReason(type, list)))
      btn.disabled = list.length === 0
      btn.onclick = () => {
        // 只有一個選擇就直接下達；有多個人選就列出候選卡
        if (list.length === 1 && type !== 'pinchHit' && type !== 'pinchRun' && type !== 'changePitcher' && type !== 'defensiveSub') h.choose(list[0])
        else {
          state.picking = type
          h.rerender()
        }
      }
      grid.append(btn)
    }
    return grid
  }

  function candidates(type: Tactic['type']): HTMLElement {
    const box = el('div', 'candidates')
    const head = el('div', 'candidates-head')
    const back = el('button', 'pill-btn', T.backArrow)
    const goBack = () => {
      state.picking = null
      h.rerender()
    }
    back.onclick = goBack
    keys.Escape = goBack
    head.append(back, el('span', 'section-label', T.pickFor(T.commandNames[type])))
    box.append(head)
    const list = type === 'defensiveSub' ? defensiveSubs().slice(0, 4).map((d) => d.tactic) : tactics.filter((t) => t.type === type)
    list.forEach((t, i) => box.append(optionButton(t, i)))
    return box
  }

  // ---- 詳細資訊：相關球員的能力字母表 ----

  function details(): HTMLElement {
    const table = el('div', 'detail-table')
    const row = (role: string, p: Player) => {
      const r = el('div', 'detail-row')
      r.append(el('span', 'detail-who', `${p.name}（${role}）`))
      const values = Object.values(p.ratings)
      for (let i = 0; i < 4; i++) r.append(i < values.length ? gradeBadge(values[i], 'sm') : el('span'))
      table.append(r)
    }
    row(T.batter, game.batter)
    row(T.pitcher, game.pitcher)
    game.bases.forEach((p, i) => {
      if (p) row(T.runnerOn((i + 1) as 1 | 2 | 3), p)
    })
    row(T.onDeck, game.batting.lineup[(game.batting.battingIndex + 1) % 9].player)
    if (game.battingSide === userSide) game.batting.bench.forEach((p) => row(T.bench, p))
    else {
      game.fielding.relievers.forEach((p) => row(T.reliever, p))
      game.fielding.bench.forEach((p) => row(T.bench, p))
    }
    return table
  }

  // ---- 組合 ----

  const panel = el('section', 'sheet-panel decision-panel')
  panel.setAttribute('role', 'dialog')
  const ribbon = RIBBONS[reason]
  panel.setAttribute('aria-label', ribbon.title)

  const ribbonWrap = el('div', 'ribbon-wrap')
  const ribbonEl = el('div', `ribbon ${ribbon.className}`)
  const ribbonInner = el('span', 'ribbon-inner')
  ribbonInner.innerHTML = ribbon.icon
  ribbonInner.append(el('span', 'ribbon-title', ribbon.title))
  ribbonEl.append(ribbonInner)
  ribbonWrap.append(ribbonEl)
  panel.append(ribbonWrap)

  // 局勢條：局數與出局、比分與差距、壘包
  const situation = el('div', 'situation-bar')
  const inning = el('div', 'sit-inning')
  const inningNum = el('span', 'sit-inning-num', String(game.inning))
  inningNum.append(el('span', 'sit-half', game.half === 'top' ? T.halfTop : T.halfBottom))
  const outs = el('span', 'sit-outs')
  for (let i = 0; i < 3; i++) outs.append(el('span', `sit-out ${i < game.outs ? 'on' : ''}`))
  outs.append(el('span', 'sit-outs-text', T.outs(game.outs)))
  inning.append(inningNum, outs)
  const mine = game.score[userSide]
  const theirs = game.score[userSide === 'home' ? 'away' : 'home']
  const score = el('div', 'sit-score')
  const nums = el('span', 'sit-score-nums')
  nums.append(el('span', 'user', String(mine)), el('span', 'colon', ' : '), el('span', 'opponent', String(theirs)))
  score.append(nums, el('span', 'sit-lead', mine === theirs ? T.tied : mine > theirs ? T.leadBy(mine - theirs) : T.trailBy(theirs - mine)))
  const bases = el('div', 'sit-bases')
  const on = game.bases.map(Boolean)
  bases.innerHTML = `<svg aria-hidden="true" viewBox="0 0 54 38">
    <rect x="20" y="3" width="14" height="14" rx="2" transform="rotate(45 27 10)" class="${on[1] ? 'on' : ''}"/>
    <rect x="35" y="18" width="14" height="14" rx="2" transform="rotate(45 42 25)" class="${on[0] ? 'on' : ''}"/>
    <rect x="5" y="18" width="14" height="14" rx="2" transform="rotate(45 12 25)" class="${on[2] ? 'on' : ''}"/>
  </svg>`
  bases.append(el('span', 'sit-bases-text', runnersText(on)))
  situation.append(inning, score, bases)
  panel.append(situation)

  if (game.over) {
    const done = el('button', 'btn-yellow btn-big', T.handToPlayers)
    done.onclick = h.handOver
    panel.append(done)
    return panel
  }

  // 打者對投手
  const duel = el('div', 'decision-duel')
  const side = (p: Player, s: Side, label: string, isPitcher: boolean) => {
    const box = el('div', 'dd-side')
    const info = el('div', 'dd-info')
    info.append(el('span', 'dd-label', label), el('span', 'dd-name', p.name))
    const stats = el('span', 'dd-stats')
    const labels = isPitcher ? ['威', '控', '體'] : ['打', '力', '速', '守']
    Object.values(p.ratings).forEach((v, i) => {
      const s = el('span', 'dd-stat')
      s.append(el('span', 'dd-stat-label', labels[i]), gradeBadge(v, 'sm'))
      stats.append(s)
    })
    info.append(stats)
    const chips = el('span', 'dd-chips')
    chips.append(handChip(p, !isPitcher && game.platoonOn ? game.matchup() : undefined))
    if (p.role === 'batter') chips.append(tendencyChip(p.tendency))
    info.append(chips)
    if (isPitcher) {
      const pct = staminaPct()
      const level = pct >= 50 ? 'high' : pct >= 25 ? 'mid' : 'low'
      const bar = el('span', 'dd-stamina')
      const track = el('span', 'dd-track')
      const fill = el('span', `dd-fill ${level}`)
      fill.style.width = `${pct}%`
      track.append(fill)
      bar.append(track, el('span', `dd-pct ${level}`, `${pct}%`))
      info.append(bar)
    }
    box.append(avatar(p.id, teamOf(s), `team-ring ${teamOf(s)}`), info)
    return box
  }
  duel.append(
    side(game.batter, game.battingSide, T.batter, false),
    el('span', 'dd-vs', T.versus),
    side(game.pitcher, game.fieldingSide, `${T.pitcher}・${T.pitchCount(game.fielding.pitchCount)}`, true),
  )
  panel.append(duel)
  if (game.queued) panel.append(el('div', 'queued-note', T.queued(T.commandNames[game.queued.type])))

  if (state.picking) {
    panel.append(candidates(state.picking))
  } else {
    const kind = game.takeOver()
    if (kind) panel.append(takeOverCard(kind))
    if (game.fieldingSide === userSide) panel.append(alignmentBar())
    else if (game.alignment !== 'normal') panel.append(enemyAlignmentNote())
    const picks = keyTactics()
    if (picks.length) {
      panel.append(el('span', 'section-label', T.keyHeading))
      picks.forEach((t, i) => panel.append(optionButton(t, i)))
    } else {
      const empty = el('div', 'no-options')
      const icon = el('span', 'no-options-icon')
      icon.innerHTML = CLIPBOARD
      const words = el('span', 'no-options-words')
      words.append(el('span', 'no-options-title', T.noKeyTitle), el('span', 'no-options-hint', T.noKeyHint))
      empty.append(icon, words)
      panel.append(empty)
    }

    const toggles = el('div', 'panel-toggles')
    const toggle = (label: string, key: string, open: boolean, flip: () => void) => {
      const b = el('button', `panel-toggle ${open ? 'open' : ''}`)
      b.type = 'button'
      b.setAttribute('aria-expanded', String(open))
      b.append(label)
      b.insertAdjacentHTML('beforeend', CHEVRON_DOWN)
      b.append(kbd(key.toUpperCase()))
      const run = () => {
        flip()
        h.rerender()
      }
      b.onclick = run
      keys[key] = run
      return b
    }
    toggles.append(
      toggle(T.otherTactics, 'o', state.showOthers, () => (state.showOthers = !state.showOthers)),
      toggle(T.details, 'i', state.showDetails, () => (state.showDetails = !state.showDetails)),
    )
    if (state.showOthers || state.showDetails) {
      keys.Escape = () => {
        state.showOthers = false
        state.showDetails = false
        h.rerender()
      }
    }
    panel.append(toggles)
    if (state.showOthers) panel.append(commandGrid())
    if (state.showDetails) panel.append(details())
  }

  const go = el('button', 'btn-yellow btn-big hand-over', T.handToPlayers)
  go.append(kbd('SPACE'))
  go.onclick = h.handOver
  panel.append(go)
  return panel
}
