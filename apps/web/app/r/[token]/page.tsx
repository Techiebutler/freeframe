'use client'

import * as React from 'react'
import useSWR from 'swr'
import { PartsWorkspace } from '@/components/v2/parts-workspace'
import { requestIterations } from '@/lib/iterations'
import { ArrowLeft } from 'lucide-react'
import { discardUpload, finishRequest, objectToNote, requestReview, uploadToRequest, viewRequest, type RequestAsset, type RequestView } from '@/lib/platform'
import { createUploadQueue } from '@/lib/part-upload-queue'
import { DropZone } from '@/components/v2/drop-zone'
import { UploadCard, type UploadPhase } from '@/components/v2/upload-card'
import { RequestWorkspace, SubmissionSuccess } from '@/components/v2/request-workspace'

interface Who { name: string; email: string }
interface Job { id: string; file: File; progress: number; phase: UploadPhase; error?: string; assetId?: string }
const WHO_KEY = 'aditor-request-who'
const validWho = (who: Who) => !!who.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(who.email)

function CompleteRequestPage({ params: { token }, onActivity }: { params: { token: string }; onActivity?: () => void }) {
  const { data: view, error: viewError, mutate: refreshView } = useSWR(`/r/${token}`, () => viewRequest(token), { shouldRetryOnError: false, refreshInterval: d => d?.completed_at ? 0 : 60000 })
  const { data: review, error: reviewError, mutate: refreshReview } = useSWR(view?.assets.length ? `/r/${token}/review` : null, () => requestReview(token), { refreshInterval: d => d?.completed_at || view?.completed_at ? 0 : 10000 })
  const [jobs, setJobs] = React.useState<Job[]>([])
  const [who, setWho] = React.useState<Who>({ name: '', email: '' })
  const identity = React.useRef<Who | null>(null)
  const identityWaiters = React.useRef<((who: Who) => void)[]>([])
  const queue = React.useRef(createUploadQueue(2))
  const [error, setError] = React.useState('')
  const [waitingIdentity, setWaitingIdentity] = React.useState(false)
  const [revision, setRevision] = React.useState<RequestAsset | null>(null)
  const [uploadMode, setUploadMode] = React.useState(false)
  const [activeId, setActiveId] = React.useState<string>()
  const [completedAt, setCompletedAt] = React.useState<string>()
  const finishAttempt = React.useRef('')
  React.useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(WHO_KEY) || 'null'); if (saved && validWho(saved)) { setWho(saved); identity.current = saved } } catch { /* private browsing */ }
  }, [])
  const refresh = React.useCallback(async () => { await Promise.allSettled([refreshView(), refreshReview()]) }, [refreshView, refreshReview])
  // Everything not yet submitted counts: the request must not close or leave this screen under it.
  const uploading = jobs.some(j => j.phase === 'queued' || j.phase === 'uploading' || j.phase === 'uploaded')
  const complete = !!(view?.completed_at || review?.completed_at || completedAt)
  const assets = review?.assets || []
  const hasSubmission = (view?.assets.length || 0) > 0
  const batchOpen = uploading || jobs.some(j => j.phase === 'error')
  const showUpload = !complete && (uploadMode || uploading || jobs.some(j => j.phase === 'error') || (!hasSubmission && !jobs.some(j => j.phase === 'submitted')))
  React.useEffect(() => { window.scrollTo?.({ top: 0 }) }, [showUpload, complete])
  React.useEffect(() => {
    if (!uploading) return
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [uploading])
  const readyToFinish = !!review?.assets.length && review.assets.every(a => a.processing === 'ready' && a.review_state === 'clear') && review.gate.status === 'clear'
  React.useEffect(() => {
    if (!readyToFinish || uploadMode || uploading || complete || jobs.some(j => j.phase === 'error')) return
    const signature = review!.assets.map(a => a.version_id).join(',')
    if (finishAttempt.current === signature) return
    finishAttempt.current = signature
    finishRequest(token).then(r => { setCompletedAt(r.completed_at); refresh() }).catch(e => setError(e.message))
  }, [readyToFinish, uploadMode, uploading, complete, jobs, review, token, refresh])

  const update = (id: string, patch: Partial<Job>) => setJobs(js => js.map(j => j.id === id ? { ...j, ...patch } : j))
  const submitIdentity = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validWho(who)) { setError('Add your name and a valid email to submit.'); return }
    const value = { name: who.name.trim(), email: who.email.trim() }
    identity.current = value
    try { localStorage.setItem(WHO_KEY, JSON.stringify(value)) } catch { /* private browsing */ }
    identityWaiters.current.splice(0).forEach(resolve => resolve(value)); setWaitingIdentity(false); setError('')
  }
  const upload = async (job: Job) => {
    update(job.id, { phase: 'queued', progress: 0, error: undefined }); setError('')
    try {
      // Bytes need the shared uplink slot; details do not. A file waiting for details gives its slot to the next one.
      const result = await queue.current(release => {
        update(job.id, { phase: 'uploading' })
        return uploadToRequest(token, identity.current || { name: '', email: '' }, job.file, progress => update(job.id, { progress }), {
          assetId: job.assetId,
          onTransferred: () => { update(job.id, { phase: 'uploaded', progress: 1 }); release() },
          identity: async () => {
            if (identity.current) return identity.current
            setWaitingIdentity(true)
            return new Promise<Who>(resolve => identityWaiters.current.push(resolve))
          },
          onIdentityRejected: rejected => {
            if (identity.current !== rejected) return
            identity.current = null
            try { localStorage.removeItem(WHO_KEY) } catch { /* private browsing */ }
            setWho(w => ({ ...w })); setError('That name or email was not accepted. Check it and submit again. Your files are still uploaded.')
          },
        })
      })
      // Read the server first: the review still holds this file as `uploading` until then.
      await refresh()
      update(job.id, { phase: 'submitted', progress: 1, assetId: result.asset_id })
      setActiveId(result.asset_id); setUploadMode(false); setRevision(null)
    } catch (e) { update(job.id, { phase: 'error', error: e instanceof Error ? e.message : 'Upload stopped. Try again.' }) }
  }
  const onFiles = (files: File[]) => {
    if (complete) return
    if (files.some(file => !file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(file.name))) { setError('Choose a video file for this review.'); return }
    onActivity?.()
    const chosen = revision ? files.slice(0, 1) : files
    const fresh = chosen.map(file => ({ id: crypto.randomUUID(), file, assetId: revision?.asset_id, progress: 0, phase: 'queued' as UploadPhase }))
    setJobs(js => [...js.filter(j => j.phase !== 'submitted'), ...fresh])
    fresh.forEach(job => { void upload(job) })
  }
  const uploaderDetails = identity.current ? <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm text-text-secondary"><span>Submitting as {who.name} · {who.email}</span><button className="min-h-11 text-accent" onClick={() => { identity.current = null; setWho(w => ({ ...w })) }}>Edit details</button></div> : <form onSubmit={submitIdentity} className="mt-6">
    <div className="grid gap-4 sm:grid-cols-2">{(['name', 'email'] as const).map(field => <label key={field} className="text-xs font-medium text-text-secondary">Your {field}<input required type={field === 'email' ? 'email' : 'text'} value={who[field]} autoComplete={field} onChange={e => { setWho(w => ({ ...w, [field]: e.target.value })); identity.current = null }} className="field mt-2 min-h-11 w-full" /></label>)}</div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-text-tertiary">{waitingIdentity ? 'Add your details to submit your uploaded files. Keep this tab open.' : 'Your files can upload while you fill this in.'}</p>{!identity.current && <button className="min-h-11 rounded-full bg-accent px-5 text-sm font-semibold text-text-inverse">{uploading ? 'Submit my files' : 'Save details'}</button>}</div>

  </form>
  const jobCard = (job: Job) => <div key={job.id} className="mt-3"><UploadCard file={job.file} name={job.file.name} size={job.file.size} phase={job.phase} progress={job.progress} error={job.error} onRetry={() => upload(job)} onRemove={job.phase === 'error' ? () => setJobs(js => js.filter(j => j.id !== job.id)) : undefined} />{job.phase === 'uploaded' && <p className="mt-2 text-xs text-text-secondary">{waitingIdentity ? 'Waiting for your details. Not handed in yet: add your name and email below, then press Submit my files.' : 'Submitting your file…'}</p>}</div>
  return <div data-system-appearance className="owner-workspace handin-workspace min-h-screen bg-bg-primary text-text-primary">
    <header className={`relative mx-auto flex h-20 max-w-[1120px] items-center border-b border-border px-5 sm:px-8 ${complete ? 'justify-center' : 'justify-between'}`}>{view?.logo_url ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={view.logo_url} alt={view.brand} className="h-8 max-w-40 object-contain" /> : <span className="text-lg font-semibold tracking-tight">{view?.brand || 'File request'}</span>}<span className={`text-xs text-text-tertiary ${complete ? 'absolute right-5 sm:right-8' : ''}`}>{complete ? 'Completed' : showUpload ? 'Editor upload' : 'Editor review'}</span></header>
    <main className={`mx-auto px-5 pb-16 pt-8 sm:px-8 sm:pt-10 ${showUpload ? 'max-w-3xl' : 'max-w-[1120px]'}`}>
      {viewError && (!view || [401, 403, 404, 410].includes(viewError.status)) ? <div className="py-20 text-center"><h1 className="text-2xl font-semibold">{viewError.status === 410 ? 'This link is closed' : 'This link could not be opened'}</h1><p className="mt-3 text-text-secondary">{viewError.message}</p></div> : !view ? <p role="status">Opening your project…</p> : <>
      <div className={`mb-7 ${complete ? 'text-center' : ''}`}><p className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-text-tertiary">{revision && showUpload ? `Next version · v${revision.version + 1}` : complete ? 'Handed in. Nicely done.' : 'Your project'}</p><h1 className="text-balance text-3xl font-semibold tracking-tight">{view.title}</h1></div>
      {error && <div role="alert" className="mb-5 rounded-xl border border-border p-4 text-sm text-status-error">{error}{readyToFinish && !complete && <button className="ml-3 min-h-11 underline" onClick={() => { finishAttempt.current = ''; refresh() }}>Try again</button>}</div>}
      {complete ? <SubmissionSuccess token={token} brand={view.brand} /> : <>
      {showUpload ? <>
        {hasSubmission && !uploading && <button className="mb-4 flex min-h-11 items-center gap-2 text-sm text-text-secondary" onClick={() => { setUploadMode(false); setRevision(null) }}><ArrowLeft size={16} /> Back to {revision ? `v${revision.version} ` : ''}feedback</button>}
        <DropZone onFiles={onFiles} multiple={!revision} accept="video/*" disabled={uploading && !!revision} title={revision ? `Drop ${revision.name} · v${revision.version + 1}` : hasSubmission || batchOpen ? 'Drop more files to add them' : 'Drop your files to begin'} hint={revision ? 'New filename? No problem. This replaces the selected cut.' : 'Video files · or choose files'} />{jobs.filter(j => j.phase !== 'submitted' || batchOpen).map(jobCard)}{uploaderDetails}
      </> : <>
        <RequestWorkspace statusUnavailable={!!reviewError} token={token} brand={view.brand} assets={assets} activeId={activeId} onSelect={setActiveId} onRefresh={refresh} onRevise={asset => { setRevision(asset); setUploadMode(true) }} onDiscard={async asset => { try { await discardUpload(token, { asset_id: asset.asset_id, version_id: asset.version_id! }); setActiveId(undefined); await refresh() } catch (e) { setError(e instanceof Error ? e.message : 'That file could not be removed. Try again.'); await refresh() } }} onObject={async (asset, comment, text) => { const result = await objectToNote(token, { asset_id: asset.asset_id, version_id: asset.version_id, comment_id: comment.id, body: comment.body, text, name: who.name }); refresh(); return result }} />
        <button className="mx-auto mt-5 flex min-h-11 rounded-full border border-border px-5 text-sm font-medium items-center" onClick={() => { setRevision(null); setUploadMode(true) }}>Add more files</button>
        {reviewError && <p role="alert" className="mb-5 text-sm text-status-error">Feedback is temporarily unavailable. Your files are safe. <button onClick={refresh} className="min-h-11 underline">Try again</button></p>}

      </>}
      </>}
      </>}
    </main>
  </div>
}

