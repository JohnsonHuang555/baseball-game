# 移除 V1，網站只有 V2（Phase 6D）

## 1. 為什麼移除 V1

V2（放置型棒球經營）已經是正式版本，有完整的養成、招募、聯盟、直播、新手引導與存檔遷移。V1（逐球操作的錦標賽／自由練習）不再開發，保留 V1 帶來三個問題：

- **首頁要先選模式**：玩家要先在 V1 首頁點「放置經營」，V2 也要有「返回 V1 首頁」的按鈕與流程。
- **首頁載入太多**：首頁的 JavaScript 與 CSS 有一大半是 V1 的畫面。
- **共用模組與 V1 綁在一起**：V2 經由共用模組間接依賴 V1 的錦標賽、存檔、獎盃與教學程式。

這次只移除 V1 的遊玩功能，不新增玩法，也不改模擬引擎與平衡數值。

## 2. 新的網站入口

`src/main.ts` 只載入共用樣式（`src/ui/shared.css`），然後呼叫 `startV2`（`src/v2/ui/entry.ts`）。

- **開 `/`**：直接進 V2，沒有模式選擇，也不需要多點一下。重新整理後還是 V2。
- **舊網址 `/#v2`**：照常進 V2，並用 `history.replaceState` 把 `#v2` 拿掉。
  - 不重新載入，也不新增瀏覽紀錄。
  - 保留路徑與查詢字串。
  - 其他 hash 不動。
- **不會重複初始化**：入口不監聽 `hashchange`／`popstate`。同一個 root 再呼叫 `startV2` 會回傳原本的 App，所以返回鍵或改 hash 都不會建立第二個 V2。
- **`openV2(root, opts)` 拿掉了 `onExit` 參數**：V2 就是整個網站，沒有可以離開的上一層。
  - **返回按鈕**：刪除。
  - **存檔損壞畫面**：刪除「回到首頁」。
  - **Escape**：不再關閉 App，開啟時把按鍵設定清空。
  - **觀戰畫面、對話框**：仍然用 Escape 或自己的按鈕關閉，關閉後回到 V2。
  - **`close()`**：只給測試與重新掛載用，畫面上沒有任何會呼叫它的入口。
- **離開前的草稿確認**：原本「有未儲存的草稿時離開 V2 要先確認」跟著離開入口一起刪除。
  - 陣容與戰術的草稿仍在原本的分頁裡，切換分頁也不會丟失。
  - 跟以前一樣，關掉瀏覽器分頁不會提示。

## 3. 刪除的 V1 功能與檔案

依 import graph 確認沒有被 V2 使用之後才刪除：先從 `src/v2/`、`scripts/` 往下找出所有用到的檔案，再拆開共用的部分。

| 功能 | 刪除的檔案 |
|---|---|
| 首頁模式選擇、首頁展示卡片、V2 入口按鈕 | `src/main.ts` 的 V1 首頁、`src/v2/ui/entry.ts` 的舊內容（`v2EntryButton`、`v1Label`） |
| 錦標賽（難度選擇、例行賽／季後賽、獎勵、休息站、商店、選秀、傳奇球員館） | `src/sim/tournament.ts`、`rest.ts`、`prices.ts`、`growth.ts`、`src/ui/tournamentScreen.ts`、`restScreen.ts`、`cards.ts`、`replaceList.ts`、`growthPanel.ts` |
| 自由練習（快速比賽）與自訂隊伍 | `src/ui/practice.ts`、`customTeams.ts` |
| 組隊畫面、逐球比賽畫面、決策面板、親自出手（計量條、投球手勢） | `src/ui/setupScreen.ts`、`gameScreen.ts`、`decisionPanel.ts`、`meter.ts`、`pitchCall.ts`、`gesture.ts`、`synergyResult.ts` |
| 獎盃櫃、通關紀錄、球團史、解鎖進度 | `src/ui/clubHistory.ts`、`progress.ts` |
| V1 教學 | `src/ui/tutorial.ts`、`tutorialSteps.ts` |
| V1 存檔讀寫 | `src/ui/save.ts` |
| V1 畫面樣式 | `src/style.css`、`theme.css`、`team.css`、`match.css`、`decision.css`、`screens.css`、`desktop.css`；仍在使用的部分合併成 `src/ui/shared.css` |

