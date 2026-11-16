'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Check, Download, Loader2 } from 'lucide-react'

interface DeliveryFile { name: string; url: string; size_bytes: number; mime_type: string }
interface Delivery {
  title: string; brand: string; version: number; video_url: string | null; files: DeliveryFile[]
  approved_by: string; approved_at: string; live_notes: string[]
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`)

async function load(token: string): Promise<Delivery> {
  const res = await fetch(`${API_URL}/deliveries/${token}`)
  if (!res.ok) throw new Error(String(res.status))
  return res.json()
}

/** Public hand-off page (no login): what was approved, the files, and what to do with them. */
export default function DeliveryPage({ params: { token } }: { params: { token: string } }) {
  const { data, error } = useSWR(`/d/${token}`, () => load(token), { shouldRetryOnError: false, revalidateOnFocus: false })

  if (error) return <main className="grid min-h-dvh place-items-center bg-bg-primary px-4 text-center text-text-primary"><p className="text-base text-text-secondary">This delivery link is not valid anymore.</p></main>
  if (!data) return <main className="grid min-h-dvh place-items-center bg-bg-primary"><Loader2 className="h-6 w-6 animate-spin text-text-tertiary motion-reduce:animate-none" aria-label="Loading" /></main>

  const when = new Date(data.approved_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <main className="min-h-dvh bg-bg-primary px-4 py-8 text-text-primary">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
        <header className="flex flex-col gap-1">
          <p className="text-[13px] font-medium text-text-secondary">{data.brand} · Version {data.version}</p>
          <h1 className="text-[28px] font-semibold leading-[34px]">{data.title}</h1>
        </header>

        {data.video_url && <video src={data.video_url} controls playsInline preload="metadata" className="max-h-[70dvh] w-full rounded-2xl bg-black" aria-label={data.title} />}

        <section aria-label="Downloads" className="flex flex-col gap-2">
          {data.files.map(f => (
            <a key={f.url} href={f.url} download className="press flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-border px-4 hover:bg-bg-hover">
              <span className="min-w-0"><span className="block truncate text-[17px] font-medium">{f.name}</span><span className="text-[13px] text-text-secondary">{size(f.size_bytes)}</span></span>
              <span className="inline-flex shrink-0 items-center gap-2 text-[15px] font-semibold text-accent"><Download size={18} aria-hidden="true" />Download</span>
            </a>
          ))}
        </section>

        <section aria-label="How to use it" className="flex flex-col gap-2">
          <h2 className="text-[17px] font-semibold">How to use it</h2>
          <ol className="flex flex-col gap-2 text-[15px] leading-5 text-text-secondary">
            {data.live_notes.map((n, i) => <li key={i} className="flex gap-3"><span className="w-4 shrink-0 font-semibold text-text-primary">{i + 1}</span>{n}</li>)}
          </ol>
        </section>

        <p className="flex items-center gap-2 text-[13px] text-text-secondary"><Check size={16} className="text-status-success" aria-hidden="true" />Approved by {data.approved_by} on {when}</p>
      </div>
    </main>
  )
}
