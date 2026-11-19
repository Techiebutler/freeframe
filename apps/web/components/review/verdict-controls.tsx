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
 * The phone row's classes, for whoever renders `variant="row"`. The row is a
 * size container (`container-type: inline-size`) because the buttons choose
 * between words and icons by how much room the row itself has, which is not a
 * function of the viewport: the asset page's rail takes 52px of a phone's width
 * and the share page has none. Without a container the query never matches and
 * the labels stay, so a row that forgets the class is wide, not broken.
 *
 * The height is fixed on purpose: the page re-measures `--ff-stage-max` when the
 * row appears and nothing in it may change that.
 */
export const VERDICT_ROW_CLASS =
  'flex h-10 shrink-0 items-center overflow-x-auto border-b border-border bg-bg-secondary px-3 [container-type:inline-size]'

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
   * the layout under it, a bar of its own, where the labels show while they fit
   * and fold back to the same icons when the row (a `VERDICT_ROW_CLASS`
   * container) has under 380px inside its padding, as on a phone.
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

  return (
    <VerdictControlsView
      verdicts={data}
      canGive={role !== null && GIVING_ROLES.includes(role)}
      canRemove={role !== null && REMOVING_ROLES.includes(role)}
      variant={variant}
      give={(status, note) =>
        api.put(`/assets/${assetId}/verdict`, { version_id: versionId, status, ...(note ? { note } : {}) })
      }
      clear={() => api.delete(`/assets/${assetId}/verdict?version_id=${versionId}`)}
      remove={(id) => api.delete(`/assets/${assetId}/verdicts/${id}`)}
      revalidate={() => mutate()}
    />
  )
}

export interface VerdictControlsViewProps {
  /** `undefined` while the first load is out. */
  verdicts: Verdict[] | undefined
  canGive: boolean
  canRemove: boolean
  variant?: 'toolbar' | 'row'
  /** Gives or changes the caller's verdict. A blank note is passed as `undefined`. */
  give: (status: VerdictValue, note?: string) => Promise<unknown>
  /** Clears the caller's own verdict. */
  clear: () => Promise<unknown>
  /** Removes anyone's verdict; only called when `canRemove`. */
  remove?: (id: string) => Promise<unknown>
  /** Refetches the list; awaited after every successful write. */
  revalidate: () => Promise<unknown>
  /**
   * Runs before a press does anything, and a `false` stops it quietly: no
   * request, no note box. The share page asks a guest who they are here. A
   * list instead of `true` goes on, deciding clear-or-give against that list:
   * the share page re-reads when who is pressing is not who the list on
   * screen was read as. A throw also stops the press, and its message is shown:
   * nothing is decided against a list that could not be read.
   */
  beforePress?: () => Promise<boolean | Verdict[]>
  /**
   * Extra actions under a failure's message, given the error the call threw.
   * `redo` makes the failed press again from the start: `beforePress`, then
   * clear-or-give decided afresh (a note already typed is kept). It never
   * re-sends the old request, which was decided for whoever pressed then.
   * `dismiss` puts the message away. The share page offers "Sign in" and
   * "Continue as guest" here for a lapsed sign-in.
   */
  errorActions?: (error: unknown, controls: { redo: () => Promise<void>; dismiss: () => void }) => React.ReactNode
}

/** What a press asked for. `note` is set only when it came from the note box,
 *  which always gives (a note is never an undo). */
interface Intent {
  status: VerdictValue
  note?: string
}

/**
 * The buttons, the note box and the error line, for whoever supplies the
 * calls: the team's asset page and a share link both render this.
 */
