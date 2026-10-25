// 所有介面文字集中在這裡，之後要加語系只改這個檔
import type { PitchResult, PlayKind } from '../sim/game'
import type { CardTier } from '../sim/generate'
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
  swapHint: '再點一名球員即可交換',
  lineup: '先發打序',
  bench: '板凳',
  pitchers: '投手',
  starter: '先發',
  reliever: '後援',
  left: (n: number) => `剩 ${n} 次`,
  rare: '稀有！',
  inning: (n: number, top: boolean) => `${n} 局${top ? '上' : '下'}`,
  batter: '打者',
  pitcher: '投手',
  pitchCount: (n: number) => `用球 ${n}`,
  tired: '體力下滑',
  command: '指令',
  resume: '繼續比賽',
  queued: (name: string) => `已下達：${name}，下一球執行`,
  reasonLeverage: '關鍵時刻！',
  reasonFatigue: '投手體力下滑',
  reasonPause: '教練暫停',
  groupOffense: '戰術',
  groupSubs: '換人',
  groupDefense: '投手調度',
  win: '勝利！',
  lose: '落敗',
  playAgain: '再來一場',
  backToTitle: '回首頁',
  outs: (n: number) => `${n} 出局`,
  runnersNone: '壘上無人',
  baseName: (b: 1 | 2 | 3) => ['一', '二', '三'][b - 1],
  halfEnd: (n: number, top: boolean) => `── ${n} 局${top ? '上' : '下'}結束 ──`,
  gameOver: '比賽結束',
  scored: (runs: number) => `，得 ${runs} 分`,
  stealResult: (ok: boolean) => (ok ? '盜壘成功' : '盜壘失敗，出局'),
  subPinchHit: (inName: string, outName: string) => `代打：${inName} 替換 ${outName}`,
  subPinchRun: (inName: string, outName: string) => `代跑：${inName} 替換 ${outName}`,
  subPitcher: (inName: string, outName: string) => `換投：${inName} 上場，${outName} 退場`,
  tacticSteal: (from: 1 | 2, name: string, speed: number) =>
    `盜${from === 1 ? '二' : '三'}壘（${name}，速 ${speed}）`,
  tacticBunt: '犧牲觸擊',
  tacticHitAndRun: '打帶跑',
  tacticPinchHit: '代打',
  pinchRunMenu: '代跑',
  back: '返回',
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

export const TIER_NAMES: Record<CardTier, string> = {
  bronze: '銅',
  silver: '銀',
  gold: '金',
  rainbow: '彩虹',
}

export const PITCH_TEXT: Record<PitchResult, string> = {
  ball: '壞球',
  calledStrike: '好球',
  swingingStrike: '揮棒落空',
  foul: '界外',
  inPlay: '擊出！',
}

export const PLAY_TEXT: Record<PlayKind, string> = {
  single: '擊出一壘安打',
  double: '擊出二壘安打',
  triple: '擊出三壘安打',
  homeRun: '轟出全壘打！',
  groundOut: '滾地球出局',
  doublePlay: '打成雙殺',
  flyOut: '高飛球出局',
  sacrificeFly: '高飛犧牲打',
  lineOut: '平飛球出局',
  strikeout: '被三振',
  walk: '獲得四壞球保送',
  intentionalWalk: '被故意四壞保送',
  sacrificeBunt: '犧牲觸擊成功',
  buntPopOut: '觸擊失敗，小飛球出局',
}
