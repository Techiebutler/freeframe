'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, Download, Loader2 } from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import type { DownloadOption } from '@/types'

/**
 * Pick what a download is: the original upload, or the transcode the server
 * made of it. The options are asked for when the menu opens, not before, since
 * most menus are never opened and the answer costs the server a storage lookup.
 */

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export function useDownloadOptions(load: () => Promise<DownloadOption[] | null>) {
  const [options, setOptions] = React.useState<DownloadOption[]>([])
  const [state, setState] = React.useState<LoadState>('idle')
  const loadRef = React.useRef(load)
  loadRef.current = load

  // Re-asked on every open: a version can finish transcoding while the page
  // sits there, and the menu should then offer what it now has.
  const refresh = React.useCallback(async () => {
    setState('loading')
    try {
      const result = await loadRef.current()
      if (result && result.length > 0) {
        setOptions(result)
        setState('ready')
      } else {
        setState('error')
      }
    } catch {
      setState('error')
    }
  }, [])

  return { options, state, refresh }
}

/**
 * Keyboard users open the menu before the options arrive, so Radix focuses the
 * menu itself and Enter does nothing until an arrow key moves into the list.
 * Once the options are in, move focus to the first one -- but only while focus
 * is still on the menu, so a pointer or arrow key that already chose is left be.
 */
function useFocusFirstItemWhenLoaded(
  contentRef: React.RefObject<HTMLDivElement>,
  state: LoadState,
) {
  React.useEffect(() => {
    if (state !== 'ready' && state !== 'error') return
    const content = contentRef.current
    if (!content || document.activeElement !== content) return
    content.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [contentRef, state])
}

const contentClass =
  'z-[100] min-w-[220px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'

const itemClass =
  'flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary cursor-pointer outline-none transition-colors'

function optionDetail(option: DownloadOption): string {
  const parts = [option.format, option.size_bytes != null ? formatBytes(option.size_bytes) : null]
  return parts.filter(Boolean).join(' · ')
}

function DownloadOptionItems({
  options,
  state,
  onPick,
}: {
  options: DownloadOption[]
  state: LoadState
  onPick: (rendition?: string) => void
}) {
  if (state === 'loading' || state === 'idle') {
    return (
      <div className="flex items-center gap-2 mx-1 px-2.5 py-2 text-sm text-text-tertiary">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading…
      </div>
    )
  }
  if (state === 'error') {
    // The list could not be had; a download with no choice still works, and
    // is the file a download always was.
    return (
      <DropdownMenu.Item onSelect={() => onPick()} className={itemClass}>
        <Download className="h-3.5 w-3.5 text-text-tertiary" />
        Download
      </DropdownMenu.Item>
    )
  }
  return (
    <>
      {options.map((option) => (
        <DropdownMenu.Item
          key={option.id}
          onSelect={() => onPick(option.id)}
          className={itemClass}
        >
          <span className="flex-1 text-text-primary">{option.label}</span>
          <span className="text-xs text-text-tertiary tabular-nums">{optionDetail(option)}</span>
        </DropdownMenu.Item>
      ))}
    </>
  )
}

/** A button that opens a menu of download options. `children` is the trigger. */
export function DownloadMenu({
  load,
  onPick,
  children,
  align = 'end',
}: {
  load: () => Promise<DownloadOption[] | null>
  onPick: (rendition?: string) => void
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  const { options, state, refresh } = useDownloadOptions(load)
  const contentRef = React.useRef<HTMLDivElement>(null)
  useFocusFirstItemWhenLoaded(contentRef, state)
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void refresh() }}>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          align={align}
          sideOffset={4}
          className={contentClass}
          // A portal still bubbles through the React tree, and these menus
          // sit inside clickable cards and rows.
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu.Label className="px-3.5 pt-1 pb-1.5 text-2xs font-medium uppercase tracking-wide text-text-tertiary">
            Download
          </DropdownMenu.Label>
          <DownloadOptionItems options={options} state={state} onPick={onPick} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The same choice as a submenu, for a "Download" entry in a larger menu. */
export function DownloadSubmenu({
  load,
  onPick,
}: {
  load: () => Promise<DownloadOption[] | null>
  onPick: (rendition?: string) => void
}) {
  const { options, state, refresh } = useDownloadOptions(load)
  const contentRef = React.useRef<HTMLDivElement>(null)
  useFocusFirstItemWhenLoaded(contentRef, state)
  return (
    <DropdownMenu.Sub onOpenChange={(open) => { if (open) void refresh() }}>
      <DropdownMenu.SubTrigger className={cn(itemClass, 'data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary')}>
        <Download className="h-3.5 w-3.5 text-text-tertiary" />
        <span className="flex-1">Download</span>
        <ChevronRight className="h-3.5 w-3.5 text-text-tertiary" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          ref={contentRef}
          sideOffset={6}
          className={contentClass}
          onClick={(e) => e.stopPropagation()}
        >
          <DownloadOptionItems options={options} state={state} onPick={onPick} />
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}
