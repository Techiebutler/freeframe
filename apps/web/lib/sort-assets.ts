import type { AssetStatus } from '@/types'
import type { SortDirection, SortKey } from '@/stores/view-store'
import { compareNames } from './utils'

const statusOrder: Record<AssetStatus, number> = {
  in_review: 0,
  draft: 1,
  approved: 2,
  rejected: 3,
  archived: 4,
}

interface SortableAsset {
  name: string
  status: AssetStatus
  asset_type: string
  updated_at: string
}

/**
 * The order the project view shows assets in. The review page's prev/next
 * walks the same order, so both have to come from here. 'custom' keeps the
 * order they arrived in. Returns a new array.
 */
export function sortAssets<T extends SortableAsset>(
  assets: readonly T[],
  sortKey: SortKey,
  sortDirection: SortDirection,
): T[] {
  const result = [...assets]
  if (sortKey === 'custom') return result

  result.sort((a, b) => {
    let cmp = 0
    if (sortKey === 'date') {
      cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    } else if (sortKey === 'name') {
      cmp = compareNames(a.name, b.name)
    } else if (sortKey === 'status') {
      cmp = statusOrder[a.status] - statusOrder[b.status]
    } else if (sortKey === 'type') {
      cmp = a.asset_type.localeCompare(b.asset_type)
    }
    return sortDirection === 'asc' ? cmp : -cmp
  })
  return result
}
