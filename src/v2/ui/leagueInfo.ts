// 聯盟說明資料（遊戲指南、聯盟之路、聯盟詳情、首頁「下一個目標」共用）。
// 規則與數字一律從 domain 的 config 讀（LEAGUES、PROMOTION_CONFIG、RANKED_CONFIG），不在畫面另外寫一份；
// 玩家自己的積分一律來自存檔（domain/league.ts 的 rankedView），畫面不重算。
//
// Phase 7B 起競技積分是正式規則（方案 D）：挑戰者起有積分；職業、傳奇歸零降一級；挑戰者保底。
// 積分不影響晉級：晉級仍是 100 場＋最近 60 場 60%＋挑戰賽。所以畫面上「積分」與「晉級條件」分開顯示，
// 也不畫「晉級區」（設計稿 p7 的 80 分晉級區是 RFC 階段的示意，沒有採用）
import { el } from '../../ui/playerCard'
import { canRelegate, leagueOf, rankedEnabled, type RankedView } from '../domain/league'
import { LEAGUES, MAX_TIER, PROMOTION_CONFIG, RANKED_CONFIG } from '../domain/leagueConfig'
import type { SettledMatch } from '../domain/club'

export type Risk = 'safe' | 'floor' | 'danger'

export function riskOf(tier: number): Risk {
  if (!rankedEnabled(tier)) return 'safe'
  return canRelegate(tier) ? 'danger' : 'floor'
}

const n = (x: number) => x.toLocaleString('zh-Hant')
const short = (tier: number) => leagueOf(tier).name.replace('聯盟', '')
const R = RANKED_CONFIG
const loss = -R.lossPoints

export const LEAGUE_INTRO: readonly string[] = [
  '起點。熟悉比賽、領取收益、第一次養成球員。',
  '開始練習招募與調整陣容，準備進入競技。',
  '競技積分從這裡開始。這一級是保底，不會降回業餘。',
  '晉級與保級同時存在，每一場都算數。',
  '目前最高的聯盟。目標是維持資格、繼續養成球隊。',
]

export function riskLabel(tier: number): string {
  const r = riskOf(tier)
  if (r === 'safe') return '只升不降'
  if (r === 'floor') return `保底：不會降回${short(tier - 1)}`
  return `可能降回${short(tier - 1)}`
}

/** 晉級條件（所有聯盟相同，來自 PROMOTION_CONFIG；積分不在裡面） */
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

/** 這一級的競技積分規則（挑戰者以上） */
export function rankedRules(tier: number): string[] {
  if (!rankedEnabled(tier)) return []
  const out = [`一般比賽勝 +${R.winPoints}／敗 −${loss}，積分 ${R.minPoints}～${R.maxPoints}；晉級挑戰賽不計分`, `晉級或降級到這一級時從 ${R.initialPoints} 分開始`]
  if (canRelegate(tier)) {
    out.push(`積分歸零就降回${leagueOf(tier - 1).name}（一次只降一級）`)
    out.push(`晉級後前 ${R.promotionProtectionMatches} 場有保護：積分最低停在 1 分`)
    out.push(`${R.dangerThreshold} 分以下是危險區`)
  } else out.push(`保底：積分 ${R.minPoints} 分也不會降回${leagueOf(tier - 1).name}`)
  out.push('積分不影響晉級：晉級只看上面的條件')
  return out
}

/** 降級規則的說明 */
export function relegationText(tier: number): { risk: Risk; title: string; text: string } {
  const risk = riskOf(tier)
  if (risk === 'safe') return { risk, title: '只升不降', text: '這一級不會降級，也沒有競技積分，可以放心慢慢養成。' }
  if (risk === 'floor') return { risk, title: '保底聯盟', text: `積分再低也不會降回${leagueOf(tier - 1).name}。` }
  return {
    risk,
    title: '可能降級',
    text: `積分歸零會降回${leagueOf(tier - 1).name}。球員、資金、經驗、陣容都會保留；首次晉級獎勵不會重複發放，晉級條件要在新聯盟重新累積。`,
  }
}

