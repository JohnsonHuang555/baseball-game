# 骰子棒球

手機與電腦都能玩的網頁棒球經營遊戲：管理自己的球團、培養與招募球員、調整陣容與戰術，比賽由自動教練打完，每 5 分鐘一場，離開網站也會繼續（最多算 8 小時）。一路從新秀聯盟往傳奇聯盟晉級，隨時可以觀看正在進行的比賽。

> 網站只有這一個遊戲。開 `/` 就直接進入；以前的網址 `/#v2` 也會進到同一個畫面，並自動把 `#v2` 從網址拿掉。
> 早期「逐球操作的錦標賽／自由練習」版本（V1）已在 Phase 6D 移除，見 [ADR-0016](docs/adr/0016-v2-only-migration.md)。

## 開發

```bash
npm install
npm run dev        # 開發伺服器
npm run test       # 全部測試（模擬引擎、共用元件、V2）
npm run build      # 型別檢查並打包到 dist/
```

| 指令 | 用途 |
|---|---|
| `npm run bench:v2` | 單場模擬效能 |
| `npm run bench:v2:idle` | 放置結算、升級／招募、晉級挑戰、Box Score、直播時間軸等的效能與存檔大小 |
| `npm run balance:v2` | 平衡模擬的例行檢查（4 種玩家策略、30 天） |
| `npm run balance:v2:matrix` / `:analyze` / `:report` | 完整的平衡分析工具（見 `docs/balance/v2-phase6c-report.md`） |

## 程式結構

| 路徑 | 內容 |
|---|---|
| `src/main.ts` | 網站入口：載入共用樣式，呼叫 `startV2` |
| `src/v2/` | 遊戲本體：存檔與規則（`domain/`）、結算／經濟／聯盟／直播（`application/`）、儲存與多分頁鎖（`infrastructure/`）、畫面（`ui/`） |
| `src/sim/` | 確定性的比賽模擬引擎：球員產生、打擊、投球、守備、跑壘、羈絆、規則版本、重播（ADR-0001、0003、0004） |
| `src/ui/` | V2 共用的畫面元件：觀戰球場（`field.ts`）、投球視角（`pitchCam.ts`）、動畫節奏與音效、頭像、等級徽章、對話框、球員小卡、播報文字、共用樣式（`shared.css`） |

詳細的功能、存檔與數值說明見 [`docs/v2.md`](docs/v2.md)；設計決策見 `docs/adr/`。

## 存檔

遊戲進度存在瀏覽器的 localStorage（`dice-baseball.club.v3`，schemaVersion 8），舊版本會自動升級並先備份原文。早期版本留下的資料（錦標賽進度、球團史等）不再讀取，但也不會被刪除。
