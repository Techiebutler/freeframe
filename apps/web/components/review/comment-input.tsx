'use client'

import * as React from 'react'
import {
  Pencil,
  Paperclip,
  X,
  Loader2,
  Send,
  Smile,
  Clock,
  ChevronLeft,
  ChevronDown,
  MousePointer,
  Square,
  Minus,
  RotateCcw,
  Trash2,
  Globe,
  Lock,
} from 'lucide-react'
import { cn, formatTime, formatTimecode, formatFrames } from '@/lib/utils'
import { useReviewStore } from '@/stores/review-store'
import { useDrawing } from '@/hooks/use-drawing'
import { api } from '@/lib/api'
import type { User } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommentInputProps {
  assetId: string
  projectId: string
  assetType?: string
  replyToId?: string | null
  annotationData?: Record<string, unknown> | null
  onSubmit: (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotationData?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ) => Promise<void>
  onCancelReply?: () => void
  className?: string
}

// ─── Drawing tools config ─────────────────────────────────────────────────────

const EMOJIS = [
  '👍', '👎', '❤️', '🔥', '👀', '🎉', '😂', '😮',
  '😢', '💯', '✅', '❌', '⭐', '💡', '🤔', '👏',
]

type DrawingTool = 'pen' | 'rectangle' | 'arrow' | 'line'

const DRAW_TOOLS: { id: DrawingTool; icon: React.ElementType; label: string }[] = [
  { id: 'pen', icon: Pencil, label: 'Pencil' },
  { id: 'arrow', icon: MousePointer, label: 'Arrow' },
  { id: 'line', icon: Minus, label: 'Line' },
  { id: 'rectangle', icon: Square, label: 'Rectangle' },
]

const DRAW_COLORS = [
  '#AF52DE', // purple
  '#FF9500', // orange
  '#34C759', // green
  '#FF3B30', // red
]

// ─── @mention dropdown ────────────────────────────────────────────────────────

function MentionDropdown({
  query,
  projectId,
  onSelect,
}: {
  query: string
  projectId: string
  onSelect: (user: User) => void
  onClose: () => void
}) {
  const [members, setMembers] = React.useState<User[]>([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!projectId) return
    setLoading(true)
    api
      .get<Array<{ user_id: string; role: string }>>(`/projects/${projectId}/members`)
      .then(async (memberList) => {
        if (!memberList || memberList.length === 0) { setMembers([]); return }
        const userIds = memberList.map((m) => m.user_id).join(',')
        const users = await api.get<User[]>(`/users?ids=${userIds}`)
        setMembers(users)
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
    return <div className="py-2 px-4 text-xs text-text-tertiary">No members found</div>
  }

  return (
    <>
      {filtered.map((user) => (
        <button
          key={user.id}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(user)
          }}
        >
          <div className="h-6 w-6 rounded-full bg-accent flex items-center justify-center text-[10px] text-text-primary font-semibold shrink-0">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="font-medium truncate text-[13px]">{user.name}</div>
            <div className="text-[11px] text-text-tertiary truncate">{user.email}</div>
          </div>
        </button>
      ))}
    </>
  )
}

// ─── Comment input component (Frame.io style) ───────────────────────────────

