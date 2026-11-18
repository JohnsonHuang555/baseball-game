// 候選平衡方案：在模擬裡把正式的設定物件改成候選值（只影響這一次模擬的程序，不改原始碼），用來比較方案。
// 正式採用的方案要另外改 src/v2/domain 的 Config。
import { REWARD_CONFIG } from '../../src/v2/domain/config'
import { LEAGUES, PROMOTION_CONFIG } from '../../src/v2/domain/leagueConfig'
import { UPGRADE_COST } from '../../src/v2/domain/progressionConfig'

/** 改寫一個（readonly、字面型別的）設定值：只在模擬程序裡 */
const set = (obj: object, key: string, value: number) => ((obj as Record<string, number>)[key] = value)

export const CANDIDATES: Record<string, { label: string; apply: () => void }> = {
  main: { label: '目前的正式數值', apply: () => undefined },
  /** Phase 6C 改動前的 main（對手每級 +0.5），用來重現基準 */
  pre6c: {
    label: 'Phase 6C 之前的數值（聯盟對手每級 +0.5）',
    apply: () => LEAGUES.forEach((l, i) => set(l, 'opponentMean', 5 + 0.5 * i)),
  },
  /** 方案 B：中後期升級成本降低（指數 1.3 → 1.2；Lv.1→2 不變） */
  B: {
    label: '升級經驗指數 1.3 → 1.2',
    apply: () => {
      set(UPGRADE_COST, 'expPower', 1.2)
    },
  },
  /** 方案 C：B ＋ 晉級視窗 60 → 40 場、聯盟對手每級 +0.5 → +0.4 */
  C: {
    label: 'B ＋ 最近勝率視窗 60 → 40 場 ＋ 聯盟對手每級 +0.5 → +0.4',
    apply: () => {
      set(UPGRADE_COST, 'expPower', 1.2)
      set(PROMOTION_CONFIG, 'window', 40)
      LEAGUES.forEach((l, i) => set(l, 'opponentMean', 5 + 0.4 * i))
    },
  },
  /** 方案 S：只把聯盟對手每級的強度差 +0.5 → +0.4（新秀 5.0、業餘 5.4、挑戰者 5.8、職業 6.2、傳奇 6.6） */
  S: {
    label: '聯盟對手每級 +0.5 → +0.4',
    apply: () => {
      LEAGUES.forEach((l, i) => set(l, 'opponentMean', 5 + 0.4 * i))
    },
  },
  /** 方案 S45：聯盟對手每級 +0.5 → +0.45（S 的折衷） */
  S45: {
    label: '聯盟對手每級 +0.5 → +0.45',
    apply: () => {
      LEAGUES.forEach((l, i) => set(l, 'opponentMean', Math.round((5 + 0.45 * i) * 100) / 100))
    },
  },
  /** 對照：挑戰賽對手不再加強（下一級 +0.25 → +0） */
  Y: {
    label: '挑戰賽對手加成 +0.25 → 0',
    apply: () => {
      set(PROMOTION_CONFIG, 'challengeBonus', 0)
    },
  },
  /** 對照：只提高比賽經驗 25%（看「多給經驗」與「降低成本」的差別） */
  X: {
    label: '比賽經驗 +25%（勝 12 → 15、敗 8 → 10）',
    apply: () => {
      set(REWARD_CONFIG.win, 'experience', 15)
      set(REWARD_CONFIG.loss, 'experience', 10)
    },
  },
}

export function applyCandidate(name: string | undefined): string {
  const c = CANDIDATES[name ?? 'main']
  if (!c) throw new Error(`不認識的候選方案：${name}`)
  c.apply()
  return c.label
}
