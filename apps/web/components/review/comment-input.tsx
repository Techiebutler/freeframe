'use client'

import * as React from 'react'
import {
  Pencil,
  Paperclip,
  Clock,
  AlignLeft,
  ChevronDown,
  X,
  Loader2,
  Globe,
  Send,
  Smile,
} from 'lucide-react'
import { cn, formatTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useReviewStore } from '@/stores/review-store'
import { api } from '@/lib/api'
import type { User } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type CommentMode = 'general' | 'timecode' | 'range'

interface CommentInputProps {
  assetId: string
  projectId: string
  /** If set, this is a reply — show reply indicator */
  replyToId?: string | null
  /** Annotation drawing data from canvas */
  annotationData?: Record<string, unknown> | null
  onSubmit: (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotationData?: Record<string, unknown>,
    parentId?: string,
  ) => Promise<void>
  onCancelReply?: () => void
  className?: string
}

// ─── @mention dropdown ────────────────────────────────────────────────────────

interface MentionDropdownProps {
  query: string
  projectId: string
  onSelect: (user: User) => void
  onClose: () => void
}

function MentionDropdown({ query, projectId, onSelect, onClose }: MentionDropdownProps) {
  const [members, setMembers] = React.useState<User[]>([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!projectId) return
    setLoading(true)
    api
      .get<{ members: Array<{ user: User }> }>(`/projects/${projectId}/members`)
      .then((res) => {
        setMembers(res.members.map((m) => m.user))
      })
      .catch(() => setMembers([]))
      .finally(() => setLoading(false))
  }, [projectId])

  const filtered = members.filter(
    (u) =>
      u.name.toLowerCase().includes(query.toLowerCase()) ||
      u.email.toLowerCase().includes(query.toLowerCase()),
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-3 px-4">
        <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="py-2 px-4 text-xs text-text-tertiary">No members found</div>
    )
  }

  return (
    <>
      {filtered.map((user) => (
        <button
          key={user.id}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-bg-hover transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(user)
          }}
        >
          <div className="h-6 w-6 rounded-full bg-accent-muted flex items-center justify-center text-2xs text-accent font-medium shrink-0">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="font-medium truncate">{user.name}</div>
            <div className="text-2xs text-text-tertiary truncate">{user.email}</div>
          </div>
        </button>
      ))}
    </>
  )
}

// ─── Comment input component ──────────────────────────────────────────────────