export function CommentInput({
  assetId,
  projectId,
  assetType,
  replyToId,
  annotationData,
  onSubmit,
  onCancelReply,
  className,
}: CommentInputProps) {
  const {
    isDrawingMode,
    drawingTool,
    drawingColor,
    playheadTime,
    timeFormat,
    pendingAnnotation,
    toggleDrawingMode,
    setDrawingTool,
    setDrawingColor,
    setPendingAnnotation,
  } = useReviewStore()

  const { clear, undo, getJSON } = useDrawing()

  const [body, setBody] = React.useState('')
  const [mentionUserIds, setMentionUserIds] = React.useState<string[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [commentVisibility, setCommentVisibility] = React.useState<'public' | 'internal'>('public')
  const [visDropdownOpen, setVisDropdownOpen] = React.useState(false)
  const [timecodeAttached, setTimecodeAttached] = React.useState(true)
  const visRef = React.useRef<HTMLDivElement>(null)

  // Emoji picker state
  const [emojiOpen, setEmojiOpen] = React.useState(false)

  // Mention state
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null)
  const [mentionStart, setMentionStart] = React.useState<number>(0)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  // Close dropdowns on outside click
  React.useEffect(() => {
    if (!visDropdownOpen && !emojiOpen) return
    function handleClick(e: MouseEvent) {
      if (visDropdownOpen && visRef.current && !visRef.current.contains(e.target as Node)) setVisDropdownOpen(false)
      if (emojiOpen) setEmojiOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [visDropdownOpen, emojiOpen])

  const canAnnotate = assetType !== 'audio'
  const hasTimecode = assetType === 'video' || assetType === 'audio'

  function displayTime(seconds: number): string {
    switch (timeFormat) {
      case 'frames': return formatFrames(seconds)
      case 'standard': return formatTime(seconds)
      case 'timecode': return formatTimecode(seconds)
      default: return formatTimecode(seconds)
    }
  }
  const hasAnnotation = !!(annotationData && Object.keys(annotationData).length > 0) || !!(pendingAnnotation && (pendingAnnotation as any)?.objects?.length > 0)

  // Capture canvas state synchronously before exiting drawing mode
  function exitDrawingMode() {
    if (isDrawingMode) {
      try {
        const json = getJSON()
        const objs = (json as any)?.objects
        if (objs && Array.isArray(objs) && objs.length > 0) {
          setPendingAnnotation(json)
        }
      } catch { /* canvas may not be ready */ }
    }
    toggleDrawingMode()
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setBody(value)

    const cursor = e.target.selectionStart ?? value.length
    const textBeforeCursor = value.slice(0, cursor)
    const atIdx = textBeforeCursor.lastIndexOf('@')

    if (atIdx !== -1) {
      const afterAt = textBeforeCursor.slice(atIdx + 1)
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
    setBody(`${before}@${user.name} ${after}`)
    setMentionUserIds((prev) => prev.includes(user.id) ? prev : [...prev, user.id])
    setMentionQuery(null)
    textareaRef.current?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') setMentionQuery(null)
    if (e.key === 'Enter' && !e.shiftKey) {
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
      // Grab canvas state: try live canvas first, then store, then prop
      let finalAnnotation: Record<string, unknown> | undefined = undefined

      if (isDrawingMode) {
        try {
          const json = getJSON()
          const objects = (json as any)?.objects
          if (objects && Array.isArray(objects) && objects.length > 0) {
            finalAnnotation = json
          }
        } catch { /* canvas may not exist */ }
        exitDrawingMode()
      } else {
        try {
          const json = getJSON()
          const objects = (json as any)?.objects
          if (objects && Array.isArray(objects) && objects.length > 0) {
            finalAnnotation = json
          }
        } catch { /* canvas may not exist */ }
      }

      if (!finalAnnotation && pendingAnnotation) {
        const objs = (pendingAnnotation as any)?.objects
        if (objs && Array.isArray(objs) && objs.length > 0) {
          finalAnnotation = pendingAnnotation
        }
      }

      if (!finalAnnotation && annotationData) {
        finalAnnotation = annotationData
      }

      await onSubmit(
        trimmed,
        hasTimecode && timecodeAttached && playheadTime > 0 ? playheadTime : undefined,
        undefined,
        finalAnnotation,
        replyToId ?? undefined,
        commentVisibility,
        mentionUserIds.length > 0 ? mentionUserIds : undefined,
      )

      setBody('')
      setMentionUserIds([])
      setPendingAnnotation(null)
      if (replyToId && onCancelReply) onCancelReply()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={cn('border-t border-border bg-bg-secondary shrink-0', className)}>
      {/* Reply indicator */}
      {replyToId && (
        <div className="flex items-center justify-between px-4 py-2 bg-accent/5 border-b border-accent/10 text-xs text-accent">
          <span>Replying to comment</span>
          <button className="text-text-tertiary hover:text-text-primary" onClick={onCancelReply}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Input area */}
      <div className="px-4 pt-3 pb-2">
        <div className="relative">
          <div className="flex items-start gap-0 rounded-lg border border-border bg-bg-tertiary focus-within:border-accent/50 focus-within:ring-1 focus-within:ring-accent/20">
            {/* Inline timecode badge — show when timecode attached (normal mode) or in drawing mode */}
            {hasTimecode && (timecodeAttached || isDrawingMode) && (
              <span className="shrink-0 ml-2.5 mt-[9px] rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[11px] text-amber-400 leading-none select-none">
                {displayTime(playheadTime)}
              </span>
            )}
            <textarea
              ref={textareaRef}
              className="flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none min-h-[38px] max-h-[120px]"
              placeholder={replyToId ? 'Write a reply...' : 'Leave your comment...'}
              value={body}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />
          </div>

          {/* Mention dropdown */}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-0 right-0 mb-1 z-50 rounded-lg border border-border bg-bg-elevated shadow-xl max-h-48 overflow-y-auto">
              <MentionDropdown
                query={mentionQuery}
                projectId={projectId}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
              />
            </div>
          )}
        </div>

        {error && <p className="mt-1.5 text-xs text-red-400">{error}</p>}
      </div>

      {/* Bottom toolbar */}
      <div className="px-4 pb-3">
        {canAnnotate && isDrawingMode ? (
          /* ─── Drawing toolbar ─── */
          <div className="flex items-center gap-1">
            <button
              onClick={() => exitDrawingMode()}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
              title="Exit drawing"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            {DRAW_TOOLS.map((tool) => {
              const Icon = tool.icon
              return (
                <button
                  key={tool.id}
                  onClick={() => setDrawingTool(tool.id as DrawingTool)}
                  title={tool.label}
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                    drawingTool === tool.id
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              )
            })}

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            {DRAW_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setDrawingColor(color)}
                className={cn(
                  'w-5 h-5 rounded-full transition-all shrink-0',
                  drawingColor === color
                    ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-secondary'
                    : 'hover:scale-110',
                )}
                style={{ backgroundColor: color }}
              />
            ))}

            <div className="w-px h-4 bg-white/10 mx-0.5" />

            <button
              onClick={undo}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
              title="Undo"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={clear}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
              title="Clear"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          /* ─── Default toolbar (Frame.io style) ─── */
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {/* Timecode attach toggle — for video/audio */}
              {hasTimecode && (
                <button
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                    timecodeAttached
                      ? 'text-amber-400 bg-amber-400/10'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary',
                  )}
                  onClick={() => setTimecodeAttached((p) => !p)}
                  title={timecodeAttached ? 'Detach timecode' : 'Attach timecode'}
                >
                  <Clock className="h-4 w-4" />
                </button>
              )}

              {/* Draw annotation — hidden for audio */}
              {canAnnotate && (
                <button
                  className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
                    hasAnnotation
                      ? 'text-accent bg-accent/10'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary',
                  )}
                  onClick={() => toggleDrawingMode()}
                  title="Draw annotation"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}

              {/* Emoji */}
              <div className="relative">
                <button
                  className="h-7 w-7 flex items-center justify-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary transition-colors"
                  title="Add emoji"
                  onClick={() => setEmojiOpen((p) => !p)}
                >
                  <Smile className="h-4 w-4" />
                </button>
                {emojiOpen && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 rounded-lg border border-border bg-bg-elevated shadow-2xl p-1.5 animate-in fade-in zoom-in-95 duration-100 w-[200px]">
                    <div className="grid grid-cols-8 gap-px">
                      {EMOJIS.map((e) => (
                        <button
                          key={e}
                          className="h-6 w-6 rounded flex items-center justify-center text-sm hover:bg-bg-hover transition-colors"
                          onClick={() => {
                            setBody((prev) => prev + e)
                            setEmojiOpen(false)
                            textareaRef.current?.focus()
                          }}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

            </div>

            <div className="flex items-center gap-2">
              {/* Visibility dropdown */}
              <div className="relative" ref={visRef}>
                <button
                  onClick={() => setVisDropdownOpen((p) => !p)}
                  className={cn(
                    'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] transition-colors border',
                    commentVisibility === 'internal'
                      ? 'text-amber-400 border-amber-400/30 bg-amber-400/10'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary border-border',
                  )}
                >
                  {commentVisibility === 'internal' ? <Lock className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
                  {commentVisibility === 'internal' ? 'Internal' : 'Public'}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {visDropdownOpen && (
                  <div className="absolute bottom-full right-0 mb-1 z-50 w-44 rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 animate-in fade-in zoom-in-95 duration-100">
                    <button
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-[13px] transition-colors',
                        commentVisibility === 'public' ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:bg-bg-tertiary',
                      )}
                      onClick={() => { setCommentVisibility('public'); setVisDropdownOpen(false) }}
                    >
                      <Globe className="h-3.5 w-3.5" />
                      Public
                    </button>
                    <button
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-[13px] transition-colors',
                        commentVisibility === 'internal' ? 'text-amber-400 bg-bg-tertiary' : 'text-text-secondary hover:bg-bg-tertiary',
                      )}
                      onClick={() => { setCommentVisibility('internal'); setVisDropdownOpen(false) }}
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Internal
                    </button>
                  </div>
                )}
              </div>

              {/* Submit */}
              <button
                onClick={handleSubmit}
                disabled={!body.trim() || submitting}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent text-text-primary hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Send (Enter)"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
