'use client'

import * as React from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Columns2, FlipHorizontal2, MessageSquare, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { useStreamUrl } from '@/hooks/use-stream-url'
import { localTime, parseOffsetParam, type SideTiming } from '@/lib/compare-time'
import { CompareVersionSelect } from './compare-version-select'
import { CompareScrubber, type ScrubberMarker } from './compare-scrubber'
import { useSyncedTransport } from './use-synced-transport'
import { useSharedTransform } from './use-shared-transform'
import { WipeViewer } from './wipe-viewer'
import { AnnotationOverlay } from '@/components/review/annotation-overlay'
import { AnnotationCanvas } from '@/components/review/annotation-canvas'
import { VideoFrameConstraint } from '@/components/review/video-player'
import { CommentPanel } from '@/components/review/comment-panel'
import { CommentInput } from '@/components/review/comment-input'
import type { AssetResponse, AssetVersion } from '@/types'

interface CompareOverlayProps {
  asset: AssetResponse
  versions: AssetVersion[]
  rightVersion: AssetVersion
  onClose(): void
  /** Mirror of the page's role gate — comment inputs render only when true. */
  canComment?: boolean
}

function mediaOf(v: AssetVersion | null | undefined): { fps?: number | null; duration_seconds?: number | null } {
  // AssetVersion embeds media metadata as `files` (MediaFile[], types/index.ts);
  // fps / duration_seconds live on the first entry.
  return (v as { files?: Array<{ fps?: number | null; duration_seconds?: number | null }> })?.files?.[0] ?? {}
}

