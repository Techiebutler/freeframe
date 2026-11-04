'use client'

import * as React from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUpRight, Plus, Timer, BookOpen, CheckCheck, Search, X, ArrowRight, Pause, Play, Trophy, Crown, ChevronDown } from 'lucide-react'
import { api } from '@/lib/api'
import { usePageTitle } from '@/hooks/use-page-title'
import { useAuthStore } from '@/stores/auth-store'
import { editorAccuracy, getEditors, getTimeSaved, hours, listRequests, type FileRequest, type TimeSaved } from '@/lib/platform'
import { RequestSheet } from '@/components/v2/request-sheet'
import { ProjectKanban } from '@/components/v2/project-kanban'
import { FolderArt } from '@/components/v2/folder-art'
import { Avatar } from '@/components/shared/avatar'
import { LinkCard } from '@/components/v2/link-card'
import { SavedChecklist } from '@/components/v2/checklist'

type Filter = 'All' | 'Ready'

export default function HomePage() {
  usePageTitle('Overview')
  const user = useAuthStore(s => s.user)
  const [sheet, setSheet] = React.useState(false)
  const [sharing, setSharing] = React.useState<FileRequest | null>(null)
  const [filter, setFilter] = React.useState<Filter>('All')
  const [query, setQuery] = React.useState('')
  const [motionPaused, setMotionPaused] = React.useState(false)
  const { data: requests, error, mutate, isLoading } = useSWR('/requests', listRequests, {
    refreshInterval: d => (d || []).some(r => r.state === 'live' && r.status === 'reviewing' && r.assets > 0) ? 5000 : 30000,
  })
  const { data: saved, error: savedError } = useSWR('/insights/time-saved?30', () => getTimeSaved(30), { shouldRetryOnError: false })
  const { data: performance, error: editorError, mutate: refreshEditors } = useSWR('/insights/editors', getEditors, { refreshInterval: 30000, shouldRetryOnError: false })
  const live = (requests || []).filter(r => r.state === 'live')
  const ready = live.filter(r => r.assets > 0 && r.status === 'clear')
  const filtered = (filter === 'Ready' ? ready : requests || [])
    .filter(r => `${r.title} ${r.project_name} ${r.last_uploader_name || ''}`.toLowerCase().includes(query.toLowerCase().trim()))
  const editorUnavailable = !!editorError || performance?.reviewed === false
  const editors = performance?.editors || []
  const accuracy = editorAccuracy(editors)
  const quality = accuracy.average === null ? '—' : `${Math.round(accuracy.average * 100)}%`


  return (
    <div className="owner-overview mx-auto w-full max-w-[1320px] px-4 pb-12 pt-6 sm:px-8 lg:px-12 lg:pt-10">
      <div className="flex flex-wrap items-center justify-between gap-5">
        <div>
          <h1 className="text-[2.125rem] font-semibold leading-tight tracking-[-0.035em]">Overview<span className="text-accent">.</span></h1>
        </div>
        <button type="button" onClick={() => setSheet(true)} className="press inline-flex h-12 items-center gap-2 rounded-full bg-accent px-5 text-[0.9375rem] font-semibold text-text-inverse hover:bg-accent-hover">
          <Plus size={18} /> Request files
        </button>
      </div>

      <section aria-label="At a glance" className="overview-metrics mt-8 grid gap-4">
        <button type="button" onClick={() => { setFilter('Ready'); setQuery('') }} className="metric-card metric-ready text-left" aria-label="Show ready requests">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-[0.875rem] font-medium"><CheckCheck size={17} /> Ready to go</span><ArrowUpRight size={17} /></div>
          <p className="metric-number mt-6">{requests ? ready.length.toString().padStart(2, '0') : '—'}</p>
          <p className="mt-2 text-[0.8125rem]">{error ? 'Requests unavailable' : 'Open ready files'}</p>
        </button>
        <Link href="/insights" className="metric-card metric-time group relative overflow-hidden">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-[0.875rem] font-medium"><Timer size={17} /> Time saved</span><ArrowUpRight size={17} /></div>
          <p className="relative z-10 mt-6 flex items-baseline gap-2"><strong className="metric-number">{saved ? hours(saved.totalSec) : '—'}</strong><span className="text-[1.125rem]">hours</span></p>
          <p className="relative z-10 mt-2 text-[0.8125rem]">{savedError ? 'Temporarily unavailable' : 'Estimated · last 30 days'}</p>
          <SavingsLine points={saved?.perDay || []} />
        </Link>
        <a href="#editor-performance" className="metric-card metric-quality">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-[0.875rem] font-medium"><CheckCheck size={17} /> First-try pass rate</span><ArrowUpRight size={17} /></div>
          <p className="mt-6 flex items-start gap-2">
            <span className="metric-number">{editorUnavailable ? '—' : quality}</span>
            {!editorUnavailable && accuracy.outliers.length > 0 && <span
              aria-label={`${accuracy.outliers.length} ${accuracy.outliers.length === 1 ? 'editor stands' : 'editors stand'} out. See ranking.`}
              className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[0.75rem] font-semibold tabular-nums text-text-inverse ring-2 ring-bg-secondary">
              {accuracy.outliers.length}
            </span>}
          </p>
          <p className="mt-2 text-[0.8125rem]">{editorUnavailable ? 'Temporarily unavailable' : accuracy.count ? `Average of ${accuracy.count} ${accuracy.count === 1 ? 'editor' : 'editors'} · all history` : performance ? 'No reviewed first versions yet' : 'Loading editor results…'}</p>
        </a>

      </section>

      <div className="mt-9 grid items-start gap-8">
        <section aria-label="Project requests" className="min-w-0">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-[1.25rem] font-semibold tracking-tight">Projects <span className="ml-1 text-[0.875rem] font-normal text-text-secondary">{requests?.length ?? ''}</span></h2>
            <Link href="/projects" className="inline-flex min-h-11 items-center gap-1.5 text-[0.8125rem] text-text-secondary hover:text-text-primary">All projects <ArrowUpRight size={14} /></Link>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {filter === 'Ready' && <button type="button" onClick={() => setFilter('All')} className="press inline-flex min-h-11 items-center gap-2 rounded-full bg-accent-muted px-3 text-[0.8125rem] font-medium text-accent">Ready to go <X size={14} /><span className="sr-only">Show all stages</span></button>}
              <button type="button" aria-pressed={motionPaused} onClick={() => setMotionPaused(p => !p)} aria-label={motionPaused ? 'Resume motion' : 'Pause motion'} title={motionPaused ? 'Resume motion' : 'Pause motion'} className="press kanban-motion grid h-11 w-11 place-items-center rounded-full text-text-secondary hover:bg-bg-hover">{motionPaused ? <Play size={14} /> : <Pause size={14} />}</button>
            </div>
            <label className="flex h-11 w-full items-center gap-2 rounded-full border border-border bg-bg-secondary px-3 sm:w-44"><Search size={16} className="shrink-0 text-text-secondary" /><input aria-label="Search requests" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a project" className="min-w-0 w-full bg-transparent text-[0.8125rem] outline-none" /></label>
          </div>
          {error && <div role="alert" className="mt-4 rounded-2xl border border-border p-5 text-[0.9375rem]">Could not load requests. <button className="min-h-11 font-semibold text-accent" onClick={() => mutate()}>Retry</button></div>}
          {isLoading ? <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Loading requests">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton-shimmer h-64 animate-shimmer rounded-2xl" />)}</div> : !error && !requests?.length ? (
            <button type="button" onClick={() => setSheet(true)} className="press mt-5 flex w-full flex-col items-center gap-3 rounded-3xl border border-dashed border-border bg-bg-secondary px-6 py-12 text-center">
              <FolderArt size={88} /><span className="text-[1.25rem] font-semibold">Request your first files</span><span className="text-[0.9375rem] text-text-secondary">One link for your editor. Everything comes back here.</span>
            </button>
          ) : filtered.length ? (
            <ProjectKanban requests={filtered} paused={motionPaused} onShare={setSharing} onDone={async done => { await Promise.all(done.map(r => api.delete(`/requests/${r.id}`))); void mutate() }} focusReady={filter === 'Ready'} />
          ) : !error && <div className="mt-5 rounded-2xl border border-border p-8 text-center"><p className="text-[0.9375rem] text-text-secondary">No matching requests</p><button onClick={() => { setQuery(''); setFilter('All') }} className="mt-2 min-h-11 text-[0.875rem] font-medium text-accent">Clear filters</button></div>}
          {user?.is_staff === false && !requests?.length && !isLoading && !error && <Link href="/start" className="mt-3 inline-flex min-h-11 items-center text-sm text-accent">Set up your brand and first briefing <ArrowRight size={16} className="ml-2" /></Link>}

        </section>

        <aside className="grid items-start gap-4">
          <section id="editor-performance" className="rounded-3xl border border-border bg-bg-secondary p-5 scroll-mt-6">
            <div className="flex items-center justify-between gap-3">
              <div><h2 className="flex items-center gap-2 text-[1.062rem] font-semibold tracking-tight"><Trophy size={17} className="text-accent" />Editor leaderboard</h2><p className="mt-1 text-[0.8125rem] text-text-secondary">First-try accuracy</p></div>
              <button type="button" aria-label="Invite via file request" onClick={() => setSheet(true)} className="press inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full px-3 text-[0.8125rem] font-medium text-accent hover:bg-accent-muted"><Plus size={14} />Invite<span className="hidden sm:inline"> editor</span></button>
            </div>
            {editorUnavailable ? <div role="alert" className="mt-5 text-[0.8125rem] text-text-secondary">Editor results unavailable. <button onClick={() => refreshEditors()} className="min-h-11 font-medium text-accent">Retry</button></div> : !performance ? <div className="skeleton-shimmer mt-5 h-32 animate-shimmer rounded-xl" /> : !editors.length ? <p className="mt-6 text-[0.875rem] leading-relaxed text-text-secondary">Your editors appear here after their first upload.</p> : (
              <ol aria-label="Editor accuracy ranking" className="leaderboard-list mt-3">{editors.map((editor, i) => {
                const known = editor.first_try_rate !== null
                const outlier = accuracy.outliers.find(o => o.email === editor.email)
                return <li key={editor.email}>
                  <details className="leaderboard-row" data-leader={known && i === 0}>
                    <summary className="leaderboard-summary">
                      <span className="text-center text-[0.75rem] tabular-nums text-text-secondary" aria-label={known ? `Rank ${i + 1}` : 'Unranked'}>{known ? i + 1 : '—'}</span>
                      <span className="relative inline-flex" aria-hidden="true"><Avatar name={editor.name || editor.email} />{known && i === 0 && <Crown size={13} className="leaderboard-crown" />}</span>
                      <span className="min-w-0 break-words text-[0.875rem] font-medium [overflow-wrap:anywhere]">{editor.name || editor.email}{known && editor.rated < 5 && <span className="ml-1.5 text-[0.6875rem] font-normal text-text-secondary" title="Fewer than 5 reviewed videos">Small sample</span>}</span>
                      <span className="inline-flex items-center gap-1.5">{outlier && <span className="text-accent" title={outlier.direction === 'above' ? 'Above average' : 'Below average'}><span aria-hidden="true">{outlier.direction === 'above' ? '↑' : '↓'}</span><span className="sr-only">{outlier.direction === 'above' ? 'Above average' : 'Below average'}</span></span>}{known ? <strong className="text-base font-semibold tabular-nums">{Math.round(editor.first_try_rate! * 100)}%</strong> : <span className="text-[0.75rem] text-text-secondary" aria-label="Not reviewed yet">—<span className="sr-only">Not reviewed yet</span></span>}</span>
                      <ChevronDown size={14} className="leaderboard-chevron text-text-secondary" />
                    </summary>
                    <div className="leaderboard-detail space-y-1 text-[0.75rem] leading-relaxed text-text-secondary">
                      {editor.name && <p className="break-words [overflow-wrap:anywhere]">{editor.email}</p>}
                      <p>{editor.rated} of {editor.videos} reviewed</p>
                      <p>{editor.avg_versions === null ? 'Average versions unavailable' : `${editor.avg_versions.toFixed(1)} versions per video on average`}</p>
                      <p>{editor.open_must_fixes} open {editor.open_must_fixes === 1 ? 'must-fix' : 'must-fixes'}</p>
                    </div>
                  </details>
                </li>
              })}</ol>
            )}
            <details className="mt-2 border-t border-border text-[0.75rem] leading-relaxed text-text-secondary"><summary className="min-h-11 cursor-pointer py-3">How this is measured</summary><p className="mt-2">Share a file request. Editors enter their name and email and join after their first upload.</p><p className="mt-2">Only reviewed first versions count. Pending or unavailable reviews are excluded. A new version is not a new video. Fewer than 5 reviewed videos is marked as a small sample. The overview averages each rated editor equally, over all available history. The notification marks editors at least 20 percentage points above or below that average. It appears only with at least 3 editors who each have 5 reviewed videos; smaller samples never receive a marker.</p></details>
          </section>
          <Link href="/rules" className="guidelines-nudge press group"><span className="guidelines-book" aria-hidden="true"><BookOpen size={23} /></span><div className="min-w-0 flex-1"><h2 className="text-[0.9375rem] font-semibold leading-snug tracking-tight">Brand guidelines</h2><p className="mt-1 text-[0.75rem] text-text-secondary">Review and update your brand rules.</p></div><ArrowRight size={17} className="shrink-0 text-accent" /></Link>
        </aside>
      </div>
      <RequestSheet open={sheet} onOpenChange={setSheet} onCreated={() => mutate()} />
      <Dialog.Root open={!!sharing} onOpenChange={open => { if (!open) { setSharing(null); void mutate() } }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" /><Dialog.Content className="owner-sheet sheet-in fixed inset-x-4 top-[15vh] z-50 mx-auto max-h-[75vh] max-w-lg overflow-y-auto rounded-3xl border border-border bg-bg-elevated p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-[1.375rem] font-semibold tracking-tight">{sharing?.assets ? 'Share files' : 'Share upload link'}</Dialog.Title><Dialog.Description className="mt-1 text-[0.9375rem] text-text-secondary">{sharing?.title}</Dialog.Description></div><Dialog.Close aria-label="Close share dialog" className="press grid h-11 w-11 place-items-center rounded-full hover:bg-bg-hover"><X size={20} /></Dialog.Close></div>
        <div className="mt-6">{sharing && (sharing.assets > 0 ? sharing.review_share_token ? <LinkCard url={`${window.location.origin}/share/${encodeURIComponent(sharing.review_share_token)}`} label="View & download" hint="Anyone with this link can view and download these files." copiedHint="Copied. Ready to share with your team." openLabel="Preview shared files" /> : <p role="alert" className="text-sm text-text-secondary">The file-sharing link is unavailable. Reload this page and try again.</p> : <LinkCard url={sharing.url} label="Upload link" hint="Anyone with this link can upload files. No account needed." />)}</div>
        {sharing?.checklist_binding_id && <div className="mt-5"><SavedChecklist bindingId={sharing.checklist_binding_id} initial={sharing.checklist} /></div>}
      </Dialog.Content></Dialog.Portal></Dialog.Root>
    </div>
  )
}

function SavingsLine({ points }: { points: TimeSaved['perDay'] }) {
  if (points.length < 2 || !points.some(p => p.sec > 0)) return null
  let cumulative = 0
  const values = points.map(p => (cumulative += Math.max(0, p.sec)))
  const max = Math.max(1, ...values)
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${i * 400 / (values.length - 1)},${68 - v / max * 58}`).join(' ')
  return <svg viewBox="0 0 400 80" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full opacity-30" aria-hidden="true"><path d={`${line} L400,80 L0,80Z`} fill="currentColor" opacity="0.15" /><path d={line} stroke="currentColor" fill="none" strokeWidth="1.5" /></svg>
}