**留下來但刪掉 V1 專屬內容的檔案**：

| 檔案 | 刪掉的內容 |
|---|---|
| `src/ui/strings.ts` | 557 個介面文字刪成 49 個，另外刪掉事件、秘技、裝備的說明文字 |
| `src/ui/prefs.ts` | 隊名、決策提示、親自操作、羈絆展開 |
| `src/ui/synergyUi.ts`、`visual.ts`、`synergyIcons.ts`、`modal.ts`、`grades.ts`、`avatar.ts` | 只有 V1 畫面用的元件 |
| `src/sim/potential.ts` | 覺醒機制，型別保留 |
| `src/sim/items.ts` | 商店的秘技清單 |

**沒有圖片或其他靜態資源要刪**：專案的圖都是程式產生的 SVG／Canvas。

## 4. 保留的共用模組

| 模組 | V2 用在哪裡 |
|---|---|
| `src/sim/game.ts`、`generate.ts`、`rng.ts`、`types.ts`、`traits.ts`、`pitches.ts`、`positions.ts`、`setup.ts`、`arrange.ts`、`synergy.ts`、`items.ts`、`potential.ts` | 自動比賽的模擬、球員產生、招募、陣容、最多羈絆排法、重播與規則版本 |
| `src/ui/field.ts`（FieldRenderer）、`pitchCam.ts`（PitchCam）、`playAnimation.ts`、`sound.ts`、`bases.ts` | 直播與晉級挑戰的觀戰畫面（`replayView.ts`，動態載入） |
| `src/ui/strings.ts` | 播報文字（`describePlay`）、球種、守位、能力、特性、羈絆名稱 |
| `src/ui/avatar.ts`、`grades.ts`、`playerCard.ts`、`visual.ts`、`synergyUi.ts`、`synergyIcons.ts`、`modal.ts`、`keys.ts`、`prefs.ts` | 球員頭像、字母等級、特性標籤、toast、羈絆徽章、確認／選項視窗、快捷鍵、音效與頭像偏好 |

**`basesSvg` 的搬移**：首頁的目前比賽與觀戰比分板用到 `basesSvg`，這個函式原本在 V1 的 `gameScreen.ts`，會把整個 V1 比賽畫面一起拉進來。所以搬到新的 `src/ui/bases.ts`，內容不變。

## 5. 為什麼保留 `src/sim`

`src/sim` 是 V2 自動比賽的模擬引擎，不是 V1 專屬。

- **比賽結果**：V2 每一場的結果、重播、Box Score 都由它決定（ADR-0001、0003、0004、0007）。
- **球員資料**：球員產生與資料格式也是 V2 存檔的一部分。

搬家或重寫都有改變比賽結果的風險，所以只刪掉錦標賽專屬的檔案（tournament、rest、prices、growth）與確定沒人用的函式，其他原樣保留，路徑也不變。

**驗證**：同樣的球團種子、前 100 場，三個種子共 300 場的計畫與結果，雜湊跟 main 完全相同。

## 6. 為什麼保留部分 `src/ui`

`src/ui` 不是 V1 專屬，裡面有 V2 直接使用的元件：

- **觀戰畫面**：Canvas 球場、投球視角、動畫節奏、音效。
- **球員畫面**：頭像、等級徽章、特性、羈絆、對話框、toast。

V2 已經照這些路徑引用它們，所以只刪掉 V1 畫面，不搬家；路徑不是這次的目標。

## 7. V2 存檔相容策略

V2 的存檔完全不變：

- **key**：`dice-baseball.club.v3`，備份 key 也一樣。
- **版本與遷移**：schemaVersion 8，遷移流程不變。
- **存檔內容**：球員、等級、資源、聯盟、近期比賽、固定的 LiveMatch 計畫、新手任務。
- **多分頁鎖**：`dice-baseball.club.v3.settlement`，寫入者 key 也一樣。

**驗證**：

- **既有測試**：遷移、多分頁、固定計畫、冪等結算與領取的測試全部保留並通過。
- **入口與流程**：新增的 `src/v2/ui/entry.dom.test.ts` 從新入口驗證建立、重新整理、結算、領取、升級、招募、陣容、戰術、戰報。
- **舊資料共存**：同時有 V1 舊資料時，載入的是原本的 V2 球團，存檔內容不變。

