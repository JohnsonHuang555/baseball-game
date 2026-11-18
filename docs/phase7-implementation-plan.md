# Phase 7 實作計畫：遊戲指南、聯盟之路、競技聯盟

狀態：**第一階段（唯讀 UI＋規則 RFC＋平衡模擬）完成**，第二階段（積分與升降級的 Domain／存檔）**等 RFC 確認後才開始**。
相關文件：[規則 RFC](phase7-ranked-league-rfc.md)、[平衡報告](balance/v2-phase7-ranked-report.md)、設計稿 canvas page `p7`。

## 1. 設計稿與現有程式的差異

| 項目 | 設計稿 p7 | 現有程式（main 3fe8498） | 這次的處理 |
|---|---|---|---|
| 聯盟顏色 | 新秀 #3FB86B、業餘 #3D8BFF、挑戰者 #8E4BE0、職業 #F2542D、傳奇 #E8B21C | `LEAGUES.color` 是 #3FA34D／#2D7CFF／#8E44E8／#E8573F／#D4A017 | 改成設計稿的顏色（只有顏色，規則不變） |
| 聯盟徽章 | IdLgBadge：盾牌＋星數＝等級、三種狀態（已到達／目前／未到達＋鎖） | 只有 `icon('league')` 加數字 | 新增 `leagueBadge.ts`；首頁原本的聯盟卡維持舊徽章（不在這次範圍） |
| 遊戲指南入口 | 首頁標題列「?」 | 沒有 | 新增；只在「球團」分頁顯示 |
| 下一個目標 | 首頁「目前建議」下方；電腦版在第一欄最後 | 沒有（只有聯盟卡） | 新增 `goalCard`；聯盟卡保留（設計稿也保留） |
| 聯盟之路／聯盟詳情 | 全畫面；手機爬梯＋底部詳情、電腦版台階＋440px 面板 | 沒有 | 新增 `leagueRoadView.ts` |
| 積分、晉級區、危險區、降級 | 示意數字：0～100、勝 +3／敗 −2、晉級區 80、危險區 20、歸零降級、起始 50 | **沒有積分，所有聯盟只升不降** | 只在指南／聯盟之路以「示意・待定」標籤出現；首頁不顯示任何積分 |
| 目標卡 C／D／E（積分條） | 挑戰者以上顯示玩家的積分條 | 沒有資料 | **不做**：顯示正式條件（100 場／60%）＋一行「示意」說明；積分條等 RFC 定案 |
| IdRank（晉級資格／成功／失敗／降級對話框）、IdRankStates（+3／−2 回饋、六態、Toast） | 有 | 晉級成功／失敗對話框已經有（leagueView.ts） | 不改：降級、積分回饋都依賴未定案的規則，放到第二階段 |
| 「?」按鈕的樣式 | 白圓 44px、Bungee | — | 照做 |
| 全畫面視窗的關閉鈕 | 「✕ 關閉」白框透明 | `v2Modal` 只有 ✕ | `v2Modal` 新增 `full` 選項 |

## 2. 現有規則與資料模型盤點

- `domain/leagueConfig.ts`：`LEAGUES`（tier、名稱、顏色、`opponentMean` 5.0～6.6、`rewardMultiplier` 1.0～1.6、`promotionReward`）、`PROMOTION_CONFIG`（100 場、最近 60 場、60%、失敗後 12 場、挑戰加成 0.25、紀錄 10 筆）。
- `domain/league.ts`：`LeagueState { tier, matches, wins, losses, recent, promotions, highestTier, nextChallengeSeq, challengeReadyAt, challenges, rewardedTiers }`；`eligibility()`、`recordLeagueResult()`、`leagueViolations()`。
- `application/settlementService.ts`：`settleOutcomes` 逐場記錄；`plan.leagueTier !== league.tier` 時拒絕（固定的進行中比賽除外），只有同聯盟的比賽才 `recordLeagueResult`。
- `application/batchRunner.ts`：一批的所有比賽都用結算開始時的 `club.league.tier` 規劃。
- `application/leagueService.ts`：`challengeNextLeague`（鎖 → 先結算到期比賽 → 檢查序號與資格 → 打挑戰賽 → `applyChallenge` → 一次存檔），用 `nextChallengeSeq＋requestKey` 冪等。
- `application/guidance.ts`：`eligibility().ok` 時建議挑戰。
- `infrastructure/clubRepository.ts`：每次讀寫都 `validateClub` → `leagueViolations`。
- 存檔：`dice-baseball.club.v3`、`schemaVersion 8`、遷移鏈 3→…→8（`domain/migration.ts`）。

### `tier`／`highestTier`／`promotions` 必須相等的假設（降級會打破）

