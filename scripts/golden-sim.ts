// 重新產生模擬器 Golden 指紋（只在「有意改變比賽結果」時才更新，並在 PR 說明原因）：
//   vite-node scripts/golden-sim.ts > src/sim/__golden__/sim-golden.json
import { goldenCases, goldenPrint } from '../src/sim/__golden__/cases'

const out: Record<string, unknown> = {}
for (const c of goldenCases()) out[c.id] = goldenPrint(c)
console.log(JSON.stringify(out, null, 1))
