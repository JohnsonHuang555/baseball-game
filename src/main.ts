// 網站入口：骰子棒球只有 V2（放置型棒球經營）。開 / 直接進 V2，舊網址 /#v2 也可以（見 v2/ui/entry.ts）。
// 共用樣式（色彩變數、按鈕、對話框、球員卡片、觀戰球場）在前，V2 自己的樣式由 v2/ui/app.ts 載入
import './ui/shared.css'
import { startV2 } from './v2/ui/entry'

startV2(document.getElementById('app')!)
