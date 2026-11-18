// 精彩時刻判定（Phase 6B）：觀戰畫面決定「這一格要怎麼演」。純函式：只看模擬算好的狀態與事件，不碰畫面、時間或亂數。
//
// 兩種判定，用到的資料不同：
// - frameMoment(before, frame)：這一格「揭曉」時用。看這一格之前、之後的狀態與事件，判定得分、追平、取得領先、逆轉、
//   全壘打、滿貫、再見、三振、雙殺。這些都是結果，畫面只能在這一格正式提交之後才演（見 livePlayer.ts）。
// - clutchSituation(state)：這一格「開始前」用。只看事件發生前的狀態（局數、比分、壘上、出局），不看這一格的事件，
//   所以可以在投球前就顯示「關鍵打席」，而且不會因為結果而改變（之後被三振也一樣是關鍵打席）。
//
// 判定條件（我方 = 打擊方是 userSide；對手得分也一樣判定，只是 ours = false）：
// - score：打擊方這一格得分 > 0（分數差，不是事件的 runs 加總：盜回本壘、暴投等也算）
// - tieGame：得分前打擊方落後，得分後同分
// - takeLead：得分前打擊方沒有領先（落後或同分），得分後領先；得分前落後的是逆轉（comeback = true）
// - homeRun：這一格有全壘打；grandSlam：全壘打帶回 4 分
// - walkOff：這一格有 gameOver、是下半局、主隊打擊、得分前主隊沒有領先、這一格得分、贏家是主隊。
//   不能只看「九局下得分」：比賽要真的在這一格結束，而且是這一分讓主隊贏
// - clutchSituation：7 局以後、得點圈（二壘或三壘）有人、打擊方落後 0～(壘上人數 + 1) 分
//   （這一個打席有機會追平或超前）。9 局以後兩出局、或 9 局下以後主隊打擊且可能再見，是最高等級
//
// 同一格符合多個分類時，只選一個主要演出（primary），優先序：walkOff > grandSlam > homeRun > takeLead > tieGame > score。
// 例如九局下落後三分滿壘的再見滿貫全壘打：primary = walkOff，headline 是「再見滿貫全壘打」，附上 4 分打點與最終比分，
// 不會連續演四段大型特效
import type { GameEvent, PlayKind, Side } from '../../sim/game'
import type { ReplayFrame, ReplayState } from './replayPlayer'

export type MomentKind = 'score' | 'tieGame' | 'takeLead' | 'walkOff' | 'homeRun' | 'grandSlam' | 'clutchSituation'

/** 主要演出的優先序（越前面越優先）；clutchSituation 是開打前的提示，不參與揭曉的優先序 */
export const MOMENT_PRIORITY: readonly MomentKind[] = ['walkOff', 'grandSlam', 'homeRun', 'takeLead', 'tieGame', 'score']

export interface FrameMoment {
  /** 打擊方是我方 */
  ours: boolean
  battingSide: Side
  /** 這一格打擊方得了幾分 */
  runs: number
  /** 符合的分類（依優先序排好） */
  kinds: MomentKind[]
  /** 主要演出；這一格沒有得分相關的精彩時刻就是 null */
  primary: MomentKind | null
  /** 取得領先時，得分前是落後（逆轉） */
  comeback: boolean
  /** 這一格的全壘打（打者、帶回幾分、距離；距離只有事件有提供時才有） */
  homeRun: { batterId: string; runs: number; distance: number | null } | null
  walkOff: boolean
  /** 這一格最後一個打擊結果（盜壘是 'steal'；只有投球是 null） */
  play: PlayKind | 'steal' | null
  /** 這一格的打者（有打擊結果時） */
  batterId: string | null
  /** 三振：揮空或站著不動 */
  strikeout: 'swinging' | 'looking' | null
  /** 雙殺：實際出局的跑者（來自模擬的跑壘結果） */
  doublePlay: { outs: string[]; notation: string | null } | null
  /** 這一格結束了半局（第三個出局）或比賽 */
  endsHalf: boolean
  final: boolean
  /** 得分後的比分（我方、對手） */
  score: { us: number; them: number }
}

const other = (s: Side): Side => (s === 'home' ? 'away' : 'home')

