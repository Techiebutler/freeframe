'use client'

import * as React from 'react'
import useSWR from 'swr'
import { AlertCircle, ArrowLeft, CheckCircle2, Download, FileVideo, Loader2, Plus, Upload, X } from 'lucide-react'
import { declareParts, handoffMessage, objectToOutputNote, removePart, requestIterations, retryParts, submitParts, type IterationProgress, type IterationSlot, type PartRole } from '@/lib/iterations'
import { objectToNote, uploadToRequest, type RequestAsset } from '@/lib/platform'
import { createUploadQueue } from '@/lib/part-upload-queue'
import { RequestWorkspace } from './request-workspace'

interface Who { name: string; email: string }
interface Job { id: string; slot: IterationSlot; file: File; assetId?: string; phase: 'queued' | 'uploading' | 'done' | 'error'; progress: number; error?: string; declared: boolean }
const roleLabels: Record<PartRole, string> = { hook: 'Hooks', opening: 'Openings', lead: 'Leads', body: 'Bodies', cta: 'CTAs' }
const validWho = (w: Who) => !!w.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(w.email)
const button = 'press min-h-11 rounded-full px-4 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40'
const statusLabel: Record<string, string> = { missing: 'Waiting for file', uploaded: 'Preparing review', ready: 'Waiting for review', reviewing: 'Checking', clear: 'Checked', held: 'Needs a change', error: 'Retry needed', processing: 'Preparing review', uploading: 'Uploading', rendering: 'Creating ad', delivered: 'Delivered', queued: 'Queued' }