/** Fullscreen two-version compare. Chrome: select A, (image mode toggle), select B, close. */
export function CompareOverlay({ asset, versions, rightVersion, onClose, canComment = true }: CompareOverlayProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)
  const setActiveAnnotation = useReviewStore((s) => s.setActiveAnnotation)
  const setFocusedCommentId = useReviewStore((s) => s.setFocusedCommentId)
  // Remount key for the per-pane AnnotationOverlays (page.tsx idiom) so a
  // re-click on the same comment re-runs the canvas sizing effect.
  const focusedCommentId = useReviewStore((s) => s.focusedCommentId)
  const setIsDrawingMode = useReviewStore((s) => s.setIsDrawingMode)
  const setPendingAnnotation = useReviewStore((s) => s.setPendingAnnotation)
  const { user } = useAuthStore()

  // Isolate compare from the shared review store's annotation/drawing signals:
  // - on MOUNT clear isDrawingMode/pendingAnnotation so a stale unsubmitted
  //   drawing from the normal viewer can't leak into compare;
  // - on UNMOUNT clear everything CommentPanel may have written (it has no prop
  //   override for focusedCommentId/activeAnnotation) so the normal view's
  //   remounted AnnotationOverlay doesn't show a stale drawing. Unmount-scoped:
  //   covers ESC, the X button, and browser-back param stripping.
  React.useEffect(() => {
    setIsDrawingMode(false)
    setPendingAnnotation(null)
    return () => {
      setActiveAnnotation(null)
      setFocusedCommentId(null)
      setIsDrawingMode(false)
      setPendingAnnotation(null)
    }
  }, [setActiveAnnotation, setFocusedCommentId, setIsDrawingMode, setPendingAnnotation])

  const ready = React.useMemo(
    () => versions.filter((v) => v.processing_status === 'ready').sort((a, b) => a.version_number - b.version_number),
    [versions],
  )

  // Left = ?compare= param (fallback: nearest other ready version). Right = route's current version.
  const compareParam = searchParams.get('compare')
  const fallbackLeft =
    [...ready].reverse().find((v) => v.version_number < rightVersion.version_number) ??
    ready.find((v) => v.id !== rightVersion.id) ?? null
  const left = ready.find((v) => v.id === compareParam) ?? fallbackLeft
  const right = rightVersion

  const isVideo = asset.asset_type === 'video'
  const mode = (searchParams.get('mode') === 'sbs' ? 'sbs' : 'wipe') as 'wipe' | 'sbs'
  const offA = parseOffsetParam(searchParams.get('offA'))
  const offB = parseOffsetParam(searchParams.get('offB'))

  const writeParams = React.useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(searchParams.toString())
      mutate(p)
      router.replace(`${pathname}?${p.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  // Streams
  const { url: urlA, error: errA } = useStreamUrl(asset.id, left?.id ?? null)
  const { url: urlB, error: errB } = useStreamUrl(asset.id, right.id)

  // Timings — ONE source shared by the transport, scrubber, localTime and markers.
  // Stored metadata first; reactive element-duration fallback (below) for
  // pre-backfill files whose MediaFile rows lack duration_seconds.
  const mediaA = mediaOf(left)
  const mediaB = mediaOf(right)
  const fps = mediaB.fps ?? mediaA.fps ?? null

  const [elemDur, setElemDur] = React.useState<{ a: number | null; b: number | null }>({ a: null, b: null })

  const timingA: SideTiming = { offset: offA, duration: mediaA.duration_seconds ?? elemDur.a ?? 0 }
  const timingB: SideTiming = { offset: offB, duration: mediaB.duration_seconds ?? elemDur.b ?? 0 }

  // Exclusive-unmute audio: at most one side is ever audible. 'b' preserves
  // the pre-existing default (side B carried audio, hardcoded). Declared
  // before the transport: the audible side is the transport's clock master
  // (its media clock owns T, so it never receives audible corrective seeks).
  const [audioSide, setAudioSide] = React.useState<'a' | 'b' | 'none'>('b')

  const transport = useSyncedTransport({
    urlA: isVideo ? urlA : null,
    urlB: isVideo ? urlB : null,
    timingA,
    timingB,
    audibleSide: isVideo ? (audioSide === 'none' ? null : audioSide) : null,
    fps,
  })

  // Reactive element-duration fallback: re-render when metadata loads (a render-time
  // videoRef.current?.duration read would go stale while paused).
  const videoRefA = transport.playerA.videoRef
  const videoRefB = transport.playerB.videoRef
  React.useEffect(() => {
    if (!isVideo) return
    const sides: Array<['a' | 'b', HTMLVideoElement | null]> = [
      ['a', videoRefA.current],
      ['b', videoRefB.current],
    ]
    const cleanups: Array<() => void> = []
    for (const [side, el] of sides) {
      if (!el) continue
      const update = () => {
        const d = Number.isFinite(el.duration) ? el.duration : null
        setElemDur((prev) => (prev[side] === d ? prev : { ...prev, [side]: d }))
      }
      el.addEventListener('loadedmetadata', update)
      el.addEventListener('durationchange', update)
      update() // metadata may already be loaded
      cleanups.push(() => {
        el.removeEventListener('loadedmetadata', update)
        el.removeEventListener('durationchange', update)
      })
    }
    return () => cleanups.forEach((fn) => fn())
  }, [isVideo, urlA, urlB, videoRefA, videoRefB])

  // Per-side comments
  const sideA = useComments(asset.id, left?.id ?? null)
  const sideB = useComments(asset.id, right.id)
  const [panelAOpen, setPanelAOpen] = React.useState(false)
  const [panelBOpen, setPanelBOpen] = React.useState(true)

  // Annotation AUTHORING: at most one pane draws at a time (the Fabric canvas is
  // a module-level singleton — a second mounted AnnotationCanvas disposes the
  // first). `drawingSide` names that pane; the active pane's CommentInput shows
  // the drawing toolbar and an AnnotationCanvas mounts over that pane, in the
  // SAME VideoFrameConstraint / image container the display overlay uses, so the
  // saved drawing aligns with how it later renders. Available for video and
  // image side-by-side; image wipe stays display-only (one ambiguous stage).
  const canAuthor = isVideo || mode === 'sbs'
  const [drawingSide, setDrawingSide] = React.useState<'a' | 'b' | null>(null)
  const toggleDrawing = React.useCallback(
    (side: 'a' | 'b') => setDrawingSide((prev) => (prev === side ? null : side)),
    [],
  )
  // Drive the shared drawing store from drawingSide (AnnotationCanvas/useDrawing
  // read the store). Resetting pendingAnnotation on every change clears a stale
  // drawing when switching panes or exiting — so it can't attach to the next
  // comment on the other side.
  React.useEffect(() => {
    setIsDrawingMode(drawingSide !== null)
    setPendingAnnotation(null)
  }, [drawingSide, setIsDrawingMode, setPendingAnnotation])
  // Exit authoring when the surface it lived on goes away: playback starts (the
  // frame moves out from under a frame-anchored drawing), the active pane's panel
  // closes, or the image mode flips to wipe (no per-pane canvas there).
  React.useEffect(() => {
    if (!canAuthor) setDrawingSide(null)
    else if (drawingSide === 'a' && !panelAOpen) setDrawingSide(null)
    else if (drawingSide === 'b' && !panelBOpen) setDrawingSide(null)
  }, [canAuthor, drawingSide, panelAOpen, panelBOpen])

  // Per-side annotation DISPLAY. Component-local so it dies with the overlay:
  // never written to the store, whose activeAnnotation the normal view's overlay
  // reads. lastAnnotationSide picks which drawing the single wipe stage shows.
  // (Authoring is separate — see drawingSide above.)
  const [annotationA, setAnnotationA] = React.useState<Record<string, unknown> | null>(null)
  const [annotationB, setAnnotationB] = React.useState<Record<string, unknown> | null>(null)
  const [lastAnnotationSide, setLastAnnotationSide] = React.useState<'a' | 'b' | null>(null)
  const showAnnotationFor = React.useCallback(
    (side: 'a' | 'b', drawing: Record<string, unknown> | null) => {
      if (side === 'a') setAnnotationA(drawing)
      else setAnnotationB(drawing)
      // Showing a drawing claims the wipe stage for this side; clearing one
      // releases it only if this side held it (the other side keeps its claim).
      setLastAnnotationSide((prev) => (drawing ? side : prev === side ? null : prev))
    },
    [],
  )
  // Normal-player parity: starting playback clears the shown drawing — a
  // frame-anchored annotation must not sit over moving video. Every play
  // trigger (scrubber button, space key) funnels through transport.isPlaying.
  React.useEffect(() => {
    if (!transport.isPlaying) return
    setAnnotationA(null)
    setAnnotationB(null)
    setLastAnnotationSide(null)
    setDrawingSide(null)
  }, [transport.isPlaying])
  // Belt-and-braces: enforce exclusive audio directly on the elements every render.
  // React's muted prop updates are unreliable in some browsers (facebook/react#10389),
  // and HLS re-attachment must never resurrect audio on a muted side.
  React.useEffect(() => {
    const a = transport.playerA.videoRef.current
    const b = transport.playerB.videoRef.current
    if (a) a.muted = audioSide !== 'a'
    if (b) b.muted = audioSide !== 'b'
  })

  const markersA: ScrubberMarker[] = sideA.comments
    .filter((c) => c.timecode_start != null && !c.resolved)
    .map((c) => ({
      id: c.id, tc: c.timecode_start as number,
      authorName: c.author?.name ?? c.guest_author?.name ?? 'Unknown',
      body: c.body, hasAnnotation: Boolean(c.annotation),
    }))
  const markersB: ScrubberMarker[] = sideB.comments
    .filter((c) => c.timecode_start != null && !c.resolved)
    .map((c) => ({
      id: c.id, tc: c.timecode_start as number,
      authorName: c.author?.name ?? c.guest_author?.name ?? 'Unknown',
      body: c.body, hasAnnotation: Boolean(c.annotation),
    }))

  // Marker click (mirrors progress-bar.tsx's CommentMarker click, adapted to
  // compare's two panes): seek pane-local, pause if playing, focus the comment
  // (drives CommentItem's scrollIntoView/highlight in whichever panel holds
  // it), open that side's panel if closed, and show the comment's drawing in
  // that pane (or clear it for drawing-less comments).
  const handleMarkerClick = React.useCallback(
    (side: 'a' | 'b', marker: ScrubberMarker) => {
      transport.seekTo(marker.tc + (side === 'a' ? timingA.offset : timingB.offset))
      // CRITICAL: toggle() (not setIsPlaying) — only toggle() updates the
      // transport's internal playingRef; setIsPlaying is the raw state setter.
      if (transport.isPlaying) transport.toggle()
      setFocusedCommentId(marker.id)
      if (side === 'a') setPanelAOpen(true)
      else setPanelBOpen(true)
      const comment = (side === 'a' ? sideA : sideB).comments.find((c) => c.id === marker.id)
      showAnnotationFor(side, comment?.annotation?.drawing_data ?? null)
    },
    [transport, timingA.offset, timingB.offset, setFocusedCommentId, setPanelAOpen, setPanelBOpen, sideA, sideB, showAnnotationFor],
  )

  // Per-side reply adapters — mirror page.tsx's handleSubmitReply (createComment
  // with only body + parentId, no timecode) so CommentPanel's inline reply box
  // renders (it's gated on onSubmitReply being defined).
  const handleReplyA = React.useCallback(
    async (parentId: string, body: string) => {
      await sideA.createComment(body, undefined, undefined, undefined, parentId)
    },
    [sideA],
  )
  const handleReplyB = React.useCallback(
    async (parentId: string, body: string) => {
      await sideB.createComment(body, undefined, undefined, undefined, parentId)
    },
    [sideB],
  )

  // Shared zoom/pan for image modes
  const transform = useSharedTransform()

  // ESC closes; space toggles play (video). Ignore keys typed into comment
  // inputs — same guard idiom as the page's global keydown handler.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'Escape') onClose()
      if (e.key === ' ' && isVideo) { e.preventDefault(); transport.toggle() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, isVideo, transport])

  if (!left) return null

  const badgeA = `v${left.version_number}`
  const badgeB = `v${right.version_number}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-primary">
      {/* Top bar — minimalist chrome only */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <div className="shrink-0">
          <CompareVersionSelect
            testId="compare-select-a"
            versions={versions}
            value={left.id}
            excludeId={right.id}
            accentClass="text-sky-400"
            onChange={(v) => writeParams((p) => p.set('compare', v.id))}
          />
        </div>
        {/* Center: asset title (flex-1 min-w-0 truncates without pushing either
            side's chrome), plus the image-only mode toggle beside it. */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
          <span className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-text-primary" title={asset.name}>
            {asset.name}
          </span>
          {!isVideo && (
            <button
              type="button"
              aria-label={mode === 'wipe' ? 'Switch to side-by-side' : 'Switch to wipe'}
              onClick={() => writeParams((p) => p.set('mode', mode === 'wipe' ? 'sbs' : 'wipe'))}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover"
            >
              {mode === 'wipe' ? <Columns2 className="h-3.5 w-3.5" /> : <FlipHorizontal2 className="h-3.5 w-3.5" />}
              {mode === 'wipe' ? 'Side-by-side' : 'Wipe'}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <CompareVersionSelect
            testId="compare-select-b"
            versions={versions}
            value={right.id}
            excludeId={left.id}
            accentClass="text-emerald-400"
            onChange={(v) => setCurrentVersion(v)}
          />
          <button
            type="button"
            aria-label="Close compare"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stage + side panels */}
      <div className="flex min-h-0 flex-1">
        {/* Left comment panel */}
        <aside className={cn('shrink-0 border-r border-border transition-all', panelAOpen ? 'w-80' : 'w-0 overflow-hidden')}>
          {panelAOpen && (
            <div className="flex h-full flex-col">
              <CommentPanel
                comments={sideA.comments}
                currentUserId={user?.id}
                onResolve={async (id) => { await sideA.resolveComment(id) }}
                onDelete={async (id) => { await sideA.deleteComment(id) }}
                onAddReaction={async (id, e) => { await sideA.addReaction(id, e) }}
                onRemoveReaction={async (id, e) => { await sideA.removeReaction(id, e) }}
                onReply={() => {}}
                onSubmitReply={handleReplyA}
                onSeekToTimecode={(tc, pause) => {
                  transport.seekTo(tc + timingA.offset)
                  // Normal-player parity: comment clicks pass pause=true.
                  if (pause && transport.isPlaying) transport.toggle()
                }}
                onShowAnnotation={(d) => showAnnotationFor('a', d)}
                exportVersionId={left.id}
              />
              {canComment && (
              <CommentInput
                assetId={asset.id}
                projectId={asset.project_id}
                assetType={asset.asset_type}
                playheadTimeOverride={isVideo ? localTime(transport.t, timingA) : undefined}
                disableAnnotations={!canAuthor}
                annotationActive={drawingSide === 'a'}
                onToggleAnnotation={() => toggleDrawing('a')}
                onPauseVideo={() => { if (transport.isPlaying) transport.toggle() }}
                onSubmit={async (
                  body: string,
                  // Pane-local already (via playheadTimeOverride); undefined when
                  // the user detaches the timecode toggle — pass straight through.
                  timecodeStart?: number,
                  timecodeEnd?: number,
                  annotationData?: Record<string, unknown>,
                  parentId?: string,
                  visibility?: string,
                  mentionUserIds?: string[],
                ) => {
                  await sideA.createComment(
                    body,
                    timecodeStart,
                    timecodeEnd,
                    annotationData,
                    parentId,
                    visibility,
                    mentionUserIds,
                  )
                }}
              />
              )}
            </div>
          )}
        </aside>

        {/* Panel toggles + stage */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            aria-label="Toggle left comments"
            onClick={() => setPanelAOpen((p) => !p)}
            className="absolute left-2 top-1/2 z-20 -translate-y-1/2 rounded-md bg-bg-elevated/80 p-1.5 text-sky-400 hover:bg-bg-hover"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Toggle right comments"
            onClick={() => setPanelBOpen((p) => !p)}
            className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-md bg-bg-elevated/80 p-1.5 text-emerald-400 hover:bg-bg-hover"
          >
            <MessageSquare className="h-4 w-4" />
          </button>

          {isVideo ? (
            <>
              <div className="flex min-h-0 flex-1">
                <div className="relative flex min-w-0 flex-1 items-center justify-center bg-black">
                  <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
                    <span className="rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeA}</span>
                    <button
                      type="button"
                      aria-label={audioSide === 'a' ? `Mute ${badgeA}` : `Unmute ${badgeA}`}
                      onClick={() => setAudioSide((prev) => (prev === 'a' ? 'none' : 'a'))}
                      className="flex h-7 w-7 items-center justify-center rounded bg-black/40 text-white/80 transition-colors hover:text-white"
                    >
                      {audioSide === 'a' ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                    </button>
                  </div>
                  {/* Exclusive unmute: audioSide names the (at most one) audible side. */}
                  <video ref={transport.playerA.videoRef} className="max-h-full max-w-full" playsInline muted={audioSide !== 'a'} />
                  {/* Drawings are AUTHORED inside VideoFrameConstraint on the
                      normal player (video-frame coordinates, letterbox bars
                      excluded) — render them in the same space. The constraint
                      aspect-fits itself to the rendered video box within
                      video.parentElement = this pane container (relative). */}
                  <VideoFrameConstraint videoRef={transport.playerA.videoRef}>
                    <AnnotationOverlay key={`a-${focusedCommentId ?? 'none'}`} annotation={annotationA} />
                    {drawingSide === 'a' && <AnnotationCanvas />}
                  </VideoFrameConstraint>
                  {errA && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeA}</span>}
                </div>
                <div className="w-px bg-border" />
                <div className="relative flex min-w-0 flex-1 items-center justify-center bg-black">
                  <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={audioSide === 'b' ? `Mute ${badgeB}` : `Unmute ${badgeB}`}
                      onClick={() => setAudioSide((prev) => (prev === 'b' ? 'none' : 'b'))}
                      className="flex h-7 w-7 items-center justify-center rounded bg-black/40 text-white/80 transition-colors hover:text-white"
                    >
                      {audioSide === 'b' ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                    </button>
                    <span className="rounded bg-emerald-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeB}</span>
                  </div>
                  <video ref={transport.playerB.videoRef} className="max-h-full max-w-full" playsInline muted={audioSide !== 'b'} />
                  <VideoFrameConstraint videoRef={transport.playerB.videoRef}>
                    <AnnotationOverlay key={`b-${focusedCommentId ?? 'none'}`} annotation={annotationB} />
                    {drawingSide === 'b' && <AnnotationCanvas />}
                  </VideoFrameConstraint>
                  {errB && <span className="absolute text-[12px] text-text-tertiary">Stream unavailable for {badgeB}</span>}
                </div>
              </div>
              <CompareScrubber
                t={transport.t}
                total={transport.total}
                isPlaying={transport.isPlaying}
                fps={fps}
                onToggle={transport.toggle}
                onSeek={transport.seekTo}
                markersA={markersA}
                markersB={markersB}
                timingA={timingA}
                timingB={timingB}
                onMarkerClick={handleMarkerClick}
                labelA={badgeA}
                labelB={badgeB}
                onOffsetChange={(side, value) =>
                  writeParams((p) => p.set(side === 'a' ? 'offA' : 'offB', String(value)))
                }
                onResetOffsets={() =>
                  writeParams((p) => { p.delete('offA'); p.delete('offB') })
                }
              />
            </>
          ) : mode === 'wipe' ? (
            urlA && urlB ? (
              <WipeViewer
                urlA={urlA}
                urlB={urlB}
                badgeA={badgeA}
                badgeB={badgeB}
                transform={transform}
                overlaySide={lastAnnotationSide}
                overlay={
                  // Most recently activated side's drawing. WipeViewer clips it
                  // (via overlaySide) to that version's visible half — a v1 marker
                  // shows only left of the divider, a v2 marker only right — so it
                  // never bleeds onto the other version.
                  <AnnotationOverlay
                    key={`${lastAnnotationSide ?? 'none'}-${focusedCommentId ?? 'none'}`}
                    annotation={lastAnnotationSide === 'a' ? annotationA : lastAnnotationSide === 'b' ? annotationB : null}
                  />
                }
              />
            ) : null
          ) : (
            <div
              className="relative flex min-h-0 flex-1 items-stretch overflow-hidden bg-black"
              onWheel={(e) => transform.onWheel(e)}
              onPointerDown={transform.onPointerDown}
              onDoubleClick={transform.reset}
            >
              <div className="relative flex min-w-0 flex-1 items-center justify-center">
                <span className="absolute left-3 top-3 z-10 rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeA}</span>
                {urlA && (
                  // Transform lives on a DEFINITE-size (h-full w-full — never
                  // max-*, whose content-sized box breaks the img's percentage
                  // caps) wrapper so the annotation overlay zooms/pans with
                  // the image — mirrors ImageViewer's inside-the-transform
                  // placement. At scale 1 the img letterboxes in the same
                  // available box as before.
                  <div className="relative flex h-full w-full items-center justify-center" style={transform.styleFor()}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={urlA} alt={badgeA} className="max-h-full max-w-full object-contain" draggable={false} />
                    <AnnotationOverlay key={`a-${focusedCommentId ?? 'none'}`} annotation={annotationA} />
                    {drawingSide === 'a' && <AnnotationCanvas />}
                  </div>
                )}
              </div>
              <div className="w-px bg-border" />
              <div className="relative flex min-w-0 flex-1 items-center justify-center">
                <span className="absolute right-3 top-3 z-10 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeB}</span>
                {urlB && (
                  <div className="relative flex h-full w-full items-center justify-center" style={transform.styleFor()}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={urlB} alt={badgeB} className="max-h-full max-w-full object-contain" draggable={false} />
                    <AnnotationOverlay key={`b-${focusedCommentId ?? 'none'}`} annotation={annotationB} />
                    {drawingSide === 'b' && <AnnotationCanvas />}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right comment panel */}
        <aside className={cn('shrink-0 border-l border-border transition-all', panelBOpen ? 'w-80' : 'w-0 overflow-hidden')}>
          {panelBOpen && (
            <div className="flex h-full flex-col">
              <CommentPanel
                comments={sideB.comments}
                currentUserId={user?.id}
                onResolve={async (id) => { await sideB.resolveComment(id) }}
                onDelete={async (id) => { await sideB.deleteComment(id) }}
                onAddReaction={async (id, e) => { await sideB.addReaction(id, e) }}
                onRemoveReaction={async (id, e) => { await sideB.removeReaction(id, e) }}
                onReply={() => {}}
                onSubmitReply={handleReplyB}
                onSeekToTimecode={(tc, pause) => {
                  transport.seekTo(tc + timingB.offset)
                  if (pause && transport.isPlaying) transport.toggle()
                }}
                onShowAnnotation={(d) => showAnnotationFor('b', d)}
                exportVersionId={right.id}
              />
              {canComment && (
              <CommentInput
                assetId={asset.id}
                projectId={asset.project_id}
                assetType={asset.asset_type}
                playheadTimeOverride={isVideo ? localTime(transport.t, timingB) : undefined}
                disableAnnotations={!canAuthor}
                annotationActive={drawingSide === 'b'}
                onToggleAnnotation={() => toggleDrawing('b')}
                onPauseVideo={() => { if (transport.isPlaying) transport.toggle() }}
                onSubmit={async (
                  body: string,
                  // Pane-local already (via playheadTimeOverride); undefined when
                  // the user detaches the timecode toggle — pass straight through.
                  timecodeStart?: number,
                  timecodeEnd?: number,
                  annotationData?: Record<string, unknown>,
                  parentId?: string,
                  visibility?: string,
                  mentionUserIds?: string[],
                ) => {
                  await sideB.createComment(
                    body,
                    timecodeStart,
                    timecodeEnd,
                    annotationData,
                    parentId,
                    visibility,
                    mentionUserIds,
                  )
                }}
              />
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
