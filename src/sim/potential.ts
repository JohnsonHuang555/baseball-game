// 潛能的資料型別：V1 錦標賽裡部分球員帶著「？」的潛在特性，累積到條件就覺醒。
// 覺醒機制隨 V1 移除（Phase 6D）；型別留著，因為球員資料（types.ts）與畫面的潛能標籤仍認得這個欄位
import type { TraitId } from './traits'

/** 累積的是比賽紀錄裡的哪一欄：安打、全壘打、打點、三振（投手）、抓到的出局數 */
export type PotentialStat = 'hits' | 'hr' | 'rbi' | 'k' | 'outs'

export interface Potential {
  trait: TraitId
  stat: PotentialStat
  need: number
  progress: number
}
