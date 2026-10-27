// 各畫面的新手教學內容：框哪裡、說什麼
import type { TutorialId, TutorialStep } from './tutorial'

export const TUTORIAL_STEPS: Record<TutorialId, TutorialStep[]> = {
  home: [
    {
      target: '.home-buttons',
      title: '歡迎來到骰子棒球',
      text: '你是教練：隨機發到一支球隊，調整陣容、在關鍵時刻下指令，必要時親自出棒或投球。第一次玩建議先到「自由練習」熟悉操作，再挑戰錦標賽。',
    },
  ],
  team: [
    {
      target: '.team-header',
      title: '這是你的球隊',
      text: '你的球隊用藍色表示，右邊橘色的是這場的對手。隊名可以自己改，也可以隨機換一個。',
    },
    {
      target: '.pitch',
      title: '場上的先發球員',
      text: '藍圈都是你的球員，右下角的字母是綜合評價（S 最好、G 最差）。點一下可以看能力、交換位置，或重骰這名球員。',
    },
    {
      target: '.order-panel',
      title: '打序',
      text: '由上到下是打擊順序，字母依序是打擊、力量、速度、守備。先點一名球員再點另一名，就能交換棒次。',
    },
    {
      target: '.reserves',
      title: '板凳與後援投手',
      text: '比賽中可以派他們上場：代打、代跑、守備替補，或接替累了的投手。',
    },
    {
      target: '.footer-buttons',
      title: '準備好就開賽',
      text: '不滿意整隊可以重骰（次數有限）。按「開始比賽」進入比賽。',
    },
  ],
  match: [
    {
      target: ['.match-top', '.match-header'],
      title: '分清楚誰是誰',
      text: '標著「我方」、藍色的是你的球隊，橘色是對手。三角形標記的是正在進攻的一方。',
    },
    {
      target: '.match-field',
      title: '比賽會自動進行',
      text: '球員會自己打、自己守。左上角隨時告訴你現在是我方進攻還是守備。',
    },
    {
      target: '.pause-btn',
      title: '按「指令」暫停',
      text: '隨時都能暫停下戰術：盜壘、觸擊、代打、換投、守備佈陣……',
    },
    {
      target: ['.manual-toggle', '.match-field'],
      title: '親自出手',
      text: '遇到關鍵打席會由你親自出手：英雄時刻（第 8 局以後一支安打就能追平或超前）、我方守備滿壘、差一步就能讓球員覺醒、第 7 局以後一分差二三壘都有人。自由練習可以用右上角的開關（按 T）改成「每球」或「關」。輪到你時：打擊是停紅線，停在黃色區偏下拉打、偏上推打、正中最強，對手佈陣時可以打向空出來的那一邊；投球是選球種再畫手勢。某一球不想出手，按「這球交給球員」。',
    },
    {
      target: '.speed-toggle',
      title: '比賽速度',
      text: '嫌慢可以切到 2x 或 4x，關鍵時刻會自動放慢。',
    },
    {
      target: '.prompt-btn',
      title: '決策提示',
      text: '關鍵時刻比賽會自動暫停問你要不要下指令。覺得太常或太少，點這裡調整。',
    },
  ],
  decision: [
    {
      target: '.decision-panel .situation-bar',
      title: '現在的局勢',
      text: '局數與出局數、比分（藍色是我方）、壘上有沒有人。',
    },
    {
      target: '.decision-panel .option-card',
      optional: true,
      title: '推薦調度',
      text: '這個時刻值得考慮的指令，會列出換人前後的能力對比。點一下就下達。',
    },
    {
      target: '.panel-toggles',
      title: '其他指令與詳細資訊',
      text: '想用推薦以外的指令，或看雙方球員的完整能力，打開這裡。',
    },
    {
      target: '.hand-over',
      title: '交給球員',
      text: '不想下指令就交給球員，比賽繼續進行。',
    },
  ],
  alignment: [
    {
      target: '.alignment-bar',
      title: '守備佈陣',
      text: '每位打者都有擊球方向（偏左、平均、偏右）。把野手往他習慣的方向移，就能少被打安打；猜錯方向反而留下大洞。每格的百分比是對這位打者的被安打率變化。',
    },
    {
      target: '.match-field',
      title: '野手會跑到新位置',
      text: '佈陣只對目前這位打者有效，打席結束會回到標準站位。三壘有人時可以「內野前進」擋住得分，怕被打長打就「外野後退」。',
    },
  ],
  pitchCall: [
    {
      target: '.pc-pitches',
      title: '選球種',
      text: '每位投手會 2～4 種球，標「專長」的是他最拿手的。點一個球種就開始投。同一個打席連投同一種球，打者比較容易抓到，記得換著投。',
    },
    {
      target: '.pitch-call',
      title: '畫出手勢',
      text: '接著從綠點開始，照著虛線畫向箭頭，畫出這個球種的手勢。速度也要對：直球、指叉要快，滑球、曲球中等，變速球要刻意畫慢，沿著虛線跑的小球會示範節奏。每一球的虛線會稍微轉個角度，左投手的手勢左右相反。投手的控球越好、體力越多，手勢越寬容。電腦上也可以用方向鍵。',
    },
  ],
  hub: [
    {
      target: '.season-panel',
      title: '例行賽與季後賽',
      text: '例行賽 8 場，拿到 5 勝晉級季後賽，輸第 4 場就淘汰。勝場越多，季後賽的對手越弱。季後賽八強、四強各一場，決賽三戰兩勝。',
    },
    {
      target: '.kit-panel',
      title: '秘寶與裝備',
      text: '秘寶整輪對全隊有效；裝備掛在球員身上，每人最多 2 件。點背包裡的裝備裝上，點身上的裝備卸下。',
    },
    {
      target: '.hub-bottom',
      title: '下一場比賽',
      text: '對手會一場比一場強。開賽前可以調整打序與守位；補強靠每場比賽後的獎勵。',
    },
  ],
  draft: [
    {
      target: '.draft-cards',
      title: '獎勵選擇',
      text: '每場比賽後都有獎勵：贏球 3 選 1，輸球 2 選 1。卡片有球員、裝備、秘寶、特性。先點一張卡。',
    },
    {
      target: '.draft-release',
      title: '交給誰',
      text: '球員卡要換掉一名同類型的球員；裝備選誰帶上（或先放進背包）；特性選誰學會。都不想要就放棄。',
    },
  ],
}
