import { describe, expect, it } from 'vitest'
import type { BattedBall } from '../sim/game'
import { describePlay, homeRunName, runnersText } from './strings'

const ball = (type: BattedBall['type'], fielder: BattedBall['fielder']): BattedBall => ({ type, angle: 0, distance: 100, fielder })

describe('全壘打的叫法依得分數', () => {
  it('陽春、兩分、三分、滿貫', () => {
    expect(homeRunName(1)).toBe('陽春全壘打')
    expect(homeRunName(2)).toBe('兩分全壘打')
    expect(homeRunName(3)).toBe('三分全壘打')
    expect(homeRunName(4)).toBe('滿貫全壘打')
    expect(describePlay('homeRun', ball('fly', 'CF'), 4, null)).toBe('轟出滿貫全壘打！')
  })
})

describe('壘上情況', () => {
  it('三個壘包都有人叫滿壘', () => {
    expect(runnersText([true, true, true])).toBe('滿壘')
    expect(runnersText([true, false, true])).toBe('一、三壘有人')
    expect(runnersText([false, false, false])).toBe('壘上無人')
  })
})

describe('比賽紀錄', () => {
  it('雙殺附上守備記號', () => {
    expect(describePlay('doublePlay', ball('ground', 'SS'), 0, '6-4-3')).toBe('游擊方向滾地球，形成 6-4-3 雙殺')
    expect(describePlay('doublePlay', ball('fly', 'CF'), 0, '8-2')).toContain('8-2 雙殺')
    expect(describePlay('doublePlay', ball('line', '2B'), 0, '4-3')).toContain('回壘不及')
  })

  it('失誤寫出是哪個守備員', () => {
    expect(describePlay('error', ball('ground', '3B'), 0, null)).toBe('擊出三壘方向滾地球，三壘手失誤上壘')
  })
})
