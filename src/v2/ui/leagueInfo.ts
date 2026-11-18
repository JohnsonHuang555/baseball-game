// Phase 7 的聯盟說明資料（遊戲指南、聯盟之路、聯盟詳情、首頁「下一個目標」共用）。
// 正式規則一律從 domain 的 config 讀（LEAGUES、PROMOTION_CONFIG、IDLE_CONFIG…），不在這裡另外寫一份數字。
//
// 「競技積分／降級」還在 RFC（docs/phase7-ranked-league-rfc.md），沒有定案：
// RANKED_PREVIEW 是設計稿上的示意數字，只用在畫面上「示意・待定」的插圖與說明，
// 不是遊戲規則、不會寫進存檔、也不會影響任何結算。畫面上用到它的地方一定要加示意標籤（placeholderTag）。
import { el } from '../../ui/playerCard'
import { leagueOf } from '../domain/league'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG } from '../domain/leagueConfig'

export const RANKED_PREVIEW = {
  /** 從這一級開始規劃用積分（挑戰者） */
  fromTier: 2,
  /** 規劃會降級的聯盟（職業、傳奇） */
  relegateTiers: [3, 4] as readonly number[],
  max: 100,
  start: 50,
  win: 3,
  loss: 2,
  promoteAt: 80,
  dangerAt: 20,
} as const

export type Risk = 'safe' | 'floor' | 'danger'

export function riskOf(tier: number): Risk {
  if (tier < RANKED_PREVIEW.fromTier) return 'safe'
  return RANKED_PREVIEW.relegateTiers.includes(tier) ? 'danger' : 'floor'
}

export const isRankedPreview = (tier: number) => tier >= RANKED_PREVIEW.fromTier

const n = (x: number) => x.toLocaleString('zh-Hant')
const short = (tier: number) => leagueOf(tier).name.replace('聯盟', '')

export const LEAGUE_INTRO: readonly string[] = [
  '起點。熟悉比賽、領取收益、第一次養成球員。',
  '開始練習招募與調整陣容，準備進入競技。',
  '規劃中的競技升降級會從這裡開始，這一級是保底。',
  '晉級與保級同時存在，每一場都算數（規劃中）。',
  '目前最高的聯盟。目標是維持資格、繼續養成球隊。',
]

export function riskLabel(tier: number): string {
  const r = riskOf(tier)
  if (r === 'safe') return '只升不降'
  if (r === 'floor') return `保底：不會降回${short(tier - 1)}`
  return `可能降回${short(tier - 1)}`
}

/** 目前正式的晉級條件（所有聯盟相同，來自 PROMOTION_CONFIG） */
export function officialConditions(tier: number): string[] {
  if (tier >= MAX_TIER) return ['已經是最高的聯盟，沒有晉級條件']
  const p = PROMOTION_CONFIG
  return [
    `在本聯盟完成 ${p.minMatches} 場一般比賽`,
    `最近 ${p.window} 場勝率 ${Math.round(p.winRate * 100)}% 以上`,
    `贏得晉級挑戰賽（對手比${leagueOf(tier + 1).name}的一般對手更強）`,
    `挑戰失敗後，再完成 ${p.retryAfterMatches} 場一般比賽才能再挑戰`,
  ]
}

/** 規劃中（示意・待定）的條件：只在競技區的聯盟顯示 */
export function plannedConditions(tier: number): string[] {
  if (!isRankedPreview(tier)) return []
  const r = RANKED_PREVIEW
  if (tier >= MAX_TIER) return [`競技積分 0～${r.max}，目標是維持在危險區（${r.dangerAt} 分）以上`]
  return [`競技積分進入晉級區（${r.promoteAt} 分以上），再贏得晉級挑戰賽`, `每場勝 +${r.win}／敗 −${r.loss}，晉級後從 ${r.start} 分開始`]
}

