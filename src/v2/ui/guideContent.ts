// 遊戲指南（設計稿 p7 IdGuide）的章節內容。數字一律從 config 讀，改 config 指南會跟著變；
// 第 8 章是正式的競技積分與降級規則（Phase 7B），數字都從 RANKED_CONFIG 讀。
import { IDLE_CONFIG, REWARD_CONFIG } from '../domain/config'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from '../domain/leagueConfig'
import { MAX_LEVEL, RECRUIT_CONFIG } from '../domain/progressionConfig'
import type { IconName } from './icons'
import { RANKED_CONFIG } from '../domain/leagueConfig'
import { POSITION_SYNERGY_FIELDING, SYNERGY_KEYS, captainWeight, thresholds } from '../../sim/synergy'
import { gradeOf } from '../../ui/grades'
import { ARCHETYPE_NAMES, SYNERGY_NAMES } from '../../ui/strings'
import { SYNERGY_DESC, synergyEffects } from '../../ui/synergyInfo'

export interface GuideCard {
  icon: IconName
  title: string
  text: string
  /** 重點：黑底白字 */
  tag?: 'key'
}

export type GuideVisual =
  | { kind: 'flow'; steps: { icon: IconName; label: string }[] }
  | { kind: 'stats'; items: { value: string; label: string }[] }
  | { kind: 'grades' }
  | { kind: 'leagues' }
  | { kind: 'points' }

export interface GuideChapter {
  id: string
  short: string
  title: string
  icon: IconName
  summary: string
  visual?: GuideVisual
  cards: GuideCard[]
  faq?: { q: string; a: string }[]
}

const n = (x: number) => x.toLocaleString('zh-Hant')
const pct = (x: number) => `${Math.round(x * 100)}%`

