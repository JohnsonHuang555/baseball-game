// 存檔驗證的小工具：每個檢查失敗都丟 ClubValidationError，訊息寫明是哪個欄位
export type ClubValidationCode = 'unsupported-version' | 'invalid-schema'

export class ClubValidationError extends Error {
  override name = 'ClubValidationError'
  constructor(
    readonly code: ClubValidationCode,
    message: string,
  ) {
    super(message)
  }
}

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
export const invalid = (path: string, why: string) => new ClubValidationError('invalid-schema', `存檔格式錯誤：${path} ${why}`)
const at = (parent: string | undefined, key: string) => (parent ? `${parent}.${key}` : key)

export function obj(o: Obj, key: string, parent?: string): Obj {
  const v = o[key]
  if (!isObj(v)) throw invalid(at(parent, key), '必須是物件')
  return v
}
export function arr(o: Obj, key: string, parent?: string): unknown[] {
  const v = o[key]
  if (!Array.isArray(v)) throw invalid(at(parent, key), '必須是陣列')
  return v
}
export function str(o: Obj, key: string, parent?: string): void {
  if (typeof o[key] !== 'string' || o[key] === '') throw invalid(at(parent, key), '必須是非空字串')
}
export function num(o: Obj, key: string, parent?: string): void {
  const v = o[key]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(at(parent, key), '必須是 0 以上的數字')
}
export function int(o: Obj, key: string, parent?: string): void {
  const v = o[key]
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid(at(parent, key), '必須是 0 以上的整數')
}

/** 球員資料的基本形狀 */
export function player(p: unknown, role: 'batter' | 'pitcher', path: string): void {
  if (!isObj(p) || p.role !== role || typeof p.id !== 'string' || typeof p.name !== 'string' || !isObj(p.ratings) || !Array.isArray(p.traits)) {
    throw invalid(path, `不是合法的${role === 'batter' ? '打者' : '投手'}`)
  }
  for (const [k, v] of Object.entries(p.ratings)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10) throw invalid(`${path}.ratings.${k}`, '必須是 0～10 的數字')
  }
}

/** 近期比賽、replay：兩個版本的格式一樣 */
export function validateMatches(value: Obj): void {
  arr(value, 'recentMatches').forEach((m, i) => {
    const path = `recentMatches[${i}]`
    if (!isObj(m)) throw invalid(path, '不是物件')
    str(m, 'matchId', path)
    int(m, 'matchIndex', path)
    int(m, 'seed', path)
    num(m, 'earnedFunds', path)
    num(m, 'earnedExperience', path)
    num(m, 'settledAt', path)
    const r = obj(m, 'result', path)
    int(r, 'runsFor', `${path}.result`)
    int(r, 'runsAgainst', `${path}.result`)
    arr(r, 'highlights', `${path}.result`)
  })
  arr(value, 'replays').forEach((r, i) => {
    if (!isObj(r) || typeof r.matchId !== 'string' || !isObj(r.replay)) throw invalid(`replays[${i}]`, '格式不對')
  })
}
