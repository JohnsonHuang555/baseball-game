// 所有介面文字集中在這裡，之後要加語系只改這個檔
import type { BattedBall, Fielder, PitchResult, PlayKind } from '../sim/game'
import type { Round } from '../sim/tournament'
import type { TraitId } from '../sim/traits'
import type { Position } from '../sim/types'

export const T = {
  gameTitle: '骰子棒球',
  gameSubtitle: '你是教練。隨機發一支球隊，剩下的交給你的判斷。',
  quickMatch: '快速比賽',
  tournament: '錦標賽',
  comingSoon: '即將推出',
  myTeam: '我的球隊',
  opponent: '對手',
  avgOverall: '平均總評',
  rerollTeam: '整隊重骰',
  rerollPlayer: '重骰此球員',
  cancel: '取消',
  startGame: '開始比賽',
  bench: '板凳',
  starter: '先發',
  reliever: '後援',
  inning: (n: number, top: boolean) => `${n} 局${top ? '上' : '下'}`,
  batter: '打者',
  pitcher: '投手',
  pitchCount: (n: number) => `用球 ${n}`,
  tired: '體力下滑',
  command: '指令',
  queued: (name: string) => `已下達：${name}，下一球執行`,
  reasonLeverage: '關鍵時刻！',
  reasonFatigue: '投手體力下滑',
  reasonPause: '教練暫停',
  win: '勝利！',
  lose: '落敗',
  playAgain: '再來一場',
  backToTitle: '回首頁',
  outs: (n: number) => `${n} 出局`,
  halfEnd: (n: number, top: boolean) => `── ${n} 局${top ? '上' : '下'}結束 ──`,
  gameOver: '比賽結束',
  scored: (runs: number) => `，得 ${runs} 分`,
  stealResult: (ok: boolean) => (ok ? '盜壘成功' : '盜壘失敗，出局'),
  subPinchHit: (inName: string, outName: string) => `代打：${inName} 替換 ${outName}`,
  subPinchRun: (inName: string, outName: string) => `代跑：${inName} 替換 ${outName}`,
  subPitcher: (inName: string, outName: string) => `換投：${inName} 上場，${outName} 退場`,
  tacticSteal: (from: 1 | 2, name: string) => `盜${from === 1 ? '二' : '三'}壘 ${name}`,
  tacticBunt: '犧牲觸擊',
  tacticHitAndRun: '打帶跑',
  lineupOnlyHint: '錦標賽開打後不能重骰，只能調整打序、投手與板凳',
  roundNames: { r16: '十六強', qf: '八強', sf: '四強', final: '決賽' } as Record<Round, string>,
  tournamentHeading: (round: string) => `錦標賽・${round}`,
  startTournament: '開始錦標賽',
  continueTournament: (round: string) => `繼續錦標賽（${round}）`,
  newTournament: '新的錦標賽',
  confirmOverwrite: '目前的錦標賽進度會被清除，確定要重新開始嗎？',
  nextGame: '調整陣容並開賽',
  nextOpponent: '下一個對手',
  finalGame: (n: number, user: number, opp: number) => `決賽 第 ${n} 戰（系列 ${user}-${opp}）`,
  bracketTitle: '賽程',
  historyTitle: '戰績',
  pending: '待定',
  continue: '繼續',
  draftTitle: '選秀',
  draftHint: '贏球了！從 3 名球員中挑 1 名加入隊伍，或放棄這次選秀',
  draftReleaseHint: (name: string) => `選擇要釋出的球員，由 ${name} 接替`,
  skipDraft: '放棄選秀',
  champion: '奪冠！',
  overallLabel: '總評',
  swap: '交換',
  close: '關閉',
  swapPick: (name: string) => `選擇要和 ${name} 交換的球員`,
  swapped: (a: string, b: string) => `${a} 已與 ${b} 交換`,
  rerolledPlayer: (from: string, to: string) => `${from} 重骰為 ${to}`,
  rerolledTeam: (left: number) => `整隊重骰完成，剩 ${left} 次`,
  renamed: (name: string) => `隊名改為 ${name}`,
  walkedIntentionally: (name: string) => `故意四壞：${name}`,
  drafted: (pick: string, released: string) => `${pick} 加入，${released} 釋出`,
  draftSkipped: '放棄這次選秀',
  swapHintLineup: '兩名先發互換打序；板凳換上場接手守位',
  designatedHitter: '指定打擊',
  battingOrder: '打序',
  prompts: (level: string) => `決策提示：${level}`,
  handToPlayers: '交給球員',
  otherTactics: '其他指令',
  details: '詳細資訊',
  stealChance: (pct: number) => `成功率 約 ${pct}%`,
  buntChance: (pct: number) => `成功率 約 ${pct}%`,
  stamina: '體力',
  noKeyOptions: '這個時刻沒有特別建議的調度，可以交給球員，或從其他指令中挑選',
  nextBatterIs: (name: string, grade: string) => `下一棒 ${name}（打擊 ${grade}）`,
  rename: '改隊名',
  randomName: '隨機隊名',
  save: '儲存',
  teamNamePlaceholder: '輸入隊名',
  callError: '失誤！',
  callDoublePlay: '雙殺！',
  onDeck: '下一棒',
  runnerOn: (base: 1 | 2 | 3) => `${['一', '二', '三'][base - 1]}壘跑者`,
  yourSide: '我方',
  theirSide: '對手',
  eliminated: (round: string) => `止步${round}`,
  tournamentOver: '這支隊伍的旅程結束了，下次會是全新的隊伍。',
  gameRecord: (round: string, won: boolean, u: number, o: number) => `${round}　${won ? '勝' : '敗'} ${u}:${o}`,
  tacticPinchHit: '代打',
  tacticPinchRun: (base: 1 | 2 | 3, runner: string) => `代跑 ${['一', '二', '三'][base - 1]}壘 ${runner}`,
  tacticChangePitcher: '換投',
  tacticIntentionalWalk: '故意四壞',
}

