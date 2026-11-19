// 重新產生球團 Golden（只在有意改變比賽、收益或積分時才更新，並在 PR 說明原因）：
//   vite-node scripts/golden-club.ts > src/v2/application/__golden__/club-golden.json
import { GOLDEN_CLUBS, clubGolden } from '../src/v2/application/__golden__/clubGolden'

const out: Record<string, unknown> = {}
for (const [seed, tier, n] of GOLDEN_CLUBS) out[`c${seed}-t${tier}`] = await clubGolden(seed, tier, n)
console.log(JSON.stringify(out, null, 1))
