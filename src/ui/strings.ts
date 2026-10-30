// 所有介面文字集中在這裡，之後要加語系只改這個檔
import type {
  Alignment,
  BattedBall,
  Fielder,
  PitchResult,
  PlayKind,
} from '../sim/game';
import type { CardTier } from '../sim/generate';
import { EQUIPMENT, type EquipmentId, type RelicId } from '../sim/items';
import type { EventId } from '../sim/rest';
import type { PitchTraitId } from '../sim/pitches';
import type { Round } from '../sim/tournament';
import type { TraitId } from '../sim/traits';
import type { SynergyKey } from '../sim/synergy';
import type { Archetype, Bats, Hand, Position, Tendency } from '../sim/types';

export const T = {
  gameTitle: '骰子棒球',
  gameSubtitleLines: ['你是教練。隨機發一支球隊，', '剩下的交給你的判斷。'],
  quickMatch: '自由練習',
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
  subPinchHit: (inName: string, outName: string) =>
    `代打：${inName} 替換 ${outName}`,
  subPinchRun: (inName: string, outName: string) =>
    `代跑：${inName} 替換 ${outName}`,
  opponentPrefix: '對手',
  subPitcher: (inName: string, outName: string) =>
    `換投：${inName} 上場，${outName} 退場`,
  tacticSteal: (from: 1 | 2, name: string) =>
    `盜${from === 1 ? '二' : '三'}壘 ${name}`,
  tacticBunt: '犧牲觸擊',
  tacticHitAndRun: '打帶跑',
  lineupOnlyHint: '錦標賽開打後不能重骰，補強靠每場比賽後的獎勵',
  lineupDiceHint: (n: number) => (n > 0 ? `剩 ${n} 次球員重骰` : '沒有球員重骰了'),
  roundNames: {
    season: '例行賽',
    r16: '十六強',
    qf: '八強',
    sf: '四強',
    final: '決賽',
  } as Record<Round, string>,
  tournamentHeading: (round: string) => `錦標賽・${round}`,
  startTournament: '開始錦標賽',
  continueTournament: (round: string) => `繼續錦標賽（${round}）`,
  newTournament: '新的錦標賽',
  confirmOverwrite: '目前的錦標賽進度會被清除，確定要重新開始嗎？',
  overwriteConfirm: '清除並重新開始',
  nextGame: '調整陣容並開賽',
  nextOpponent: '下一個對手',
  finalGame: (n: number, user: number, opp: number) =>
    `決賽 第 ${n} 戰（系列 ${user}-${opp}）`,
  historyTitle: '戰績',
  continue: '繼續',
  // ---- 一輪：例行賽、季後賽、秘寶、裝備、獎勵 ----
  seasonGame: (n: number) => `例行賽 第 ${n} 場`,
  seasonRecord: (w: number, l: number) => `${w} 勝 ${l} 敗`,
  seasonNeed: (need: number, lossesLeft: number) =>
    need > 0 ? `還差 ${need} 勝晉級季後賽・還能輸 ${lossesLeft} 場` : '已確定晉級季後賽',
  playoffsTitle: '季後賽',
  playoffSeed: (n: number) => `第 ${n} 種子`,
  seedHint: '例行賽勝場越多，季後賽對手越弱',
  scheduleTitle: '賽程',
  relicsTitle: '秘寶',
  bagTitle: '背包',
  bagEmpty: '背包是空的',
  equippedTitle: '身上的裝備',
  noEquipped: '還沒有人帶裝備',
  equipHint: '點背包裡的裝備裝到球員身上，點身上的裝備卸下',
  relicPickTitle: '選擇起始秘寶',
  relicPickHint: '秘寶整輪都有效，決定這支隊伍的打法',
  rewardTitle: (won: boolean) => (won ? '贏球獎勵' : '輸球獎勵'),
  rewardHint: (won: boolean, n: number) => (won ? `從 ${n} 張卡中挑 1 張，或放棄` : `輸球也有收穫：從 ${n} 張卡中挑 1 張`),
  rewardKinds: { player: '球員', equipment: '裝備', relic: '秘寶', trait: '特性', pitchTrait: '球種特性', newPitch: '新球種' },
  pitchTraitName: (trait: string, pitch: string) => `${trait}${pitch}`,
  newPitchDesc: '親自配球多一種選擇；自動投球時打者更難跟上',
  pitchWho: (name: string) => `要讓哪位投手學會 ${name}？`,
  pitchLearned: (name: string, pitch: string) => `${name} 學會 ${pitch}`,
  pitchHas: '已經會了',
  noPitcherEligible: '沒有投手能學',
  pitchTraitTaken: '這個球種已有特性',
  pitchMissing: '不會這個球種',
  // ---- 潛能與覺醒 ----
  potentialLabel: '潛能',
  potentialTag: (stat: string, progress: number, need: number) => `？ ${stat} ${progress}/${need}`,
  potentialHint: (stat: string, need: number) => `這一輪累積 ${need} ${stat}就會覺醒，覺醒前不知道會得到什麼特性；訓練也能推進`,
  potentialStats: { hits: '支安打', hr: '支全壘打', rbi: '分打點', k: '次三振', outs: '個出局數' },
  potentialStatShort: { hits: '安打', hr: '全壘打', rbi: '打點', k: '三振', outs: '出局' },
  awakened: (name: string, trait: string) => `覺醒！${name} 獲得「${trait}」`,
  rewardCandidates: '獎勵卡',
  pickFirstCard: '先選一張卡',
  // ---- 休息站 ----
  funds: (n: number) => `資金 ${n}`,
  fundsEarned: (n: number) => `球團資金 +${n}`,
  refund: (n: number) => `釋出換回 ${n} 資金`,
  restTitle: '休息站',
  restHint: '選一個地方，之後前往下一場',
  restPlaces: {
    shop: { name: '商店', desc: '用球團資金買球員、裝備、秘寶、特性，也可以付費強化' },
    training: { name: '訓練', desc: '免費讓一位球員的一項能力 +1' },
    event: { name: '事件', desc: '碰碰運氣：每個選擇都有代價' },
  },
  enter: '進入',
  shopTitle: '商店',
  shopHint: '用球團資金補強；買球員就是交易，要換掉一名同角色的球員',
  buyFor: (price: number) => `買下・${price}`,
  sold: '已售出',
  notEnough: '資金不夠',
  bought: (name: string) => `買下 ${name}`,
  rerollShopFor: (cost: number) => `換一批商品・${cost}`,
  upgradeFor: (cost: number) => `付費強化・${cost}`,
  leaveShop: '離開商店，前往下一場',
  upgradeWho: '要強化誰？',
  trainWho: '要訓練誰？',
  whichRating: (name: string) => `${name} 要提升哪一項？`,
  ratingStep: (label: string, from: string, to: string) => `${label}：${from} → ${to}`,
  ratingUp: (name: string, rating: string) => `${name} 的${rating} +1`,
  trainingTitle: '訓練',
  trainingHint: '免費讓一位球員的一項能力 +1，訓練完前往下一場',
  train: '訓練',
  eventTitle: '事件',
  eventCost: (n: number) => `花 ${n} 資金`,
  eventPickWho: '選一位球員',
  eventDone: '事件結束，前往下一場',
  eventGot: (what: string) => `得到 ${what}`,
  eventGotTrait: (name: string, trait: string) => `${name} 染上了「${trait}」`,
  opponentRoster: '對手陣容',
  opponentRosterOf: (name: string) => `${name} 的陣容`,
  viewRoster: '陣容',
  traitFull: '特性已滿',
  traitHas: '已經會了',
  traitWrongRole: '角色不符',
  noTraits: '還沒有特性',
  skipReward: '放棄這次獎勵',
  rewardSkipped: '放棄這次獎勵',
  equipWho: (item: string) => `要把 ${item} 裝在誰身上？`,
  traitWho: (trait: string) => `要讓誰學會 ${trait}？`,
  relicTake: (relic: string) => `收下秘寶 ${relic}`,
  take: '收下',
  toBag: '先放進背包',
  equip: '裝上',
  unequip: '卸下',
  bagNoneUsable: '背包裡沒有他能帶的裝備',
  learn: '學會',
  replaceItem: (item: string) => `換下 ${item}`,
  noEligible: '沒有能學這個特性的球員',
  equipped: (item: string, name: string) => `${name} 裝上 ${item}`,
  stashed: (item: string) => `${item} 放進背包`,
  unequipped: (item: string, name: string) => `${name} 卸下 ${item}，放回背包`,
  learned: (name: string, trait: string) => `${name} 學會 ${trait}`,
  relicGained: (relic: string) => `獲得秘寶：${relic}`,
  joined: (pick: string, released: string) => `${pick} 加入，${released} 釋出`,
  pickEquipTarget: '裝到誰身上',
  pickReplace: (name: string) => `${name} 的裝備已滿，換下哪一件？`,
  equipmentCount: (n: number, max: number) => `裝備 ${n}/${max}`,
  advanced: '晉級季後賽！',
  oldSaveDiscarded: '錦標賽改版了，舊的錦標賽進度無法繼續；冠軍紀錄與裝扮都還在',
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
    swing: '親自出棒',
    aimPitch: '決勝球',
    throw: '配球',
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
  callStrikeout: '三振！',
  calledStrikeout: '站著被三振',
  speciesLabel: '球員頭像',
  speciesNames: { cat: '貓咪', dog: '小狗' },
  // ---- 難度、獎盃櫃、裝扮 ----
  levelNames: { 1: '新人', 2: '職業', 3: '明星', 4: '傳奇', 5: '名人堂' } as Record<number, string>,
  tierTag: (name: string) => `難度・${name}`,
  tierTitle: '選擇難度',
  tierMessage: '拿下冠軍就會開放下一級難度，並解鎖新的球員裝扮。',
  tierStrength: (n: number) => (n === 1 ? '對手和你差不多強' : `對手能力再提升 ${n - 1} 級`),
  tierReward: (outfit: string) => `首次奪冠解鎖：${outfit}`,
  tierCleared: '已通過',
  outfitNames: {
    standard: '標準',
    stripes: '條紋球衣',
    goldCap: '金色球帽',
    shades: '墨鏡',
    crown: '冠軍皇冠',
    gold: '黃金戰袍',
  },
  outfitLocked: (tier: string) => `通過「${tier}」解鎖`,
  outfitPicked: (name: string) => `裝扮換成「${name}」`,
  // ---- 自由練習 ----
  freePractice: '自由練習',
  practiceHint: '只打一場、不記錄任何結果。可以自己組隊、改能力，也能從球團史匯入冠軍隊伍。',
  practiceMine: '我方',
  practiceOpponent: '對手',
  randomTeam: '隨機球隊',
  randomTeamSub: '開打前可以重骰',
  randomOpponent: '隨機對手',
  opponentLevelSub: (level: string) => `強度：${level}錦標賽中段`,
  myTeams: '我的球隊',
  noCustomTeams: '還沒有自製球隊。新建一隊，或匯入冠軍隊伍。',
  newTeam: '新建球隊',
  importChampion: '匯入冠軍隊伍',
  importNone: '還沒有冠軍可以匯入',
  importWhich: '匯入哪一座冠軍？',
  imported: (name: string) => `已匯入「${name}」`,
  edit: '編輯',
  remove: '刪除',
  removeConfirm: (name: string) => `確定要刪除「${name}」嗎？`,
  removed: (name: string) => `已刪除「${name}」`,
  startPractice: '開始練習',
  editorTitle: '編輯球隊',
  autosaveHint: '修改會自動存檔；點球員編輯能力、特性、裝備與球種',
  teamNameLabel: '隊名',
  relicsHint: '點一下裝上或拿掉',
  arrangeLineup: '調整打序與守位',
  done: '完成',
  addLegend: '加入傳奇館球員',
  noLegends: '傳奇館還沒有球員',
  legendReplaceWho: (name: string) => `${name} 要取代誰？`,
  editPlayer: (name: string) => `編輯 ${name}`,
  playerName: '名字',
  handLabel: '慣用手',
  ratingsLabel: '能力',
  traitsLabel: '特性（最多 3 個，互斥的會互相取代）',
  equipLabel: '裝備（最多 2 件）',
  noneOption: '無',
  newPitchesLabel: '新球種',
  pitchTraitsLabel: '球種特性',
  savePlayer: '套用',
  practiceResult: '自由練習',
  // ---- 球團史 ----
  clubHistory: '球團史',
  clubHistoryCount: (n: number) => (n > 0 ? `球團史・${n} 座冠軍` : '球團史'),
  historyTabs: { champions: '冠軍', legends: '傳奇館', runs: '歷程', wardrobe: '衣櫃' },
  legendsEmpty: '還沒有傳奇。奪冠後可以從冠軍隊伍挑一位球員送進來。',
  runsEmpty: '還沒有打完任何一輪。錦標賽不論奪冠或淘汰，都會記在這裡。',
  runChampion: '奪冠',
  runRecord: (w: number, l: number) => `${w} 勝 ${l} 敗`,
  recapOpen: '奪冠回顧',
  recapTitle: (team: string) => `${team} 的奪冠回顧`,
  recapGames: '每一場',
  recapAwaken: '覺醒',
  recapGrowth: '成長（開打或加入時 → 奪冠時）',
  recapNone: '這座獎盃是改版前拿的，沒有回顧。',
  recapNoAwaken: '這一輪沒有人覺醒',
  mvpTag: (name: string) => `MVP ${name}`,
  awakenLine: (game: number, name: string, trait: string) => `第 ${game} 場後・${name} 覺醒「${trait}」`,
  legendInductTitle: '送一位球員進傳奇館',
  legendInductHint: '之後開新錦標賽時可以帶他加入：能力值每項 −1，保留特性',
  inducted: (name: string) => `${name} 進入傳奇館`,
  legendFrom: (team: string, tier: string) => `${team}・${tier}冠軍`,
  legendPickTitle: '帶一位傳奇加入？',
  legendPickMessage: '能力值每項 −1，保留特性，不帶裝備與球種特性；會取代同角色總評最低的一位。',
  legendSkip: '不帶，全隊隨機',
  legendJoined: (name: string) => `${name} 從傳奇館歸隊`,
  wardrobeHint: '我方球員的頭像換上裝扮。通過越高的難度，解鎖越多款式。',
  current: '使用中',
  trophyEmpty: '還沒有獎盃。拿下錦標賽冠軍，這支隊伍就會留在這裡。',
  trophyFinal: (user: number, opp: number) => `決賽 ${user}:${opp}`,
  trophyBest: (tier: string) => `最高通過難度：${tier}`,
  trophyNone: '還沒通過任何難度',
  championTier: (tier: string) => `「${tier}」難度冠軍`,
  unlockOutfit: (name: string) => `解鎖新裝扮：${name}`,
  unlockTier: (tier: string) => `開放新難度：${tier}`,
  locked: '未解鎖',
  // ---- 左右投打與成長 ----
  bats: { L: '左打', R: '右打', S: '兩打' } as Record<Bats, string>,
  throws: { L: '左投', R: '右投' } as Record<Hand, string>,
  matchupNames: { same: '同側', opposite: '對側' },
  matchupTips: {
    same: '同側對決：打者打擊下修',
    opposite: '對側對決：打者比較有利',
  },
  matchupLabel: '對決',
  growthTitle: '本場成長',
  mvpTitle: '本場 MVP',
  noGrowth: '這場沒有人成長，下一場再加油',
  growthHint: '錦標賽中表現好的球員會成長：MVP 能力 +1，其他表現好的 +0.5',
  batterLine: (l: { pa: number; hits: number; hr: number; rbi: number }) =>
    `${l.pa} 打席 ${l.hits} 安${l.hr ? ` ${l.hr} 轟` : ''}${l.rbi ? ` ${l.rbi} 打點` : ''}`,
  pitcherLine: (l: { outs: number; k: number; runs: number }) =>
    `${Math.floor(l.outs / 3)}${l.outs % 3 ? `.${l.outs % 3}` : ''} 局 ${l.k} 三振 ${l.runs} 失分`,
  // ---- 守備佈陣與擊球傾向 ----
  tendencyLabel: '擊球方向',
  tendencyNames: {
    left: '偏左外野',
    even: '平均',
    right: '偏右外野',
  } as Record<Tendency, string>,
  tendencyShort: { left: '偏左', even: '平均', right: '偏右' } as Record<
    Tendency,
    string
  >,
  alignmentTitle: '守備佈陣',
  alignmentNames: {
    normal: '標準',
    shiftLeft: '偏左佈陣',
    shiftRight: '偏右佈陣',
    infieldIn: '內野前進',
    outfieldBack: '外野後退',
  } as Record<Alignment, string>,
  alignmentShort: {
    normal: '標準',
    shiftLeft: '偏左',
    shiftRight: '偏右',
    infieldIn: '內野前進',
    outfieldBack: '外野後退',
  } as Record<Alignment, string>,
  alignmentNotes: {
    normal: '一般站位',
    shiftLeft: '野手往左外野方向移',
    shiftRight: '野手往右外野方向移',
    infieldIn: '三壘跑者回不來，但滾地球較易穿過',
    outfieldBack: '少被打長打，但前方空出來',
  } as Record<Alignment, string>,
  alignmentHint: (batter: string, tendency: string) =>
    `${batter} 擊球方向：${tendency}。只對這位打者有效`,
  hitChange: (pct: number) =>
    pct === 0 ? '±0%' : `被安打 ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
  aligned: (name: string) => `守備改成「${name}」，只對這位打者有效`,
  tagAlignment: '佈陣',
  enemyAligned: (name: string) => `對手改成「${name}」`,
  enemyAlignment: (name: string) => `對手採取「${name}」`,
  enemyAlignmentEffect: (pct: number) =>
    `這位打者安打率 ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
  enemyAlignmentTip: {
    shift:
      '可以用觸擊（對偏移佈陣成功率提高），或換上擊球方向不同的代打。換人後對手會重新佈陣',
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
  takeOverNames: { swing: '親自出棒', aimPitch: '決勝球', throw: '配球' },
  meterHint: '紅線來到黃色區時點一下',
  meterSkip: '這球交給球員',
  manualLabel: '親自操作',
  manualStates: { off: '關', clutch: '關鍵', all: '每球' },
  manualToast: {
    off: '親自操作：關，全部交給球員',
    clutch: '親自操作：關鍵，關鍵打席由你出手',
    all: '親自操作：每球，每一球都由你出手',
  },
  keyAtBatToast: {
    hero: '英雄時刻！一支安打就能改寫比分，這個打席由你出手',
    basesLoaded: '滿壘危機！這個打席由你配球',
    milestone: '差一步！這個打席有機會讓球員覺醒，由你出手',
    crunch: '一分差、二三壘有人！這個打席由你出手',
  },
  meterGrades: {
    perfect: '完美！',
    good: '不錯！',
    early: '太早了',
    late: '太晚了',
    miss: '失投',
  },
  meterLog: (kind: 'swing' | 'aimPitch', grade: string) =>
    `${kind === 'swing' ? '親自出棒' : '決勝球'}：${grade}`,
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
  aimMarks: { pull: '拉打', center: '中間', oppo: '推打' },
  swingLog: (grade: string, aim: string, pitch: string) =>
    `親自出棒：${grade}（${aim}）・對方投${pitch}`,
  throwLog: (pitch: string, grade: string) => `配球：${pitch}（${grade}）`,
  pitchCallTitle: '配球',
  pitchCallHint: '點一個球種開始投',
  primaryPitch: '專長',
  repeatedPitch: '剛投過',
  repeatWarning: '同一個打席連投同一種球，打者比較容易抓到',
  drawHint: (pitch: string) => `照著虛線畫出${pitch}`,
  drawKeys: '或用方向鍵',
  drawBack: '重選',
  drawBackwards: '方向畫反了：從綠點畫向箭頭',
  tempoNames: { fast: '要快', medium: '中等速度', slow: '要慢' },
  tempoOff: {
    fast: (pitch: string) => `太快了：${pitch}要畫慢一點`,
    slow: (pitch: string) => `太慢了：${pitch}要畫快一點`,
  },
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
  replaceWho: (name: string, role: string) => `${name} 要替換哪一名${role}？`,
  pickFirst: '先從上面選一名球員',
  orderNth: (n: number) => `第 ${n} 棒`,
  replace: '換掉',
  halfTop: '局上',
  halfBottom: '局下',
  tiredTag: '疲勞',
  promptLabel: '決策提示',
  tierNames: {
    bronze: '銅卡',
    silver: '銀卡',
    gold: '金卡',
    rainbow: '彩虹卡',
  } as Record<CardTier, string>,
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
  swapPositionOrder: '交換守位／棒次',
  close: '關閉',
  swapPick: (name: string) => `選擇要和 ${name} 交換的球員`,
  swapped: (a: string, b: string) => `${a} 已與 ${b} 交換`,
  rerolledPlayer: (from: string, to: string) => `${from} 重骰為 ${to}`,
  rerolledTeam: (left: number) => `整隊重骰完成，剩 ${left} 次`,
  renamed: (name: string) => `隊名改為 ${name}`,
  walkedIntentionally: (name: string) => `故意四壞：${name}`,
  swapHintLineup: '點球場上的人交換守位，點打序列表交換棒次',
  designatedHitter: '指定打擊',
  primaryLabel: '本職守位',
  archetypeLabel: '流派',
  archetypeEditHint: '四選一，決定他算進哪個流派羈絆',
  primaryEditHint: '八選一。指定打擊誰都能擔任，不用選；守本職以外的守位時守備會打折。',
  positionColumn: '守位',
  trade: '交易',
  replaceWhoTitle: (name: string) => `${name} 要換掉誰？`,
  recommended: '推薦',
  topPick: '最推薦',
  othersCount: (n: number) => `其他 ${n} 人`,
  netChange: '能力',
  replaceHim: '換他',
  loseCaptain: '失去隊長',
  resultSynergyHint: '本場啟動過的羈絆，與它促成的結果',
  lostAtInning: (n: number) => `第 ${n} 局失效`,
  assistSummary: (text: string) => `羈絆促成：${text}`,
  assistNames: {
    homeRun: '全壘打',
    extraBase: '長打',
    hit: '安打',
    steal: '盜壘',
    advance: '多跑一個壘',
    avoidK: '避開三振',
    walk: '保送',
    errorSaved: '少一次失誤',
    hitSaved: '攔下安打',
    doublePlay: '雙殺',
    caughtStealing: '阻殺',
  },
  statPower: (hr: number, k: number) => `力量型 ${hr} 轟、${k} 次三振`,
  statSpeed: (sb: number) => `速度型盜壘成功 ${sb} 次`,
  statSkill: (k: number, bb: number) => `技巧型 ${k} 次三振、${bb} 次保送`,
  statDefense: (e: number) => `全隊失誤 ${e}`,
  statMiddle: (dp: number) => `雙殺 ${dp}`,
  statBattery: (bb: number, cs: number) => `保送 ${bb}、阻殺盜壘 ${cs}`,
  assistLog: (name: string) => `〔${name}〕`,
  opponentAssist: (name: string) => `對手・${name}`,
  assistCallout: (name: string) => `${name}促成`,
  synergiesOf: (team: string) => `${team} 的羈絆`,
  noticeBecause: (name: string) => `${name} 退場`,
  captainLeft: '隊長離場，本場沒有隊長',
  loseCaptainGame: '失去隊長，本場不遞補',
  offPositionNextInning: (pos: string) => `下局起${pos}非本職`,
  showRatingChange: '看能力變化 ›',
  hideRatingChange: '收起能力變化',
  noRatingChange: '能力等級都不變',
  replaceNative: (name: string, pos: string) => `${name}在${pos}是本職`,
  replaceOffPosition: (name: string, pos: string) => `${name}守${pos}是非本職，守備會打折`,
  replaceLosesTraits: (n: number) => `換掉會失去他的 ${n} 個特性`,
  bestGain: '最多能讓',
  gainText: (name: string, from: number, to: number, upgrade: boolean) => `${name} ${from}→${to} ${upgrade ? '升級' : '啟動'}`,
  swapping: '交換中',
  bothOffPosition: '兩人都非本職',
  nameOffPosition: (name: string) => `${name}非本職`,
  bestArrangement: '最多羈絆排法',
  bestArrangementHint: '從先發加板凳中，排出羈絆最多、沒人守非本職的陣容',
  alreadyBest: '現在已經是羈絆最多的排法',
  arrangeNow: '現在',
  arrangeAfter: '排完',
  arrangeChanges: (n: number) => `要做的改動（${n} 項）`,
  arrangeIn: (name: string, pos: string, native: boolean, out: string) => `${name} 上場${pos === '指定打擊' ? '當指定打擊' : `守${pos}`}${native && pos !== '指定打擊' ? '（本職）' : ''}，${out} 下板凳`,
  arrangeMove: (name: string, from: string, to: string, native: boolean) => `${name} 從${from}改守${to}${native ? '（本職）' : ''}`,
  offPositionChange: (from: number, to: number) => `非本職 ${from} 人 → ${to} 人`,
  arrangeLosesCaptain: '隊長會下板凳，排完要重新指定隊長',
  arrangeNote: '上場的人接下場那人的棒次，其他人的棒次不動。套用後還可以自己再改。',
  applyArrangement: '套用這個排法',
  arrangeApplied: '已套用最多羈絆排法',
  playerDetailOf: (name: string) => `${name} 的資料`,
  benchNoSynergy: '板凳（不算羈絆）',
  myBattingOrder: '我方打序',
  openBattingOrder: '打開我方打序',
  battingOrderHint: '9 人・點開調整棒次',
  battingOrderSheetHint: '點兩個人交換棒次（不影響羈絆）。點頭像打開球員資料，可以設為隊長。',
  synergyTitle: '羈絆',
  synergyLineupOnly: '只算先發 9 人',
  synergyActiveCount: (n: number) => `已啟動 ${n}`,
  synergyStatus: ['未啟動', '已啟動・3 人階', '已升級・5 人階'] as const,
  synergyTierLabel: (n: number) => `${n} 人`,
  synergyCurrent: '・目前',
  synergyHint: (tier: number, missing: number) => (tier === 2 ? '已達最高階' : tier === 1 ? `還差 ${missing} 人升級` : `還差 ${missing} 人啟動`),
  synergyCount: (count: number, need: number) => `${count}/${need}`,
  synergyMembers: (n: number) => `算進去的人（${n}）`,
  synergyBenchNote: (names: string) => `板凳的${names}也是這個流派，但板凳不算羈絆。`,
  synergyIn: '他在哪些羈絆裡',
  synergyNoteActive: (missing: number, tier: number) => (tier === 2 ? '已達最高階' : `再 ${missing} 人${tier === 1 ? '就升級' : '上場就啟動'}`),
  synergyCaptainNote: (weight: number) => `他是隊長，算 ${weight} 人`,
  synergyBenchSelf: '他在板凳，板凳不算羈絆',
  collapseSynergy: '收合羈絆',
  expandSynergy: '展開羈絆',
  captainLabel: '隊長',
  captainCounts: (weight: number) => `隊長・算 ${weight} 人`,
  setCaptain: '設為隊長',
  isCaptain: '已是隊長',
  captainOnlyLineup: '板凳球員不能當隊長',
  noCaptain: '還沒指定隊長：點一位打者，在資料面板裡設為隊長',
  captainRule: (weight: number) => `隊長在自己流派的人數中算 ${weight} 人。換隊長免費，比賽之間隨時可以換`,
  captainNow: (name: string, title: string) => `目前隊長：${name}（${title}）。換隊長免費，比賽之間隨時可以換`,
  captainSet: (name: string, title: string) => `${name} 成為${title}`,
  mySynergies: '我方羈絆',
  noSynergy: '還沒有啟動的羈絆',
  noSynergyShort: '無',
  middleOk: '二壘、游擊都守本職',
  positionOk: (title: string, name: string) => `${title} ${name} 守本職`,
  positionOff: (title: string, name: string) => `${title} ${name} 非本職`,
  positionOn: '成立',
  positionOffShort: '未成立',
  positionTierLabel: '成立時',
  positionMembers: '站在這些守位的人',
  positionYou: (name: string) => `他守本職，${name}成立`,
  positionBecause: (pos: string, title: string) => `因為他守${pos}是非本職；換本職的${title}上來就成立`,
  diffUp: (name: string) => `${name} 升級`,
  diffActivate: (name: string) => `${name} 啟動`,
  diffFormed: (name: string) => `${name} 成立`,
  diffLose: (name: string) => `${name} 失效`,
  diffDown: (name: string) => `${name} 降階`,
  diffCount: (name: string, from: number, to: number) => `${name} ${from}→${to}`,
  upgradeWord: '升級',
  activateWord: '啟動',
  synergyMissing: (n: number) => `差 ${n}`,
  synergySummary: (active: number, near: boolean) => `已啟動 ${active}${near ? '・最接近 1' : ''}`,
  scoutingLine: (parts: string[]) => `他們${parts.join('；')}。`,
  oppOrderSub: '9 人・流派與本職',
  oppPitcherSub: '沒有流派',
  oppBenchSub: '不算羈絆',
  benchMark: '替',
  viewOpponent: '看對手陣容',
  opponentSynergies: '對手羈絆',
  relicLink: (name: string) => `連動：${name}`,
  yourTeam: '你的隊伍',
  archetypeCount: (type: string, n: number) => `${type} ${n} 人`,
  relicNow: (who: string, synergy: string, upgrade: boolean) => `${who}：${synergy} 立刻${upgrade ? '升級' : '啟動'}`,
  relicProgress: (who: string, synergy: string, count: string, missing: number) => `${who}：${synergy} ${count}，再 ${missing} 人升級`,
  relicNoCaptain: '還沒指定隊長；指定後他算 3 人',
  relicCaptain: (name: string, synergy: string, from: number, to: number, result: string) =>
    `隊長 ${name} 算 3 人：${synergy} ${from} → ${to}${result ? `，${result}` : ''}`,
  relicCount: (n: number) => `${n} 個`,
  closestSynergy: (name: string, missing: number) => `${name} 還差 ${missing} 人`,
  primaryChip: (pos: string) => `本職 ${pos}`,
  primaryNote: (pos: string) => `（本職${pos}）`,
  primaryShort: (pos: string) => `本職${pos}`,
  offPosition: '非本職',
  fieldingDrop: (from: string, to: string) => `守 ${from}→${to}`,
  offPositionTitle: (pos: string, from: string, to: string) => `目前守${pos}（非本職）：守備 ${from} → ${to}`,
  offPositionWhy: (penalty: number, primary: string) =>
    `${penalty === 1 ? '同為內野或同為外野' : penalty === 3 ? '非捕手去守捕手' : '內外野互換'}，守備 −${penalty}。回到${primary}就恢復。`,
  primaryFielding: (grade: string) => `本職 ${grade}`,
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
  gameRecord: (round: string, won: boolean, u: number, o: number) =>
    `${round}　${won ? '勝' : '敗'} ${u}:${o}`,
  tacticPinchHit: '代打',
  tacticPinchRun: (base: 1 | 2 | 3, runner: string) =>
    `代跑 ${['一', '二', '三'][base - 1]}壘 ${runner}`,
  tacticChangePitcher: '換投',
  tacticIntentionalWalk: '故意四壞',
  tacticDefensiveSub: (pos: string, out: string, inName: string) =>
    `守備替補 ${pos} ${out} → ${inName}`,
  subDefense: (inName: string, outName: string) =>
    `守備替補：${inName} 替換 ${outName}`,
  swappedPositions: (a: string, b: string) => `${a} 與 ${b} 交換守位`,
  swappedOrder: (a: string, b: string) => `${a} 與 ${b} 交換棒次`,
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

/** 看對手時的一句話描述，接在「他們」後面 */
export const SYNERGY_SCOUTING: Record<SynergyKey, string> = {
  power: '長打多，但三振也多',
  speed: '跑得快，常盜壘、多跑壘',
  skill: '很難被三振，也很會選球',
  defense: '守備很硬，失誤少',
  middle: '雙殺也更容易成功',
  battery: '投手控球穩，也不好盜壘',
};

export const CAPTAIN_TITLES: Record<Archetype, string> = {
  power: '重砲隊長',
  speed: '速度隊長',
  skill: '技巧隊長',
  defense: '防守隊長',
};

/** 流派羈絆 3 人階與 5 人階的效果 */
export const SYNERGY_DESC: Record<SynergyKey, [string, string?]> = {
  power: ['力量型打者更容易打出全壘打與長打，但三振也變多', '全壘打與長打再提升，三振再增加'],
  speed: ['速度型球員盜壘更容易成功，安打時更常多跑一個壘，滾地球也更容易跑成內野安打', '盜壘、跑壘與內野安打再提升'],
  skill: ['技巧型打者三振變少、保送變多，兩好球後也更容易打出安打', '三振再減少、保送再增加'],
  defense: ['全隊守備失誤變少，守備範圍變大', '失誤再減少，部分安打變成出局'],
  middle: ['二壘手、游擊手都守本職：雙殺更容易成功，二游失誤變少'],
  battery: ['捕手守本職：我方投手控球提升，捕手更容易阻殺盜壘'],
};

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

export const PROMPT_NAMES = {
  few: '少',
  many: '多',
  pitcher: '只提醒換投',
  off: '關閉',
} as const;

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

export const EQUIPMENT_NAMES: Record<EquipmentId, string> = {
  trainingBat: '練習球棒',
  masterBat: '名匠球棒',
  weightedBat: '加重球棒',
  compressedBat: '壓縮木棒',
  legendBat: '傳說球棒',
  spikes: '釘鞋',
  carbonSpikes: '碳纖釘鞋',
  leatherGlove: '皮革手套',
  goldGlove: '金手套',
  gripBag: '止滑粉袋',
  precisionSleeve: '精準臂套',
  elbowGuard: '加壓護肘',
  fireballGlove: '火球手套',
  enduranceBand: '耐力護腕',
  goldenSleeve: '黃金臂套',
};

/** 裝備的效果，例如「打擊 +1・力量 +2」 */
export function equipmentDesc(id: EquipmentId): string {
  return Object.entries(EQUIPMENT[id].bonus)
    .map(([k, v]) => `${RATING_FULL[k as keyof typeof RATING_FULL]} +${v}`)
    .join('・');
}

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

/** 休息站的事件：標題、情境、兩個選項 */
export const EVENT_TEXT: Record<EventId, { title: string; body: string; options: [string, string] }> = {
  fanMeet: {
    title: '球迷見面會',
    body: '球迷擠滿了球場外的廣場，大家都想跟球員合照。',
    options: ['辦簽名會：資金 +40', '派一位打者上台分享：他的打擊 +1'],
  },
  undergroundTraining: {
    title: '地下特訓',
    body: '有位退休強打開了一間只練長打的祕密打擊場。',
    options: ['送一位打者去練：力量 +2、守備 −1', '不去了'],
  },
  visitingCoach: {
    title: '名投手教練來訪',
    body: '一位傳奇投手教練路過，願意收費指導一位投手。',
    options: ['付學費：一位投手學會隨機一個投手特性', '婉拒'],
  },
  lateNight: {
    title: '加練到深夜',
    body: '球員們自動留下來加練，教練要決定練什麼。',
    options: ['全隊練跑壘：先發九人速度 +0.5', '一位投手練長投：體力 +1'],
  },
  sponsor: {
    title: '贊助商上門',
    body: '一家飲料公司開出不錯的條件，但代言行程很操。',
    options: ['簽約：資金 +80，但隨機一位球員染上一個紅特', '婉拒'],
  },
  fleaMarket: {
    title: '二手球具市集',
    body: '市集裡堆滿了舊球具，說不定能挖到寶。',
    options: ['花錢挖寶：隨機一件裝備放進背包', '只逛不買'],
  },
  mysteriousElder: {
    title: '神祕老人',
    body: '一位老人說他手上有一件被遺忘的寶物，只是要價不低。',
    options: ['買下：隨機一個沒有的秘寶', '轉身離開'],
  },
  rehab: {
    title: '復健中心',
    body: '球團新蓋的復健中心開幕，可以安排一位球員全面調整。',
    options: ['安排一位球員：每項能力 +0.5', '把時段租出去：資金 +30'],
  },
};

export const RELIC_NAMES: Record<RelicId, string> = {
  leadoff: '開路先鋒',
  speedster: '飛毛腿',
  deepRelief: '後援陣容',
  stamina: '耐力訓練',
  rispSoul: '得點圈之魂',
  ironWall: '鐵壁',
  comeback: '逆轉魂',
  strikeZone: '好球帶',
  patience: '選球眼',
  powerHouse: '重砲軍團',
  guardian: '守護神',
  dynasty: '王朝',
  powerFactory: '全壘打工廠',
  runSchool: '跑壘學校',
  hitClass: '打擊教室',
  ironCurtain: '銅牆鐵壁',
  captainBand: '隊長臂章',
};

export const RELIC_DESC: Record<RelicId, string> = {
  leadoff: '每個半局的第一位打者打擊 +2',
  speedster: '全隊盜壘成功率提升，跑壘更積極',
  deepRelief: '後援投手球威 +1',
  stamina: '投手多投 15 球才會疲勞',
  rispSoul: '得點圈有人時全隊打擊 +1',
  ironWall: '全隊守備 +1',
  comeback: '第 7 局起落後時全隊打擊 +1.5',
  strikeZone: '全隊投手控球 +1',
  patience: '全隊比較不會追打壞球',
  powerHouse: '全隊擊出全壘打的機率提高 25%',
  guardian: '第 9 局起我方投手球威 +1.5',
  dynasty: '全隊打擊、力量、球威、控球都 +0.5',
  powerFactory: '重砲打線 2 人啟動、4 人升級',
  runSchool: '快腿球隊 2 人啟動、4 人升級',
  hitClass: '精準打線 2 人啟動、4 人升級',
  ironCurtain: '鐵壁球隊 2 人啟動、4 人升級',
  captainBand: '隊長在自己流派的人數中算三人',
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