## 8. V1 舊資料的處理

V1 的 key 都**不再讀取或寫入，也不會刪除**：

- `dice-baseball.tournament.v2`、`dice-baseball.tournament.v1`
- `dice-baseball.progress`
- `dice-baseball.customTeams`
- `dice-baseball.tutorial.*`
- `dice-baseball.teamName`、`dice-baseball.decisionPrompts`、`dice-baseball.manual`、`dice-baseball.synergyExpanded`

**保留的原因**：

- **不會干擾**：這些資料不會覆蓋 V2，也不會讓 V2 重新建立球團，留在瀏覽器裡只佔一點空間。
- **不刪除**：自動刪除玩家資料沒有好處，萬一需要回頭查也還在。
- **舊版的清除也停用**：舊版首頁「刪掉更舊的錦標賽存檔」的動作也一起停用。

**仍然沿用的顯示偏好**：`dice-baseball.avatarSpecies`（貓／狗頭像）、`dice-baseball.outfit`（我方頭像裝扮）與 `dice-baseball.sound`（音效開關）。V2 的畫面一直都在用它們，所以玩家看到的頭像與音效設定不變。

- **選擇入口**：裝扮與貓狗原本是在 V1 首頁與組隊畫面選的，V2 目前沒有切換入口，只沿用已經存下的值。
- **解鎖檢查**：裝扮的解鎖檢查會讀 V1 的獎盃紀錄，所以拿掉了。存下的裝扮本來就是解鎖後才能選的，所以只檢查值是不是認得的裝扮。

## 9. 測試調整

基準是 main `20176f0`（已包含 6B、6C）。全部測試從 47 個檔案、623 個測試，變成 45 個檔案、594 個測試。

**刪除的測試**（對應刪除的功能）：

| 測試 | 數量 | 對應的功能 |
|---|---|---|
| `src/sim/tournament.test.ts` | 35 | 錦標賽、休息站、獎勵卡、潛能、傳奇館 |
| `src/ui/gesture.test.ts` | 10 | V1 親自出手的投球手勢 |
| `src/ui/save.test.ts` | 1 | V1 錦標賽存檔 |
| `src/sim/game.test.ts` 的錦標賽成長 | 3 | `growth.ts` |

**改寫的測試**：`src/v2/ui/app.dom.test.ts` 裡「V1 首頁的模式選擇」與「離開 V2 前確認草稿」兩項，改成「沒有返回按鈕、Escape 不關閉 V2、草稿保留」與「開啟時清空按鍵設定」。存檔損壞畫面的測試改成沒有「回到首頁」。其他 V2 測試只把 `openV2(root, onExit, opts)` 改成 `openV2(root, opts)`。

**新增的測試**：`src/v2/ui/entry.dom.test.ts`，共 20 個。

- **網址**：`/` 與 `/#v2` 都進 V2、其他 hash 不動。
- **重新整理與初始化**：重新整理回到原本的球團；重複啟動、hashchange、返回鍵都不會建立第二個 V2。
- **沒有 V1**：
  - 畫面上沒有任何 V1 的入口與文字。
  - 入口只載入共用樣式與 V2。
  - 沒有任何檔案引用已刪除的 V1 模組或樣式。
- **V1 舊資料**：不讀、不清、不覆蓋 V2。
- **主要流程**：從入口走一遍完整的 V2 主要流程。
- **生命週期**：
  - 重複啟動、`close()` 後重新啟動、重複 `close()`、舊 App 晚關不清掉新的快取。
  - 關閉後沒有留下監聽器、計時器與多分頁鎖。

**保留的共用測試**：
- **模擬引擎**：128 個，包含比賽、守備、跑壘、戰術、延長賽、疲勞、全壘打、左右相剋、特性、關鍵打席、球種、羈絆、產生器、守位、排法。
- **共用元件**：9 個，包含 6B 的球場動畫測試。
- **平衡工具**：16 個。

**V2 測試**：421 個變成 441 個。

## 10. Bundle Size 前後比較（`npm run build`）

基準是 main `20176f0`（已包含 6B、6C）。

