// 所有介面文字集中在這裡，之後要加語系只改這個檔
import type { Alignment, BattedBall, Fielder, PitchResult, PlayKind } from '../sim/game'
import type { CardTier } from '../sim/generate'
import type { Round } from '../sim/tournament'
import type { TraitId } from '../sim/traits'
import type { Position, Tendency } from '../sim/types'

export const T = {
  gameTitle: '骰子棒球',
  gameSubtitleLines: ['你是教練。隨機發一支球隊，', '剩下的交給你的判斷。'],
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
  // ---- 決策面板 ----
  keyHeading: '重點調度・點一下直接下達',
  noKeyTitle: '這個時刻沒有特別建議的調度',
  noKeyHint: '要下指令可以從「其他指令」選',
  leadBy: (n: number) => `領先 ${n} 分`,
  trailBy: (n: number) => `落後 ${n} 分`,
  tied: '平手',
  successRate: '成功率',
  tagPinchHit: '代打',
  tagPinchRun: '代跑',
  tagSteal: '盜壘',
  tagBunt: '觸擊',
  tagHitAndRun: '打帶跑',
  tagPitcher: '換投',
  tagWalk: '保送',
  tagDefense: '守備',
  replaces: (name: string) => `換下 ${name}`,
  runnerOut: (where: string, name: string) => `${where} ${name} 換下`,
  stealTarget: (base: string) => `衝${base}壘`,
  batterIs: '打者犧牲觸擊',
  hitAndRunSub: '一壘跑者起跑、打者出棒',
  walkSub: '故意四壞，改跟下一棒對決',
  commandNames: {
    steal: '盜壘',
    bunt: '觸擊',
    hitAndRun: '打帶跑',
    pinchHit: '代打',
    pinchRun: '代跑',
    changePitcher: '換投',
    intentionalWalk: '故意四壞',
    defensiveSub: '守備替補',
    alignment: '守備佈陣',
  } as Record<string, string>,
  benchLeft: (n: number) => `板凳 ${n} 人`,
  relieversLeft: (n: number) => `後援 ${n} 人`,
  choices: (n: number) => `${n} 個選擇`,
  noRunners: '壘上無人',
  basesFull: '壘包已滿',
  baseAhead: '前方壘包有人',
  twoOuts: '兩出局不能觸擊',
  needFirst: '需要一壘有人、二壘空著',
  benchEmpty: '板凳沒人了',
  relieversEmpty: '後援用完了',
  onlyAtStart: '打席開始前才能用',
  pickFor: (name: string) => `選擇${name}人選`,
  backArrow: '‹ 返回',
  // ---- 電腦版 ----
  orderColumnFull: '棒次',
  traitsColumn: '特性',
  swapGuide: '點兩名球員交換：點球場上的人交換守位，點打序列表交換棒次',
  logTitle: '比賽紀錄',
  // ---- 守備佈陣與擊球傾向 ----
  tendencyLabel: '擊球方向',
  tendencyNames: { left: '偏左外野', even: '平均', right: '偏右外野' } as Record<Tendency, string>,
  tendencyShort: { left: '偏左', even: '平均', right: '偏右' } as Record<Tendency, string>,
  alignmentTitle: '守備佈陣',
  alignmentNames: {
    normal: '標準',
    shiftLeft: '偏左佈陣',
    shiftRight: '偏右佈陣',
    infieldIn: '內野前進',
    outfieldBack: '外野後退',
  } as Record<Alignment, string>,
  alignmentShort: { normal: '標準', shiftLeft: '偏左', shiftRight: '偏右', infieldIn: '內野前進', outfieldBack: '外野後退' } as Record<Alignment, string>,
  alignmentNotes: {
    normal: '一般站位',
    shiftLeft: '野手往左外野方向移',
    shiftRight: '野手往右外野方向移',
    infieldIn: '三壘跑者回不來，但滾地球較易穿過',
    outfieldBack: '少被打長打，但前方空出來',
  } as Record<Alignment, string>,
  alignmentHint: (batter: string, tendency: string) => `${batter} 擊球方向：${tendency}。只對這位打者有效`,
  hitChange: (pct: number) => (pct === 0 ? '±0%' : `被安打 ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`),
  aligned: (name: string) => `守備改成「${name}」，只對這位打者有效`,
  tagAlignment: '佈陣',
  enemyAligned: (name: string) => `對手改成「${name}」`,
  enemyAlignment: (name: string) => `對手採取「${name}」`,
  enemyAlignmentEffect: (pct: number) => `這位打者安打率 ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
  enemyAlignmentTip: {
    shift: '可以用觸擊（對偏移佈陣成功率提高），或換上擊球方向不同的代打。換人後對手會重新佈陣',
    infieldIn: '內野前進：滾地球容易穿過，但三壘跑者遇到滾地球出局時回不來',
    outfieldBack: '外野後退：長打不容易，一壘安打比較容易',
  },
  vsEnemyAlignment: (name: string) => ` · 對手${name}`,
  alignmentSub: (tendency: string) => `打者擊球${tendency}`,
  // ---- 新手教學與我方標示 ----
  tutorialNext: '下一步',
  tutorialDone: '開始玩',
  tutorialSkip: '跳過教學',
  tutorialReplay: '重看新手教學',
  tutorialReset: '已重設，進入各畫面時會再顯示教學',
  mySide: '我方',
  opponentSide: '對手',
  weAreBatting: '我方進攻中',
  weAreFielding: '我方守備中',
  soundOn: '音效：開（按 M 關閉）',
  soundOff: '音效：關（按 M 開啟）',
  // ---- 全壘打數據 ----
  hrDistance: '飛行距離',
  hrExitVelocity: '擊球初速',
  hrLaunchAngle: '仰角',
  meters: (ft: number) => `${Math.round(ft * 0.3048)}`,
  kmh: (mph: number) => `${Math.round(mph * 1.609)}`,
  hrLog: (ft: number) => `（飛行 ${Math.round(ft * 0.3048)} 公尺）`,
  // ---- 親自出手（計量條） ----
  takeOverNames: { swing: '親自出棒', aimPitch: '決勝球' },
  takeOverTag: { swing: '出棒', aimPitch: '投球' },
  takeOverSub: {
    swing: '下一球一定揮棒，停在黃色區就能打出好球',
    aimPitch: '這一球由你來投，停在黃色區就能壓制打者',
  },
  takeOverZone: (kind: 'swing' | 'aimPitch', width: string) => `${kind === 'swing' ? '打者打擊' : '投手控球與體力'}決定黃色區寬度：${width}`,
  zoneWidths: ['窄', '普通', '寬'],
  meterHint: '按住蓄力，放開出手',
  meterGrades: { perfect: '完美！', good: '不錯！', early: '太早了', late: '太晚了' },
  meterLog: (kind: 'swing' | 'aimPitch', grade: string) => `${kind === 'swing' ? '親自出棒' : '決勝球'}：${grade}`,
  thisRun: '這屆戰績',
  finalNth: (n: number) => `決賽 第 ${n} 戰`,
  trophyLabel: '冠軍獎盃',
  ballLabel: '棒球',
  pickCard: '選卡',
  confirmKey: '確認',
  cycleSpeed: '切換速度',
  lineupTitle: (name: string) => `${name} 打線`,
  atBat: '打擊中',
  baseNames: ['一壘', '二壘', '三壘'],
  batterNth: (n: number) => `打者 · 第 ${n} 棒`,
  pitcherPitches: (n: number) => `投手 · 用球 ${n}`,
  // ---- 錦標賽與選秀 ----
  winMark: '勝',
  loseMark: '敗',
  draftCandidates: '候選球員',
  replaceWho: (name: string, role: string) => `${name} 要替換哪一名${role}？`,
  pickFirst: '先從上面選一名球員',
  orderNth: (n: number) => `第 ${n} 棒`,
  replace: '換掉',
  halfTop: '局上',
  halfBottom: '局下',
  tiredTag: '疲勞',
  promptLabel: '決策提示',
  tierNames: { bronze: '銅卡', silver: '銀卡', gold: '金卡', rainbow: '彩虹卡' } as Record<CardTier, string>,
  rareArrived: '稀有球員登場！',
  accept: '收下',
  confirm: '確定',
  relievers: '後援投手',
  orderColumn: '棒',
  playerColumn: '球員',
  pitcherMark: '投',
  versus: 'VS',
  orderAndPosition: (order: number, pos: string) => `打序 ${order}・${pos}`,
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
  swapHintLineup: '點球場上的人交換守位，點打序列表交換棒次',
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
  rename: '改隊名',
  randomName: '隨機隊名',
  save: '儲存',
  teamNamePlaceholder: '輸入隊名',
  callError: '失誤！',
  callDoublePlay: '雙殺！',
  onDeck: '下一棒',
  runnerOn: (base: 1 | 2 | 3) => `${['一', '二', '三'][base - 1]}壘跑者`,
  eliminated: (round: string) => `止步${round}`,
  tournamentOver: '這支隊伍的旅程結束了，下次會是全新的隊伍。',
  gameRecord: (round: string, won: boolean, u: number, o: number) => `${round}　${won ? '勝' : '敗'} ${u}:${o}`,
  tacticPinchHit: '代打',
  tacticPinchRun: (base: 1 | 2 | 3, runner: string) => `代跑 ${['一', '二', '三'][base - 1]}壘 ${runner}`,
  tacticChangePitcher: '換投',
  tacticIntentionalWalk: '故意四壞',
  tacticDefensiveSub: (pos: string, out: string, inName: string) => `守備替補 ${pos} ${out} → ${inName}`,
  subDefense: (inName: string, outName: string) => `守備替補：${inName} 替換 ${outName}`,
  swappedPositions: (a: string, b: string) => `${a} 與 ${b} 交換守位`,
  swappedOrder: (a: string, b: string) => `${a} 與 ${b} 交換棒次`,
}

export const POSITION_FULL: Record<Position, string> = {
  C: '捕手',
  '1B': '一壘手',
  '2B': '二壘手',
  '3B': '三壘手',
  SS: '游擊手',
  LF: '左外野',
  CF: '中外野',
  RF: '右外野',
  DH: '指定打擊',
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
  fielding: '守',
  stuff: '威',
  control: '控',
  stamina: '耐',
} as const

export const RATING_FULL = {
  contact: '打擊',
  power: '力量',
  speed: '速度',
  fielding: '守備',
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
