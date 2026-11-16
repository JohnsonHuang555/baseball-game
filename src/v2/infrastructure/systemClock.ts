// 正式環境的時間來源：核心邏輯只透過 Clock 取得時間，Date.now() 只出現在這裡
import type { Clock } from '../application/idleEngine'

export const systemClock: Clock = { now: () => Date.now() }
