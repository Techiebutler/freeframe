'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUpDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useViewStore, type SortKey } from '@/stores/view-store'

const sortOptions: { value: SortKey; label: string }[] = [
  { value: 'custom', label: 'Custom' },
  { value: 'date', label: 'Date' },
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Status' },
  { value: 'type', label: 'Type' },
]

export function SortPopover() {
  const { sortKey, setSortKey, sortDirection, toggleSortDirection } = useViewStore()
  const activeLabel = sortOptions.find((o) => o.value === sortKey)?.label ?? 'Custom'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-tertiary hover:text-text-primary transition-colors">
          <ArrowUpDown className="h-3.5 w-3.5" />
          <span>Sorted by</span>
          <span className="text-text-primary">{activeLabel}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-48 rounded-lg border border-border bg-bg-elevated shadow-xl py-1.5
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                if (sortKey === opt.value) {
                  toggleSortDirection()
                } else {
                  setSortKey(opt.value)
                }
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 font-mono text-xs transition-colors',
                sortKey === opt.value
                  ? 'text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
              )}
            >
              <span className="w-4 shrink-0">
                {sortKey === opt.value && <Check className="h-3.5 w-3.5" />}
              </span>
              {opt.label}
              {sortKey === opt.value && (
                <span className="ml-auto text-xs text-text-tertiary">
                  {sortDirection === 'asc' ? 'A-Z' : 'Z-A'}
                </span>
              )}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
