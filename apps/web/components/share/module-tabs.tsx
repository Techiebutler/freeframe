'use client'

import * as React from 'react'
import { chainOrder, partLabel } from './embed-chain'

export interface TabItem { id: string; name: string; role?: string | null; order?: number | null; count?: number }

/** What a segment says: "Hook 2", "Body", "CTA" for the parts of a module ad, else the file's own name. */
export function tabName(item: TabItem, items: TabItem[]) {
  if (!item.role) return item.name.replace(/\.[a-z0-9]{2,4}$/i, '')
  return partLabel(item, items.filter(i => i.role === item.role).length)
}

/**
 * The one file switcher of the review UI (embed everywhere: Desk tile, focus, phone, Telegram): one segmented control, text only,
 * hooks first, then Body, then CTA. Full names, one tap switches, the current one is highlighted; scrolls sideways when the segments do not fit.
 */
export function ModuleTabs({ items, selectedId, onSelect }: { items: TabItem[]; selectedId: string; onSelect: (id: string) => void }) {
  const ordered = React.useMemo(() => chainOrder(items) ?? items, [items])
  const cur = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => { cur.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' }) }, [selectedId])
  return (
    <div className="ep-seg" role="group" aria-label="Files of this ad">
      {ordered.map(i => (
        <button key={i.id} ref={i.id === selectedId ? cur : undefined} type="button" aria-pressed={i.id === selectedId} title={i.name} onClick={() => onSelect(i.id)} className="ep-seg-btn">
          {tabName(i, ordered)}
          {!!i.count && <span className="ep-count" aria-label={`${i.count} comments`}>{i.count}</span>}
        </button>
      ))}
    </div>
  )
}
