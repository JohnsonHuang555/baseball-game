// 各畫面的新手教學內容：框哪裡、說什麼
import type { TutorialId, TutorialStep } from './tutorial'

export const TUTORIAL_STEPS: Record<TutorialId, TutorialStep[]> = {
  home: [
    {
      target: '.home-buttons',
      title: '歡迎來到骰子棒球',
      text: '你是教練：隨機發到一支球隊，調整陣容、在關鍵時刻下指令，必要時親自出棒或投球。第一次玩建議從「快速比賽」開始。',
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
      target: '.manual-toggle',
      title: '親自操作',
      text: '想自己打、自己投，就打開這裡（或按 T）。每一球投出前都會直接讓你出手：打擊是先猜球再停紅線（偏下拉打、偏上推打），投球是選球種、點位置再畫手勢。某一球不想出手，按「這球交給球員」。',
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
      text: '每位投手會 2～4 種球，標「看家」的是他最拿手的。同一個打席連投同一種球，打者比較容易抓到，記得換著投。',
    },
    {
      target: '.pc-zone-wrap',
      title: '點一格決定位置',
      text: '這是從捕手後面看的好球帶，黑色直條是打者站的那一邊。紅色是打者的熱區，投進去容易被打；藍色是弱點。四個角落最難打，但投偏了就是壞球；正中間最好投，也最容易被打。',
    },
    {
      target: '.pitch-call',
      title: '畫出手勢',
      text: '點完位置後，從綠點開始照著虛線畫出這個球種的手勢，畫得越像、越快，球就越到位。投手的控球越好、體力越多，手勢越寬容。電腦上也可以用方向鍵。',
    },
  ],
  guess: [
    {
      target: '.guess-box',
      title: '先猜球',
      text: '投手出手前猜這球是直球還是變化球。猜中，計量條的黃色區變寬、打得更扎實；猜錯變窄。上面的球探機率會隨球數變化：球數落後的投手常搶直球，兩好球後愛用變化球。不想猜就直接打。',
    },
    {
      target: '.guess-box',
      title: '停紅線決定方向',
      text: '接著一樣停紅線。停在黃色區偏下是拉打、偏上是推打、正中最強。對手往某一邊佈陣時，故意打向空出來的那一邊吧。',
    },
  ],
  hub: [
    {
      target: '.bracket-panel',
      title: '錦標賽賽程',
      text: '16 隊單場淘汰，決賽三戰兩勝。藍色的是你的球隊與晉級路線。',
    },
    {
      target: '.hub-bottom',
      title: '下一場比賽',
      text: '開賽前可以調整打序與守位，但錦標賽開始後不能再重骰。每贏一輪（決賽除外）都能選秀補強。',
    },
  ],
  draft: [
    {
      target: '.draft-cards',
      title: '選秀',
      text: '贏球的獎勵：從三名球員中挑一名加入。先點一張卡。',
    },
    {
      target: '.draft-release',
      title: '換掉誰',
      text: '選好後，從這裡挑一名同類型的球員換掉。都不想要就放棄選秀。',
    },
  ],
}