export function CommentInput({
  assetId,
  projectId,
  replyToId,
  annotationData,
  onSubmit,
  onCancelReply,
  className,
}: CommentInputProps) {
  const playheadTime = useReviewStore((s) => s.playheadTime)
  const isDrawingMode = useReviewStore((s) => s.isDrawingMode)
  const toggleDrawingMode = useReviewStore((s) => s.toggleDrawingMode)

  const [body, setBody] = React.useState('')
  const [mode, setMode] = React.useState<CommentMode>('general')
  const [rangeStart, setRangeStart] = React.useState<string>('')
  const [rangeEnd, setRangeEnd] = React.useState<string>('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Mention state
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null)
  const [mentionStart, setMentionStart] = React.useState<number>(0)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Attachment state (for after comment is created)
  const [attachmentFile, setAttachmentFile] = React.useState<File | null>(null)

  // Detect @ trigger
  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setBody(value)

    const cursor = e.target.selectionStart ?? value.length
    // Find last @ before cursor
    const textBeforeCursor = value.slice(0, cursor)
    const atIdx = textBeforeCursor.lastIndexOf('@')

    if (atIdx !== -1) {
      const afterAt = textBeforeCursor.slice(atIdx + 1)
      // Only trigger if no spaces after @
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionQuery(afterAt)
        setMentionStart(atIdx)
        return
      }
    }
    setMentionQuery(null)
  }

  function handleMentionSelect(user: User) {
    const before = body.slice(0, mentionStart)
    const after = body.slice(mentionStart + 1 + (mentionQuery?.length ?? 0))
    const newBody = `${before}@${user.name} ${after}`
    setBody(newBody)
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  // Auto-grow textarea
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      setMentionQuery(null)
    }
    // Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  async function handleSubmit() {
    const trimmed = body.trim()
    if (!trimmed) return

    setSubmitting(true)
    setError(null)

    try {
      let timecodeStart: number | undefined
      let timecodeEnd: number | undefined

      if (mode === 'timecode') {
        timecodeStart = playheadTime
      } else if (mode === 'range') {
        const start = parseFloat(rangeStart)
        const end = parseFloat(rangeEnd)
        if (!isNaN(start)) timecodeStart = start
        if (!isNaN(end)) timecodeEnd = end
      }

      await onSubmit(
        trimmed,
        timecodeStart,
        timecodeEnd,
        annotationData ?? undefined,
        replyToId ?? undefined,
      )

      // Reset
      setBody('')
      setRangeStart('')
      setRangeEnd('')
      setAttachmentFile(null)
      if (replyToId && onCancelReply) onCancelReply()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment')
    } finally {
      setSubmitting(false)
    }
  }

  const modeOptions: Array<{ value: CommentMode; label: string; icon: React.ReactNode }> = [
    { value: 'general', label: 'General', icon: <AlignLeft className="h-3.5 w-3.5" /> },
    { value: 'timecode', label: 'Timecode', icon: <Clock className="h-3.5 w-3.5" /> },
    { value: 'range', label: 'Range', icon: <Clock className="h-3.5 w-3.5" /> },
  ]

  return (
    <div className={cn('border-t border-border bg-bg-secondary/50 px-4 py-3', className)}>
      {/* Reply indicator */}
      {replyToId && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          <span>Replying to comment…</span>
          <button
            className="text-text-tertiary hover:text-text-primary transition-colors"
            onClick={onCancelReply}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Annotation indicator */}
      {annotationData && Object.keys(annotationData).length > 0 && (
        <div className="mb-2 flex items-center gap-1.5 rounded-lg bg-accent/10 border border-accent/20 px-3 py-2 text-xs text-accent">
          <Pencil className="h-3 w-3" />
          Annotation attached
        </div>
      )}

      {/* Frame.io-style timecode badge + input row */}
      <div className="flex items-start gap-2">
        {/* Timecode badge (Frame.io style) */}
        {mode === 'timecode' && (
          <div className="shrink-0 rounded bg-amber-500/90 px-2 py-1.5 font-mono text-xs font-medium text-black">
            {formatTime(playheadTime)}
          </div>
        )}
        {mode === 'range' && (
          <div className="shrink-0 flex items-center gap-1 rounded bg-amber-500/90 px-2 py-1.5 font-mono text-xs font-medium text-black">
            <input
              type="text"
              placeholder="0:00"
              value={rangeStart}
              onChange={(e) => setRangeStart(e.target.value)}
              className="w-10 bg-transparent text-center placeholder:text-black/50 focus:outline-none"
            />
            <span>—</span>
            <input
              type="text"
              placeholder="0:00"
              value={rangeEnd}
              onChange={(e) => setRangeEnd(e.target.value)}
              className="w-10 bg-transparent text-center placeholder:text-black/50 focus:outline-none"
            />
          </div>
        )}

        {/* Textarea - grows to fill */}
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            className="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 min-h-[44px]"
            placeholder={replyToId ? 'Write a reply…' : 'Leave your comment...'}
            value={body}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            rows={1}
          />

          {/* Mention dropdown */}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-border bg-bg-elevated shadow-lg max-h-48 overflow-y-auto animate-scale-in">
              <MentionDropdown
                query={mentionQuery}
                projectId={projectId}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Attachment file preview */}
      {attachmentFile && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          <Paperclip className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate flex-1">{attachmentFile.name}</span>
          <button
            className="text-text-tertiary hover:text-status-error transition-colors"
            onClick={() => {
              setAttachmentFile(null)
              if (fileInputRef.current) fileInputRef.current.value = ''
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="mt-2 text-xs text-status-error">{error}</p>
      )}

      {/* Bottom toolbar - Frame.io style */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {/* Emoji */}
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
            title="Add emoji"
          >
            <Smile className="h-4 w-4" />
          </button>

          {/* Draw toggle */}
          <button
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              isDrawingMode
                ? 'bg-accent text-white'
                : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary',
            )}
            onClick={toggleDrawingMode}
            title="Toggle drawing mode"
          >
            <Pencil className="h-4 w-4" />
          </button>

          {/* Attachment */}
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) setAttachmentFile(file)
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Visibility toggle - Frame.io style */}
          <button className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover transition-colors">
            <Globe className="h-3.5 w-3.5" />
            Public
            <ChevronDown className="h-3 w-3" />
          </button>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!body.trim() || submitting}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Send comment"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Mode selector - moved to bottom as subtle tabs */}
      <div className="mt-3 pt-3 border-t border-border flex items-center gap-1">
        {modeOptions.map((opt) => (
          <button
            key={opt.value}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors',
              mode === opt.value
                ? 'bg-accent/10 text-accent border border-accent/20'
                : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary',
            )}
            onClick={() => setMode(opt.value)}
          >
            {opt.icon}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