export function PartsWorkspace({ token, brand, who: signedIn, onActivity }: { token: string; brand?: string; who?: Who; onActivity?: () => void }) {
  const { data: progress, error: loadError, mutate } = useSWR(['parts', token], () => requestIterations(token), { refreshInterval: 4000 })
  const [jobs, setJobs] = React.useState<Job[]>([])
  const [error, setError] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [optional, setOptional] = React.useState<PartRole[]>([])
  const [activeId, setActiveId] = React.useState<string>()
  const [revision, setRevision] = React.useState<IterationSlot>()
  const [who, setWho] = React.useState<Who>(signedIn || { name: '', email: '' })
  const contactFormId = React.useId()
  const identity = React.useRef<Who | null>(signedIn || null)
  const identityWaiters = React.useRef<((who: Who) => void)[]>([])
  const queue = React.useRef(createUploadQueue(2))
  const busyIds = React.useRef(new Set<string>())
  const [waitingIdentity, setWaitingIdentity] = React.useState(false)
  const replaceInput = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (signedIn && validWho(signedIn)) {
      identity.current = signedIn; setWho(signedIn)
      identityWaiters.current.splice(0).forEach(resolve => resolve(signedIn)); setWaitingIdentity(false)
      return
    }
    try { const saved = JSON.parse(localStorage.getItem('aditor-request-who') || 'null'); if (saved && validWho(saved)) { identity.current = saved; setWho(saved) } } catch { /* optional convenience */ }
  }, [signedIn])
  const transferring = jobs.some(j => j.phase === 'uploading' || j.phase === 'queued')
  React.useEffect(() => {
    if (!transferring) return
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [transferring])
  const refresh = React.useCallback(async () => { await mutate() }, [mutate])
  const update = (id: string, patch: Partial<Job>) => setJobs(items => items.map(j => j.id === id ? { ...j, ...patch } : j))
  const upload = async (job: Job) => {
    if (busyIds.current.has(job.slot.id)) return
    busyIds.current.add(job.slot.id)
    update(job.id, { phase: 'queued', error: undefined })
    try {
      await queue.current(async release => {
        if (!job.declared) {
          await declareParts(token, [{ id: job.slot.id, role: job.slot.role, label: job.slot.label }])
          job.declared = true
          update(job.id, { declared: true })
        }
        update(job.id, { phase: 'uploading', progress: 0 })
        const result = await uploadToRequest(token, identity.current || who, job.file, p => update(job.id, { progress: p }), {
          slotId: job.slot.id, assetId: job.assetId,
          onTransferred: release,
          identity: async () => {
            if (identity.current) return identity.current
            setWaitingIdentity(true)
            return new Promise<Who>(resolve => identityWaiters.current.push(resolve))
          },
          // A signed-in identity has no form to correct it in, so that case stays a plain failure.
          onIdentityRejected: signedIn ? undefined : rejected => {
            if (identity.current !== rejected) return
            identity.current = null
            try { localStorage.removeItem('aditor-request-who') } catch { /* optional convenience */ }
            setError('That name or email was not accepted. Check it to submit your files. They are still uploaded.')
          },
        })
        update(job.id, { phase: 'done', progress: 1, assetId: result.asset_id })
        await refresh().catch(() => {})
      })
    } catch (e) { update(job.id, { phase: 'error', error: e instanceof Error ? e.message : 'Upload stopped. Please retry.' }) }
    finally { busyIds.current.delete(job.slot.id) }
  }
  const take = (files: File[], role: PartRole, fixed?: IterationSlot) => {
    if (!progress || (!fixed && progress.submitted)) return
    if (files.some(f => (!f.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(f.name)) || !f.size || f.size > 200 * 1024 * 1024)) {
      setError('Choose video files up to 200 MB each. Export a smaller file if needed.'); return
    }
    onActivity?.()
    const selected = fixed ? files.slice(0, 1) : files
    if (fixed && busyIds.current.has(fixed.id)) return
    const fresh = selected.map(file => {
      const slot = fixed || { id: crypto.randomUUID(), label: file.name, role, group: '', script: '' }
      const existing = progress.slots.find(s => s.slot_id === slot.id)
      return { id: crypto.randomUUID(), slot, file, assetId: existing?.asset_id, phase: 'queued' as const, progress: 0, declared: !!fixed && progress.manifest.slots.some(s => s.id === fixed.id) }
    })
    setError(''); setRevision(undefined); setActiveId(undefined)
    setJobs(items => [...items.filter(j => !fresh.some(f => f.slot.id === j.slot.id)), ...fresh])
    fresh.forEach(job => { void upload(job) })
  }
  const saveIdentity = () => {
    if (!validWho(who)) return
    const value = { name: who.name.trim(), email: who.email.trim() }
    identity.current = value
    try { localStorage.setItem('aditor-request-who', JSON.stringify(value)) } catch { /* optional convenience */ }
    if (identityWaiters.current.length) setError('')
    identityWaiters.current.splice(0).forEach(resolve => resolve(value)); setWaitingIdentity(false)
  }
  const seal = async () => {
    if (submitting || transferring || !allSaved || !validWho(who) || jobs.some(j => j.phase === 'error')) return
    saveIdentity()
    setSubmitting(true); setError('')
    try { await mutate(await submitParts(token), { revalidate: false }) }
    catch (e) { setError(e instanceof Error ? e.message : 'Submission could not be confirmed. Try again.') }
    finally { setSubmitting(false) }
  }
  if (!progress) return <p role={loadError ? 'alert' : 'status'} className="py-8 text-text-secondary">{loadError ? 'This submission could not be loaded.' : 'Opening your submission…'}{loadError && <button className={button} onClick={refresh}>Try again</button>}</p>
  const slots = [...progress.manifest.slots, ...jobs.filter(j => !progress.manifest.slots.some(s => s.id === j.slot.id)).map(j => j.slot)]
  const activeJob = (id: string) => jobs.find(j => j.slot.id === id)
  const state = handoffMessage(progress, transferring)
  const assets: RequestAsset[] = progress.slots.filter(s => s.asset_id).map(s => ({ ...s, asset_id: s.asset_id!, review_progress: s.review_progress || {stage:'waiting',version_id:s.version_id}, name: slots.find(slot => slot.id === s.slot_id)?.label || 'Part', version: s.version_number || 1, asset_type: 'video', processing: s.processing || (s.media_url ? 'ready' : s.status === 'error' ? 'failed' : 'processing'), comments: s.findings || [], review_state: s.status === 'clear' ? 'clear' : s.status === 'held' ? 'held' : s.status === 'error' ? 'unavailable' : 'reviewing' }))
  const outputAssets: RequestAsset[] = progress.outputs.filter(o => o.asset_id).map(o => ({ ...o, asset_id: o.asset_id!, review_progress: o.review_progress || {stage:'waiting',version_id:o.version_id}, name: o.label, version: o.version_number || 1, asset_type: 'video', processing: o.processing || (o.media_url ? 'ready' : 'processing'), comments: o.findings || [], review_state: o.status === 'delivered' ? 'clear' : o.status === 'held' ? 'held' : o.status === 'error' ? 'unavailable' : 'reviewing' }))
  const fixedPlan = progress.simple === false
  const roles = (['opening', 'hook', 'lead', 'body', 'cta'] as PartRole[]).filter(role => slots.some(s => s.role === role) || (!fixedPlan && (role === 'hook' || role === 'body' || optional.includes(role))))
  const adding = !progress.submitted && !fixedPlan
  const displayRoles = adding ? (['hook', 'lead', 'body', 'cta', ...roles.filter(role => !['hook', 'lead', 'body', 'cta'].includes(role))] as PartRole[]) : roles
  const expandedOptional = roles.includes('lead') || roles.includes('cta')
  const flowColumns = roles.includes('lead') ? roles.includes('cta') ? 'lg:grid-cols-4' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_64px]' : roles.includes('cta') ? 'lg:grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_minmax(0,1fr)]' : 'sm:grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_64px]'
  const allSaved = slots.some(s => s.role === 'body') && slots.some(s => s.role === 'hook' || s.role === 'opening') && slots.every(s => progress.slots.some(p => p.slot_id === s.id && p.asset_id && p.version_id && p.bytes_stored === true))
  return <div className="parts-workspace space-y-6">
    <SubmissionSteps progress={progress} transferring={transferring} />
    {(progress.submitted || slots.length > 0) && <div role="status" aria-live="polite" className="flex gap-3 rounded-2xl bg-bg-secondary p-5">
      {['held', 'error'].includes(progress.state) && !transferring ? <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0 text-status-error" size={22} /> : progress.editor_done && !transferring ? <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-accent" size={22} /> : <Upload aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" size={22} />}
      <div><h2 className="text-base font-semibold">{state.title}</h2><p className="mt-1 max-w-xl text-sm leading-relaxed text-text-secondary">{state.detail}</p></div>
    </div>}
    {loadError && <p role="alert" className="text-sm text-status-error">Live status is unavailable. Last confirmed state is shown. <button className={button} onClick={refresh}>Refresh</button></p>}
    {activeId ? <>
      <button className={`${button} flex items-center gap-2 text-text-secondary`} onClick={() => setActiveId(undefined)}><ArrowLeft size={16} /> Back to parts</button>
      <RequestWorkspace token={token} brand={brand} assets={[...assets, ...outputAssets]} activeId={activeId} onSelect={setActiveId} onRefresh={refresh} statusUnavailable={!!loadError}
        onRevise={asset => { const slot = slots.find(s => progress.slots.some(p => p.slot_id === s.id && p.asset_id === asset.asset_id)); if (slot) { setRevision(slot); replaceInput.current?.click() } else { setActiveId(undefined); setError('Replace the affected source part below. We’ll recreate the final ad and check it again.') } }}
        onObject={async (asset, comment, text) => { const output = progress.outputs.find(o => o.asset_id === asset.asset_id); const result = output ? await objectToOutputNote(token, output.id, { comment_id: comment.id, body: comment.body, text, who: who.name }) : await objectToNote(token, { asset_id: asset.asset_id, version_id: asset.version_id, comment_id: comment.id, body: comment.body, text, name: who.name }); await refresh(); return result }} />
    </> : <>
      <div className={`grid items-start gap-y-6 ${adding && expandedOptional ? 'parts-flow-expanded' : ''} ${adding ? `gap-x-3 ${expandedOptional ? 'sm:grid-cols-2' : ''} ${flowColumns}` : 'gap-x-6 sm:grid-cols-2'}`}>{displayRoles.map(role => adding && !roles.includes(role) ? <div key={role} className="flex items-center justify-center self-stretch sm:pt-6"><button aria-label={role === 'lead' ? 'Add leads' : 'Add separate CTAs'} className="press inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setOptional(o => [...o, role])}><span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-secondary px-2 py-1 text-xs hover:bg-bg-hover"><Plus aria-hidden="true" size={12} />{role === 'lead' ? 'Lead' : 'CTA'}</span></button></div> : <section key={role} className="min-w-0" aria-label={roleLabels[role]}>
        <div className="mb-2 flex min-h-8 items-center gap-2"><h3 className="text-[15px] font-semibold">{roleLabels[role]}</h3><span className="rounded-full bg-bg-hover px-2 py-0.5 text-xs tabular-nums text-text-secondary">{slots.filter(s => s.role === role).length} {slots.filter(s => s.role === role).length === 1 ? 'part' : 'parts'}</span>{adding && (role === 'lead' || role === 'cta') && !slots.some(s => s.role === role) && <button aria-label={role === 'lead' ? 'Remove leads' : 'Remove separate CTAs'} title="Remove this step" className="press ml-auto grid h-11 w-11 place-items-center rounded-full text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setOptional(o => o.filter(r => r !== role))}><X size={16} /></button>}</div>
        {!progress.submitted && !fixedPlan && <PartDrop label={`Upload ${roleLabels[role].toLowerCase()}`} title={`Drop ${roleLabels[role].toLowerCase()} or click`} multiple onFiles={files => take(files, role)} />}
        <ul className="mt-3 divide-y divide-border">{slots.filter(s => s.role === role).map(slot => {
          const job = activeJob(slot.id), server = progress.slots.find(s => s.slot_id === slot.id)
          const uploading = job && (job.phase === 'queued' || job.phase === 'uploading')
          const label = uploading ? job.progress === 1 ? waitingIdentity ? 'Transfer finished · add your details' : 'Confirming upload' : job.phase === 'queued' ? 'Queued' : `Uploading · ${Math.round(job.progress * 100)}%` : job?.phase === 'error' ? 'Upload stopped' : statusLabel[server?.status || 'missing'] || 'Checking'
          return <li key={slot.id} className="py-3">
            <div className="flex items-start gap-3"><FileVideo className="mt-1 shrink-0 text-text-secondary" size={19} /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium [overflow-wrap:anywhere]">{slot.label}</p><p className="mt-1 text-sm text-text-secondary">{label}{server?.version_number ? ` · v${server.version_number}` : ''}</p></div>{server?.status === 'clear' && !uploading && <CheckCircle2 className="shrink-0 text-accent" size={18} />}</div>
            {uploading && <progress aria-label={`Uploading ${slot.label}`} value={job.progress} max={1} className="mt-3 h-1 w-full accent-[var(--accent)]" />}
            {job?.error && <p role="alert" className="mt-2 text-sm text-status-error">{job.error}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              {!uploading && !progress.submitted && !fixedPlan && <button aria-label={`Remove ${slot.label}`} title="Remove part" className="press grid h-11 w-11 place-items-center rounded-full text-text-secondary focus-visible:outline focus-visible:outline-accent" onClick={async () => { try { const result = await removePart(token, slot.id); setJobs(items => items.filter(j => j.slot.id !== slot.id)); await mutate(result, { revalidate: false }) } catch (e) { setError(e instanceof Error ? e.message : 'This part could not be removed.') } }}><X size={16} /></button>}
              {job?.phase === 'error' && <button className={`${button} text-accent`} onClick={() => upload(job)}>Retry upload</button>}
              {!uploading && server?.asset_id && <button className={`${button} text-accent`} onClick={() => setActiveId(server.asset_id)}>View feedback</button>}
              {!uploading && (!progress.submitted || progress.state !== 'delivered') && <label className={`${button} relative inline-flex cursor-pointer items-center text-text-secondary focus-within:outline focus-within:outline-2 focus-within:outline-accent`}>{server?.asset_id ? 'Replace part' : 'Choose file'}<input type="file" accept="video/*" aria-label={`Replace ${slot.label}`} className="absolute inset-0 w-full cursor-pointer opacity-0" onChange={e => { take(Array.from(e.target.files || []), slot.role, slot); e.target.value = '' }} /></label>}
            </div>
          </li>
        })}</ul>
      </section>)}</div>
      {!signedIn && (!progress.submitted || transferring) && <form id={contactFormId} onKeyDown={e => { if (e.key === 'Enter') saveIdentity() }} onSubmit={e => { e.preventDefault(); if (allSaved && !transferring) void seal(); else saveIdentity() }} className="mx-auto max-w-xl"><h3 className="sr-only">Contact</h3><div className="grid gap-3 sm:grid-cols-2">{(['name', 'email'] as const).map(field => <label key={field} className="block"><span className="sr-only">Your {field}</span><input placeholder={field === 'email' ? 'Email' : 'Name'} required type={field === 'email' ? 'email' : 'text'} autoComplete={field} value={who[field]} onChange={e => setWho(w => ({ ...w, [field]: e.target.value }))} onBlur={saveIdentity} className="field min-h-11 w-full text-sm" /></label>)}</div></form>}
      {progress.total > 0 && <p className="text-sm text-text-secondary">{slots.filter(s => s.role === 'hook' || s.role === 'opening').length} {slots.filter(s => s.role === 'hook' || s.role === 'opening').length === 1 ? 'hook' : 'hooks'} · {slots.filter(s => s.role === 'body').length} {slots.filter(s => s.role === 'body').length === 1 ? 'body' : 'bodies'} · {progress.total} final {progress.total === 1 ? 'ad' : 'ads'}</p>}
      {!progress.submitted && <button type={signedIn ? 'button' : 'submit'} form={signedIn ? undefined : contactFormId} className={`${button} mx-auto flex w-full max-w-xl items-center justify-center gap-2 bg-accent px-6 text-text-inverse`} disabled={!validWho(who) || !allSaved || transferring || submitting || jobs.some(j => j.phase === 'error')} onClick={signedIn ? seal : undefined}>{submitting && <Loader2 className="animate-spin" size={16} />}{submitting ? 'Submitting…' : 'Submit for review'}</button>}
      {progress.state === 'error' && <button className={`${button} border border-border`} onClick={async () => { try { await mutate(await retryParts(token), { revalidate: false }) } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.') } }}>Retry processing</button>}
      {progress.outputs.some(output => output.asset_id || output.status === 'error') && <section aria-label="Final ads" className="border-t border-border pt-6"><div className="flex flex-wrap justify-between gap-2"><h2 className="text-xl font-semibold">Final ads</h2>{progress.total > 0 && <span className="text-sm text-text-secondary">{progress.delivered} of {progress.total} delivered</span>}</div><p className="mt-2 text-sm leading-relaxed text-text-secondary">Created from your checked parts. Each complete ad gets a final review before delivery.</p><ul className="mt-3 divide-y divide-border">{progress.outputs.map(output => <li key={output.id} className="flex flex-wrap items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{output.label}</p><p className="mt-1 text-sm text-text-secondary">{statusLabel[output.status] || 'Waiting for parts'}</p>{output.status === 'error' && output.error && <p className="mt-1 text-sm text-status-error">{output.error}</p>}</div>{output.asset_id && <button className={`${button} text-text-secondary`} onClick={() => setActiveId(output.asset_id)}>View final review</button>}{output.status === 'delivered' && output.download_url && <a className={`${button} inline-flex items-center gap-2 text-accent`} href={output.download_url}><Download size={16} /> Download</a>}</li>)}</ul></section>}
    </>}
    <input ref={replaceInput} type="file" accept="video/*" className="hidden" aria-label="Replacement file" onChange={e => { if (revision) take(Array.from(e.target.files || []), revision.role, revision); e.target.value = '' }} />
    {error && <p role="alert" className="text-sm leading-relaxed text-status-error">{error}</p>}
  </div>
}

function SubmissionSteps({ progress: p, transferring }: { progress: IterationProgress; transferring: boolean }) {
  const declared = p.manifest.slots
  const checked = declared.filter(slot => p.slots.some(part => part.slot_id === slot.id && part.status === 'clear')).length
  const uploaded = p.submitted && p.can_leave && !transferring
  const partsClear = declared.length > 0 && checked === declared.length && !transferring
  const delivered = !transferring && p.state === 'delivered' && p.total > 0 && p.delivered === p.total
  const current = !uploaded ? 0 : !partsClear ? 1 : 2
  const steps = [
    { title: 'Upload', owner: 'Your task', done: uploaded, detail: uploaded ? 'Files saved and submitted' : 'Hooks and bodies, uploaded once' },
    { title: 'Review', owner: 'Automatic', done: partsClear, detail: declared.length ? `${checked} of ${declared.length} parts passed` : 'Feedback for each part' },
    { title: 'Final ads', owner: 'Automatic', done: delivered, detail: p.total ? `${p.delivered} of ${p.total} ads delivered` : 'Combine, review and deliver' },
  ]
  return <ol aria-label="Submission progress" className="flex justify-center gap-2">
    {steps.map((step, index) => <li key={step.title} aria-current={!delivered && index === current ? 'step' : undefined} className={`h-1.5 w-6 rounded-full ${step.done || index === current ? 'bg-accent' : 'bg-bg-hover'}`}>
      <span className="sr-only">{step.owner}: {step.title}. {step.detail}{step.done && ' · Complete'}</span>
    </li>)}
  </ol>
}

function PartDrop({ label, title, onFiles, multiple }: { label: string; title: string; onFiles: (files: File[]) => void; multiple?: boolean }) {
  const [hot, setHot] = React.useState(false)
  return <label data-dragging={hot} onDragOver={e => { e.preventDefault(); setHot(true) }} onDragLeave={() => setHot(false)} onDrop={e => { e.preventDefault(); setHot(false); onFiles(Array.from(e.dataTransfer.files)) }} className="parts-drop relative flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--drop-border)] bg-bg-secondary p-6 text-center focus-within:ring-2 focus-within:ring-accent"><span aria-hidden="true" className="parts-upload-symbol grid h-10 w-10 place-items-center rounded-xl bg-accent-muted text-accent"><Upload size={20} strokeWidth={1.75} /></span><span className="text-sm leading-relaxed text-text-secondary">{hot ? 'Drop your files' : title}</span><span className="text-xs text-text-secondary">Video · max 200 MB</span><input type="file" aria-label={label} accept="video/*" multiple={multiple} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={e => { onFiles(Array.from(e.target.files || [])); e.target.value = '' }} /></label>
}
