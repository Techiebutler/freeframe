import { describe, it, expect } from 'vitest'
import { sortAssets } from '../sort-assets'
import type { AssetStatus } from '@/types'

function a(id: string, name: string, updated_at: string, status: AssetStatus = 'in_review', asset_type = 'video') {
  return { id, name, updated_at, status, asset_type }
}

const list = [
  a('1', 'bravo', '2026-01-02T00:00:00Z', 'approved', 'image'),
  a('2', 'alpha', '2026-01-03T00:00:00Z', 'draft', 'video'),
  a('3', 'charlie', '2026-01-01T00:00:00Z', 'in_review', 'audio'),
]
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('sortAssets', () => {
  it('keeps the incoming order for custom', () => {
    expect(ids(sortAssets(list, 'custom', 'desc'))).toEqual(['1', '2', '3'])
  })

  it('sorts by modified date', () => {
    expect(ids(sortAssets(list, 'date', 'desc'))).toEqual(['2', '1', '3'])
    expect(ids(sortAssets(list, 'date', 'asc'))).toEqual(['3', '1', '2'])
  })

  it('sorts by name', () => {
    expect(ids(sortAssets(list, 'name', 'asc'))).toEqual(['2', '1', '3'])
  })

  it('sorts by status in review order', () => {
    expect(ids(sortAssets(list, 'status', 'asc'))).toEqual(['3', '2', '1'])
  })

  it('sorts by type', () => {
    expect(ids(sortAssets(list, 'type', 'asc'))).toEqual(['3', '1', '2'])
  })

  it('does not reorder the array it was given', () => {
    sortAssets(list, 'name', 'asc')
    expect(ids(list)).toEqual(['1', '2', '3'])
  })
})
