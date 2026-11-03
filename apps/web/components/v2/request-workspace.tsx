'use client'
import * as React from 'react'
import useSWR from 'swr'
import Image from 'next/image'
import { Check, CircleCheck, Download, Film, Pause, Play, RotateCcw } from 'lucide-react'
import { VideoPlayer } from '@/components/review/video-player'
import { CommentItem } from '@/components/review/comment-panel'
import { Dispute } from './review-list'
import { requestVersion, type RequestAsset, type ReviewComment, type ReviewProgress } from '@/lib/platform'
import { serverElapsed, waitExpectation } from '@/lib/review-wait'
import { downloadFeedback, feedbackSrt } from '@/lib/request-feedback'
import { useReviewStore } from '@/stores/review-store'
import type { CommentWithReplies } from '@/hooks/use-comments'

export function ReviewRobot() {
  const [moving, setMoving] = React.useState(true)
  return <div className="relative w-32 shrink-0">
    <div role="img" aria-label="A proud robot celebrating your finished work" className={`review-robot ${moving ? 'review-robot-dance' : ''}`} />
    <button aria-label={moving ? 'Pause animation' : 'Resume animation'} title={moving ? 'Pause animation' : 'Resume animation'} className="request-motion absolute bottom-0 left-10 grid h-11 w-11 place-items-center rounded-full text-text-tertiary hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setMoving(v => !v)}>{moving ? <Pause size={12} /> : <Play size={12} />}</button>
  </div>
}
export function SubmissionSuccess({ token, brand }: { token: string; brand: string }) {
  const [confetti, setConfetti] = React.useState(false)
  React.useEffect(() => {
    try {
      const key = `request-celebrated:${token}`
      if (localStorage.getItem(key)) return
      localStorage.setItem(key, '1')
    } catch { /* A single burst per mount if storage is unavailable. */ }
    setConfetti(true)
  }, [token])
  return <section className="relative mx-auto max-w-xl py-3 text-center">
    {confetti && <div aria-hidden="true" className="request-confetti pointer-events-none absolute inset-x-0 top-20 h-60 overflow-hidden">{Array.from({ length: 20 }, (_, i) => <i key={i} style={{ '--confetti-x': `${(i % 2 ? 1 : -1) * (38 + i * 9)}px`, '--confetti-turn': `${(i % 2 ? 1 : -1) * (90 + i * 27)}deg`, animationDelay: `${i % 5 * 60}ms` } as React.CSSProperties} />)}</div>}
    <div className="flex items-center justify-center gap-3">
      <ReviewRobot />
      <div role="img" aria-label="Video submitted" className="request-done-frame relative -rotate-6 rounded-2xl border border-accent/20 bg-bg-secondary p-2 text-accent shadow-sm">
        <div className="grid h-28 w-16 place-items-center rounded-lg bg-accent-muted"><Play size={23} fill="currentColor" strokeWidth={1.5} /></div>
        <span className="absolute -bottom-2 -right-2 grid h-8 w-8 place-items-center rounded-full border-4 border-bg-primary bg-accent text-text-inverse"><Check size={16} strokeWidth={3} /></span>
      </div>
    </div>
    <h2 className="mt-4 text-balance text-3xl font-semibold tracking-tight sm:text-4xl"><CircleCheck aria-hidden="true" className="mr-2 inline-block h-7 w-7 align-[-3px] text-accent" /><span>Your ads were submitted</span></h2>
    <p className="mx-auto mt-4 max-w-sm text-base leading-relaxed text-text-secondary">{brand} might reach out later, but consider your job done!</p>
  </section>
}
function ReviewAnalysis({ mediaUrl, thumbnailUrl, unavailable, onRefresh, processingText, progress, processing }: { mediaUrl?: string; thumbnailUrl?: string | null; unavailable?: boolean; onRefresh: () => void | Promise<void>; processingText?: string; progress?: ReviewProgress | null; processing?: string }) {
  const [paused, setPaused] = React.useState(false)
  const [offline, setOffline] = React.useState(false)
  React.useEffect(() => {
    const update = () => { setOffline(!navigator.onLine) }
    update()
    window.addEventListener('offline',update); window.addEventListener('online',update)
    return () => { window.removeEventListener('offline',update); window.removeEventListener('online',update) }
  }, [])
  unavailable = unavailable || offline || progress?.stage === 'failed'
  const [scanning, setScanning] = React.useState(true)
  const serverAge = serverElapsed(progress)
  const [clock, setClock] = React.useState(() => ({ at: Date.now(), now: Date.now(), base: serverAge }))
  React.useEffect(() => {
    const park = setTimeout(() => setScanning(false), 3600)
    return () => clearTimeout(park)
  }, [])
  React.useEffect(() => {
    const at = Date.now()
    setClock({ at, now: at, base: serverAge })
    if (unavailable) return
    const tick = setInterval(() => setClock(c => ({ ...c, now: Date.now() })), 1000)
    return () => clearInterval(tick)
  }, [serverAge, unavailable])
  const elapsed = clock.base === undefined ? undefined : Math.max(0, Math.floor(clock.base + (clock.now - clock.at) / 1000))
  const preparing = processing && processing !== 'ready'
  const step = preparing ? 'Preparing video' : progress?.stage === 'waiting' ? 'Waiting for review' : ({ preparing: 'Reading the brief', measuring: 'Measuring the video', analysing: 'Checking the video', finishing: 'Preparing feedback' }[progress?.step || 'preparing'])
  const expectation = waitExpectation(progress)
  const timing = progress?.timing
  const analysisElapsed = timing?.phase === 'analysing' && timing.phase_started_at && timing.server_now ? (timing.server_now - timing.phase_started_at) / 1000 : progress?.startedAgoSeconds
  const comparableElapsed = expectation.scope === 'total' ? elapsed : analysisElapsed
  const overrun = !preparing && progress?.stage === 'reading' && progress.step !== 'finishing' && expectation.upper !== undefined && comparableElapsed !== undefined && comparableElapsed > expectation.upper
  const elapsedLabel = elapsed === undefined ? 'Waiting time will appear when confirmed' : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} elapsed`
  const [ratio, setRatio] = React.useState(9 / 16)
  const [failedThumbnail, setFailedThumbnail] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const thumbnail = thumbnailUrl && !failedThumbnail
  return <div className="review-analysis relative mx-auto mt-5 max-w-sm rounded-3xl border border-border bg-bg-secondary px-6 pb-5 pt-7 text-center" data-paused={paused} data-scanning={!unavailable && scanning}>
    <div className="review-frame-preview relative mx-auto overflow-hidden rounded-xl bg-bg-tertiary" style={{ width: Math.min(240, 224 * ratio), aspectRatio: ratio }}>
      {thumbnail ? /* eslint-disable-next-line @next/next/no-img-element */ <img key={attempt} src={thumbnailUrl} alt="Still frame of your submitted video" className="h-full w-full object-contain" onLoad={e => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight || 9 / 16)} onError={() => setFailedThumbnail(true)} /> : mediaUrl && !failed ? <video key={attempt} src={mediaUrl} aria-label="Still frame of your submitted video" role="img" muted playsInline preload="metadata" disablePictureInPicture disableRemotePlayback tabIndex={-1} className="pointer-events-none h-full w-full object-contain" onContextMenu={e => e.preventDefault()} onPlay={e => e.currentTarget.pause()} onLoadedMetadata={e => { const video = e.currentTarget; setRatio(video.videoWidth / video.videoHeight || 9 / 16); video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0 }} onError={() => setFailed(true)} /> : <div className="grid h-full place-content-center gap-3 p-4 text-xs text-text-tertiary"><Film className="mx-auto" size={24} />{failed ? 'Preview unavailable' : 'Preparing preview'}</div>}
      {!unavailable && <div aria-hidden="true" className="review-frame-overlay pointer-events-none absolute inset-0"><div className="review-frame-grid absolute inset-0" /><div className="review-analysis-scan absolute inset-x-0 top-0 h-full" /><div className="review-frame-target absolute inset-x-[20%] inset-y-[30%] rounded-md border"><i /><i /><i /><i /></div></div>}
    </div>
    <h3 className="mt-5 text-lg font-semibold">{offline ? 'Connection paused' : unavailable ? 'Review unavailable' : 'Review in progress'}</h3>
    <p role="status" className="mx-auto mt-2 min-h-6 max-w-xs text-base leading-relaxed text-text-secondary">{unavailable ? offline ? 'Your file is safe. Reconnect to check the review.' : 'Your file is safe. We cannot confirm the review yet.' : <span key={step} className="review-step-text inline-block">{progress?.retrying ? 'Retrying the review' : preparing && processingText ? processingText : step}</span>}</p>
    {!unavailable && <>
      <div role="progressbar" aria-label="Review steps" aria-valuetext={step} className="review-progress-track relative mt-5 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
        <div className="review-progress-fill h-full rounded-full" ><span className="review-progress-activity block h-full w-12 bg-accent" /></div>
      </div>
      <div className="mt-4 space-y-1 text-sm leading-relaxed">
        <p className="font-medium text-text-primary">{expectation.label}</p>
        <p className="tabular-nums text-text-secondary">{elapsedLabel}</p>
        <p className="text-text-tertiary">{expectation.detail}</p>
        {overrun && <p className="pt-2 text-text-secondary">Taking longer than usual. Your review is still running.</p>}
      </div>
    </>}
    {(failed || unavailable) && <button className="mt-2 min-h-11 text-sm font-medium text-accent" onClick={() => { setFailed(false); setFailedThumbnail(false); setAttempt(n => n + 1); void onRefresh() }}>{unavailable ? 'Check again' : 'Retry preview'}</button>}
    {!unavailable && <button aria-label={paused ? 'Resume animation' : 'Pause animation'} title={paused ? 'Resume animation' : 'Pause animation'} className="request-motion absolute right-2 top-2 grid h-11 w-11 place-items-center rounded-full text-text-tertiary hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setPaused(v => !v)}>{paused ? <Play size={12} /> : <Pause size={12} />}</button>}
  </div>
}
function UploadNotFinished({ onUploadAgain, onRemove }: { onUploadAgain?: () => void; onRemove?: () => void | Promise<void> }) {
  const [removing, setRemoving] = React.useState(false)
  return <div className="mx-auto mt-5 max-w-sm rounded-3xl border border-border bg-bg-secondary px-6 py-7 text-center">
    <h3 className="text-lg font-semibold">Upload not finished</h3>
    <p role="status" className="mx-auto mt-2 max-w-xs text-base leading-relaxed text-text-secondary">This file did not finish uploading, so it was not handed in and is not being reviewed. If it is still uploading in another tab, keep that tab open. Otherwise upload it again.</p>
    {onUploadAgain && <button className="mt-5 min-h-11 w-full rounded-full bg-accent px-4 text-sm font-semibold text-text-inverse" onClick={onUploadAgain}>Upload it again</button>}
    {onRemove && <button disabled={removing} className="mt-2 min-h-11 w-full text-sm font-medium text-text-secondary disabled:opacity-50" onClick={async () => { setRemoving(true); try { await onRemove() } finally { setRemoving(false) } }}>Remove this file</button>}
  </div>
}
const unavailableAction = async () => { throw new Error('This action is unavailable on a request link.') }

export function RequestWorkspace({ token, brand, assets, activeId, onSelect, onRevise, onDiscard, onObject, onRefresh, processingText, statusUnavailable }: {
  token: string; brand?: string; assets: RequestAsset[]; activeId?: string; onSelect: (id: string) => void
  onRevise?: (asset: RequestAsset) => void; onDiscard?: (asset: RequestAsset) => void | Promise<void>; onRefresh: () => void | Promise<void>
  onObject?: (asset: RequestAsset, comment: ReviewComment, text: string) => Promise<{ withdrawn: boolean; why: string }>
  processingText?: string; statusUnavailable?: boolean
}) {
  const latest = assets.find(a => a.asset_id === activeId) || assets.find(a => a.review_state === 'held') || assets.find(a => a.review_state === 'upload_incomplete') || assets[0]
  const [historyId, setHistoryId] = React.useState('')
  React.useEffect(() => { setHistoryId(''); useReviewStore.getState().reset() }, [latest?.asset_id])
  const { data: history, error: historyError } = useSWR(latest && historyId && historyId !== latest.version_id ? ['request-version', token, latest.asset_id, historyId] : null, () => requestVersion(token, latest.asset_id, historyId), { refreshInterval: 60000 })
  const historic = !!historyId && historyId !== latest?.version_id
  const asset = historic ? history && { ...latest, ...history } : latest
  const source = React.useRef<{ key: string; url: string }>()
  const [, redraw] = React.useReducer(n => n + 1, 0)
  const sourceKey = `${asset?.asset_id}:${asset?.version_id || asset?.version}:${asset?.media_url?.split('?')[0]}`
  if (asset?.media_url && source.current?.key !== sourceKey) source.current = { key: sourceKey, url: asset.media_url }
  const refreshMedia = async () => { await onRefresh(); source.current = undefined; redraw() }
  const focused = useReviewStore(s => s.focusedCommentId)
  const native: CommentWithReplies[] = (asset?.comments || []).map((c, i) => ({ id: c.id || `note-${i}`, asset_id: latest.asset_id, version_id: asset?.version_id || '', parent_id: null, author_id: 'review-agent', guest_author_id: null, author: { id: 'review-agent', name: brand?.trim() || 'Review team', avatar_url: null }, timecode_start: c.t, timecode_end: null, body: c.body, review_source: c.review_source, resolved: false, visibility: 'public', created_at: '', updated_at: '', deleted_at: null, replies: [], reactions: [], annotation: null, guest_author: null }))
  const pending = !asset || asset.processing !== 'ready' || (!historic && asset.review_state !== 'held' && asset.review_state !== 'clear')
  const unavailable = asset && (!asset.review_state || asset.review_state === 'unavailable')
  return <section className={`request-workspace ${pending ? 'mx-auto max-w-lg' : ''}`}>
    <div className="flex min-h-16 flex-wrap items-center gap-3 rounded-2xl border border-border bg-bg-secondary px-4 py-2"><button aria-label="Refresh video" title="Refresh video" className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-bg-hover" onClick={refreshMedia}><RotateCcw size={16} /></button>
      {assets.length > 1 ? <select aria-label="Video to review" value={latest?.asset_id || ''} onChange={e => onSelect(e.target.value)} className="min-h-11 min-w-0 flex-1 bg-transparent text-sm font-medium">{assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.name}{a.review_state === 'held' ? ' · Needs changes' : a.review_state === 'upload_incomplete' ? ' · Not uploaded' : ''}</option>)}</select> : <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{latest?.name || 'Your submission'}</h2>}
      {latest?.versions && latest.versions.length > 1 ? <select aria-label="Review version" value={historyId || latest.version_id} onChange={e => { useReviewStore.getState().reset(); setHistoryId(e.target.value) }} className="min-h-11 rounded-lg border border-border bg-bg-primary px-3 text-sm">{latest.versions.map(v => <option key={v.id} value={v.id}>v{v.version_number}{v.id === latest.version_id ? ' · Latest' : ' · History'}</option>)}</select> : latest && <span className="rounded-full bg-bg-hover px-3 py-1 text-xs">v{latest.version}</span>}
    </div>
    {onRevise && !historic && latest?.processing === 'failed' && <button onClick={() => onRevise(latest)} className="mt-4 min-h-11 w-full rounded-full bg-accent px-4 text-sm font-semibold text-text-inverse">Upload a replacement v{latest.version + 1}</button>}
    {asset?.review_state === 'upload_incomplete' ? <UploadNotFinished onUploadAgain={onRevise && !historic ? () => onRevise(latest) : undefined} onRemove={onDiscard && !historic ? () => onDiscard(latest) : undefined} /> : pending ? <ReviewAnalysis key={`${asset?.asset_id}-${asset?.version_id}-${historyId}`} mediaUrl={source.current?.key === sourceKey ? source.current.url : undefined} thumbnailUrl={asset?.thumbnail_url} unavailable={unavailable || !!historyError || statusUnavailable} onRefresh={refreshMedia} processingText={processingText} progress={asset?.review_progress} processing={asset?.processing} /> : <div className="request-review-grid mt-4 grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="request-media flex min-w-0 items-center justify-center overflow-hidden rounded-2xl bg-black/95">
        {asset?.media_url ? asset.asset_type === 'image' ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={source.current?.url} alt={asset.name} className="max-h-[65vh] max-w-full object-contain" /> : <VideoPlayer key={`${asset.asset_id}-${asset.version_id}-${historyId}`} assetId={latest.asset_id} initialStreamUrl={source.current?.url} onRetry={refreshMedia} comments={native} className="request-player h-full w-full" /> : <div className="p-8 text-center text-sm text-white/70">{historyError ? 'This version could not be loaded.' : historic ? 'Loading this version…' : 'Your video is being prepared.'}<button className="mx-auto mt-3 block min-h-11 underline" onClick={onRefresh}>Refresh video</button></div>}
      </div>
      <aside className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-bg-secondary">
        <div className="border-b border-border p-4"><h3 className="text-base font-semibold">{historic ? `v${asset?.version || ''} feedback` : pending ? 'Review in progress' : unavailable ? 'Review unavailable' : asset?.review_state === 'held' ? 'A few finishing touches' : 'Review passed'}</h3><p role="status" className="mt-1 text-sm leading-relaxed text-text-secondary">{historic ? 'Previous version · shown for reference.' : pending ? processingText || 'Checking the cut against the brief. Notes appear here when ready.' : unavailable ? 'Your file is safe. We cannot confirm the review yet.' : asset?.review_state === 'held' ? 'Jump to a timestamp to see exactly what needs changing.' : 'No required changes for this version.'}</p></div>
        {unavailable && <button className="m-5 min-h-11 rounded-full border border-border text-sm" onClick={onRefresh}>Check again</button>}
        {!!native.length && <div className="max-h-[360px] overflow-y-auto p-3 md:max-h-[320px]">{native.map((comment, i) => <div key={comment.id} className="review-note mb-3"><span className={`ml-10 text-[11px] font-semibold uppercase tracking-wide ${asset!.comments[i].must_fix || asset!.comments[i].weight === 'must_fix' ? 'text-status-error' : 'text-text-tertiary'}`}>{asset!.comments[i].must_fix || asset!.comments[i].weight === 'must_fix' ? 'Required change' : 'Optional'}</span><CommentItem comment={comment} readOnly isFocused={focused === comment.id} onResolve={unavailableAction} onDelete={unavailableAction} onAddReaction={unavailableAction} onRemoveReaction={unavailableAction} onReply={() => {}} onCancelReply={() => {}} action={!historic && onObject && (asset!.comments[i].must_fix || asset!.comments[i].weight === 'must_fix') ? <Dispute c={asset!.comments[i]} onObject={(c, text) => onObject(asset!, c, text)} /> : undefined} /></div>)}</div>}
        {!!asset?.comments.length && <details className="border-t border-border px-5 py-3"><summary className="cursor-pointer text-sm text-text-secondary">Take feedback into your editor<span className="mt-2 flex items-center gap-2">{[['premiere-pro', 'Premiere Pro'], ['davinci-resolve', 'DaVinci Resolve'], ['final-cut-pro', 'Final Cut Pro (Mac)'], ['capcut', 'CapCut (Desktop/Web)']].map(([icon, name]) => <Image key={icon} src={`/editor-apps/${icon}.png`} alt={name} title={name} width={24} height={24} unoptimized className="h-6 w-6 object-contain" />)}</span></summary><p className="mt-3 text-xs leading-relaxed text-text-tertiary">Import SRT as a temporary caption track at the start of this source clip. Premiere Pro, DaVinci Resolve, Final Cut Pro (Mac) and CapCut (Desktop/Web). Remove it before exporting.</p><div className="mt-2 flex flex-wrap gap-3"><button disabled={!feedbackSrt(asset.comments, asset.duration_seconds)} onClick={() => downloadFeedback(`${asset.name.replace(/\.[^.]+$/, '')}-v${asset.version}`, asset.comments, asset.duration_seconds)} className="flex min-h-11 items-center gap-2 text-sm font-medium text-accent disabled:opacity-40"><Download size={15} /> Feedback SRT</button><button className="min-h-11 text-sm text-text-secondary" onClick={() => downloadFeedback(`${asset.name.replace(/\.[^.]+$/, '')}-v${asset.version}`, asset.comments, asset.duration_seconds, 'txt')}>All notes TXT</button></div></details>}
        {onRevise && latest?.review_state === 'held' && <div className="border-t border-border p-4"><button onClick={() => onRevise(latest)} className="press min-h-11 w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-text-inverse">Feedback done, back to upload v{latest.version + 1}</button></div>}
      </aside>
    </div>}
  </section>
}
