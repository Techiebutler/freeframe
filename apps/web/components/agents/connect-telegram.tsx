'use client'

import * as React from 'react'
import { Check, Loader2, Send } from 'lucide-react'
import { linkTelegram } from '@/lib/agents'

export function ConnectTelegram({ connected = false }: { connected?: boolean }) {
  const [busy, setBusy] = React.useState(false)
  const [url, setUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState('')

  const connect = async () => {
    setBusy(true); setError('')
    try {
      const { url: link } = await linkTelegram()
      setUrl(link)
      window.open(link, '_blank', 'noopener,noreferrer')
    } catch { setError('Could not start the link. Try again.') }
    finally { setBusy(false) }
  }

  return (
    <section aria-labelledby="telegram-h" className="flex items-start gap-3 rounded-lg border border-border bg-bg-secondary p-4">
      <Send className="mt-0.5 h-5 w-5 text-text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id="telegram-h" className="text-sm font-medium text-text-primary">Telegram</h3>
        <p className="mt-1 text-xs text-text-tertiary">Get a message with a review link when files are ready.</p>
        {connected && !url ? (
          <p className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-status-success"><Check size={14} aria-hidden="true" />Connected</p>
        ) : (
          <button type="button" onClick={connect} disabled={busy}
            className="press mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-text-inverse hover:bg-accent-hover disabled:opacity-60">
            {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />}{connected ? 'Reconnect Telegram' : 'Connect Telegram'}
          </button>
        )}
        {url && <p role="status" className="mt-2 text-xs text-text-secondary">Telegram should open. Tap Start there. If nothing opened, <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-text-primary underline">open Telegram</a>.</p>}
        {error && <p role="alert" className="mt-2 text-xs text-status-error">{error}</p>}
      </div>
    </section>
  )
}
