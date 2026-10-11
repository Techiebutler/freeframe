'use client'

import * as React from 'react'
import { getAccessToken, refreshAccessToken } from '@/lib/auth'

// ─── Event payload types ──────────────────────────────────────────────────────

export interface TranscodeProgressEvent {
  asset_id: string
  percent: number
}

export interface TranscodeCompleteEvent {
  asset_id: string
  version_id: string
}

export interface TranscodeFailedEvent {
  asset_id: string
  error: string
}

export interface NewCommentEvent {
  asset_id: string
  comment_id: string
  author: string
}

export interface CommentResolvedEvent {
  comment_id: string
}

export interface ApprovalUpdatedEvent {
  asset_id: string
  user_id: string
  status: string
}

export type SSEEventType =
  | 'transcode_progress'
  | 'transcode_complete'
  | 'transcode_failed'
  | 'new_comment'
  | 'comment_resolved'
  | 'approval_updated'

export interface SSEEvent {
  type: SSEEventType
  data:
    | TranscodeProgressEvent
    | TranscodeCompleteEvent
    | TranscodeFailedEvent
    | NewCommentEvent
    | CommentResolvedEvent
    | ApprovalUpdatedEvent
}

// ─── Hook options ─────────────────────────────────────────────────────────────

export interface UseSSEOptions {
  onTranscodeProgress?: (data: TranscodeProgressEvent) => void
  onTranscodeComplete?: (data: TranscodeCompleteEvent) => void
  onTranscodeFailed?: (data: TranscodeFailedEvent) => void
  onNewComment?: (data: NewCommentEvent) => void
  onCommentResolved?: (data: CommentResolvedEvent) => void
  onApprovalUpdated?: (data: ApprovalUpdatedEvent) => void
  enabled?: boolean
}

export interface UseSSEReturn {
  isConnected: boolean
  lastEvent: SSEEvent | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000]
// Refresh a token this close to expiry before connecting with it, rather than
// open a stream the server is about to end.
const EXPIRY_SKEW_MS = 10_000

// The server re-checks access for as long as a stream is open and ends it with
// a final `revoked` event once the subscriber may no longer see the project.
// These two reasons are about the token, so a fresh one may reconnect; any
// other reason means access itself was taken away.
const TOKEN_REASONS = new Set(['token_expired', 'token_revoked'])

function isExpiringSoon(token: string): boolean {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(part)) as { exp?: number }
    return typeof exp === 'number' && exp * 1000 <= Date.now() + EXPIRY_SKEW_MS
  } catch {
    return false // not ours to judge; the server will answer
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSSE(projectId: string | null | undefined, options: UseSSEOptions = {}): UseSSEReturn {
  const {
    onTranscodeProgress,
    onTranscodeComplete,
    onTranscodeFailed,
    onNewComment,
    onCommentResolved,
    onApprovalUpdated,
    enabled = true,
  } = options

  const [isConnected, setIsConnected] = React.useState(false)
  const [lastEvent, setLastEvent] = React.useState<SSEEvent | null>(null)

  // Stable callback refs so reconnects don't need to re-register handlers
  const callbackRefs = React.useRef({
    onTranscodeProgress,
    onTranscodeComplete,
    onTranscodeFailed,
    onNewComment,
    onCommentResolved,
    onApprovalUpdated,
  })

  React.useEffect(() => {
    callbackRefs.current = {
      onTranscodeProgress,
      onTranscodeComplete,
      onTranscodeFailed,
      onNewComment,
      onCommentResolved,
      onApprovalUpdated,
    }
  })

  React.useEffect(() => {
    if (!enabled || !projectId) return

    let es: EventSource | null = null
    let retryIndex = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let destroyed = false
    // The token the server last refused; it must not be offered again.
    let rejectedToken: string | null = null

    function scheduleReconnect() {
      // Exponential backoff reconnect
      const delay = BACKOFF_STEPS[Math.min(retryIndex, BACKOFF_STEPS.length - 1)]
      retryIndex++
      retryTimer = setTimeout(connect, delay)
    }

    async function connect() {
      if (destroyed) return

      let token = getAccessToken()
      if (token && (token === rejectedToken || isExpiringSoon(token))) {
        // A refused refresh signs the user out (lib/auth); a failed one
        // returns null and we try again later.
        token = await refreshAccessToken()
        if (destroyed) return
        if (!token) {
          scheduleReconnect()
          return
        }
      }
      const usedToken = token
      // Use window.location.origin as a base so deployments behind a reverse
      // proxy can set NEXT_PUBLIC_API_URL to a relative path like "/api"
      // without crashing the URL constructor.
      const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
      const url = new URL(`${API_URL}/events/${projectId}`, base)
      if (token) {
        url.searchParams.set('token', token)
      }

      es = new EventSource(url.toString())

      es.onopen = () => {
        if (destroyed) return
        setIsConnected(true)
        retryIndex = 0 // reset backoff on successful connection
      }

      es.onerror = () => {
        if (destroyed) return
        setIsConnected(false)
        es?.close()
        es = null
        scheduleReconnect()
      }

      // ── revoked: the server is ending this stream ──
      es.addEventListener('revoked', (e: MessageEvent) => {
        if (destroyed) return
        let reason = ''
        try {
          reason = (JSON.parse(e.data) as { reason?: string }).reason ?? ''
        } catch {
          // treat as access revoked
        }
        setIsConnected(false)
        es?.close()
        es = null
        if (TOKEN_REASONS.has(reason)) {
          rejectedToken = usedToken
          scheduleReconnect()
        } else {
          // No longer allowed to see this project: reconnecting would only be
          // refused, again and again, for as long as the tab stays open.
          destroyed = true
        }
      })

      // ── transcode_progress ──
      es.addEventListener('transcode_progress', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeProgressEvent
          const event: SSEEvent = { type: 'transcode_progress', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeProgress?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcode_complete ──
      es.addEventListener('transcode_complete', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeCompleteEvent
          const event: SSEEvent = { type: 'transcode_complete', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeComplete?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── transcode_failed ──
      es.addEventListener('transcode_failed', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as TranscodeFailedEvent
          const event: SSEEvent = { type: 'transcode_failed', data }
          setLastEvent(event)
          callbackRefs.current.onTranscodeFailed?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── new_comment ──
      es.addEventListener('new_comment', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as NewCommentEvent
          const event: SSEEvent = { type: 'new_comment', data }
          setLastEvent(event)
          callbackRefs.current.onNewComment?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── comment_resolved ──
      es.addEventListener('comment_resolved', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as CommentResolvedEvent
          const event: SSEEvent = { type: 'comment_resolved', data }
          setLastEvent(event)
          callbackRefs.current.onCommentResolved?.(data)
        } catch {
          // ignore malformed events
        }
      })

      // ── approval_updated ──
      es.addEventListener('approval_updated', (e: MessageEvent) => {
        if (destroyed) return
        try {
          const data = JSON.parse(e.data) as ApprovalUpdatedEvent
          const event: SSEEvent = { type: 'approval_updated', data }
          setLastEvent(event)
          callbackRefs.current.onApprovalUpdated?.(data)
        } catch {
          // ignore malformed events
        }
      })
    }

    void connect()

    return () => {
      destroyed = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      es?.close()
      setIsConnected(false)
    }
  }, [projectId, enabled])

  return { isConnected, lastEvent }
}
