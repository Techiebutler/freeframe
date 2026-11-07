'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, BookOpen, Check, ChevronDown, ArrowUp, Sparkles, X } from 'lucide-react'
import Link from 'next/link'
import { ownsProject, canManageWorkspace } from '@/lib/workspace-access'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { usePageTitle } from '@/hooks/use-page-title'
import { useToast } from '@/components/shared/toast'
import { decideSuggestion, getRules, importRules } from '@/lib/platform'
import { BRIEFING_ACCEPT, GUIDELINE_HINT, briefingFilePayload, briefingTextPayload } from '@/lib/briefing'
import type { Project } from '@/types'
import { BrandLogo } from '@/components/v2/brand-logo'
import { DropZone } from '@/components/v2/drop-zone'
import { RuleLibrary, RuleSeverity } from '@/components/v2/rule-library'
import { AutoreviewBrandButton } from '@/components/layout/autoreview-nav'

export default function RulesPage() {
  usePageTitle('Brand rules')
  const user = useAuthStore(s => s.user)
  const { data: projects, error, mutate } = useSWR<Project[]>('/projects', (k: string) => api.get<Project[]>(k))
  const brands = React.useMemo(() => (projects || []).filter(p => ownsProject(user, p) && (user?.is_staff === false || p.is_workspace)).sort((a, b) => a.name.localeCompare(b.name)), [projects, user])
  const [selection, setSelection] = React.useState('')
  const brand = brands.find(p => p.id === selection) || brands[0]

  if (projects && !canManageWorkspace(user, projects)) return <div className="mx-auto max-w-xl p-8"><h1 className="text-2xl font-semibold">Your editing workspace</h1><p className="mt-3 text-text-secondary">Brand rules are managed by the workspace owner. Your review includes the rules that apply to your work.</p><Link href="/handin" className="mt-4 inline-flex min-h-11 items-center text-accent">Go to Hand in</Link></div>
  return <div className="brand-playbook mx-auto w-full max-w-[1320px] px-4 pb-12 pt-6 sm:px-8 lg:px-12 lg:pt-10">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><h1 className="text-[2.125rem] font-semibold leading-tight tracking-[-0.035em]">Brand rules<span className="text-accent">.</span></h1></div>
      {!!brands.length && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3"><AutoreviewBrandButton slug={brand.autoreview_brand_slug} name={brand.name} /><label className="flex min-w-0 max-w-full items-center gap-3 text-[0.8125rem] text-text-secondary"><span>Brand</span><select value={brand.id} onChange={e => setSelection(e.target.value)} className="field h-11 min-w-0 max-w-[240px]" aria-label="Brand">{brands.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>}
    </div>
    {error ? <div role="alert" className="playbook-surface mt-8 p-5">Could not load brands. <button type="button" onClick={() => mutate()} className="min-h-11 px-2 font-medium text-accent">Retry</button></div> : !projects ? <div className="skeleton-shimmer mt-8 h-48 animate-shimmer rounded-3xl" aria-label="Loading brands" /> : !brand ? <p className="playbook-surface mt-8 p-8 text-text-secondary">Create a request first. Its brand appears here.</p> : <BrandPlaybook key={brand.id} projectId={brand.id} brandName={brand.name} />}
  </div>
}

function BrandPlaybook({ projectId, brandName }: { projectId: string; brandName: string }) {
  const toast = useToast()
  const { data, mutate, error } = useSWR(`/insights/rules?${projectId}`, () => getRules(projectId), { shouldRetryOnError: false })
  const [importOpen, setImportOpen] = React.useState(false)
  const [reading, setReading] = React.useState(false)
  const [text, setText] = React.useState('')
  const quickInput = React.useRef<HTMLTextAreaElement>(null)
  const [importError, setImportError] = React.useState('')
  const [approvalsOpen, setApprovalsOpen] = React.useState(false)
  const [pending, setPending] = React.useState<string | null>(null)
  const [decisionError, setDecisionError] = React.useState<{ id: string; message: string } | null>(null)
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const brandRules = (data?.rules || []).filter(r => r.scope === 'brand' && r.active)
  const houseRules = (data?.rules || []).filter(r => r.scope === 'global' && r.active)
  const required = brandRules.filter(r => r.severity === 'blocker').length

  async function read(payload: string | File) {
    setReading(true); setImportError('')
    try {
      const body = payload instanceof File ? await briefingFilePayload(payload, 'Guidelines') : briefingTextPayload(payload, 'Guidelines')
      const result = await importRules({ project_id: projectId, ...body })
      if (!mounted.current) return
      toast.success(result.drafted ? `${result.drafted} rules ready for your approval.` : 'No new rules found. Your existing rules are unchanged.')
      if (!(payload instanceof File)) setText('')
      setImportOpen(false); setApprovalsOpen(true)
      void mutate()
    } catch (e) {
      if (mounted.current) setImportError(e instanceof Error ? e.message : 'Could not read that guide. Please try again.')
    } finally { if (mounted.current) setReading(false) }
  }

  async function decide(id: string, action: 'accept' | 'dismiss') {
    setPending(id); setDecisionError(null)
    try {
      const result = await decideSuggestion({ project_id: projectId, suggestion_id: id, action })
      if (!result.ok) throw new Error('The rule could not be saved. Try again.')
      if (!mounted.current) return
      await mutate(d => d && { ...d, suggestions: d.suggestions.filter(s => s.id !== id) }, { revalidate: false })
      void mutate()
    } catch (e) {
      if (mounted.current) setDecisionError({ id, message: e instanceof Error ? e.message : 'That did not save. Please try again.' })
    } finally { if (mounted.current) setPending(null) }
  }

  return <>
    <section className="playbook-surface playbook-composer mt-6" aria-label="Quick rules">
      <div className="playbook-composer-art" aria-hidden="true"><div className="playbook-book"><span className="playbook-book-spine" /><BookOpen size={38} strokeWidth={1.3} /><span className="playbook-book-line" /><span className="playbook-book-line short" /></div></div>
      <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-3"><label htmlFor="quick-guideline" className="text-[1rem] font-semibold tracking-tight">Add a quick rule</label><button type="button" disabled={reading} onClick={() => { setImportError(''); setImportOpen(true) }} className="min-h-11 text-[0.75rem] text-text-secondary underline decoration-border underline-offset-4 hover:text-text-primary disabled:opacity-50">Import guidelines</button></div>
      <form onSubmit={e => { e.preventDefault(); if (text.trim() && !reading) void read(text) }} className="quick-rule-input mt-2 flex items-end gap-2 rounded-2xl border border-border bg-bg-secondary p-2">
        <textarea ref={quickInput} id="quick-guideline" value={text} onChange={e => setText(e.target.value)} disabled={reading} rows={2} className="min-w-0 flex-1 resize-y bg-transparent px-2 py-2 text-[1rem] leading-relaxed outline-none disabled:opacity-50" placeholder={`Always show the ${brandName} logo on the end card.`} aria-label="Quick rule" />
        <button type="submit" disabled={!text.trim() || reading} aria-label={reading ? 'Preparing rule…' : 'Add for approval'} title="Add for approval" className="press grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-text-inverse disabled:opacity-40"><ArrowUp size={20} /></button>
      </form>
      {reading && !importOpen && <p role="status" className="mt-3 text-[0.8125rem] text-text-secondary">Preparing your rule…</p>}
      {importError && !importOpen && <p role="alert" className="mt-3 text-[0.8125rem] text-text-secondary">{importError}</p>}
      </div>
    </section>
    <p className="mt-3 text-[0.75rem] text-text-secondary">{data ? `${brandRules.length} active ${brandRules.length === 1 ? 'rule' : 'rules'} · ${required} must follow` : error ? 'Rules unavailable' : 'Loading your rules…'}</p>
    <p className="playbook-priority"><span>Briefing</span><ArrowRight size={12} /><span>Brand rules</span><ArrowRight size={12} /><span>Best practice</span><span className="ml-auto hidden sm:inline">In that order.</span></p>
    <div className="mt-8 grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-8">
        {error && <div role="alert" className="playbook-surface p-5 text-[0.9375rem]">Could not load rules. <button type="button" onClick={() => mutate()} className="min-h-11 px-2 font-medium text-accent">Retry</button></div>}
        {!data && !error && <div className="grid gap-4 sm:grid-cols-2" aria-label="Loading rules">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton-shimmer h-56 animate-shimmer rounded-3xl" />)}</div>}
        {!!data?.suggestions.length && <details open={approvalsOpen} onToggle={e => setApprovalsOpen(e.currentTarget.open)} className="playbook-suggestions" aria-label="Suggested rules"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2"><Sparkles size={17} className="text-accent" /><h2 className="text-[1.0625rem] font-semibold">For your approval</h2><span className="ml-auto text-[0.8125rem] text-text-secondary">{data.suggestions.length}</span><ChevronDown size={16} className="text-text-secondary" /></summary><p className="mt-1 text-[0.8125rem] text-text-secondary">Suggestions only. You decide what becomes a rule.</p><ul className="mt-4 divide-y divide-border">{data.suggestions.map(s => <li key={s.id} className="py-4 first:pt-0 last:pb-0"><h3 className="break-words text-[0.9375rem] font-semibold">{s.name || 'Suggested rule'}</h3>{s.what && <p className="mt-2 whitespace-pre-wrap break-words text-[0.875rem] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{s.what}</p>}{s.source === 'owner-comment' && <p className="mt-2 text-[0.75rem] text-text-secondary">From your feedback</p>}<div className="mt-3 flex justify-end gap-2"><button type="button" disabled={!!pending} onClick={() => decide(s.id, 'dismiss')} aria-label={`Dismiss ${s.name || 'suggested rule'}`} className="press min-h-11 rounded-full px-4 text-[0.8125rem] text-text-secondary hover:bg-bg-hover disabled:opacity-50">Dismiss</button><button type="button" disabled={!!pending} onClick={() => decide(s.id, 'accept')} aria-label={`Use rule: ${s.name || 'suggested rule'}`} className="press inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-muted px-4 text-[0.8125rem] font-semibold text-accent disabled:opacity-50"><Check size={15} />{pending === s.id ? 'Saving…' : 'Use rule'}</button></div>{decisionError?.id === s.id && <p role="alert" className="mt-2 text-[0.875rem] text-text-secondary">{decisionError.message}</p>}</li>)}</ul></details>}
        {data && <RuleLibrary rules={brandRules} brandName={brandName} onAdd={() => quickInput.current?.focus()} />}
        {!!houseRules.length && <details className="playbook-surface p-5"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-3"><BookOpen size={18} className="text-text-secondary" /><span className="font-medium">Best practice</span><span className="text-[0.8125rem] text-text-secondary">{houseRules.length}</span><ChevronDown size={16} className="ml-auto" /></summary><p className="mt-1 text-[0.8125rem] text-text-secondary">The baseline beneath your brand rules.</p><ul className="mt-4 divide-y divide-border">{houseRules.map(r => <li key={r.id} className="py-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{r.name}</h3><RuleSeverity rule={r} /></div><p className="mt-2 whitespace-pre-wrap break-words text-[0.875rem] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{r.what}</p></li>)}</ul></details>}
      </div>
      <aside className="playbook-brand-kit min-w-0"><BrandLogo projectId={projectId} brandName={brandName} /><p className="mt-5 px-1 text-[0.8125rem] leading-relaxed text-text-secondary">Add a quick note whenever something changes. Each suggestion comes to you for approval.</p></aside>
    </div>
    <Dialog.Root open={importOpen} onOpenChange={setImportOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" /><Dialog.Content className="owner-sheet playbook-dialog sheet-in"><div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-2xl font-semibold tracking-tight">Import guidelines</Dialog.Title><Dialog.Description className="mt-2 text-[0.9375rem] text-text-secondary">For {brandName}. You approve every suggested rule.</Dialog.Description></div><Dialog.Close aria-label="Close guidelines" className="press grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-bg-hover"><X size={20} /></Dialog.Close></div><div className="mt-6">
      <DropZone compact accept={BRIEFING_ACCEPT} disabled={reading} onFiles={([f]) => { if (f) void read(f) }} title={reading ? 'Reading your guide…' : 'Drop your brand guide'} hint={GUIDELINE_HINT} />
      {reading && <p role="status" className="mt-4 text-[0.875rem] text-text-secondary">Finding the details that matter…</p>}{importError && <p role="alert" className="mt-4 text-[0.875rem] text-text-secondary">{importError}</p>}
    </div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </>
}
