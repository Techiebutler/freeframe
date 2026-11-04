import { describe, expect, it } from 'vitest'
import { pickDefaultLevel } from '../quality'

const lv = (...heights: number[]) => heights.map((height, index) => ({ index, height }))
describe('pickDefaultLevel', () => {
  it('takes the highest rendition up to 1080p', () => {
    expect(pickDefaultLevel(lv(360, 720, 1080, 2160))).toBe(2)
    expect(pickDefaultLevel(lv(360, 540, 720))).toBe(2)
  })
  it('works whatever order the manifest lists them in', () => {
    expect(pickDefaultLevel(lv(1080, 360, 720))).toBe(0)
  })
  it('when everything is above the cap it takes the smallest', () => {
    expect(pickDefaultLevel(lv(1440, 2160))).toBe(0)
  })
  it('stays on auto without usable heights', () => {
    expect(pickDefaultLevel([])).toBe(-1)
    expect(pickDefaultLevel([{ index: 0, height: 0 }, { index: 1, height: 0 }])).toBe(-1)
  })
  it('respects a custom cap', () => {
    expect(pickDefaultLevel(lv(360, 720, 1080), 720)).toBe(1)
  })
})
