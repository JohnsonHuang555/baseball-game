// 內容指紋：用來比對兩份資料是不是同一份（物件 key 排序後比，從存檔讀回來的資料也能比）
import type { ClubSave } from './club'

/** 跟 JSON.stringify 一樣（略過 undefined），但物件的 key 排序 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

/** 兩組 FNV-1a 32 位元雜湊接起來，當作內容的版本字串 */
function hash(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/**
 * 設定的版本：陣容、戰術各自一個。畫面的草稿記下建立時的版本，儲存時在鎖內跟存檔目前的版本比，
 * 不一致代表別的分頁已經改過，拒絕覆寫。陣容與戰術分開：別的分頁改了戰術，不影響這邊儲存陣容
 */
export interface SettingsVersions {
  roster: string
  coach: string
}

export function settingsVersions(club: Pick<ClubSave, 'roster' | 'strategy'>): SettingsVersions {
  return { roster: hash(stableJson(club.roster)), coach: hash(stableJson(club.strategy.coach)) }
}