/** 降級規則的說明（現行：所有聯盟都不會降級；競技區附上規劃中的示意） */
export function relegationText(tier: number): { risk: Risk; title: string; text: string; planned: boolean } {
  const risk = riskOf(tier)
  if (risk === 'safe') return { risk, title: '只升不降', text: '這一級不會降級，可以放心慢慢養成。', planned: false }
  if (risk === 'floor') return { risk, title: '保底聯盟（規劃中）', text: `規劃中的競技積分從這裡開始，但積分再低也不會降回${leagueOf(tier - 1).name}。目前所有聯盟都還不會降級。`, planned: true }
  return {
    risk,
    title: '可能降級（規劃中）',
    text: `規劃中：積分降到 0 會降回${leagueOf(tier - 1).name}，球員、資金、經驗都會保留；首次晉級獎勵不會重複發放。目前所有聯盟都還不會降級。`,
    planned: true,
  }
}

/** 聯盟之路卡片之間的連接說明：upper 是連接線上方的聯盟（下一級晉級到 upper） */
export function linkText(upper: number): { text: string; tone: 'safe' | 'floor' | 'danger'; planned: boolean } {
  const p = PROMOTION_CONFIG
  if (upper < RANKED_PREVIEW.fromTier) return { text: `↑ 晉級挑戰（${p.minMatches} 場・勝率 ${Math.round(p.winRate * 100)}%）`, tone: 'safe', planned: false }
  if (upper === RANKED_PREVIEW.fromTier) return { text: '— 保底線：挑戰者以下不再降級 —', tone: 'floor', planned: true }
  return { text: '↑ 晉級挑戰 ↓ 積分歸零降級', tone: 'danger', planned: true }
}

export function rewardText(tier: number): string {
  const r = leagueOf(tier).promotionReward
  return r.funds || r.experience ? `${n(r.funds)} 資金・${n(r.experience)} 經驗` : '沒有（起點）'
}

export const multiplierText = (tier: number) => `×${leagueOf(tier).rewardMultiplier.toFixed(2)}`

/** 設計稿的「示意」標籤：紫色虛線框 */
export function placeholderTag(text = '示意・待定'): HTMLElement {
  const t = el('span', 'v2-demo-tag', text)
  t.title = '規則還在設計中，數字不是正式規則'
  return t
}

/** 對手難度：5 格，黑色實心格數 = 階級 + 1 */
export function difficultyPips(tier: number, big = false): HTMLElement {
  const box = el('span', `v2-pips ${big ? 'big' : ''}`.trim())
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', `對手難度 ${tier + 1} / ${LEAGUES.length}`)
  for (let i = 0; i < LEAGUES.length; i++) box.append(el('span', i <= tier ? 'on' : ''))
  return box
}

/** 示意積分條：左邊低分區（保底紫或危險紅）、右邊晉級區（綠），沒有玩家資料 */
export function previewPointsBar(tier: number, value: number = RANKED_PREVIEW.start): HTMLElement {
  const r = RANKED_PREVIEW
  const bar = el('div', `v2-points-bar ${riskOf(tier)}`)
  bar.setAttribute('role', 'img')
  bar.setAttribute('aria-label', `示意：積分 ${value} / ${r.max}，晉級區 ${r.promoteAt} 分以上，危險區 ${r.dangerAt} 分以下`)
  const track = el('span', 'v2-points-track')
  const low = el('span', 'v2-points-low')
  low.style.width = `${(r.dangerAt / r.max) * 100}%`
  const up = el('span', 'v2-points-up')
  up.style.width = tier >= MAX_TIER ? '0%' : `${((r.max - r.promoteAt) / r.max) * 100}%`
  track.append(low, el('span', 'v2-points-mid'), up)
  const fill = el('span', 'v2-points-fill')
  fill.style.width = `${(value / r.max) * 100}%`
  fill.style.background = leagueOf(tier).color
  const mark = el('span', 'v2-points-mark')
  mark.style.left = `${(value / r.max) * 100}%`
  bar.append(track, fill, mark)
  return bar
}