export function frameMoment(before: ReplayState, frame: Pick<ReplayFrame, 'events' | 'after'>, userSide: Side): FrameMoment {
  const batting = before.battingSide
  const fielding = other(batting)
  const after = frame.after
  const runs = after.score[batting] - before.score[batting]
  const diffBefore = before.score[batting] - before.score[fielding]
  const diffAfter = after.score[batting] - after.score[fielding]
  const events = frame.events
  const plays = events.filter((e): e is Extract<GameEvent, { type: 'play' }> => e.type === 'play')
  const lastAction = [...events].reverse().find((e) => e.type === 'play' || e.type === 'steal')
  const hr = plays.find((p) => p.kind === 'homeRun') ?? null
  const gameOver = events.some((e) => e.type === 'gameOver')
  const walkOff = gameOver && before.half === 'bottom' && batting === 'home' && runs > 0 && diffBefore <= 0 && after.winner === 'home'

  const kinds: MomentKind[] = []
  if (walkOff) kinds.push('walkOff')
  if (hr && hr.runs === 4) kinds.push('grandSlam')
  if (hr) kinds.push('homeRun')
  if (runs > 0 && diffBefore <= 0 && diffAfter > 0) kinds.push('takeLead')
  if (runs > 0 && diffBefore < 0 && diffAfter === 0) kinds.push('tieGame')
  if (runs > 0) kinds.push('score')
  kinds.sort((a, b) => MOMENT_PRIORITY.indexOf(a) - MOMENT_PRIORITY.indexOf(b))

  let strikeout: FrameMoment['strikeout'] = null
  const kIndex = events.findIndex((e) => e.type === 'play' && e.kind === 'strikeout')
  if (kIndex >= 0) {
    const prev = events.slice(0, kIndex).reverse().find((e) => e.type === 'pitch')
    strikeout = prev?.type === 'pitch' && prev.result === 'calledStrike' ? 'looking' : 'swinging'
  }
  const dp = plays.find((p) => p.kind === 'doublePlay')
  const ours = batting === userSide
  return {
    ours,
    battingSide: batting,
    runs,
    kinds,
    primary: kinds[0] ?? null,
    comeback: kinds.includes('takeLead') && diffBefore < 0,
    homeRun: hr ? { batterId: hr.batterId, runs: hr.runs, distance: hr.ball ? hr.ball.distance : null } : null,
    walkOff,
    play: lastAction ? (lastAction.type === 'steal' ? 'steal' : (lastAction as Extract<GameEvent, { type: 'play' }>).kind) : null,
    batterId: lastAction?.type === 'play' ? lastAction.batterId : null,
    strikeout,
    doublePlay: dp ? { outs: dp.moves.filter((m) => m.to === 'out').map((m) => m.runnerId), notation: dp.notation } : null,
    endsHalf: events.some((e) => e.type === 'halfInningEnd') || gameOver,
    final: gameOver,
    score: { us: after.score[userSide], them: after.score[other(userSide)] },
  }
}

/** 主要演出的標題用：再見＋全壘打的組合（「再見滿貫全壘打」等） */
export function headlineKind(m: FrameMoment): 'walkOffGrandSlam' | 'walkOffHomeRun' | 'walkOff' | 'grandSlam' | 'homeRun' | 'takeLead' | 'comeback' | 'tieGame' | 'score' | null {
  switch (m.primary) {
    case 'walkOff':
      return m.kinds.includes('grandSlam') ? 'walkOffGrandSlam' : m.kinds.includes('homeRun') ? 'walkOffHomeRun' : 'walkOff'
    case 'takeLead':
      return m.comeback ? 'comeback' : 'takeLead'
    case null:
      return null
    default:
      return m.primary as 'grandSlam' | 'homeRun' | 'tieGame' | 'score'
  }
}

export interface ClutchSituation {
  /** 打擊方是我方 */
  ours: boolean
  /** high：9 局以後兩出局，或 9 局下以後主隊可能再見 */
  level: 'normal' | 'high'
  /** 打擊方落後幾分（0 是同分） */
  deficit: number
  /** 得點圈（二、三壘）有人 */
  scoringPosition: true
  outs: number
  runnersOn: number
}

/**
 * 這個狀態（事件發生前）是不是關鍵打席。只用已經發生的狀態，不看下一球的結果。
 * 比賽已經結束、或還沒到 7 局就是 null
 */
export function clutchSituation(state: ReplayState, userSide: Side): ClutchSituation | null {
  if (state.over || state.inning < 7) return null
  const scoringPosition = !!(state.bases[1] || state.bases[2])
  if (!scoringPosition) return null
  const batting = state.battingSide
  const deficit = state.score[other(batting)] - state.score[batting]
  const runnersOn = state.bases.filter(Boolean).length
  // 這個打席有機會追平或超前：落後 0～(壘上人數 + 1) 分（全壘打最多帶回壘上人數 + 1 分）
  if (deficit < 0 || deficit > runnersOn + 1) return null
  const walkOffChance = state.inning >= 9 && state.half === 'bottom' && batting === 'home'
  const level = (state.inning >= 9 && state.outs === 2) || walkOffChance ? 'high' : 'normal'
  return { ours: batting === userSide, level, deficit, scoringPosition: true, outs: state.outs, runnersOn }
}

/** 半局結束後的局間提示：比賽進入後段（7 局）、最終局（9 局）、延長賽 */
export function inningStage(state: Pick<ReplayState, 'inning' | 'half' | 'over'>): 'late' | 'final' | 'extra' | null {
  if (state.over || state.half !== 'top') return null
  if (state.inning === 7) return 'late'
  if (state.inning === 9) return 'final'
  if (state.inning > 9) return 'extra'
  return null
}
