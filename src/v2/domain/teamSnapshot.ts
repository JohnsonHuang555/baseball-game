// 存在存檔裡的整支球隊快照（目前只有傳奇總冠軍賽的冠軍隊）的合法性檢查。
//
// 不另外訂一套規則，而是重用既有的兩個檢查：
// - 球員的基本形狀與能力範圍：validation.ts 的 player()（球團球員也用它：角色、ID、名字、能力都是 0～10 的有限數字）
// - 陣容：lineup.ts 的 lineupIssues()（模擬引擎要求的陣容：9 名先發打者、9 個守位各一人、板凳是打者、投手是投手、
//   同一名球員只出現一次、隊長是先發打者）
// 再加上模擬引擎會讀、但上面兩個沒檢查的欄位：能力的鍵、特性 ID 與角色、打者的流派／本職守位／打擊方向／左右打、投手的慣用手。
//
// 相容性：這裡只檢查「不管哪個版本的規則都必須成立」的條件（引擎能跑的形狀），不檢查強度、能力分布或是否等於重新產生的球隊，
// 所以之後調整平衡或產生器，舊的快照照樣能讀。冠軍隊一律由 generateTeam 產生，沒有裝備、潛能、額外球種：
// 如果以後的快照要帶這些欄位，要把這裡跟著版本化（舊快照沒有，不會被新規則拒絕）。
import { POSITIONS, FIELD_POSITIONS, ARCHETYPES, type Roster } from '../../sim/types'
import { TRAITS, type TraitId } from '../../sim/traits'
import { lineupIssues } from './lineup'
import { ClubValidationError, isObj, player, type Obj } from './validation'

const RATING_KEYS = { batter: ['contact', 'power', 'speed', 'fielding'], pitcher: ['stuff', 'control', 'stamina'] } as const
/** 冠軍隊快照不會有的欄位（generateTeam 不產生；有的話代表快照被改過或來自別的來源） */
const NOT_IN_SNAPSHOT = ['equipment', 'potential', 'extraPitches', 'pitchTraits'] as const

/** 一名球員：回傳問題清單（空的就是合法） */
export function snapshotPlayerIssues(p: unknown, role: 'batter' | 'pitcher', path: string): string[] {
  try {
    player(p, role, path)
  } catch (e) {
    if (e instanceof ClubValidationError) return [e.message.replace(/^存檔格式錯誤：/, '')]
    throw e
  }
  const x = p as Obj
  const out: string[] = []
  if ((x.id as string) === '') out.push(`${path}.id 不能是空字串`)
  const keys = Object.keys(x.ratings as Obj).sort()
  const want = [...RATING_KEYS[role]].sort()
  if (keys.join() !== want.join()) out.push(`${path}.ratings 的能力項目不對（應該是 ${RATING_KEYS[role].join('、')}）`)
  const traits = x.traits as unknown[]
  if (new Set(traits).size !== traits.length) out.push(`${path}.traits 有重複的特性`)
  for (const t of traits) {
    if (typeof t !== 'string' || !Object.prototype.hasOwnProperty.call(TRAITS, t)) out.push(`${path}.traits 不認識的特性：${String(t)}`)
    else if (TRAITS[t as TraitId].role !== role) out.push(`${path}.traits ${t} 不是${role === 'batter' ? '打者' : '投手'}的特性`)
  }
  if (role === 'batter') {
    if (!['left', 'even', 'right'].includes(x.tendency as string)) out.push(`${path}.tendency 不合法`)
    if (!['L', 'R', 'S'].includes(x.bats as string)) out.push(`${path}.bats 不合法`)
    if (!(FIELD_POSITIONS as readonly unknown[]).includes(x.primary)) out.push(`${path}.primary 不合法`)
    if (!(ARCHETYPES as readonly unknown[]).includes(x.archetype)) out.push(`${path}.archetype 不合法`)
  } else if (!['L', 'R'].includes(x.throws as string)) out.push(`${path}.throws 不合法`)
  for (const k of NOT_IN_SNAPSHOT) if (x[k] !== undefined) out.push(`${path}.${k} 不應該出現在球隊快照裡`)
  return out
}

/** 一整支球隊：名稱、每名球員、陣容合法性。回傳問題清單（空的就是合法） */
export function teamSnapshotIssues(team: unknown, path = 'team'): string[] {
  if (!isObj(team)) return [`${path} 必須是物件`]
  const out: string[] = []
  if (typeof team.name !== 'string' || team.name.trim() === '') out.push(`${path}.name 必須是非空字串`)
  if (!isObj(team.roster)) return [...out, `${path}.roster 必須是物件`]
  const r = team.roster
  const rp = `${path}.roster`
  if (!Array.isArray(r.lineup) || !Array.isArray(r.bench) || !Array.isArray(r.relievers)) return [...out, `${rp} 的打線、板凳、後援必須是陣列`]
  r.lineup.forEach((s: unknown, i: number) => {
    if (!isObj(s)) return void out.push(`${rp}.lineup[${i}] 格式不對`)
    if (!(POSITIONS as readonly unknown[]).includes(s.position)) out.push(`${rp}.lineup[${i}].position 不合法`)
    out.push(...snapshotPlayerIssues(s.player, 'batter', `${rp}.lineup[${i}].player`))
  })
  r.bench.forEach((p: unknown, i: number) => out.push(...snapshotPlayerIssues(p, 'batter', `${rp}.bench[${i}]`)))
  out.push(...snapshotPlayerIssues(r.starter, 'pitcher', `${rp}.starter`))
  r.relievers.forEach((p: unknown, i: number) => out.push(...snapshotPlayerIssues(p, 'pitcher', `${rp}.relievers[${i}]`)))
  if (r.captain !== undefined && typeof r.captain !== 'string') out.push(`${rp}.captain 必須是字串`)
  // 形狀都對了，才交給引擎的陣容檢查（它假設球員都是物件）
  if (!out.length) out.push(...lineupIssues(r as unknown as Roster).map((s) => `${rp} ${s}`))
  return out
}
