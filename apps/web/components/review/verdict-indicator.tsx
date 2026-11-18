'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, Pencil, X, type LucideIcon } from 'lucide-react'
import { cn, formatRelativeTime } from '@/lib/utils'
import {
  verdictCountLabel,
  verdictTone,
  VERDICT_LABEL,
  VERDICT_TONE_TEXT_CLASS,
  VERDICT_VALUE_TONE,
  type VerdictTone,
} from '@/lib/verdicts'
import type { Verdict } from '@/types'

const TONE_VIEW: Record<VerdictTone, { Icon: LucideIcon; label: string }> = {
  approved: { Icon: Check, label: VERDICT_LABEL.approved },
  changes: { Icon: Pencil, label: VERDICT_LABEL.changes_requested },
  rejected: { Icon: X, label: VERDICT_LABEL.rejected },
}

/** How long the pointer may be away before a hover-opened popover closes. It
 *  has to bridge the gap between the trigger and the popover. */
const HOVER_CLOSE_DELAY_MS = 150

/** Hover opens only where hovering is a real gesture: a mouse or trackpad. */
function hoverCapable(event: React.PointerEvent): boolean {
  if (event.pointerType === 'touch') return false
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches
}

interface VerdictIndicatorProps {
  verdicts: Verdict[]
  /** Owners and editors may remove anyone's verdict. */
  canRemove: boolean
  onRemove?: (id: string) => void
}

/**
 * The verdicts on a version as one icon and a count, in the colour of the most
 * serious one. Hover (fine pointers) or click/tap opens who said what. Renders
 * nothing when there are no verdicts.
 */
export function VerdictIndicator(props: VerdictIndicatorProps) {
  const tone = verdictTone(props.verdicts)
  if (!tone) return null
  // Its own component, so the open state is dropped with the last verdict and a
  // later one does not find the popover already open.
  return <VerdictPopover {...props} tone={tone} />
}

function VerdictPopover({
  verdicts,
  canRemove,
  onRemove,
  tone,
}: VerdictIndicatorProps & { tone: VerdictTone }) {
  const [open, setOpen] = React.useState(false)
  const [confirmingId, setConfirmingIdState] = React.useState<string | null>(null)
  // What the timer and handlers need to read without going stale.
  const confirming = React.useRef<string | null>(null)
  const openedByHover = React.useRef(false)
  const closedByHover = React.useRef(false)
  // Clicked open, or hover-opened and then clicked: leaving the pointer no longer closes it.
  const pinned = React.useRef(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setConfirmingId = React.useCallback((id: string | null) => {
    confirming.current = id
    setConfirmingIdState(id)
  }, [])

  const cancelHoverClose = React.useCallback(() => {
    clearTimeout(closeTimer.current)
  }, [])

  React.useEffect(() => () => clearTimeout(closeTimer.current), [])

  const close = React.useCallback(() => {
    clearTimeout(closeTimer.current)
    pinned.current = false
    openedByHover.current = false
    setConfirmingId(null)
    setOpen(false)
  }, [setConfirmingId])

  const scheduleHoverClose = React.useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      // A pinned popover, or one asking "Remove this verdict?", stays put.
      if (pinned.current || confirming.current) return
      closedByHover.current = true
      close()
    }, HOVER_CLOSE_DELAY_MS)
  }, [close])

  const handleTriggerEnter = (event: React.PointerEvent) => {
    if (!hoverCapable(event)) return
    cancelHoverClose()
    if (open) return
    openedByHover.current = true
    pinned.current = false
    closedByHover.current = false
    setOpen(true)
  }

  // We own the toggle: Radix's own would shut a hover-opened popover on the very
  // click that follows the hover, and a mouse click is always a hover first.
  const handleTriggerClick = (event: React.MouseEvent) => {
    event.preventDefault()
    cancelHoverClose()
    if (open && openedByHover.current && !pinned.current) {
      pinned.current = true
      return
    }
    if (open) {
      close()
      return
    }
    openedByHover.current = false
    pinned.current = true
    closedByHover.current = false
    setOpen(true)
  }

  // Escape, an outside click or focus leaving: Radix asks, we close.
  const handleOpenChange = (next: boolean) => {
    if (next) setOpen(true)
    else close()
  }

  const { Icon, label: toneLabel } = TONE_VIEW[tone]

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${verdictCountLabel(verdicts.length)}, ${toneLabel.toLowerCase()}`}
          data-tone={tone}
          onClick={handleTriggerClick}
          onPointerEnter={handleTriggerEnter}
          onPointerLeave={scheduleHoverClose}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium tabular-nums',
            'outline-none transition-colors hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent',
            VERDICT_TONE_TEXT_CLASS[tone],
          )}
        >
          <Icon aria-hidden className="h-3.5 w-3.5" />
          <span>{verdicts.length}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // Hovering must not steal focus from wherever the reviewer was.
          onOpenAutoFocus={(event) => {
            if (openedByHover.current) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            if (closedByHover.current) event.preventDefault()
          }}
          onPointerEnter={cancelHoverClose}
          onPointerLeave={scheduleHoverClose}
          className="z-[100] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-elevated shadow-2xl
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <ul className="max-h-80 divide-y divide-border overflow-y-auto py-1">
            {verdicts.map((verdict) => (
              <VerdictRow
                key={verdict.id}
                verdict={verdict}
                canRemove={canRemove}
                confirming={confirmingId === verdict.id}
                onAskRemove={() => setConfirmingId(verdict.id)}
                onCancelRemove={() => setConfirmingId(null)}
                onConfirmRemove={() => {
                  setConfirmingId(null)
                  onRemove?.(verdict.id)
                }}
              />
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function VerdictRow({
  verdict,
  canRemove,
  confirming,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  verdict: Verdict
  canRemove: boolean
  confirming: boolean
  onAskRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
}) {
  const tone = VERDICT_VALUE_TONE[verdict.status]
  const { Icon, label } = TONE_VIEW[tone]
  const outsider = verdict.who.is_guest || verdict.who.kind === 'external'

  return (
    <li className="flex gap-2.5 px-3 py-2.5">
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', VERDICT_TONE_TEXT_CLASS[tone])} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="truncate text-sm font-medium text-text-primary">{verdict.who.name}</span>
          {outsider && (
            <span className="rounded bg-bg-hover px-1.5 py-px text-2xs font-medium text-text-secondary">
              Guest
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-2xs text-text-tertiary">
          <span className={VERDICT_TONE_TEXT_CLASS[tone]}>{label}</span>
          {verdict.via_link_title && <span>{`via ${verdict.via_link_title}`}</span>}
          <time dateTime={verdict.updated_at} title={new Date(verdict.updated_at).toLocaleString()}>
            {formatRelativeTime(verdict.updated_at)}
          </time>
        </div>
        {verdict.note && (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text-secondary">{verdict.note}</p>
        )}
        {canRemove &&
          (confirming ? (
            <div role="group" aria-label={`Remove ${verdict.who.name}'s verdict`} className="mt-1.5 flex items-center gap-2 text-xs">
              <span className="text-text-secondary">Remove this verdict?</span>
              <button
                type="button"
                onClick={onConfirmRemove}
                className="font-medium text-status-error hover:underline"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={onCancelRemove}
                className="text-text-tertiary hover:text-text-primary hover:underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAskRemove}
              className="mt-1.5 text-xs text-text-tertiary hover:text-status-error hover:underline"
            >
              Remove
            </button>
          ))}
      </div>
    </li>
  )
}
