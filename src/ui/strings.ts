// 共用的介面文字：觀戰的播報、球種、守位、特性、羈絆、能力名稱等（V2 自己的文字在 v2/ui/strings.ts）
import type {
  BattedBall,
  Fielder,
  PitchResult,
  PlayKind,
} from '../sim/game';
import type { PitchTraitId } from '../sim/pitches';
import type { TraitId } from '../sim/traits';
import type { SynergyKey } from '../sim/synergy';
import type { Archetype, Position } from '../sim/types';

export const T = {
  cancel: '取消',
  halfEnd: (n: number, top: boolean) => `── ${n} 局${top ? '上' : '下'}結束 ──`,
  gameOver: '比賽結束',
  scored: (runs: number) => `，得 ${runs} 分`,
  stealResult: (ok: boolean) => (ok ? '盜壘成功' : '盜壘失敗，出局'),
  subPinchHit: (inName: string, outName: string) =>
    `代打：${inName} 替換 ${outName}`,
  subPinchRun: (inName: string, outName: string) =>
    `代跑：${inName} 替換 ${outName}`,
  opponentPrefix: '對手',
  subPitcher: (inName: string, outName: string) =>
    `換投：${inName} 上場，${outName} 退場`,
  // ---- 一輪：例行賽、季後賽、秘技、裝備、獎勵 ----
  pitchTraitName: (trait: string, pitch: string) => `${trait}${pitch}`,
  // ---- 潛能與覺醒 ----
  potentialTag: (stat: string, progress: number, need: number) => `？ ${stat} ${progress}/${need}`,
  potentialHint: (stat: string, need: number) => `這一輪累積 ${need} ${stat}就會覺醒，覺醒前不知道會得到什麼特性；訓練也能推進`,
  potentialStats: { hits: '支安打', hr: '支全壘打', rbi: '分打點', k: '次三振', outs: '個出局數' },
  potentialStatShort: { hits: '安打', hr: '全壘打', rbi: '打點', k: '三振', outs: '出局' },
  // ---- 電腦版 ----
  callStrikeout: '三振！',
  calledStrikeout: '站著被三振',
  // ---- 新手教學與我方標示 ----
  mySide: '我方',
  opponentSide: '對手',
  soundOn: '音效：開（按 M 關閉）',
  soundOff: '音效：關（按 M 開啟）',
  // ---- 全壘打數據 ----
  hrDistance: '飛行距離',
  hrExitVelocity: '擊球初速',
  hrLaunchAngle: '仰角',
  meters: (ft: number) => `${Math.round(ft * 0.3048)}`,
  kmh: (mph: number) => `${Math.round(mph * 1.609)}`,
  hrLog: (ft: number) => `（飛行 ${Math.round(ft * 0.3048)} 公尺）`,
  // ---- 配球對決 ----
  pitchNames: {
    fastball: '直球',
    slider: '滑球',
    curve: '曲球',
    change: '變速球',
    splitter: '指叉球',
  },
  pitchShort: {
    fastball: '直',
    slider: '滑',
    curve: '曲',
    change: '變',
    splitter: '叉',
  },
  pitchesLabel: '球種',
  pitchesTitle: (list: string, primary: string) =>
    `球種：${list}（專長：${primary}）`,
  // ---- 錦標賽與選秀 ----
  halfTop: '局上',
  halfBottom: '局下',
  confirm: '確定',
  synergyStatus: ['未啟動', '已啟動・3 人階', '已升級・5 人階'] as const,
  synergyTierLabel: (n: number) => `${n} 人`,
  synergyHint: (tier: number, missing: number) => (tier === 2 ? '已達最高階' : tier === 1 ? `還差 ${missing} 人升級` : `還差 ${missing} 人啟動`),
  captainLabel: '隊長',
  noSynergyShort: '無',
  middleOk: '二壘、游擊都守本職，守備 B 以上',
  positionOk: (title: string, name: string) => `${title} ${name} 守本職，守備 B 以上`,
  positionOff: (title: string, name: string) => `${title} ${name} 非本職`,
  positionWeak: (title: string, name: string, grade: string) => `${title} ${name} 守備 ${grade}，要 B 以上`,
  positionOn: '成立',
  positionOffShort: '未成立',
  synergyMissing: (n: number) => `差 ${n}`,
  primaryChip: (pos: string) => `本職 ${pos}`,
  callError: '失誤！',
  callDoublePlay: '雙殺！',
  subDefense: (inName: string, outName: string) =>
    `守備替補：${inName} 替換 ${outName}`,
};

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
};

/** 守位的短稱，用在「本職二壘」「目前守游擊」這類句子 */
export const POSITION_SPOT: Record<Position, string> = {
  C: '捕手',
  '1B': '一壘',
  '2B': '二壘',
  '3B': '三壘',
  SS: '游擊',
  LF: '左外野',
  CF: '中外野',
  RF: '右外野',
  DH: '指定打擊',
};

export const ARCHETYPE_NAMES: Record<Archetype, string> = {
  power: '力量型',
  speed: '速度型',
  skill: '技巧型',
  defense: '防守型',
};

export const SYNERGY_NAMES: Record<SynergyKey, string> = {
  power: '重砲打線',
  speed: '快腿球隊',
  skill: '精準打線',
  defense: '鐵壁球隊',
  middle: '黃金二遊',
  battery: '投捕搭檔',
};

/** 小地方（晶片、球場圖）用的羈絆簡稱 */
export const SYNERGY_SHORT: Record<SynergyKey, string> = {
  power: '重砲',
  speed: '快腿',
  skill: '精準',
  defense: '鐵壁',
  middle: '二遊',
  battery: '投捕',
};