/** 聯盟之路卡片之間的連接說明：upper 是連接線上方的聯盟（下一級晉級到 upper） */
export function linkText(upper: number): { text: string; tone: 'safe' | 'floor' | 'danger' } {
  const p = PROMOTION_CONFIG
  if (!rankedEnabled(upper)) return { text: `↑ 晉級挑戰（${p.minMatches} 場・勝率 ${Math.round(p.winRate * 100)}%）`, tone: 'safe' }
  if (!canRelegate(upper)) return { text: `— 保底線：${leagueOf(upper).name}不會降回${short(upper - 1)} —`, tone: 'floor' }
  return { text: '↑ 晉級挑戰　↓ 積分歸零降級', tone: 'danger' }
}

export function rewardText(tier: number): string {
  const r = leagueOf(tier).promotionReward
  return r.funds || r.experience ? `${n(r.funds)} 資金・${n(r.experience)} 經驗` : '沒有（起點）'
}

export const multiplierText = (tier: number) => `×${leagueOf(tier).rewardMultiplier.toFixed(2)}`

/** 對手難度：5 格，黑色實心格數 = 階級 + 1 */
export function difficultyPips(tier: number, big = false): HTMLElement {
  const box = el('span', `v2-pips ${big ? 'big' : ''}`.trim())
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', `對手難度 ${tier + 1} / ${LEAGUES.length}`)
  for (let i = 0; i < LEAGUES.length; i++) box.append(el('span', i <= tier ? 'on' : ''))
  return box
}

/** 競技狀態的短標籤（保底／保級安全／降級危險區） */
export function rankedStatus(v: RankedView): { text: string; tone: 'floor' | 'safe' | 'danger' } | null {
  if (!v.enabled) return null
  if (v.zone === 'floor') return { text: `保底・不會降回${short(v.tier - 1)}`, tone: 'floor' }
  if (v.zone === 'danger') return { text: '降級危險區', tone: 'danger' }
  return { text: '保級安全', tone: 'safe' }
}

/**
 * 積分條：左邊是危險區（會降級的聯盟是紅、挑戰者是保底紫），沒有晉級區（積分不影響晉級）。
 * points 一定是存檔裡的值；指南的例子要在旁邊寫清楚是「例」
 */
export function pointsBar(tier: number, points: number, label?: string): HTMLElement {
  const bar = el('div', `v2-points-bar ${riskOf(tier)}`)
  bar.setAttribute('role', 'meter')
  bar.setAttribute('aria-valuemin', String(R.minPoints))
  bar.setAttribute('aria-valuemax', String(R.maxPoints))
  bar.setAttribute('aria-valuenow', String(points))
  bar.setAttribute('aria-label', label ?? `競技積分 ${points} / ${R.maxPoints}${canRelegate(tier) ? `，${R.dangerThreshold} 分以下是危險區` : ''}`)
  const track = el('span', 'v2-points-track')
  const low = el('span', 'v2-points-low')
  low.style.width = `${(R.dangerThreshold / R.maxPoints) * 100}%`
  track.append(low, el('span', 'v2-points-mid'))
  const fill = el('span', 'v2-points-fill')
  fill.style.width = `${(points / R.maxPoints) * 100}%`
  fill.style.background = leagueOf(tier).color
  const mark = el('span', 'v2-points-mark')
  mark.style.left = `${(points / R.maxPoints) * 100}%`
  bar.append(track, fill, mark)
  return bar
}