export const POSITION_NAMES: Record<Position, string> = {
  C: '捕',
  '1B': '一',
  '2B': '二',
  '3B': '三',
  SS: '游',
  LF: '左',
  CF: '中',
  RF: '右',
  DH: '指',
}

export const RATING_LABELS = {
  contact: '打',
  power: '力',
  speed: '速',
  stuff: '威',
  control: '控',
  stamina: '耐',
} as const

export const RATING_FULL = {
  contact: '打擊',
  power: '力量',
  speed: '速度',
  stuff: '球威',
  control: '控球',
  stamina: '體力',
} as const

export const TRAIT_DESC: Record<TraitId, string> = {
  slugger: '長打能力大幅提升，更容易擊出全壘打',
  clutch: '得點圈有人時打擊提升',
  eye: '不容易追打壞球',
  stealer: '盜壘成功率提升',
  bunter: '犧牲觸擊成功率提升',
  clutchBad: '得點圈有人時打擊下降',
  freeSwinger: '揮空的機率較高',
  ironArm: '體力消耗慢，疲勞後也不容易崩潰',
  strikeoutArtist: '讓打者揮空的能力提升',
  wild: '控球不穩，容易投出四壞',
}

export const PROMPT_NAMES = { few: '少', many: '多', pitcher: '只提醒換投', off: '關閉' } as const

export const TRAIT_NAMES: Record<TraitId, string> = {
  slugger: '怪力',
  clutch: '得點圈強打',
  eye: '選球眼',
  stealer: '盜壘○',
  bunter: '觸擊○',
  clutchBad: '得點圈×',
  freeSwinger: '扇風機',
  ironArm: '鐵腕',
  strikeoutArtist: '奪三振',
  wild: '四死球',
}


export const PITCH_TEXT: Record<PitchResult, string> = {
  ball: '壞球',
  calledStrike: '好球',
  swingingStrike: '揮棒落空',
  foul: '界外',
  inPlay: '擊出！',
}

/** 擊球方向，用守備位置稱呼 */
const AREA: Record<Fielder, string> = {
  P: '投手',
  C: '捕手',
  '1B': '一壘',
  '2B': '二壘',
  '3B': '三壘',
  SS: '游擊',
  LF: '左外野',
  CF: '中外野',
  RF: '右外野',
}

export const FIELDER_TITLES: Record<Fielder, string> = {
  P: '投手',
  C: '捕手',
  '1B': '一壘手',
  '2B': '二壘手',
  '3B': '三壘手',
  SS: '游擊手',
  LF: '左外野手',
  CF: '中外野手',
  RF: '右外野手',
}

const BALL_TYPES: Record<BattedBall['type'], string> = { ground: '滾地球', fly: '高飛球', line: '平飛球' }

/** 依得分數稱呼全壘打：陽春、兩分、三分、滿貫 */
export function homeRunName(runs: number): string {
  return ['陽春全壘打', '兩分全壘打', '三分全壘打', '滿貫全壘打'][Math.min(4, Math.max(1, runs)) - 1]
}

/** 壘上情況：三個壘包都有人時說「滿壘」 */
export function runnersText(occupied: readonly boolean[]): string {
  const bases = occupied.flatMap((on, i) => (on ? [['一', '二', '三'][i]] : []))
  if (bases.length === 0) return '壘上無人'
  if (bases.length === 3) return '滿壘'
  return `${bases.join('、')}壘有人`
}

export function describePlay(kind: PlayKind, ball: BattedBall | null, runs: number, notation: string | null): string {
  const area = ball ? AREA[ball.fielder] : ''
  switch (kind) {
    case 'single':
      return `擊出${area}方向一壘安打`
    case 'double':
      return `擊出${area}方向二壘安打`
    case 'triple':
      return `擊出${area}方向三壘安打`
    case 'homeRun':
      return `轟出${homeRunName(runs)}！`
    case 'groundOut':
      return `${area}方向滾地球出局`
    case 'flyOut':
      return `${area}方向高飛球被接殺`
    case 'lineOut':
      return `${area}方向平飛球被接殺`
    case 'sacrificeFly':
      return `${area}方向高飛犧牲打`
    case 'doublePlay':
      if (ball?.type === 'ground') return `${area}方向滾地球，形成 ${notation} 雙殺`
      if (ball?.type === 'fly') return `${area}高飛球被接殺，三壘跑者衝本壘遭觸殺，形成 ${notation} 雙殺`
      return `${area}方向平飛球被接殺，跑者回壘不及，形成 ${notation} 雙殺`
    case 'error':
      return `擊出${area}方向${BALL_TYPES[ball!.type]}，${FIELDER_TITLES[ball!.fielder]}失誤上壘`
    case 'strikeout':
      return '被三振'
    case 'walk':
      return '獲得四壞球保送'
    case 'intentionalWalk':
      return '被故意四壞保送'
    case 'sacrificeBunt':
      return '犧牲觸擊成功'
    case 'buntPopOut':
      return '觸擊失敗，小飛球出局'
  }
}