| 項目 | 移除前 | 移除後 | 變化 |
|---|---|---|---|
| 首頁 JavaScript | 433.52 kB（gzip 151.54 kB） | 209.30 kB（gzip 73.26 kB） | −52% |
| CSS | 161.39 kB（gzip 29.49 kB） | 46.27 kB（gzip 9.08 kB） | −71% |
| 首頁初始載入（HTML＋JS＋CSS） | 595.8 kB（gzip 181.6 kB） | 256.4 kB（gzip 82.9 kB） | −57% |
| 觀戰畫面（動態載入） | 22.90 kB（gzip 8.75 kB） | 37.28 kB（gzip 13.71 kB） | +14.4 kB（見下） |
| 全部 JavaScript | 456.4 kB（gzip 160.3 kB） | 246.6 kB（gzip 87.0 kB） | −46% |
| Build 時間（`tsc`＋`vite build`，3 次平均） | 9.5 秒（vite 1.91 秒） | 7.7 秒（vite 1.18 秒） | −19% |
| 首頁出現 V2 的時間（Chrome，本機） | 182 ms | 161 ms | −12% |
| 同上（CPU 降速 4 倍＋慢速 4G） | 3,710 ms | 2,283 ms | −38% |

**觀戰畫面為什麼變大**：

- 球場（`field.ts`）、投球視角、動畫與播報文字以前同時被 V1 比賽畫面與觀戰畫面使用，所以被打包進首頁。
- 現在只有觀戰畫面用到，就跟著移到動態載入的 chunk，首頁不用先下載。
- 所以這不是新增的程式。

**首頁出現時間的量法**：

- **工具**：Playwright 開真的 Chrome，從開始載入到建立球團的畫面出現，各 7 次取中位數。
- **字型**：擋掉 Google Fonts，避免外部網路影響。
- **差異來源**：本機的差異小，因為檔案從本機讀取。在慢速網路與慢 CPU 下，下載與解析的量減半，差異就明顯了。

**數字的來源**：這一節的數字在 PR #11 合併後重新量過，基準是 main `20176f0`。PR #13 一開始量的數字以 `ebcfe40` 為基準（還沒有 6B），比例幾乎一樣。

## 11. 與 Phase 6B（PR #11）的整合

**已整合**：PR #11 先合併進 main（`20176f0`），再把 main 合併進這個 PR。下表是合併時處理的地方（反過來的順序也是同樣這些點）。

**合併時要處理的地方**：

| 檔案 | 處理 |
|---|---|
| `src/v2/ui/replayView.ts` | `basesSvg` 從 `../../ui/bases` 匯入（`ui/gameScreen.ts` 已刪除）。git 會自動保留這一行；另外一段註解衝突，保留 6B 的 prelude／reveal 說明，把「V1 animate()」改成「原本逐球比賽畫面 animate()」 |
| `src/v2/ui/phase6b.dom.test.ts` | `openV2(root, () => undefined, {...})` 改成 `openV2(root, {...})`（沒有衝突標記，但不改會編譯失敗） |
| `src/ui/field.ts`、`pitchCam.ts` | 6B 新增的註解提到「V1 比賽畫面」，改成說明觀戰用的方法；舊的 `pitch()`／`play()` 已經沒有呼叫端（`pitch()` 只剩 6B 的 `field.test.ts` 拿來對照），先保留 |
| `src/v2/ui/strings.ts` | 6C 的成長回饋文字與 6B 的 `fx*` 文字都保留 |
| `src/v2/ui/v2.css` | 6C 與 6B 的區塊都保留；注意衝突邊界會切在 `.v2-preview-team { color: var(--indigo);` 中間，要補回 `}`，否則 build 會出現 `Expected "}"` 警告。`v2-entry`、`v1-label` 這些 V1 入口樣式不要加回來 |
| `docs/v2.md` | 功能表兩列都保留；ADR 清單寫成 0014、0015、0016；`bench:v2:idle` 用 6B 的說明（多了精彩時刻判定），保留 6C 的 balance 指令列 |

**避免把 V1 帶回來**：
- `ui/gameScreen.ts`、`style.css` 等 V1 檔案在 #11 裡沒有被修改，合併後維持刪除；`v2.css` 的 V1 入口樣式也沒有回來。
- `src/v2/ui/entry.dom.test.ts` 會檢查兩件事：入口只載入共用樣式與 V2，以及沒有任何檔案（含測試）引用已刪除的 V1 模組或樣式。合併後只要測試通過，就代表沒有重新引入 V1。
