'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Popover from '@radix-ui/react-popover'
import { Check, Pencil, X, type LucideIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { verdictsKey } from '@/lib/verdicts'
import { VerdictIndicator } from '@/components/review/verdict-indicator'
import type { ProjectRole, Verdict, VerdictValue } from '@/types'

/** Longest note the API takes (`VerdictSet.note`). */
const NOTE_MAX_LENGTH = 5000

/** Reviewers and above give or clear their own verdict. */
const GIVING_ROLES: readonly ProjectRole[] = ['reviewer', 'editor', 'owner']
/** Owners and editors may also remove anyone's. */
const REMOVING_ROLES: readonly ProjectRole[] = ['editor', 'owner']

const GENERIC_FAILURE = "Couldn't save your verdict. Try again."

/**
 * The buttons say what to do (Approve), the verdicts say what was done
 * (Approved), so these are not `VERDICT_LABEL`.
 */
const BUTTONS: ReadonlyArray<{
  status: VerdictValue
  label: string
  Icon: LucideIcon
  asksForNote: boolean
  /** Whole class strings, so Tailwind can see them. */
  pressedClass: string
  placeholder: string
}> = [
  {
    status: 'approved',
    label: 'Approve',
    Icon: Check,
    asksForNote: false,
    pressedClass: 'border-status-success bg-bg-hover text-status-success',
    placeholder: '',
  },
  {
    status: 'changes_requested',
    label: 'Changes needed',
    Icon: Pencil,
    asksForNote: true,
    pressedClass: 'border-status-warning bg-bg-hover text-status-warning',
    placeholder: 'What needs to change?',
  },
  {
    status: 'rejected',
    label: 'Reject',
    Icon: X,
    asksForNote: true,
    pressedClass: 'border-status-error bg-bg-hover text-status-error',
    placeholder: 'Why is it rejected?',
  },
]

/**
 * The server's own sentence when it sent one. Read off the error rather than
 * with `instanceof ApiError`, so a failure that is not an `ApiError` (a network
 * drop) falls through to the generic line instead of showing nothing.
 */
function failureMessage(err: unknown): string {
  const detail = (err as { detail?: unknown } | null | undefined)?.detail
  return typeof detail === 'string' && detail ? detail : GENERIC_FAILURE
}

export interface VerdictControlsProps {
  assetId: string
  /** The version on screen. Verdicts are per version. */
  versionId: string
  /** The caller's role in the project; `null` for someone who is not a member. */
  role: ProjectRole | null
  /**
   * `toolbar` sits in the asset page's top bar, which has no room for words:
   * the buttons are icons there, named by `aria-label` and `title`. `row` is
   * the layout under it, a bar of its own, where the labels fit and always show.
   */
  variant?: 'toolbar' | 'row'
}

/**
 * Where the team gives, changes and clears its verdict on the version shown:
 * the indicator for everyone, and Approve / Changes needed / Reject for
 * reviewers and above. Owners and editors can also remove anyone's.
 *
 * Remounts on a version switch, so a half-written note, a held request or an
 * error never carries over to a version it was not about.
 */
export function VerdictControls(props: VerdictControlsProps) {
  return <VerdictControlsFor key={`${props.assetId}:${props.versionId}`} {...props} />
}

function VerdictControlsFor({ assetId, versionId, role, variant = 'toolbar' }: VerdictControlsProps) {
  const key = verdictsKey(assetId, versionId)
  const { data, mutate } = useSWR<Verdict[]>(key, () => api.get<Verdict[]>(key))
  const verdicts = data ?? []
  const mine = verdicts.find((v) => v.is_mine)

  const canGive = role !== null && GIVING_ROLES.includes(role)
  const canRemove = role !== null && REMOVING_ROLES.includes(role)

  const [busy, setBusy] = React.useState(false)
  // The state is for rendering; the ref is what stops a second press that lands
  // before the render which disables the buttons.
  const inFlight = React.useRef(false)
  // The verdict whose note box is open, if any.
  const [asking, setAsking] = React.useState<VerdictValue | null>(null)
  const [note, setNote] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  // Where focus goes back to when the note box or the error is put away.
  const lastPressed = React.useRef<HTMLButtonElement | null>(null)
  const noteId = React.useId()

  /** Runs one call, revalidates on success, and says why on failure. */
  const run = async (request: () => Promise<unknown>): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setError(null)
    let ok = false
    try {
      await request()
      ok = true
    } catch (err) {
      setError(failureMessage(err))
    }
    // Held until the list is back, so the pressed button never shows the old state.
    if (ok) await mutate().catch(() => undefined)
    inFlight.current = false
    setBusy(false)
    return ok
  }

  const press = (status: VerdictValue, asksForNote: boolean, from: HTMLButtonElement) => {
    lastPressed.current = from
    setError(null)

    // The pressed button, pressed again, is the undo.
    if (mine?.status === status) {
      setAsking(null)
      void run(() => api.delete(`/assets/${assetId}/verdict?version_id=${versionId}`))
      return
    }
    if (!asksForNote) {
      setAsking(null)
      void run(() => api.put(`/assets/${assetId}/verdict`, { version_id: versionId, status }))
      return
    }
    // A second press on the button whose box is open puts the box away.
    if (asking === status) {
      setAsking(null)
      return
    }
    setNote('')
    setAsking(status)
  }

  const sendWithNote = async (event: React.FormEvent) => {
    event.preventDefault()
    if (asking === null) return
    const status = asking
    const trimmed = note.trim()
    const sent = await run(() =>
      api.put(`/assets/${assetId}/verdict`, {
        version_id: versionId,
        status,
        ...(trimmed ? { note: trimmed } : {}),
      }),
    )
    if (sent) {
      setAsking(null)
      setNote('')
    }
  }

  const putAway = () => {
    setAsking(null)
    setError(null)
  }

  const open = asking !== null || error !== null
  const showsEmptyLine = variant === 'row' && !canGive && data !== undefined && data.length === 0

  return (
    <Popover.Root open={open} onOpenChange={(next) => !next && putAway()}>
      <Popover.Anchor asChild>
        <div
          ref={rootRef}
          data-testid="verdict-controls"
          className={cn('flex items-center gap-1.5', variant === 'toolbar' ? 'shrink-0' : 'min-w-0')}
        >
          <VerdictIndicator
            verdicts={verdicts}
            canRemove={canRemove}
            onRemove={(id) => void run(() => api.delete(`/assets/${assetId}/verdicts/${id}`))}
          />

          {showsEmptyLine && <span className="text-xs text-text-tertiary">No verdicts yet</span>}

          {canGive && (
            <div role="group" aria-label="Your verdict" className="flex items-center gap-1.5">
              {BUTTONS.map(({ status, label, Icon, asksForNote, pressedClass }) => {
                const pressed = mine?.status === status
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={pressed}
                    aria-label={label}
                    title={label}
                    disabled={busy}
                    onClick={(event) => press(status, asksForNote, event.currentTarget)}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border text-xs font-medium',
                      variant === 'toolbar' ? 'w-8' : 'px-2',
                      'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      pressed
                        ? pressedClass
                        : 'border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    <Icon aria-hidden className="h-3.5 w-3.5" />
                    {variant === 'row' && <span>{label}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </Popover.Anchor>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={variant === 'row' ? 'start' : 'end'}
          sideOffset={6}
          collisionPadding={8}
          // An error on its own is read, not typed into: focus stays on the
          // button that was pressed.
          onOpenAutoFocus={(event) => {
            if (asking === null) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // Only when focus has nowhere else to be: not after a click elsewhere.
            if (!document.activeElement || document.activeElement === document.body) {
              lastPressed.current?.focus()
            }
          }}
          // The buttons are outside the box, and a press on one is not a dismissal:
          // it either puts the box away itself or swaps it for the other verdict's.
          onInteractOutside={(event) => {
            if (rootRef.current?.contains(event.target as Node)) event.preventDefault()
          }}
          className="z-[100] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {asking !== null && (
            <form onSubmit={sendWithNote} className="flex flex-col gap-2">
              <label htmlFor={noteId} className="text-xs font-medium text-text-secondary">
                Note (optional)
              </label>
              <textarea
                id={noteId}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={NOTE_MAX_LENGTH}
                rows={3}
                // Read-only rather than disabled while sending: focus stays put.
                readOnly={busy}
                placeholder={BUTTONS.find((b) => b.status === asking)?.placeholder}
                className="w-full resize-none rounded-md border border-border bg-bg-primary px-2.5 py-2 text-sm text-text-primary
                  outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-accent"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={putAway}
                  className="h-8 rounded-md px-3 text-xs font-medium text-text-secondary outline-none
                    hover:bg-bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-white outline-none transition-colors
                    hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}

          {error !== null && (
            <div className={cn('flex items-start gap-2', asking !== null && 'mt-2')}>
              <p role="alert" className="min-w-0 flex-1 text-xs text-status-error">
                {error}
              </p>
              {asking === null && (
                <button
                  type="button"
                  onClick={putAway}
                  className="shrink-0 text-xs text-text-tertiary outline-none hover:text-text-primary hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