/** 積分卡（首頁目標卡、聯盟卡、聯盟詳情、聯盟之路共用）：積分、狀態標籤、積分條、說明 */
export function rankedCard(v: RankedView, opts: { compact?: boolean } = {}): HTMLElement | null {
  if (!v.enabled || v.points === null) return null
  const status = rankedStatus(v)!
  const box = el('div', `v2-ranked ${v.zone}${opts.compact ? ' compact' : ''}`)
  box.dataset.points = String(v.points)
  box.dataset.zone = v.zone
  const head = el('div', 'v2-ranked-head')
  head.append(el('span', 'v2-ranked-k', '競技積分'), el('strong', 'v2-ranked-pts', String(v.points)), el('span', 'v2-ranked-max', `/ ${v.max}`), el('span', `v2-ranked-tag ${status.tone}`, status.text))
  box.append(head, pointsBar(v.tier, v.points))
  if (opts.compact) return box
  const lines: string[] = []
  if (v.zone === 'floor') lines.push(`勝 +${v.win}／敗 −${v.loss}・挑戰者是保底，積分 0 分也不會降級`)
  else if (v.zone === 'danger') lines.push(`在危險區：積分歸零會降回${leagueOf(v.relegateTo!).name}；贏一場 +${v.win}`)
  else lines.push(`高於危險區 ${v.aboveDanger} 分・歸零才會降回${leagueOf(v.relegateTo!).name}`)
  if (v.protectionRemaining > 0) lines.push(`晉級保護還剩 ${v.protectionRemaining} 場（積分最低停在 1 分）`)
  if (v.atMax) lines.push(`已經是上限 ${v.max} 分：保級很安全，晉級仍看場數與勝率`)
  for (const t of lines) box.append(el('p', 'v2-ranked-line', t))
  return box
}

/**
 * 一場比賽的積分變化小標籤（最近比賽、戰報列表）：來自存檔的 SettledMatch.ranked。
 * 挑戰者以上的比賽卻沒有紀錄（Phase 7B 以前結算的）顯示「未記錄」；新秀、業餘的比賽沒有積分，不顯示
 */
export function rankedDeltaChip(m: SettledMatch): HTMLElement | null {
  const tier = m.result.leagueTier ?? 0
  const r = m.ranked
  if (!r) {
    if (!rankedEnabled(tier)) return null
    const c = el('span', 'v2-pts-chip none', '積分未記錄')
    c.title = '這場在競技積分上線前結算，沒有積分紀錄'
    return c
  }
  const text = r.delta > 0 ? `+${r.delta}` : r.delta < 0 ? `−${-r.delta}` : '±0'
  const c = el('span', `v2-pts-chip ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'flat'}${r.relegatedTo !== null ? ' relegated' : ''}`, text)
  c.setAttribute('aria-label', `競技積分 ${r.before} → ${r.after}${r.relegatedTo !== null ? `，降到${leagueOf(r.relegatedTo).name}` : ''}`)
  return c
}

/** 戰報裡的積分段落：前後積分、保護、是否降級；沒有紀錄就說「未記錄」，不推算 */
export function rankedReport(m: SettledMatch): HTMLElement | null {
  const tier = m.result.leagueTier ?? 0
  const r = m.ranked
  if (!r && !rankedEnabled(tier)) return null
  const box = el('section', 'v2-report-card v2-report-ranked')
  box.append(el('h3', '', '競技積分'))
  if (!r) {
    box.append(el('p', 'v2-hint', '未記錄：這場在競技積分上線前結算，沒有積分資料。'))
    return box
  }
  const line = el('p', 'v2-report-ranked-line')
  line.append(el('strong', '', `${r.before} → ${r.after}`), ' ', rankedDeltaChip(m)!)
  box.append(line)
  const notes: string[] = []
  if (r.protected) notes.push(`晉級保護：積分停在 1 分`)
  if (r.protectionRemaining > 0) notes.push(`保護還剩 ${r.protectionRemaining} 場`)
  if (r.relegatedTo !== null) notes.push(`積分歸零，從${leagueOf(r.tier).name}降到${leagueOf(r.relegatedTo).name}`)
  else if (canRelegate(r.tier)) notes.push(r.after <= R.dangerThreshold ? '這場結束時在降級危險區' : '這場結束時保級安全')
  else notes.push(`${leagueOf(r.tier).name}是保底，不會降級`)
  for (const t of notes) box.append(el('p', 'v2-hint', t))
  return box
}
