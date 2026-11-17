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

/**
 * Which part of a module ad a file name says it is (the server only knows this for requests with a manifest).
 * EN_Hook1_WithoutTwoThings, EN-hook-a, hook1-v2, EN_Body, EN_CTA; "hook1_full" stays a whole ad. Same rules as the feedback agent's moduleRoleOf.
 */
export function moduleRoleOf(name: string): { role: 'hook' | 'body' | 'cta'; order: number } | undefined {
  const base = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '')
  if (/(^|[^a-z])cta([^a-z]|$)/i.test(base)) return { role: 'cta', order: 0 }
  const place = (x?: string) => (!x ? 0 : /^\d+$/.test(x) ? Math.max(0, Number(x) - 1) : /^[a-c]$/i.test(x) ? x.toLowerCase().charCodeAt(0) - 97 : 0)
  const named = base.match(/(?:^|[^a-z0-9])(hook|body)(\d{1,2})[-_ ][a-z][a-z0-9]*(?:[-_ ][a-z0-9]+)*$/i)
  if (named && !/full|final|complete/i.test(base)) return { role: named[1].toLowerCase() as 'hook' | 'body', order: place(named[2]) }
  const m = base.match(/(?:^|[^a-z0-9])(hook|body)(?:(\d{1,2})|[-_ ]([a-c0-9]{1,2}))?(?:[-_ ]v\d+)?$/i)
  return m ? { role: m[1].toLowerCase() as 'hook' | 'body', order: place(m[2] ?? m[3]) } : undefined
}

/** Assets without a server-side role get one from their file name, when at least one name is a module part; `order` is the rank within the role. */
export function inferRoles<T extends { name: string; role?: string | null; order?: number | null }>(assets: T[]): T[] {
  if (assets.some(a => a.role)) return assets
  const found = assets.map(a => moduleRoleOf(a.name))
  if (!found.some(Boolean)) return assets
  const keyed = assets.map((a, i) => ({ i, f: found[i] })).filter(x => x.f) as { i: number; f: { role: string; order: number } }[]
  const rank = new Map<number, number>()
  for (const role of Array.from(new Set(keyed.map(x => x.f.role)))) keyed.filter(x => x.f.role === role).sort((x, y) => x.f.order - y.f.order || x.i - y.i).forEach((x, n) => rank.set(x.i, n))
  return assets.map((a, i) => (found[i] ? { ...a, role: found[i]!.role, order: rank.get(i) ?? 0 } : a))
}

export const partLabel = (item: { role?: string | null; order?: number | null }, siblings: number) => { const r = item.role ?? ''; return `${ROLE_LABEL[r] ?? r}${siblings > 1 ? ` ${(item.order ?? 0) + 1}` : ''}` }
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
                <span>{partLabel(item, col.length)}</span>
                {!!item.count && <span className="ep-count" aria-label={`${item.count} comments`}>{item.count}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