function RequestBrief({ view }: { view: RequestView }) {
  const full = view.brief_text?.trim()
  const brief = full || view.brief_excerpt?.trim()
  const preview = brief && brief !== view.brief_url ? (brief.length > 120 ? brief.slice(0, 120).replace(/\s+\S*$/, '') + '…' : brief) : null
  const linkClass = 'press inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  return <section aria-label="Briefing" className="mb-8 text-center">
    <h1 className="text-balance text-[2.125rem] font-bold leading-[1.08] tracking-tight sm:text-[2.75rem]">{view.title}</h1>
    {preview && <p aria-label="Briefing preview" className="mx-auto mt-4 max-w-xl line-clamp-2 text-base leading-relaxed text-text-secondary">{preview}</p>}
    {full || (brief && !view.brief_url) ? <details className="mt-1">
      <summary className={`${linkClass} cursor-pointer list-none`}>{full ? 'View full brief' : 'View briefing preview'}</summary>
      <div className="mt-3 rounded-xl bg-bg-secondary p-5 text-left"><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-secondary">{full || brief}</p>{view.brief_url && <a className={`${linkClass} mt-3`} href={view.brief_url} target="_blank" rel="noopener noreferrer">Open briefing source</a>}</div>
    </details> : view.brief_url ? <a className={`${linkClass} mt-1`} href={view.brief_url} target="_blank" rel="noopener noreferrer">View full brief</a> : null}
  </section>
}