| 位置 | 假設 | 第二階段要怎麼改 |
|---|---|---|
| `league.ts` `leagueViolations` | `promotions === highestTier === tier` | 改成 `tier ≤ highestTier`、`promotions ≥ highestTier`（重返也算一次晉級）；另加 `relegations` 計數 |
| `league.ts` `leagueViolations` | `rewardedTiers` 每個 `≤ highestTier` | 不變（降級不改 highestTier） |
| `leagueService.ts` `applyChallenge` | `toTier = fromTier + 1`、`highestTier = max(...)`、`promotions++`、首次獎勵看 `rewardedTiers` | 不變；重返時 `rewardedTiers` 已有 → 不再發（已經是這樣） |
| `scripts/balance/upgrades.ts`、`scripts/bench-v2-idle.ts` | 直接設 `tier=highestTier=promotions` | 補 relegations 欄位 |
| `ui/leagueBadge.ts` `badgeStateFor` | 用 `highestTier` 判斷「已到達」 | 已經支援 tier < highestTier |
| `ui/dashboardView.ts` 聯盟卡 | 「下一級」= tier + 1 | 不變 |
| 平衡腳本 `TierLog.reachedDay` | 第一次到達 | 已改成 `??=`，重返不覆寫 |

## 3. 架構

```
domain/leagueConfig.ts ──(規則、顏色、倍率、獎勵)──┐
domain/config.ts、progressionConfig.ts ────────────┤
                                                   ▼
ui/leagueInfo.ts   規則文字（officialConditions…）＋ RANKED_PREVIEW（示意，只給畫面）
ui/guideContent.ts 指南章節（數字全部從 config 讀）
ui/leagueBadge.ts  徽章
ui/guideView.ts        → v2Modal({ full })    （「?」）
ui/leagueRoadView.ts   → v2Modal({ full }) ＋ 底部 sheet／右側面板
ui/dashboardView.ts goalCard → openRoad
```

- 全部唯讀：沒有任何新的寫入路徑，不碰 `ClubController`、不改存檔。測試驗證開關這些畫面時存檔寫入次數不變。
- 對話框堆疊：都用 `v2Modal`，`owner: controller`，所以 `App.close()` 的 `closeDialogs(controller)` 會一起清掉；Esc 只關最上層；關閉後焦點回到開啟它的按鈕（按鈕在 click 時先自己 `focus()`，避免 Safari 點擊不給焦點）。
- `RANKED_PREVIEW` 刻意放在 `ui/`、不放 `domain/`：它不是規則，任何結算都讀不到。

## 4. 第二階段（RFC 確認後）

1. `domain/leagueConfig.ts` 新增 `RANKED_CONFIG`（定案的數字）。
2. `LeagueState` 新增 `points`、`protectLeft`、`relegations`、`lastRelegation?`；`recordLeagueResult` 改成同時更新積分。
3. 降級在 `settleOutcomes` 逐場判定；判定後同一批剩下的比賽要用新聯盟重新規劃（`settleDueUnsaved` 把一批切成兩段：降級點之前、之後）。這是唯一需要動結算流程的地方。
4. `eligibility()` 依聯盟切換：0～1 級 classic，2 級以上 points＋挑戰賽。
5. 遷移 schema 8 → 9（見 RFC 第 6 節）。
6. UI：首頁目標卡 C／D／E 的積分條、直播卡結束列的 ±分、六態聯盟卡、降級對話框（IdRank relegate）、Toast（進入／離開危險區）。
7. 測試：重送、多分頁、離線批次、重新整理、Replay 都不重複計分；降級不在 Replay 中發生；舊存檔不會突然降級。

## 5. 檔案

- 新增：`src/v2/ui/leagueInfo.ts`、`guideContent.ts`、`guideView.ts`、`leagueBadge.ts`、`leagueRoadView.ts`、`phase7.dom.test.ts`、`scripts/balance/ranked.ts`、`scripts/balance-v2-ranked.ts`、`docs/phase7-*.md`、`docs/balance/v2-phase7-ranked-report.md`。
- 修改：`leagueConfig.ts`（只有顏色）、`dialog.ts`（`full`）、`app.ts`（「?」、開啟函式）、`dashboardView.ts`（目標卡）、`icons.ts`（search、help）、`strings.ts`、`v2.css`、`phase6a.dom.test.ts`（首頁順序多了目標卡）、`scripts/balance/simulate.ts`（可選的 ranked hook 與分段結算：降級後的比賽用新聯盟規劃；沒指定 ranked 時行為不變）。
- 首頁目標卡的勝率提示：最近 60 場是滾動視窗，只顯示「目前幾勝、目標幾勝、目前差幾勝」並說明舊比賽會被擠出，不承諾「再贏 N 場」；資格判定仍是 `eligibility()`。
