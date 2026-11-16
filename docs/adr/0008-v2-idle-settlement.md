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
- **三筆帳分開**：戰績 `record`（已結算）、`economy.unclaimed`（已結算未領取）、`economy.assets`（已領取）。結算只加 `unclaimed`，領取把 `unclaimed` 搬進 `assets`。
- **領取序號**：領取請求要帶讀到的 `economy.nextClaimSeq`。序號等於目前值才入帳，然後加 1；比目前小就當作已經處理過（重送、別的分頁先領了），回傳當時領到的數量（`lastClaim`）；比目前大就拒絕。存檔只多一個整數和上一次的結果，不管領過幾次，任何舊請求都不會再生效。（第一版用「最近 20 個 claimId」，第 21 次之後舊的編號就會失效，所以改成序號。）
- 狀態轉換都是不改輸入的純函式；服務層在鎖內「重新讀取 → 計算 → 存檔」，**存檔成功才回報成功**。

## 帳務不變量

`domain/club.ts` 的 `economyViolations` 檢查以下三點，讀檔驗證時對不起來就當作存檔損壞（`invalid-schema`），測試裡隨機交錯結算、領取、重送也要一直成立：

1. 每一筆都 ≥ 0。
2. `assets + unclaimed = lifetime`（Phase 2 沒有支出）。
3. `lastClaim.seq = nextClaimSeq − 1`；還沒領過時 `nextClaimSeq = 0`、`lastClaim = null`。

**Phase 3 加入支出時的調整**（本階段不實作）：

- 新增 `economy.spent`（累計支出），不變量改成 `assets = (lifetime − unclaimed) − spent`，也就是「已領取的總額 − 已花掉的總額」。`lifetime` 仍然只代表賺到的錢，不扣支出，戰績、成就照舊看它。
- 支出要用跟領取一樣的方式做到冪等：每筆支出帶單調遞增的序號（`nextSpendSeq`），或是帶唯一的購買編號，並以「目前序號」當游標，不要靠保留最近 N 筆編號。
- 支出在同一把 ClubLock 裡做「重新讀取 → 檢查 `assets` 夠不夠 → 扣款 → 存檔」，不允許 `assets` 變成負數；只能花已領取的錢，不能直接花 `unclaimed`。
- 這是存檔格式的改變：schemaVersion 升到 4，並提供 3 → 4 的轉換（`spent = 0`、`nextSpendSeq = 0`）。

## 失敗恢復

以單場為單位：

- **中斷**（AbortSignal，例如分頁要關了）：已經打完的場次照樣存檔，錨點只推進這幾場，剩下的下次接著打。因為模擬是確定性的，最後結果跟一次打完完全相同。
- **模擬失敗**：失敗之前的場次存檔，失敗的那一場沒有任何紀錄或收益，游標停在它，然後丟 `SettlementError`。
- **存檔失敗**：什麼都不算，丟 `ClubSaveError('write-failed')`。重試的結果跟沒失敗過一樣。
- 換設定時，如果到期的比賽沒有全部打完，整個操作都不存。
- **接續舊結果**（`runBatch` 的 `completed`）：舊結果的整份計畫（陣容、戰術、對手、種子、規則版本）要跟現在的計畫完全一樣；結果本身的重播設定、規則版本與 AI 設定也要跟計畫相同。只要有一項不同就丟 `BatchResumeError`，不會拿舊陣容打出來的結果，記在新陣容的帳上。比對時會先把物件的 key 排序，所以從存檔讀回來的資料也能比對。

## 多分頁

localStorage 沒有交易，也沒有 compare-and-swap：兩個分頁可能都讀到舊版本，然後各自覆寫。

- **有 Web Locks**（`navigator.locks`，主流瀏覽器 2022 年起都支援）：結算、領取、換設定整段包在同一把跨分頁的鎖 `dice-baseball.club.v3.settlement` 裡，鎖內重新讀取最新存檔。
- **沒有 Web Locks**：降級成分頁內互斥（`InProcessLock`，`crossTab: false`）。存檔前會重新讀取並比對 `revision`，衝突時丟 `conflict`，能擋下大部分重複結算；但「比對」和「寫入」之間仍可能被別的分頁插隊，所以**不宣稱跨分頁安全**。UI 看到 `crossTab: false` 時應該限制成單一可寫分頁（例如提示「請關閉其他分頁」，其他分頁只讀）。
- **建立與重設球團**也走同一把鎖：UI 一律用 `application/clubLifecycle.ts` 的 `createClubSafely`、`resetClubSafely`，回傳值會帶 `crossTab`。`ClubRepository.createClub`、`resetClub` 是沒有上鎖的底層操作，只給這兩個入口使用。有 Web Locks 時，重設會等正在進行的結算存完才刪，刪掉的球團不會被寫回來；沒有 Web Locks 時，結算存檔前的 revision 檢查會發現球團已經不在（或已經被重新建立），丟 `conflict`，一樣能擋下大部分情況，但不保證。
- 不用自製的 localStorage 鎖（寫一個時間戳當鎖）：它本身就有同樣的競爭問題，只會讓人誤以為安全。

**IndexedDB**：readwrite 交易在同一個物件存放區上會被瀏覽器序列化，可以在交易裡做真正的 compare-and-swap。但模擬是非同步分批執行的，不能放在交易裡（交易會在事件迴圈閒下來時自動提交），所以還是得「交易外計算、交易內比對 revision 後寫入」；而且要處理非同步 API、schema 升級，測試也要另外裝 fake-indexeddb。Phase 2 的存檔大約 50 KB，Web Locks 已經足夠；之後如果要保存大量完整 replay，再把 replay 封存移到 IndexedDB。

## 資料量

| 類別 | 內容 | 保留 |
|---|---|---|
| 永久 | 球團、球員、戰術、資產、未領取、總收益、戰績、結算游標 | 一直保留 |
| 一段時間 | 近期比賽摘要（含最多 3 個精彩事件） | 最近 50 場 |
| 選擇性 | 完整 MatchReplay（含雙方陣容與指令） | 最近 3 場 |
| 防重送 | 領取序號與上一次領取的結果 | 一個整數，不會成長 |

近期比賽滿了之後，存檔大約維持在 50 KB，不會隨場次成長（有測試驗證）。

## 依賴組裝

`infrastructure/composition.ts` 的 `createV2Deps()` 是唯一的組裝入口：localStorage、Web Locks（不支援時降級）、系統時間，以及批次每 `BATCH_CONFIG.chunkSize` 場用 `yieldToMain` 讓出主執行緒。即使有人繞過入口直接呼叫 `runBatch`，預設也會讓出（`yieldControl` 沒給就是 `yieldToMain`；Web Worker 裡給 `null` 才不讓出）。測試用 `createV2Deps` 的覆寫參數，換成可控制的時鐘、儲存與讓出函式。

## 效能（`npm run bench:v2:idle`）

每場約 1.6～3 ms（含計畫、模擬、記帳），其中模擬約佔八成。一次結算的上限是 96 場，大約 0.2～0.3 秒，每 8 場讓出一次主執行緒（`yieldToMain`）。1,000 場約 1.6～2.1 秒，存檔維持在約 50 KB。在比較慢的手機上，可以把 `chunkSize` 調小；要完全不佔主執行緒，可以把 `runBatch` 搬進 Web Worker：計畫與結果都是可以序列化的純資料，鎖與存檔仍然留在主執行緒。