export function guideChapters(): GuideChapter[] {
  const minutes = IDLE_CONFIG.MATCH_INTERVAL_MS / 60_000
  const perHour = 60 / minutes
  const offlineH = IDLE_CONFIG.MAX_OFFLINE_MS / 3_600_000
  const R = REWARD_CONFIG
  const maxWin = R.win.funds + R.maxRunFunds
  const maxLoss = R.loss.funds + R.maxRunFunds
  const P = PROMOTION_CONFIG
  const rc = RECRUIT_CONFIG
  const top = LEAGUES[MAX_TIER]
  const rk = RANKED_CONFIG
  const name = (t: number) => LEAGUES[t].name
  return [
    {
      id: 'intro',
      short: '介紹',
      title: '遊戲介紹',
      icon: 'club',
      summary: '經營自己的棒球隊：安排好陣容，球隊會自動比賽；回來領取收益，養成與招募球員，一路從新秀聯盟爬到傳奇聯盟。',
      visual: { kind: 'flow', steps: [{ icon: 'lineup', label: '安排球隊' }, { icon: 'play', label: '自動比賽' }, { icon: 'claim', label: '領取收益' }, { icon: 'upgrade', label: '養成・招募' }] },
      cards: [
        { icon: 'clock', title: '不用一直盯著', text: '比賽由教練 AI 自動打完，離開網站也會繼續。一天上線幾次、每次幾分鐘就夠了。', tag: 'key' },
        { icon: 'club', title: '首頁就是起點', text: '「目前建議」同一時間只告訴你一件最值得做的事，照著做就不會迷路。' },
        { icon: 'league', title: '長期目標', text: `從${LEAGUES[0].name}開始，晉級到更強的聯盟，收益也會跟著提高。` },
      ],
    },
    {
      id: 'match',
      short: '比賽',
      title: '比賽與放置規則',
      icon: 'clock',
      summary: `球隊每 ${minutes} 分鐘自動打完一場比賽。離線期間也會繼續，最多累積 ${offlineH} 小時，回來時一次結算。`,
      visual: { kind: 'stats', items: [{ value: `${minutes}:00`, label: '每場比賽' }, { value: String(perHour), label: '每小時場數' }, { value: `${offlineH} 小時`, label: '離線最多累積' }, { value: String(IDLE_CONFIG.MAX_BATCH_MATCHES), label: '一次最多結算' }] },
      cards: [
        { icon: 'clock', title: '離線最多 8 小時', text: `超過 ${offlineH} 小時的部分不會再累積比賽。睡前、起床各看一次就不會浪費。`, tag: 'key' },
        { icon: 'play', title: '可以觀看直播', text: '首頁的「目前比賽」可以看正在進行的那一場；不看也不會影響結果。' },
        { icon: 'lock', title: '結果不會因為觀看改變', text: '每一場都用固定的種子模擬，重新整理、開好幾個分頁、重看 Replay 都不會重算，也不會重複發獎勵。' },
      ],
    },
    {
      id: 'economy',
      short: '資金',
      title: '資金與經驗',
      icon: 'coin',
      summary: '每場比賽都會得到資金與經驗，先累積在「未領取收益」，要手動領取後才能使用。',
      visual: { kind: 'stats', items: [{ value: `${R.win.funds}～${maxWin}`, label: '勝場資金' }, { value: `${R.loss.funds}～${maxLoss}`, label: '敗場資金' }, { value: `${R.win.experience} / ${R.loss.experience}`, label: '勝／敗經驗' }, { value: `×${LEAGUES[0].rewardMultiplier.toFixed(2)}～×${top.rewardMultiplier.toFixed(2)}`, label: '聯盟收益倍率' }] },
      cards: [
        { icon: 'claim', title: '收益要手動領取', text: '比賽結束後，資金與經驗先放在未領取收益。領取不花任何東西，按一次就好。', tag: 'key' },
        { icon: 'coin', title: '得分換資金', text: `每得 1 分多 ${R.fundsPerRun} 資金，最多 ${R.maxRunFunds}。輸球也有基本收益。` },
        { icon: 'league', title: '聯盟越高收益越多', text: `收益會乘上聯盟倍率，${top.name}是 ×${top.rewardMultiplier.toFixed(2)}。` },
      ],
    },
    {
      id: 'growth',
      short: '養成',
      title: '球員養成',
      icon: 'upgrade',
      summary: `用資金和經驗讓球員升級（Lv.1～${MAX_LEVEL}），能力會跟著提高。能力用 S～G 的字母等級表示。`,
      visual: { kind: 'grades' },
      cards: [
        { icon: 'upgrade', title: '先培養上場的人', text: '只有上場的球員會影響比賽。首頁建議會先挑先發打者與先發投手。', tag: 'key' },
        { icon: 'exp', title: '等級越高成本越高', text: '每一級提升會變少、成本變高，平均養成通常比全部押在一個人身上划算。' },
        { icon: 'report', title: '戰績也看運氣', text: '近期戰績受對手、主客場與運氣影響，升級後不一定馬上看到勝率變化。' },
      ],
    },
    {
      id: 'recruit',
      short: '招募',
      title: '招募市場',
      icon: 'recruit',
      summary: `每次招募有三位候選人可以選，確認簽約才扣資金。球團最多 ${rc.maxPlayers} 人。`,
      visual: { kind: 'stats', items: [{ value: n(rc.baseFunds), label: '第 1 次' }, { value: n(rc.baseFunds + rc.stepFunds), label: '第 2 次' }, { value: n(rc.baseFunds + rc.stepFunds * 2), label: '第 3 次' }, { value: `+${n(rc.stepFunds)}`, label: '之後每次' }] },
      cards: [
        { icon: 'recruit', title: '三選一', text: '候選人會跟你目前同位置的球員比較，看得出會不會變強。', tag: 'key' },
        { icon: 'lineup', title: '簽約後記得換上場', text: '新球員先進預備名單，到陣容頁換上場才會影響比賽。' },
        { icon: 'release', title: '名單滿了可以釋出', text: `超過 ${rc.maxPlayers} 人時要先釋出預備球員才能再招募。釋出前會再確認一次。` },
      ],
    },
    {
      id: 'lineup',
      short: '陣容',
      title: '陣容與戰術',
      icon: 'tactics',
      summary: '上場 14 人：9 名先發打者、2 名板凳、1 名先發投手、2 名後援。戰術選一種球隊風格（均衡、強攻、機動、守備）就能玩，進階設定可以再調跑壘、後段調度與犧牲觸擊。',
      visual: { kind: 'stats', items: [{ value: '9', label: '先發打者' }, { value: '2', label: '板凳' }, { value: '1', label: '先發投手' }, { value: '2', label: '後援' }] },
      cards: [
        { icon: 'lineup', title: '注意守位', text: '盡量讓打者守本職位置；「自動排陣」會排出盡量沒人守非本職的陣容。', tag: 'key' },
        { icon: 'save', title: '改完要儲存', text: '陣容與戰術改完按儲存才會生效，從下一場比賽開始用。' },
        { icon: 'tactics', title: '戰術是比賽中的選擇', text: '強攻型不觸擊、讓強打者自己打；機動型多盜壘、打帶跑、代跑；守備型提早換投、後段領先換上守備好的替補。戰術頁會依先發陣容推薦一種風格，每場戰報的「本場戰術」列出實際做了什麼。' },
      ],
    },
    synergyChapter(),
    {
      id: 'promotion',
      short: '晉級',
      title: '聯盟晉級',
      icon: 'league',
      summary: `一共 ${LEAGUES.length} 個聯盟。達成條件後可以挑戰晉級，贏了就升上下一級；對手更強，收益也更高。${name(rk.enabledFromTier)}起有競技積分，${name(rk.relegationTiers[0])}、${name(rk.relegationTiers[1])}積分歸零會降級（見下一章）。`,
      visual: { kind: 'leagues' },
      cards: [
        { icon: 'report', title: `${P.minMatches} 場・勝率 ${pct(P.winRate)}`, text: `在本聯盟完成 ${P.minMatches} 場，而且最近 ${P.window} 場勝率 ${pct(P.winRate)} 以上，就能挑戰晉級。`, tag: 'key' },
        { icon: 'challenge', title: '晉級挑戰賽', text: '挑戰賽用目前儲存的陣容，對手比下一級的一般對手更強。結果一開打就決定並存檔。' },
        { icon: 'clock', title: `失敗後 ${P.retryAfterMatches} 場冷卻`, text: `挑戰失敗不會有損失，再完成 ${P.retryAfterMatches} 場一般比賽就能再挑戰。` },
        { icon: 'coin', title: '首次晉級獎勵', text: '第一次升上某個聯盟會得到一次性的資金與經驗，同一個聯盟只發一次；降級後再升回去不會再發。' },
        { icon: 'challenge', title: '積分不影響晉級', text: `就算積分很低也能挑戰晉級；積分滿 ${rk.maxPoints} 分也不代表可以晉級。晉級只看場數、勝率與挑戰賽。`, tag: 'key' },
      ],
    },
    {
      id: 'ranked',
      short: '積分',
      title: '競技積分與降級',
      icon: 'challenge',
      summary: `從${name(rk.enabledFromTier)}開始，每場一般比賽會加減競技積分（${rk.minPoints}～${rk.maxPoints}）。${name(rk.relegationTiers[0])}、${name(rk.relegationTiers[1])}積分歸零會降一級；${name(rk.relegationFloorTier)}是保底，不會降回${name(rk.enabledFromTier - 1)}。`,
      visual: { kind: 'points' },
      cards: [
        { icon: 'challenge', title: `勝 +${rk.winPoints}／敗 −${-rk.lossPoints}`, text: `只有一般比賽計分，晉級挑戰賽不計分。積分最高 ${rk.maxPoints}、最低 ${rk.minPoints}；晉級或降級後從 ${rk.initialPoints} 分開始。`, tag: 'key' },
        { icon: 'league', title: `${name(rk.relegationFloorTier)}是保底`, text: `${name(rk.relegationFloorTier)}積分 ${rk.minPoints} 分也不會降回${name(rk.enabledFromTier - 1)}，新秀、業餘沒有積分、只升不降。` },
        { icon: 'alert', title: '積分歸零會降級', text: `${name(rk.relegationTiers[0])}歸零降回${name(rk.relegationFloorTier)}、${name(rk.relegationTiers[1])}歸零降回${name(rk.relegationTiers[0])}，一次只降一級。${rk.dangerThreshold} 分以下是危險區，首頁會提醒。`, tag: 'key' },
        { icon: 'lock', title: `晉級後 ${rk.promotionProtectionMatches} 場保護`, text: `剛升上去的前 ${rk.promotionProtectionMatches} 場一般比賽，輸球照樣扣分，但積分最低停在 1 分，不會馬上掉回去。` },
        { icon: 'club', title: '降級不會失去任何東西', text: '球員、資金、經驗、陣容、戰術、總戰績、歷史最高聯盟都會保留；新聯盟的場數與勝率重新累積，首次晉級獎勵不會重發。' },
        { icon: 'clock', title: '離線也會計分', text: '離線時打完的比賽一樣計分；如果中途降級，後面的比賽就用新聯盟的對手與收益。' },
      ],
    },
    {
      id: 'faq',
      short: '問答',
      title: '常見問題',
      icon: 'report',
      summary: '玩家最常問的幾個問題。',
      cards: [],
      faq: [
        { q: '離線很久，比賽會一直累積嗎？', a: `最多累積 ${offlineH} 小時（${IDLE_CONFIG.MAX_BATCH_MATCHES} 場），超過的部分不會再打。` },
        { q: '開兩個分頁會重複拿獎勵嗎？', a: '不會。每場比賽只會結算一次、收益只會領一次。大部分瀏覽器支援跨分頁鎖，每個分頁都可以操作，存檔會依序寫入；不支援的瀏覽器同一時間只有一個分頁可以操作，其他分頁只能查看。' },
        { q: '晉級挑戰失敗會怎樣？', a: `不會失去任何東西，只要再完成 ${P.retryAfterMatches} 場一般比賽就能再挑戰。` },
        { q: '會被降級嗎？降級會失去什麼？', a: `只有${name(rk.relegationTiers[0])}、${name(rk.relegationTiers[1])}積分歸零才會降一級，${name(rk.relegationFloorTier)}以下不會降級。球員、資金、經驗都不會失去，只是新聯盟的場數與勝率要重新累積。` },
        { q: '重看比賽會改變結果嗎？', a: 'Replay 只是重播已經存好的結果，不會重算，也不會再發獎勵。' },
      ],
    },
  ]
}

