import { describe, expect, it } from 'vitest'
import { addMissingFields } from './save'

describe('舊存檔補欄位', () => {
  it('先發陣容的人把目前的守位當本職，指定打擊和板凳由編號推算', () => {
    const batter = (id: string) => ({ id, role: 'batter', ratings: { contact: 5, power: 5, speed: 5, fielding: 5 } })
    const roster = addMissingFields({
      lineup: [
        { position: 'SS', player: batter('a') },
        { position: 'DH', player: batter('b') },
      ],
      bench: [batter('c')],
    }) as { lineup: { player: { primary: string } }[]; bench: { primary: string }[] }
    expect(roster.lineup[0].player.primary).toBe('SS')
    expect(roster.lineup[1].player.primary).toMatch(/^(C|1B|2B|3B|SS|LF|CF|RF)$/)
    expect(roster.bench[0].primary).toMatch(/^(C|1B|2B|3B|SS|LF|CF|RF)$/)
  })
})
