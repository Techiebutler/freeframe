'use client'

import * as React from 'react'
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useKeyboardInset } from '@/hooks/use-keyboard-inset'

export type SheetState = 'peek' | 'compose' | 'half' | 'full'

export interface MobileCommentSheetProps {
  state: SheetState
  onStateChange: (next: SheetState) => void
  /** Reports the sheet's PIXEL HEIGHT on every change (drag included). The
   *  consumer turns it into `--ff-media-shift` with
   *  max(0, (h - PEEK_PX - 60) / 2), which is 0 at peek. PEEK_PX comes out
   *  because the media area already excludes the peek band (the wrapper
   *  reserves it with `pb-14 md:pb-0`), so only the sheet's growth PAST peek
   *  has to be re-centred. Must be a stable reference (useCallback) — it is an
   *  effect dependency here, and an unstable one would re-fire every render. */
  onHeightChange: (px: number) => void
  commentCount: number
  isPlaying: boolean
  onTogglePlay: () => void
  /** Pre-formatted, e.g. "00:01:23:04". EMPTY STRING means "this consumer has
   *  no time-based media" and suppresses the whole mini transport — that is how
   *  the landing grid and image assets opt out without a fifth prop. */
  currentTime: string
  /** True while isDrawingMode: the sheet cannot be dragged past `compose`. */
  lockedToCompose: boolean
  children: React.ReactNode
  composer?: React.ReactNode
  position?: 'absolute' | 'fixed'
}

/**
 * The sheet's collapsed height — the band it occupies in EVERY state, and so
 * the band its consumers must keep clear of anything they still expect to be
 * tappable. Exported because both review wrappers reserve it below `md`
 * (`pb-14`, 3.5rem = 56px, on the flex row holding the media column) and
 * subtract it from the media shift; hard-coding 56 in three files is how the
 * transport row ended up permanently behind the sheet.
 */
export const PEEK_PX = 56
const COMPOSE_PX = 220
const HALF_RATIO = 0.55
const FULL_RATIO = 0.9
/** Pointer travel under this is a tap, not a drag. */
const TAP_SLOP_PX = 6
/** Downward px/ms past which a release is a flick and always lands on `peek`. */
const FLICK_PX_PER_MS = 0.5

function heightFor(state: SheetState, rootHeight: number): number {
  switch (state) {
    case 'peek':
      return PEEK_PX
    case 'compose':
      return COMPOSE_PX
    case 'half':
      return Math.round(rootHeight * HALF_RATIO)
    case 'full':
      return Math.round(rootHeight * FULL_RATIO)
  }
}

/**
 * The bottom sheet that replaces the w-[360px] inline comment column below
 * `md`. It OVERLAYS the media rather than resizing it, which is load-bearing:
 * resizing the media mid-drag would re-letterbox the picture on every frame of
 * the gesture. It owns no comment logic and is a container with snap states, a
 * drag, and an always-visible handle row carrying a mini transport.
 *
 * No scrim: the media stays visible and interactive behind it. z-40 deliberately
 * sits below the z-50 the guest identity prompt uses on the share screen, so a
 * prompt still covers the sheet rather than appearing under it.
 */