export interface GuideHit {
  chapter: GuideChapter
  title: string
  text: string
}

/** 搜尋：章節標題、摘要、卡片、問答，忽略大小寫與空白 */
export function searchGuide(chapters: readonly GuideChapter[], query: string): GuideHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: GuideHit[] = []
  const has = (s: string) => s.toLowerCase().includes(q)
  for (const c of chapters) {
    if (has(c.title) || has(c.summary)) hits.push({ chapter: c, title: c.title, text: c.summary })
    for (const card of c.cards) if (has(card.title) || has(card.text)) hits.push({ chapter: c, title: card.title, text: card.text })
    for (const f of c.faq ?? []) if (has(f.q) || has(f.a)) hits.push({ chapter: c, title: f.q, text: f.a })
  }
  return hits
}

/** 球員流派、羈絆與隊長：門檻、隊長權重、守備門檻、加成都從 sim/synergy.ts 與 SYNERGY_EFFECT 讀 */
function synergyChapter(): GuideChapter {
  const [low, high] = thresholds('power', [])
  const w = captainWeight([])
  const grade = gradeOf(POSITION_SYNERGY_FIELDING)
  const types = (['power', 'speed', 'skill', 'defense'] as const).map((a) => ARCHETYPE_NAMES[a]).join('、')
  const exact = SYNERGY_KEYS.map((k) => {
    const t1 = synergyEffects(k, 1).join('、')
    return k === 'middle' || k === 'battery' ? `${SYNERGY_NAMES[k]}：${t1}` : `${SYNERGY_NAMES[k]}：${low} 人階 ${t1}；${high} 人階 ${synergyEffects(k, 2).join('、')}`
  }).join('\n')
  return {
    id: 'synergy',
    short: '羈絆',
    title: '球員流派、羈絆與隊長',
    icon: 'league',
    summary: `每位打者都有一種流派（${types}）。先發 9 人裡同流派的人數夠多就會啟動羈絆；另外兩個羈絆看守位。隊長在自己流派算 ${w} 人。`,
    visual: { kind: 'stats', items: [{ value: String(low), label: '人啟動' }, { value: String(high), label: '人升級' }, { value: `×${w}`, label: '隊長人數' }, { value: String(SYNERGY_KEYS.length), label: '種羈絆' }] },
    cards: [
      { icon: 'lineup', title: '只算先發 9 人', text: `同流派先發達 ${low} 人啟動第一階、${high} 人升到第二階；板凳與預備不算。陣容頁的「羈絆說明」可以看目前人數、還差幾人與怎麼改善。`, tag: 'key' },
      { icon: 'league', title: '隊長（頭像上的 C）', text: `C 是 Captain。隊長在自己流派算 ${w} 人，對其他流派沒有影響；隊長一定要是先發，換到板凳就沒有隊長，要在「羈絆說明」重新指定。換隊長可能讓羈絆啟動、升級或掉階。` },
      { icon: 'upgrade', title: SYNERGY_NAMES.power, text: SYNERGY_DESC.power },
      { icon: 'fast', title: SYNERGY_NAMES.speed, text: SYNERGY_DESC.speed },
      { icon: 'check', title: SYNERGY_NAMES.skill, text: SYNERGY_DESC.skill },
      { icon: 'lock', title: SYNERGY_NAMES.defense, text: `${SYNERGY_DESC.defense}防守型當指定打擊不算。` },
      { icon: 'swap', title: SYNERGY_NAMES.middle, text: `${SYNERGY_DESC.middle}條件：二壘手、游擊手都守本職，守備都 ${grade} 以上（含裝備）。` },
      { icon: 'tactics', title: SYNERGY_NAMES.battery, text: `${SYNERGY_DESC.battery}條件：捕手守本職，守備 ${grade} 以上（含裝備）。` },
    ],
    faq: [
      { q: '每個羈絆的精確效果是多少？', a: exact },
      { q: '防守型當指定打擊為什麼不算鐵壁球隊？', a: '鐵壁球隊加強的是全隊守備，指定打擊不上場守備，所以不算人數。把他換到守備位置就會算進來。' },
      { q: '隊長被換下來會怎樣？', a: `先發裡就沒有隊長，原本多算的 ${w - 1} 人消失，羈絆可能掉階。到陣容頁的「羈絆說明」指定新的隊長，儲存陣容後生效。` },
      { q: '有秘技可以改變隊長或門檻嗎？', a: `錦標賽的「隊長臂章」讓隊長算 ${captainWeight(['captainBand'])} 人；各流派的「門檻 −1」秘技讓門檻變成 ${thresholds('power', ['powerFactory']).join('／')} 人。放置經營模式沒有秘技。` },
    ],
  }
}
