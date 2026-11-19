# ADR-0019：競技積分與降級（Phase 7B，方案 D）

狀態：已採用（Phase 7B）。評估過程見 [RFC](../phase7-ranked-league-rfc.md)；平衡驗收見 [報告](../balance/v2-phase7b-ranked-report.md)。

## 規則

| | 新秀、業餘 | 挑戰者 | 職業、傳奇 |
|---|---|---|---|
| 競技積分 | 沒有（`points = null`） | 有 | 有 |
| 每場一般比賽 | — | 勝 +3／敗 −2，0～100 | 同左 |
| 積分歸零 | — | 不降級（保底） | 降一級，積分重設 50，沒有保護 |
| 晉級 | 100 場＋最近 60 場 60%＋挑戰賽（不變） | 同左 | 同左（傳奇沒有晉級） |
| 晉級後 | — | 積分 50、20 場保護 | 同左 |

- 數值集中在 `domain/leagueConfig.ts` 的 `RANKED_CONFIG`，畫面與指南都從這裡讀。
- **積分不影響晉級**：35 分也可以挑戰；100 分不代表有資格。畫面沒有「晉級區」（設計稿的 80 分晉級區是 RFC 階段的示意，未採用）。
- 晉級挑戰賽不計分；挑戰失敗不改積分，12 場冷卻照舊。
- 保護：晉級後前 20 場「計入目前聯盟的一般比賽」，輸球照扣，但最低停在 1；每計一場扣一次保護（存在存檔裡，跟真實時間、重新整理、分頁數無關）。
- 降級重設新聯盟的場次、勝敗、最近 60 場、挑戰冷卻；保留球員、資金、經驗、陣容、戰術、總戰績、最高階級、晉級次數、已發獎勵、挑戰紀錄。首次晉級獎勵只看 `rewardedTiers`，所以重返不重發。

## 資料模型（schemaVersion 9）

`LeagueState` 新增：

- `points: number | null`：挑戰者以上是 0～100 的整數，以下是 null。
- `protectionRemaining: number`：0～20。
- `relegations: number`：累計降級次數。
- `lastRelegation: { fromTier, toTier, matchIndex, at } | null`：`matchIndex` 是造成降級的那一場（穩定的事件身分）。

`SettledMatch.ranked?: { tier, before, after, delta, protected, protectionRemaining, relegatedTo }`：每場計分的結果跟比賽一起存，戰報直接讀，不在畫面推算。舊比賽沒有，顯示「未記錄」。

不變量（`leagueViolations`）：`tier = promotions − relegations`、`tier ≤ highestTier ≤ 最高聯盟`、`promotions ≥ highestTier`（重返也算一次晉級）、`rewardedTiers ⊆ [1, highestTier]`、積分範圍與 null 規則、職業／傳奇不會停在 0 分（歸零當場降級）、保護 0～20、降級紀錄只能從職業／傳奇降一級。

## 結算

- 計分只發生在 `settleOutcomes`，跟 `recordLeagueResult` 同一個條件：比賽計畫的聯盟 = 目前聯盟。所以晉級前就固定的進行中比賽（舊聯盟）不計分、不扣保護。
- 已結算的場次（`matchIndex < nextMatchIndex`）直接略過，重送、多分頁、重新整理都不會重複計分；Replay 只讀存檔，不經過結算。
- **分段結算**：`settleDueUnsaved` 每段只規劃 `matchesBeforePossibleRelegation` 場（保護中是剩下的保護場數，否則是 `ceil(積分 ÷ 2)`），所以降級只會發生在一段的最後一場；下一段用降級後的球團重新規劃（對手強度、收益倍率、積分規則都是新聯盟的）。降級前的比賽不重打；種子、序號、預定時間、離線 8 小時上限都跟以前一樣。新秀～挑戰者永遠只有一段，結果跟以前逐位元相同（有測試）。
- 保險：`settleOutcomes` 遇到降級後，同一次收到的其他結果（舊聯盟規劃的）一律不記，留給下一段重新規劃。
- 中斷、模擬失敗：已經記好的前綴照樣回傳並存檔，錨點只推進這幾場；之後接著結算的結果跟沒中斷時一樣。
- 所有寫入操作（升級、招募、釋出、換陣容、換戰術、晉級挑戰）都在鎖內先呼叫 `settleDueUnsaved`，所以都會先處理降級；挑戰請求帶的聯盟跟結算後的聯盟不同時，照原本的 `stale-request` 拒絕（結算結果仍然存檔）。

## 遷移（8 → 9）

挑戰者以上：50 分＋20 場適應保護；新秀、業餘：沒有積分。降級次數 0、沒有降級紀錄。其他欄位（階級、最高階級、晉級次數、已發獎勵、挑戰序號與紀錄、冷卻、固定的進行中比賽、比賽、Replay、資源）一個字都不動；不補算歷史積分、不重新模擬、不降級、不發獎勵。原始文字逐字備份到 `backup-schema8`，沿用既有的遷移流程（失敗不覆寫、多分頁只遷移一次）。

## 降級通知

`league.relegations` 只增不減，當成事件身分：已經通知到第幾次存在 `localStorage`（`dice-baseball.club.v3.seen-relegations`，跟存檔分開，唯讀分頁也能記），重畫、重新整理、其他分頁都不會再開同一次。一次離線降兩級合併成一個對話框。順序：挑戰結果 → 歡迎回來（離線摘要）→ 降級。限制：換一台裝置、或清掉 localStorage，會再通知一次最近的降級。
