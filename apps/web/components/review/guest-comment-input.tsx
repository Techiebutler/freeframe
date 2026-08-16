'use client'

import * as React from 'react'
import { Send, User, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GuestIdentity {
  email: string
  name: string
}

const STORAGE_KEY = 'freeframe_guest_identity'

function loadIdentity(): GuestIdentity | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as GuestIdentity
  } catch {
    return null
  }
}

function saveIdentity(identity: GuestIdentity) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
}

function clearIdentity() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(STORAGE_KEY)
}

// ─── Identity form ────────────────────────────────────────────────────────────

interface IdentityFormProps {
  onIdentified: (identity: GuestIdentity) => void
}

function IdentityForm({ onIdentified }: IdentityFormProps) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !email.trim()) {
      setError('Both name and email are required.')
      return
    }
    if (!/\S+@\S+\.\S+/.test(email.trim())) {
      setError('Please enter a valid email address.')
      return
    }
    const identity: GuestIdentity = { name: name.trim(), email: email.trim() }
    saveIdentity(identity)
    onIdentified(identity)
  }

  return (
    <div className="border-t border-border bg-bg-primary px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-muted">
          <User className="h-3.5 w-3.5 text-accent" />
        </div>
        <p className="text-sm font-medium text-text-primary">Who are you?</p>
      </div>
      <p className="mb-3 text-xs text-text-tertiary">
        Enter your name and email to leave a comment. No account required.
      </p>

      <form onSubmit={handleSubmit} className="space-y-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          required
          className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="flex h-9 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
        />

        {error && <p className="text-xs text-status-error">{error}</p>}

        <Button type="submit" size="sm" className="w-full">
          Continue to comment
        </Button>
      </form>
    </div>
  )
}

// ─── Guest Comment Input ───────────────────────────────────────────────────────

interface GuestCommentInputProps {
  /** The share token for this public link */
  token: string
  /** Called after a comment is successfully submitted */
  onCommentPosted?: () => void
  className?: string
  /** Session token from password verification (POST /share/{token}/verify) */
  shareSession?: string | null
}

export function GuestCommentInput({ token, onCommentPosted, className, shareSession }: GuestCommentInputProps) {
  const [identity, setIdentity] = React.useState<GuestIdentity | null>(null)
  const [body, setBody] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState(false)

  // Load identity from localStorage on mount
  React.useEffect(() => {
    setIdentity(loadIdentity())
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  async function handleSubmit() {
    const trimmed = body.trim()
    if (!trimmed || !identity) return

    setSubmitting(true)
    setError(null)
    setSuccess(false)

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
      const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
      const response = await fetch(`${API_URL}/share/${token}/comment?_=1${sp}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: trimmed,
          guest_email: identity.email,
          guest_name: identity.name,
        }),
      })

      if (!response.ok) {
        let detail = response.statusText
        try {
          const err = await response.json()
          if (err?.detail) detail = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)
        } catch {
          // ignore
        }
        throw new Error(detail)
      }

      setBody('')
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
      onCommentPosted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment')
    } finally {
      setSubmitting(false)
    }
  }

  // Not yet identified — show identity prompt
  if (!identity) {
    return <IdentityForm onIdentified={setIdentity} />
  }

  return (
    <div className={cn('border-t border-border bg-bg-primary px-4 py-3', className)}>
      {/* Identity badge */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-muted text-accent text-2xs font-medium">
            {identity.name.charAt(0).toUpperCase()}
          </div>
          <span>
            Commenting as <span className="font-medium text-text-primary">{identity.name}</span>
          </span>
        </div>
        <button
          onClick={() => {
            clearIdentity()
            setIdentity(null)
          }}
          className="text-2xs text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-0.5"
          title="Change identity"
        >
          <X className="h-3 w-3" />
          Change
        </button>
      </div>

      {/* Textarea */}
      <textarea
        className="w-full resize-none rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus min-h-[72px]"
        placeholder="Leave a comment… (⌘+Enter to submit)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        disabled={submitting}
      />

      {/* Error / success */}
      {error && <p className="mt-1 text-xs text-status-error">{error}</p>}
      {success && <p className="mt-1 text-xs text-status-success">Comment posted!</p>}

      {/* Submit */}
      <div className="mt-2 flex items-center justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!body.trim() || submitting}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Comment
        </Button>
      </div>
    </div>
  )
}
