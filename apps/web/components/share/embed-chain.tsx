'use client'

import * as React from 'react'

export interface ChainItem { id: string; name: string; role: string; order: number; duration?: number | null; count?: number }

const ROLE_ORDER = ['opening', 'hook', 'lead', 'body', 'cta']
const ROLE_LABEL: Record<string, string> = { opening: 'Opening', hook: 'Hook', lead: 'Lead', body: 'Body', cta: 'CTA' }

/** Roles in the order of an ad; unknown roles go last. */
export const roleRank = (role: string) => { const i = ROLE_ORDER.indexOf(role); return i < 0 ? ROLE_ORDER.length : i }

/** The columns of the chain: one per role, alternatives (Hook 1/2/3) stacked in their column. */
export function chainColumns(items: ChainItem[]): ChainItem[][] {
  const roles = Array.from(new Set(items.map(i => i.role))).sort((a, b) => roleRank(a) - roleRank(b))
  return roles.map(r => items.filter(i => i.role === r).sort((a, b) => a.order - b.order))
}

/** Items of a module share, in play order: roles first, then their order; null when the folder is no module request. */
export function chainOrder<T extends { role?: string | null; order?: number | null }>(assets: T[]): T[] | null {
  if (!assets.some(a => a.role)) return null
  const rest = assets.filter(a => !a.role)
  const parts = assets.filter(a => a.role).sort((a, b) => roleRank(a.role!) - roleRank(b.role!) || (a.order ?? 0) - (b.order ?? 0))
  return [...parts, ...rest]
}

const label = (item: ChainItem, siblings: number) => `${ROLE_LABEL[item.role] ?? item.role}${siblings > 1 ? ` ${item.order + 1}` : ''}`
/** The pill's width hints at the part's length. */
const width = (item: ChainItem) => Math.round(76 + Math.min(item.duration ?? 5, 30) * 2)

/**
 * The files of a module ad as a left-to-right chain (hooks stacked as alternatives, joined to the body, then the CTA).
 * Clicking a pill plays that part. Blue glass; the path through the selected file is the bright one.
 */
export function EmbedChain({ items, selectedId, onSelect }: { items: ChainItem[]; selectedId: string; onSelect: (id: string) => void }) {
  const cols = React.useMemo(() => chainColumns(items), [items])
  const box = React.useRef<HTMLDivElement>(null)
  const [paths, setPaths] = React.useState<{ d: string; on: boolean }[]>([])
  const [size, setSize] = React.useState({ w: 0, h: 0 })

  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const draw = () => {
      const b = el.getBoundingClientRect()
      const at = (id: string) => { const n = el.querySelector(`[data-id="${CSS.escape(id)}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left - b.left, r: r.right - b.left, y: r.top - b.top + r.height / 2 } }
      const out: { d: string; on: boolean }[] = []
      for (let c = 0; c < cols.length - 1; c++) {
        for (const a of cols[c]) for (const z of cols[c + 1]) {
          const A = at(a.id), Z = at(z.id)
          if (!A || !Z) continue
          const m = (A.r + Z.l) / 2
          const single = cols[c].length === 1 && cols[c + 1].length === 1
          out.push({ d: `M${A.r} ${A.y} C ${m} ${A.y}, ${m} ${Z.y}, ${Z.l} ${Z.y}`, on: a.id === selectedId || z.id === selectedId || (single && cols.some(col => col.some(i => i.id === selectedId))) })
        }
      }
      setPaths(out)
      setSize({ w: el.scrollWidth, h: el.scrollHeight })
    }
    draw()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [cols, selectedId])

  return (
    <div className="ep-chain-wrap" role="group" aria-label="Files of this ad">
      <div ref={box} className="ep-chain">
        <svg width={size.w} height={size.h} aria-hidden="true">{paths.map((p, i) => <path key={i} d={p.d} data-on={p.on ? '' : undefined} />)}</svg>
        {cols.map((col, ci) => (
          <div key={ci} className="ep-col">
            {col.map(item => (
              <button key={item.id} type="button" data-id={item.id} aria-pressed={item.id === selectedId} title={item.name} onClick={() => onSelect(item.id)} className="ep-pill" style={{ width: width(item) }}>
                <span>{label(item, col.length)}</span>
                {!!item.count && <span className="ep-count" aria-label={`${item.count} comments`}>{item.count}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