export function VerdictControlsView({
  verdicts: data,
  canGive,
  canRemove,
  variant = 'toolbar',
  give,
  clear,
  remove,
  revalidate,
  beforePress,
  errorActions,
}: VerdictControlsViewProps) {
  const verdicts = data ?? []
  const mine = verdicts.find((v) => v.is_mine)

  const [busy, setBusy] = React.useState(false)
  // The state is for rendering; the ref is what stops a second press that lands
  // before the render which disables the buttons.
  const inFlight = React.useRef(false)
  // The verdict whose note box is open, if any.
  const [asking, setAsking] = React.useState<VerdictValue | null>(null)
  const [note, setNote] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  // What the failed call threw, for `errorActions`, and what was asked for, to redo.
  const [failure, setFailure] = React.useState<unknown>(null)
  const [lastIntent, setLastIntent] = React.useState<Intent | null>(null)
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
    setFailure(null)
    let ok = false
    try {
      await request()
      ok = true
    } catch (err) {
      setError(failureMessage(err))
      setFailure(err)
    }
    // Held until the list is back, so the pressed button never shows the old state.
    if (ok) await revalidate().catch(() => undefined)
    inFlight.current = false
    setBusy(false)
    return ok
  }

  // A press waiting on `beforePress` (the share page's identity prompt), so a
  // second tap in that moment does not ask twice.
  const gating = React.useRef(false)

  /**
   * Runs `beforePress`. Null stops the press; otherwise the caller's own
   * verdict to decide against: from the list it handed back, or the one shown.
   */
  const gate = async (): Promise<{ current: Verdict | undefined } | null> => {
    if (!beforePress) return { current: mine }
    if (gating.current) return null
    gating.current = true
    let answer: boolean | Verdict[] = false
    try {
      answer = await beforePress()
    } catch (err) {
      setError(failureMessage(err))
      setFailure(err)
      return null
    } finally {
      gating.current = false
    }
    if (answer === false) return null
    return { current: Array.isArray(answer) ? answer.find((v) => v.is_mine) : mine }
  }

  /** Gives with a note, and puts the note box away once it lands. */
  const giveWithNote = async (status: VerdictValue, note: string) => {
    const sent = await run(() => give(status, note || undefined))
    if (sent) {
      setAsking(null)
      setNote('')
    }
  }

  /**
   * Clear or give, decided against `current`. Called with a note it always
   * gives. The pressed button, pressed again, is the undo. A verdict that asks
   * for a note opens the box rather than sending.
   */
  const decide = (intent: Intent, current: Verdict | undefined) => {
    const { status, note } = intent
    setLastIntent(intent)
    if (note !== undefined) {
      void giveWithNote(status, note)
      return
    }
    if (current?.status === status) {
      setAsking(null)
      void run(clear)
      return
    }
    if (!BUTTONS.find((b) => b.status === status)?.asksForNote) {
      setAsking(null)
      void run(() => give(status))
      return
    }
    setNote('')
    setAsking(status)
  }

  const press = async (status: VerdictValue, from: HTMLButtonElement) => {
    if (gating.current) return
    const gated = await gate()
    if (!gated) return
    lastPressed.current = from
    setError(null)
    // A second press on the button whose box is open puts the box away, unless
    // it is the pressed one, whose press is the undo.
    if (asking === status && gated.current?.status !== status) {
      setAsking(null)
      return
    }
    decide({ status }, gated.current)
  }

  const sendWithNote = async (event: React.FormEvent) => {
    event.preventDefault()
    if (asking === null) return
    const intent = { status: asking, note: note.trim() }
    setLastIntent(intent)
    await giveWithNote(intent.status, intent.note)
  }

  const putAway = () => {
    setAsking(null)
    setError(null)
  }

  /** The failed press again, from the start, as whoever is pressing now. */
  const redo = async () => {
    if (!lastIntent || inFlight.current) return
    setError(null)
    setFailure(null)
    const gated = await gate()
    if (!gated) return
    decide(lastIntent, gated.current)
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
            onRemove={(id) => void run(() => remove?.(id) ?? Promise.resolve())}
          />

          {showsEmptyLine && <span className="text-xs text-text-tertiary">No verdicts yet</span>}

          {canGive && (
            <div role="group" aria-label="Your verdict" className="flex items-center gap-1.5">
              {BUTTONS.map(({ status, label, Icon, pressedClass }) => {
                const pressed = mine?.status === status
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={pressed}
                    aria-label={label}
                    title={label}
                    disabled={busy}
                    onClick={(event) => void press(status, event.currentTarget)}
                    className={cn(
                      'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border text-xs font-medium',
                      // The row's buttons are square, like the toolbar's, once the
                      // row has no room for words. Whole class strings, for Tailwind;
                      // the 380px matches the label's below. The labeled row with an
                      // indicator needs about 350px, so this leaves room for a
                      // two-digit count and for the font rendering a little wider.
                      variant === 'toolbar'
                        ? 'w-8'
                        : 'px-2 [@container(max-width:380px)]:w-8 [@container(max-width:380px)]:px-0',
                      'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      pressed
                        ? pressedClass
                        : 'border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    <Icon aria-hidden className="h-3.5 w-3.5" />
                    {/* Hidden, not removed: the name is `aria-label` either way. */}
                    {variant === 'row' && <span className="[@container(max-width:380px)]:hidden">{label}</span>}
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
                // 16px on a touch screen: iOS Safari zooms into any field under
                // that when it takes focus, and this one is focused as it opens.
                // The compact size is for mice only, as in the comment composer.
                className="w-full resize-none rounded-md border border-border bg-bg-primary px-2.5 py-2 text-[16px]
                  [@media(hover:hover)]:text-[13px] text-text-primary outline-none placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-accent"
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
              <div className="min-w-0 flex-1">
                <p role="alert" className="text-xs text-status-error">
                  {error}
                </p>
                {errorActions && (
                  <ErrorActionsSlot render={errorActions} error={failure} redo={redo} dismiss={putAway} />
                )}
              </div>
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

type ErrorActionsRender = NonNullable<VerdictControlsViewProps['errorActions']>

/** Calls `errorActions` as its own element, so the handlers it is given are
 *  props (read when clicked), not values read while the controls render. */
function ErrorActionsSlot({
  render, error, redo, dismiss,
}: { render: ErrorActionsRender; error: unknown; redo: () => Promise<void>; dismiss: () => void }) {
  return <>{render(error, { redo, dismiss })}</>
}
