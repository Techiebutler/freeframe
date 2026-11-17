import { describe, expect, it } from 'vitest'
import { shortName } from '../handin-sign'

describe('shortName', () => {
  it('drops the shared title so five tiles do not all read the same', () => {
    expect(shortName('Veda – Black Friday UGC 3 – Hook 4', 'Veda – Black Friday UGC 3')).toBe('Hook 4')
    expect(shortName('Hook 4.mp4', 'Veda – Black Friday UGC 3')).toBe('Hook 4.mp4')
    expect(shortName('Veda – Black Friday UGC 3', 'Veda – Black Friday UGC 3')).toBe('Veda – Black Friday UGC 3')
  })
})
