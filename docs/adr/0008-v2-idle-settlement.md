# V2 放置結算：時間錨點、結算游標、冪等領取，與 localStorage 的多分頁限制

V2 的比賽在玩家不在的時候也要「打完」，回來時一次結算。核心原則：**同一場比賽只能結算一次，時間與存檔操作必須可測試、可恢復。**

## 資料（`src/v2/domain/club.ts`，schemaVersion 3，key `dice-baseball.club.v3`）

不沿用 V1 的 Tournament（那是一輪一輪的 roguelike）。球團存檔包含：陣容（沿用模擬的 Roster，Phase 2 不做養成）、戰術、經濟、放置進度、永久戰績、近期比賽與少量 replay，以及每存一次加 1 的 `revision`。數值常數都在 `domain/config.ts`。

## 時間（`application/idleEngine.ts`）

進度只由「時間錨點 `anchorMs`」和現在時間決定，不靠 setInterval 累加；現在時間由 `Clock` 注入，`Date.now()` 只在 `infrastructure/systemClock.ts`。

1. **累積與封頂**：`elapsed = now − anchor`，最多算 8 小時；應打場數 = `floor(elapsed / 5 分鐘)`，最多 96 場。
2. **錨點更新**：結算 n 場後 `anchor = max(anchor, now − 8h) + n × 5 分鐘`。不足一場的餘數留著；超過 8 小時的部分在這一步捨棄（錨點先拉到 `now − 8h`），之後不會補回來。
3. **時間倒退**：`now < anchor` 時 0 場，錨點不動。錨點不往回拉，所以「調慢時鐘再調回來」不會多出場次。反過來把時鐘調快，最多就是提早拿到 8 小時的量，之後時間追上錨點前都是 0 場；沒有伺服器時間就無法偵測，這是單機版接受的限制。
4. **已完成的比賽不會因為時間改變而重算**：結算過的結果直接存起來。

## 設定生效時間

換陣容或戰術（`updateSettings`）會在同一次存檔裡：先用舊設定把已經到時間的比賽打完，再套用新設定。新設定從下一場還沒到期的比賽開始生效，記在 `strategy.effectiveFromMatch`。每場比賽開打前都會做陣容、戰術的深拷貝快照（`planMatch`）。

## 結算與冪等（`application/settlementService.ts`）

- 第 i 場的 `matchId = clubId#i`，種子 = `deriveSeed(clubSeed, i)`，對手也由球團種子推導，所以重新整理或重跑批次都只會得到同一場比賽。
- **結算游標** `idle.nextMatchIndex`：比它小的場次再送來就略過，跳號或種子對不起來就整批拒絕。
- **三筆帳分開**：戰績 `record`（已結算）、`economy.unclaimed`（已結算未領取）、`economy.assets`（已領取）。結算只加 `unclaimed`，領取把 `unclaimed` 搬進 `assets`；同一個 `claimId` 重送不會再入帳。恆等式：`assets + unclaimed = lifetime`。
- 狀態轉換都是不改輸入的純函式；服務層在鎖內「重新讀取 → 計算 → 存檔」，**存檔成功才回報成功**。

## 失敗恢復

以單場為單位：

- **中斷**（AbortSignal，例如分頁要關了）：已經打完的場次照樣存檔，錨點只推進這幾場，剩下的下次接著打。因為模擬是確定性的，最後結果跟一次打完完全相同。
- **模擬失敗**：失敗之前的場次存檔，失敗的那一場沒有任何紀錄或收益，游標停在它，然後丟 `SettlementError`。
- **存檔失敗**：什麼都不算，丟 `ClubSaveError('write-failed')`。重試的結果跟沒失敗過一樣。
- 換設定時，如果到期的比賽沒有全部打完，整個操作都不存。

## 多分頁

localStorage 沒有交易，也沒有 compare-and-swap：兩個分頁可能都讀到舊版本，然後各自覆寫。

- **有 Web Locks**（`navigator.locks`，主流瀏覽器 2022 年起都支援）：結算、領取、換設定整段包在同一把跨分頁的鎖 `dice-baseball.club.v3.settlement` 裡，鎖內重新讀取最新存檔。
- **沒有 Web Locks**：降級成分頁內互斥（`InProcessLock`，`crossTab: false`）。存檔前會重新讀取並比對 `revision`，衝突時丟 `conflict`，能擋下大部分重複結算；但「比對」和「寫入」之間仍可能被別的分頁插隊，所以**不宣稱跨分頁安全**。UI 看到 `crossTab: false` 時應該限制成單一可寫分頁（例如提示「請關閉其他分頁」，其他分頁只讀）。
- 不用自製的 localStorage 鎖（寫一個時間戳當鎖）：它本身就有同樣的競爭問題，只會讓人誤以為安全。

**IndexedDB**：readwrite 交易在同一個物件存放區上會被瀏覽器序列化，可以在交易裡做真正的 compare-and-swap。但模擬是非同步分批執行的，不能放在交易裡（交易會在事件迴圈閒下來時自動提交），所以還是得「交易外計算、交易內比對 revision 後寫入」；而且要處理非同步 API、schema 升級，測試也要另外裝 fake-indexeddb。Phase 2 的存檔大約 50 KB，Web Locks 已經足夠；之後如果要保存大量完整 replay，再把 replay 封存移到 IndexedDB。

## 資料量

| 類別 | 內容 | 保留 |
|---|---|---|
| 永久 | 球團、球員、戰術、資產、未領取、總收益、戰績、結算游標 | 一直保留 |
| 一段時間 | 近期比賽摘要（含最多 3 個精彩事件） | 最近 50 場 |
| 選擇性 | 完整 MatchReplay（含雙方陣容與指令） | 最近 3 場 |
| 防重送 | 領取編號 | 最近 20 個 |

近期比賽滿了之後，存檔大約維持在 50 KB，不會隨場次成長（有測試驗證）。

## 效能（`npm run bench:v2:idle`）

每場約 1.6～3 ms（含計畫、模擬、記帳），其中模擬約佔八成。一次結算的上限是 96 場，大約 0.2～0.3 秒，每 8 場讓出一次主執行緒（`yieldToMain`）。1,000 場約 1.6～2.1 秒，存檔維持在約 50 KB。在比較慢的手機上，可以把 `chunkSize` 調小；要完全不佔主執行緒，可以把 `runBatch` 搬進 Web Worker：計畫與結果都是可以序列化的純資料，鎖與存檔仍然留在主執行緒。