export default function RequestPage({ params }: { params: { token: string } }) {
  const { data: view } = useSWR(`/r/${params.token}`, () => viewRequest(params.token), { shouldRetryOnError: false })
  const { data: progress } = useSWR(view?.receive_iterations ? ['parts', params.token] : null, () => requestIterations(params.token), { refreshInterval: 4000 })
  if (!view?.receive_iterations || progress?.mode === 'complete') return <CompleteRequestPage params={params} />
  return <div data-system-appearance className="owner-workspace handin-workspace relative min-h-screen bg-bg-primary text-text-primary">
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_50%_at_50%_0%,var(--accent-muted),transparent_70%)]" />
    <header className="relative mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-5 py-2 sm:px-8"><div className="flex shrink-0 items-center gap-2.5">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/autoreview-icon.png" alt="" className="h-7 w-7" /><span className="text-[15px] font-semibold tracking-tight">Autoreview</span></div><div className="min-w-0 text-right"><p className="text-xs text-text-secondary">Submitting to</p><span className="block break-words text-sm font-medium">{view.brand}</span></div></header>
    <main className="relative mx-auto max-w-[760px] px-5 pb-16 pt-12 sm:px-8 sm:pt-16">
      <RequestBrief view={view} />
      <PartsWorkspace token={params.token} brand={view.brand} />
    </main>
  </div>
}
