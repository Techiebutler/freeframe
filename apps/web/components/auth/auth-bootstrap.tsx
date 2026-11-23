'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { bootstrapSession, refreshAccessTokenQuietly } from '@/lib/auth'
import { usesRefreshCookie } from '@/lib/auth-transport'
import { withBasePath } from '@/lib/base-path'

/** Do not start protected requests until the browser has tried its cookie. */
export function AuthBootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'pending' | 'ready' | 'unavailable'>('pending')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!usesRefreshCookie()) {
      setState('ready')
      return
    }
    let active = true
    const pending = attempt ? refreshAccessTokenQuietly() : bootstrapSession()
    void pending.then((outcome) => {
      if (!active) return
      if ('token' in outcome) setState('ready')
      else if (outcome.failed === 'transient') setState('unavailable')
      else {
        const { pathname, search } = window.location
        window.location.replace(withBasePath(`/login?from=${encodeURIComponent(pathname + search)}`))
      }
    })
    return () => { active = false }
  }, [attempt])

  if (state === 'unavailable') {
    return <div className="p-6" role="alert">
      Could not restore your session.{' '}
      <button className="underline" onClick={() => setAttempt(value => value + 1)}>Try again</button>
    </div>
  }
  if (state !== 'ready') return <p className="p-6" role="status">Restoring your session…</p>
  return children
}
