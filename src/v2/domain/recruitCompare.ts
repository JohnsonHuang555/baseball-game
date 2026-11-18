// 招募候選人跟目前陣容的比較（純函式）：打者比同守位的先發，投手比先發投手與最弱的後援。
// 打者的守備用「守那個位置的實際守備」計算，所以不會只看總評而忽略守位。
// 比的是目前養成後的能力（候選人是 Lv.1，陣容裡的人可能已經升過級）
import { fieldingAtPosition } from '../../sim/positions'
import type { Batter, Pitcher, Player, Position } from '../../sim/types'
import type { ClubSave } from './club'
import { resolveRoster } from './roster'

/** 差距在這個範圍內算「相近」 */
export const SIMILAR_MARGIN = 0.3
/** 單項能力差這麼多以上，列為主要優勢／弱點 */
export const KEY_DIFF = 1

export type CompareVerdict = 'stronger' | 'similar' | 'weaker'
export type CompareTargetKind = 'starter-at-position' | 'designated-hitter' | 'starting-pitcher' | 'weakest-reliever'

export interface RatingDiff {
  key: string
  candidate: number
  current: number
  diff: number
}

export interface CandidateComparison {
  /** 比較的對象；陣容裡找不到可以比的人時是 null */
  target: { kind: CompareTargetKind; playerId: string; name: string; position?: Position } | null
  /** 打者：比的是哪個守位（本職） */
  position?: Position
  /** 候選人在這個位置的綜合能力（打者用該守位的實際守備） */
  candidateValue: number
  /** 比較對象在同一個位置的綜合能力 */
  targetValue: number | null
  diff: number
  verdict: CompareVerdict
  /** 簽下來換上場，陣容會變強（差距超過「相近」的範圍） */
  improves: boolean
  ratings: RatingDiff[]
  strengths: string[]
  weaknesses: string[]
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** 打者守 position 時的綜合能力：打擊、力量、速度，加上守這個位置的實際守備（指定打擊不看守備） */
export function batterValueAt(b: Batter, position: Position): number {
  const { contact, power, speed } = b.ratings
  return position === 'DH' ? avg([contact, power, speed]) : avg([contact, power, speed, fieldingAtPosition(b, position)])
}

export function pitcherValue(p: Pitcher): number {
  return avg([p.ratings.stuff, p.ratings.control, p.ratings.stamina])
}

const verdictOf = (diff: number): CompareVerdict => (diff >= SIMILAR_MARGIN ? 'stronger' : diff <= -SIMILAR_MARGIN ? 'weaker' : 'similar')

function batterRatings(c: Batter, t: Batter, position: Position): RatingDiff[] {
  const field = (b: Batter) => (position === 'DH' ? b.ratings.fielding : fieldingAtPosition(b, position))
  return [
    { key: 'contact', candidate: c.ratings.contact, current: t.ratings.contact, diff: 0 },
    { key: 'power', candidate: c.ratings.power, current: t.ratings.power, diff: 0 },
    { key: 'speed', candidate: c.ratings.speed, current: t.ratings.speed, diff: 0 },
    { key: 'fielding', candidate: field(c), current: field(t), diff: 0 },
  ].map((r) => ({ ...r, diff: r.candidate - r.current }))
}

function pitcherRatings(c: Pitcher, t: Pitcher): RatingDiff[] {
  return (['stuff', 'control', 'stamina'] as const).map((key) => ({ key, candidate: c.ratings[key], current: t.ratings[key], diff: c.ratings[key] - t.ratings[key] }))
}

function finish(base: Omit<CandidateComparison, 'verdict' | 'improves' | 'strengths' | 'weaknesses' | 'diff'>): CandidateComparison {
  const diff = base.targetValue === null ? 0 : base.candidateValue - base.targetValue
  const verdict = base.targetValue === null ? 'stronger' : verdictOf(diff)
  return {
    ...base,
    diff,
    verdict,
    improves: base.targetValue === null || diff >= SIMILAR_MARGIN,
    strengths: base.ratings.filter((r) => r.diff >= KEY_DIFF).map((r) => r.key),
    weaknesses: base.ratings.filter((r) => r.diff <= -KEY_DIFF).map((r) => r.key),
  }
}

/**
 * 候選人跟目前陣容比較。
 * - 打者：跟守本職位置的先發比（雙方都用守那個位置的實際守備）；沒有人守那個位置時，跟指定打擊比打擊三項
 * - 投手：比先發投手強就跟先發投手比；不然跟最弱的後援比（能不能補強牛棚）
 */
export function compareCandidate(club: Pick<ClubSave, 'players' | 'roster'>, candidate: Player): CandidateComparison {
  const roster = resolveRoster(club)
  if (candidate.role === 'batter') {
    const position = candidate.primary
    const spot = roster.lineup.find((s) => s.position === position)
    if (spot) {
      return finish({
        target: { kind: 'starter-at-position', playerId: spot.player.id, name: spot.player.name, position },
        position,
        candidateValue: batterValueAt(candidate, position),
        targetValue: batterValueAt(spot.player, position),
        ratings: batterRatings(candidate, spot.player, position),
      })
    }
    const dh = roster.lineup.find((s) => s.position === 'DH')
    if (dh) {
      return finish({
        target: { kind: 'designated-hitter', playerId: dh.player.id, name: dh.player.name, position: 'DH' },
        position,
        candidateValue: batterValueAt(candidate, 'DH'),
        targetValue: batterValueAt(dh.player, 'DH'),
        ratings: batterRatings(candidate, dh.player, 'DH'),
      })
    }
    return finish({ target: null, position, candidateValue: batterValueAt(candidate, position), targetValue: null, ratings: [] })
  }
  const starter = roster.starter
  const value = pitcherValue(candidate)
  if (value >= pitcherValue(starter) - SIMILAR_MARGIN || roster.relievers.length === 0) {
    return finish({
      target: { kind: 'starting-pitcher', playerId: starter.id, name: starter.name },
      candidateValue: value,
      targetValue: pitcherValue(starter),
      ratings: pitcherRatings(candidate, starter),
    })
  }
  const weakest = [...roster.relievers].sort((a, b) => pitcherValue(a) - pitcherValue(b))[0]
  return finish({
    target: { kind: 'weakest-reliever', playerId: weakest.id, name: weakest.name },
    candidateValue: value,
    targetValue: pitcherValue(weakest),
    ratings: pitcherRatings(candidate, weakest),
  })
}

/**
 * 三選一時「最能補強陣容」的候選人：比較對象的差距最大者（平手取綜合能力較高、再取位置較前）。
 * 平衡模擬的招募策略用這個挑人；畫面只把比較結果列出來，不替玩家決定
 */
export function bestCandidateIndex(club: Pick<ClubSave, 'players' | 'roster'>, candidates: readonly Player[]): number {
  let best = 0
  let bestKey = [-Infinity, -Infinity]
  candidates.forEach((p, i) => {
    const c = compareCandidate(club, p)
    const key = [c.diff, c.candidateValue]
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = i
      bestKey = key
    }
  })
  return best
}
