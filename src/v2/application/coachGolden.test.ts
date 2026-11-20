// @vitest-environment node
// 均衡型的逐指令 Golden（Phase 9 PR 2）：coach-balanced-golden.json 是重構 CoachPolicy 之前用 main 的程式產生的。
// 四組均衡參數 × 100 場，每場我方下過的所有指令（雜湊）與比分都要一模一樣；不得重新產生這份檔案來掩蓋差異
import { describe, expect, it } from 'vitest'
import golden from './__golden__/coach-balanced-golden.json'
import { BALANCED_VARIANTS, coachGolden } from './__golden__/coachGolden'

describe('均衡型自動教練：重構前後逐指令相同', () => {
  for (const variant of Object.keys(BALANCED_VARIANTS)) {
    it(`${variant}：100 場的指令與比分`, () => {
      expect(coachGolden(variant)).toEqual((golden as Record<string, string[]>)[variant])
    })
  }
})