export const RATING_LABELS = {
  contact: '打',
  power: '力',
  speed: '速',
  fielding: '守',
  stuff: '威',
  control: '控',
  stamina: '耐',
} as const;

export const RATING_FULL = {
  contact: '打擊',
  power: '力量',
  speed: '速度',
  fielding: '守備',
  stuff: '球威',
  control: '控球',
  stamina: '體力',
} as const;

export const TRAIT_DESC: Record<TraitId, string> = {
  slugger: '長打能力大幅提升，更容易擊出全壘打',
  clutch: '得點圈有人時打擊提升',
  eye: '不容易追打壞球',
  stealer: '盜壘成功率提升',
  bunter: '犧牲觸擊成功率提升',
  clutchBad: '得點圈有人時打擊下降',
  freeSwinger: '揮空的機率較高',
  goodGlove: '守備時失誤減半',
  lineDrive: '擊球多為平飛球，容易打出二、三壘安打',
  baserunner: '跑壘判斷好，安打時更容易多推進一個壘包',
  errorProne: '守備時容易失誤',
  ironArm: '體力消耗慢，疲勞後也不容易崩潰',
  closer: '第 8 局起球威與控球提升',
  strikeoutArtist: '讓打者揮空的能力提升',
  groundballer: '讓打者多打成滾地球，雙殺多、全壘打少',
  escapeArtist: '得點圈有人時更難被打',
  wild: '控球不穩，容易投出四壞',
  homerProne: '容易被打出全壘打',
  lowStamina: '體力消耗快，比較早累',
};

export const TRAIT_NAMES: Record<TraitId, string> = {
  slugger: '怪力',
  clutch: '得點圈強打',
  eye: '選球眼',
  stealer: '盜壘',
  bunter: '觸擊',
  clutchBad: '得點圈',
  freeSwinger: '扇風機',
  goodGlove: '好手套',
  lineDrive: '平飛打者',
  baserunner: '跑壘',
  errorProne: '守備不穩',
  ironArm: '鐵腕',
  closer: '終結者',
  strikeoutArtist: '奪三振',
  groundballer: '滾地球投手',
  escapeArtist: '危機處理',
  wild: '四死球',
  homerProne: '被全壘打',
  lowStamina: '體力差',
};

export const PITCH_TRAIT_NAMES: Record<PitchTraitId, string> = {
  sharp: '銳利',
  heavy: '尾勁',
  command: '精準',
};

export const PITCH_TRAIT_DESC: Record<PitchTraitId, string> = {
  sharp: '這個球種更容易讓打者揮空',
  heavy: '這個球種被打中也比較難形成安打',
  command: '這個球種更容易投進好球帶，親自配球時也更到位',
};

export const PITCH_TEXT: Record<PitchResult, string> = {
  ball: '壞球',
  calledStrike: '好球',
  swingingStrike: '揮棒落空',
  foul: '界外',
  inPlay: '擊出！',
};

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
};

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
};

const BALL_TYPES: Record<BattedBall['type'], string> = {
  ground: '滾地球',
  fly: '高飛球',
  line: '平飛球',
};

/** 依得分數稱呼全壘打：陽春、兩分、三分、滿貫 */
export function homeRunName(runs: number): string {
  return ['陽春全壘打', '兩分全壘打', '三分全壘打', '滿貫全壘打'][
    Math.min(4, Math.max(1, runs)) - 1
  ];
}

/** 壘上情況：三個壘包都有人時說「滿壘」 */
export function runnersText(occupied: readonly boolean[]): string {
  const bases = occupied.flatMap((on, i) =>
    on ? [['一', '二', '三'][i]] : [],
  );
  if (bases.length === 0) return '壘上無人';
  if (bases.length === 3) return '滿壘';
  return `${bases.join('、')}壘有人`;
}

export function describePlay(
  kind: PlayKind,
  ball: BattedBall | null,
  runs: number,
  notation: string | null,
): string {
  const area = ball ? AREA[ball.fielder] : '';
  switch (kind) {
    case 'single':
      return `擊出${area}方向一壘安打`;
    case 'double':
      return `擊出${area}方向二壘安打`;
    case 'triple':
      return `擊出${area}方向三壘安打`;
    case 'homeRun':
      return `轟出${homeRunName(runs)}！`;
    case 'groundOut':
      return `${area}方向滾地球出局`;
    case 'flyOut':
      return `${area}方向高飛球被接殺`;
    case 'lineOut':
      return `${area}方向平飛球被接殺`;
    case 'sacrificeFly':
      return `${area}方向高飛犧牲打`;
    case 'doublePlay':
      if (ball?.type === 'ground')
        return `${area}方向滾地球，形成 ${notation} 雙殺`;
      if (ball?.type === 'fly')
        return `${area}高飛球被接殺，三壘跑者衝本壘遭觸殺，形成 ${notation} 雙殺`;
      return `${area}方向平飛球被接殺，跑者回壘不及，形成 ${notation} 雙殺`;
    case 'error':
      return `擊出${area}方向${BALL_TYPES[ball!.type]}，${FIELDER_TITLES[ball!.fielder]}失誤上壘`;
    case 'strikeout':
      return '被三振';
    case 'walk':
      return '獲得四壞球保送';
    case 'intentionalWalk':
      return '被故意四壞保送';
    case 'sacrificeBunt':
      return '犧牲觸擊成功';
    case 'buntPopOut':
      return '觸擊失敗，小飛球出局';
  }
}