export function MobileCommentSheet({
  state,
  onStateChange,
  onHeightChange,
  commentCount,
  isPlaying,
  onTogglePlay,
  currentTime,
  lockedToCompose,
  children,
  composer,
  position = 'absolute',
}: MobileCommentSheetProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const keyboardInset = useKeyboardInset()
  const [rootHeight, setRootHeight] = React.useState(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight,
  )
  /** Non-null only while a drag is in flight. */
  const [liveHeight, setLiveHeight] = React.useState<number | null>(null)

  // Measure the box the percentages are relative to: the positioned ancestor
  // when absolute (the review root, which the consumer must make `relative`), the viewport
  // when fixed. jsdom reports clientHeight 0, and so does the first paint
  // before layout, hence the window.innerHeight fallback.
  //
  // Skipped entirely while the keyboard is open: an on-screen keyboard fires
  // resize on Android, and re-measuring there would resnap the sheet under the
  // typist. `compose` stays `compose`.
  React.useEffect(() => {
    if (keyboardInset > 0) return
    const measure = () => {
      const el = rootRef.current
      const box =
        position === 'fixed'
          ? null
          : ((el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null)
      setRootHeight(box?.clientHeight || window.innerHeight)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [position, keyboardInset])

  // While drawing, `half` and `full` are unreachable — the canvas needs the
  // media area and the composer is showing the drawing toolbar.
  const snapTargets = React.useMemo<SheetState[]>(
    () => (lockedToCompose ? ['peek', 'compose'] : ['peek', 'half', 'full']),
    [lockedToCompose],
  )
  const maxHeight = heightFor(snapTargets[snapTargets.length - 1], rootHeight)
  const height = liveHeight ?? heightFor(state, rootHeight)

  React.useEffect(() => {
    onHeightChange(height)
  }, [height, onHeightChange])

  const nearestState = React.useCallback(
    (px: number): SheetState =>
      snapTargets.reduce((best, candidate) =>
        Math.abs(heightFor(candidate, rootHeight) - px) <
        Math.abs(heightFor(best, rootHeight) - px)
          ? candidate
          : best,
      ),
    [snapTargets, rootHeight],
  )

  // Escape collapses the sheet — a Bluetooth keyboard, or a tablet with one.
  //
  // Guarded by lockedToCompose for the same reason toggleOpen is, and the
  // chevron is `disabled`: while drawing, `peek` is a trap. The chevron is
  // dead, the parent only moves the sheet on the FALLING edge of isDrawingMode,
  // the player's Draw button is behind the sheet, and CommentInput's "Exit
  // drawing" is not rendered at peek — so there is no way back out of drawing
  // mode. All three exits from `compose` must agree.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state !== 'peek' && !lockedToCompose) onStateChange('peek')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [state, onStateChange, lockedToCompose])

  const toggleOpen = React.useCallback(() => {
    if (lockedToCompose) return
    onStateChange(state === 'peek' ? 'half' : 'peek')
  }, [lockedToCompose, onStateChange, state])

  // ── Drag: the same pointer model as ProgressBar ─────────────────────────
  // setPointerCapture on the handle routes every subsequent event for that
  // pointer back here, including ones that leave the element, so there is no
  // window-level listener and one code path covers mouse, touch and pen.
  const dragRef = React.useRef<{
    startY: number
    startHeight: number
    lastY: number
    lastT: number
    velocity: number
  } | null>(null)

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      startHeight: height,
      lastY: e.clientY,
      lastT: e.timeStamp,
      velocity: 0,
    }
    setLiveHeight(height)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    const dt = Math.max(1, e.timeStamp - drag.lastT)
    drag.velocity = (e.clientY - drag.lastY) / dt // +ve = downward
    drag.lastY = e.clientY
    drag.lastT = e.timeStamp
    const next = drag.startHeight - (e.clientY - drag.startY)
    setLiveHeight(Math.min(maxHeight, Math.max(PEEK_PX, next)))
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    // hasPointerCapture guard: releasePointerCapture throws NotFoundError if
    // this pointer was never captured here, which happens when a drag that
    // started elsewhere is released over the handle — and, critically, when
    // pointercancel fires: an OS gesture (edge-swipe-back, Control Center,
    // the notification shade) preempts the touch, and the capture is already
    // gone by the time this handler runs (onPointerCancel routes here too).
    const handle = e.currentTarget
    if (handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId)
    }
    dragRef.current = null
    setLiveHeight(null)

    if (Math.abs(e.clientY - drag.startY) < TAP_SLOP_PX) {
      toggleOpen()
      return
    }
    const settled = Math.min(
      maxHeight,
      Math.max(PEEK_PX, drag.startHeight - (e.clientY - drag.startY)),
    )
    // Velocity bias: a quick flick down always reaches peek, however far the
    // finger actually travelled.
    const next = drag.velocity > FLICK_PX_PER_MS ? 'peek' : nearestState(settled)
    if (next !== state) onStateChange(next)
  }

  // During a drag the contents follow the live height rather than the (not yet
  // committed) state, so the panel appears as you pull the sheet up.
  const shown = liveHeight === null ? state : nearestState(liveHeight)
  // Only once the sheet actually covers the player's transport row. At `peek`
  // the review wrapper reserves a PEEK_PX band so that row stays on screen and
  // reachable, and a second play button here would stack directly on top of it
  // — two identical controls, each with its own independently-updating clock,
  // visibly disagreeing by a frame.
  // `shown`, not `state`: mid-drag the committed state lags the live height, so
  // keying off `state` would keep the mini transport rendered while the sheet
  // has already shrunk clear of the row — the two-play-button bug, live, under
  // the user's finger.
  const showTransport = currentTime !== '' && shown !== 'peek'

  return (
    <div
      ref={rootRef}
      data-testid="mobile-comment-sheet"
      data-state={state}
      className={cn(
        position === 'fixed' ? 'fixed' : 'absolute',
        'inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-xl border-t border-border bg-bg-secondary',
      )}
      style={{
        height,
        // `bottom`, not a transform: the content box must shrink with the
        // keyboard so CommentPanel keeps scrolling correctly.
        bottom: keyboardInset,
        transition: liveHeight === null ? 'height 200ms ease, bottom 200ms ease' : 'none',
      }}
    >
      <div
        data-testid="sheet-handle"
        role="button"
        tabIndex={0}
        // Explicit, because the handle's computed name comes from its own text.
        // With the mini transport hidden at `peek` that text is just
        // "Comments", which collides with the desktop panel's "Comments" tab —
        // and leaves a screen-reader user with two identically-named buttons
        // that do different things. `aria-expanded` still carries the state.
        //
        // The count has to be folded in by hand: `role="button"` is
        // children-presentational, so once aria-label wins over name-from-
        // content the `Comments · N` span is pruned from the accessibility
        // tree — and below md this is the only comment affordance there is.
        aria-label={commentCount > 0 ? `Comments panel, ${commentCount} comments` : 'Comments panel'}
        aria-expanded={state !== 'peek'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggleOpen()
          }
        }}
        // min-h-14, not h-14: this row sits inside the outer sheet's own fixed
        // `height` (56px at peek), and Tailwind preflight's border-box would
        // otherwise let its own paddingBottom subtract from that budget and
        // squeeze the 44px buttons — the exact bug fixed in the compact
        // transport row, where `min-h-12` plus a paddingBottom on the same
        // element was the fix. min-height lets this row grow
        // past 56px to fit the safe-area gutter instead of shrinking its
        // content into it; only the trailing empty padding gets clipped by the
        // outer box's overflow-hidden, never the buttons or text.
        className="flex min-h-14 shrink-0 touch-none select-none items-center gap-2 px-3"
        // Inert until the app sets `viewport-fit=cover`: iOS resolves
        // env(safe-area-inset-*) to 0 without it. Tracked in #340; kept here so
        // the row is correct the moment that lands.
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {showTransport && (
          <>
            <button
              type="button"
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onTogglePlay}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <span className="shrink-0 font-mono text-xs tabular-nums text-text-secondary">
              {currentTime}
            </span>
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
          {commentCount > 0 ? `Comments · ${commentCount}` : 'Comments'}
        </span>
        <button
          type="button"
          aria-label={state === 'peek' ? 'Open comments' : 'Close comments'}
          disabled={lockedToCompose}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggleOpen}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
        >
          {state === 'peek' ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {(shown === 'half' || shown === 'full') && (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      )}
      {shown !== 'peek' && composer}
    </div>
  )
}
