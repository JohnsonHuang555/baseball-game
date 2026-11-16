# V2 自動比賽：自動教練 + Headless Match Runner，不改模擬核心

V2 改成放置型經營，比賽由 AI 自動打完，之後還要能離線批次結算。V1 的 `Game` 已經是確定性、跟畫面分開的模擬（ADR-0001），所以 V2 不另寫引擎，而是在 `src/v2/application/` 包一層：

- `autoCoach.ts`：Strategy Pattern。`CoachPolicy.next(game)` 只讀狀態、回傳下一個指令；`AutoCoach` 負責每個打席只決策一次、指令要在 `availableTactics()` 裡、同時最多排一個戰術，再交給 `game.issue()`。第一版是均衡策略（`balanced`），參數在 `CoachParams`。
- `matchRunner.ts`：Adapter。雙方 AI 設定 `{ kind: 'autoCoach' } | { kind: 'builtin' }` 對到 V1 的 `userSide`：自動教練那一方當 `userSide`，另一方是引擎內建的 V1 對手 AI。規則版本明確寫進 setup；超過步數上限就丟 `MatchStepLimitError`。

`src/sim/*` 一行都沒改，所以 V1 的存檔格式、重播、錦標賽、自由練習都不受影響，也不用升 `RULES_VERSION`。

## Consequences

- 結果由 setup（種子、雙方陣容、規則版本）加上雙方 AI 設定決定。重播不用重跑 AI：結果裡的 `replay` 就是 V1 的 `{ setup, commands }`，交給 `replay()` 就能逐步重現。
- 自動教練的判斷改了，同一個種子會打出不同的比賽，所以另外記 `AUTO_COACH_VERSION`。要求「同種子同結果」的地方（例如已結算的離線比賽）應該存 `replay`，不要只存種子。
- 引擎同一場只有一個 `userSide`，所以 Phase 1 只能有一方用可設定的自動教練，另一方固定是 V1 內建 AI（兩邊都會自動換投）。要讓兩邊都用可設定的策略，得讓 `Game` 支援由外部控制雙方（例如 opt-in 的設定，並升規則版本），之後要做的時候再另寫 ADR。
- 效能（`npm run bench:v2`）：每場約 1～1.5 ms、250 步左右。主要成本在引擎的 `step()`（每一球算 AI 球種的 hash、羈絆人數重算），自動教練約佔一成。一次結算上百場以上時應該分批讓出主執行緒，或移到 Web Worker；`MatchResult` 可以直接序列化。
