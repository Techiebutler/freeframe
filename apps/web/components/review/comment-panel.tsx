'use client'

import * as React from 'react'
import {
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Smile,
} from 'lucide-react'
import { cn, formatTime, formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { useReviewStore } from '@/stores/review-store'
import type { CommentWithReplies } from '@/hooks/use-comments'

// ─── Props ────────────────────────────────────────────────────────────────────

interface CommentPanelProps {
  comments: CommentWithReplies[]
  isLoading?: boolean
  currentUserId?: string
  onResolve: (commentId: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onAddReaction: (commentId: string, emoji: string) => Promise<void>
  onRemoveReaction: (commentId: string, emoji: string) => Promise<void>
  onReply: (parentId: string) => void
  className?: string
}

// ─── Emoji picker (minimal inline) ───────────────────────────────────────────

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥']

// ─── Annotation thumbnail ─────────────────────────────────────────────────────

function AnnotationThumbnail({ drawingData }: { drawingData: Record<string, unknown> }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !drawingData) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Render a simple preview dot to indicate annotation exists
    ctx.fillStyle = 'rgba(255, 59, 48, 0.3)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(255, 59, 48, 0.8)'
    ctx.font = '10px sans-serif'
    ctx.fillText('✏️', 4, 14)
  }, [drawingData])

  return (
    <canvas
      ref={canvasRef}
      width={48}
      height={32}
      className="rounded border border-border bg-bg-secondary"
      title="Annotation preview"
    />
  )
}

// ─── Single comment item ──────────────────────────────────────────────────────

interface CommentItemProps {
  comment: CommentWithReplies
  depth?: number
  currentUserId?: string
  onResolve: (commentId: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onAddReaction: (commentId: string, emoji: string) => Promise<void>
  onRemoveReaction: (commentId: string, emoji: string) => Promise<void>
  onReply: (parentId: string) => void
}

function CommentItem({
  comment,
  depth = 0,
  currentUserId,
  onResolve,
  onDelete,
  onAddReaction,
  onRemoveReaction,
  onReply,
}: CommentItemProps) {
  const setPlayheadTime = useReviewStore((s) => s.setPlayheadTime)
  const [showReplies, setShowReplies] = React.useState(true)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const [resolving, setResolving] = React.useState(false)

  const authorName =
    comment.author?.name ?? comment.guest_author?.name ?? 'Unknown'
  const authorAvatar = comment.author?.avatar_url ?? null
  const isOwn = currentUserId && comment.author_id === currentUserId

  // Group reactions by emoji
  const reactionGroups = React.useMemo(() => {
    const groups: Record<string, { emoji: string; count: number; userReacted: boolean }> = {}
    for (const r of comment.reactions ?? []) {
      if (!groups[r.emoji]) {
        groups[r.emoji] = { emoji: r.emoji, count: 0, userReacted: false }
      }
      groups[r.emoji].count++
      if (r.user_id === currentUserId) groups[r.emoji].userReacted = true
    }
    return Object.values(groups)
  }, [comment.reactions, currentUserId])

  async function handleResolve() {
    setResolving(true)
    try {
      await onResolve(comment.id)
    } finally {
      setResolving(false)
    }
  }

  async function handleReactionClick(emoji: string, userReacted: boolean) {
    if (userReacted) {
      await onRemoveReaction(comment.id, emoji)
    } else {
      await onAddReaction(comment.id, emoji)
    }
  }

  async function handleQuickEmoji(emoji: string) {
    setShowEmojiPicker(false)
    const existing = reactionGroups.find((r) => r.emoji === emoji)
    if (existing?.userReacted) {
      await onRemoveReaction(comment.id, emoji)
    } else {
      await onAddReaction(comment.id, emoji)
    }
  }

  return (
    <div
      className={cn(
        'group relative',
        depth > 0 && 'ml-8 border-l border-border-secondary pl-4',
        comment.resolved && 'opacity-60',
      )}
    >
      <div className="flex gap-3 py-3 animate-fade-in">
        {/* Avatar */}
        <Avatar src={authorAvatar} name={authorName} size="sm" className="mt-0.5 shrink-0" />

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary">{authorName}</span>
            {comment.guest_author && (
              <span className="text-2xs text-text-tertiary">(guest)</span>
            )}
            <span className="text-2xs text-text-tertiary">
              {formatRelativeTime(comment.created_at)}
            </span>
            {comment.resolved && (
              <span className="inline-flex items-center gap-1 text-2xs text-status-success">
                <CheckCircle2 className="h-3 w-3" />
                Resolved
              </span>
            )}
          </div>

          {/* Timecode badge */}
          {comment.timecode_start !== null && comment.timecode_start !== undefined && (
            <button
              className="mt-1 inline-flex items-center gap-1 rounded bg-accent-muted px-1.5 py-0.5 text-2xs font-mono text-accent hover:bg-accent hover:text-text-inverse transition-colors"
              onClick={() => setPlayheadTime(comment.timecode_start!)}
              title="Jump to timecode"
            >
              <Clock className="h-2.5 w-2.5" />
              {formatTime(comment.timecode_start)}
              {comment.timecode_end !== null && comment.timecode_end !== undefined && (
                <> — {formatTime(comment.timecode_end)}</>
              )}
            </button>
          )}

          {/* Body */}
          <p className="mt-1 text-sm text-text-secondary leading-relaxed break-words">
            {comment.body}
          </p>

          {/* Annotation thumbnail */}
          {comment.annotation?.drawing_data && (
            <div className="mt-2">
              <AnnotationThumbnail drawingData={comment.annotation.drawing_data} />
            </div>
          )}

          {/* Reactions row */}
          {reactionGroups.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {reactionGroups.map((r) => (
                <button
                  key={r.emoji}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
                    r.userReacted
                      ? 'border-accent bg-accent-muted text-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-border-focus',
                  )}
                  onClick={() => handleReactionClick(r.emoji, r.userReacted)}
                >
                  {r.emoji}
                  <span className="text-2xs">{r.count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Action row */}
          <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Emoji */}
            <div className="relative">
              <button
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
                onClick={() => setShowEmojiPicker((p) => !p)}
                title="Add reaction"
              >
                <Smile className="h-3.5 w-3.5" />
              </button>
              {showEmojiPicker && (
                <div className="absolute bottom-full left-0 mb-1 z-50 flex gap-1 rounded-lg border border-border bg-bg-elevated p-1.5 shadow-lg animate-scale-in">
                  {QUICK_EMOJIS.map((e) => (
                    <button
                      key={e}
                      className="h-7 w-7 rounded text-base hover:bg-bg-hover transition-colors"
                      onClick={() => handleQuickEmoji(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Reply */}
            {depth === 0 && (
              <button
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors"
                onClick={() => onReply(comment.id)}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Reply
              </button>
            )}

            {/* Resolve */}
            {!comment.resolved && (
              <button
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-text-tertiary hover:bg-bg-hover hover:text-status-success transition-colors disabled:opacity-50"
                onClick={handleResolve}
                disabled={resolving}
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Resolve
              </button>
            )}

            {/* Delete (own comments only) */}
            {isOwn && (
              <button
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-text-tertiary hover:bg-bg-hover hover:text-status-error transition-colors"
                onClick={() => onDelete(comment.id)}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div>
          <button
            className="flex items-center gap-1 text-2xs text-text-tertiary hover:text-text-secondary transition-colors ml-9 mb-1"
            onClick={() => setShowReplies((p) => !p)}
          >
            {showReplies ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {comment.replies.length} {comment.replies.length === 1 ? 'reply' : 'replies'}
          </button>
          {showReplies && (
            <div>
              {comment.replies.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  depth={depth + 1}
                  currentUserId={currentUserId}
                  onResolve={onResolve}
                  onDelete={onDelete}
                  onAddReaction={onAddReaction}
                  onRemoveReaction={onRemoveReaction}
                  onReply={onReply}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Comment panel ────────────────────────────────────────────────────────────

export function CommentPanel({
  comments,
  isLoading,
  currentUserId,
  onResolve,
  onDelete,
  onAddReaction,
  onRemoveReaction,
  onReply,
  className,
}: CommentPanelProps) {
  const [showResolved, setShowResolved] = React.useState(false)

  // Filter top-level comments
  const filtered = React.useMemo(() => {
    const topLevel = comments.filter((c) => c.parent_id === null)
    if (showResolved) return topLevel
    return topLevel.filter((c) => !c.resolved)
  }, [comments, showResolved])

  // Sort: timecoded first (by timecode_start), then by created_at
  const sorted = React.useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aHasTime = a.timecode_start !== null && a.timecode_start !== undefined
      const bHasTime = b.timecode_start !== null && b.timecode_start !== undefined

      if (aHasTime && bHasTime) {
        return (a.timecode_start as number) - (b.timecode_start as number)
      }
      if (aHasTime && !bHasTime) return -1
      if (!aHasTime && bHasTime) return 1
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    })
  }, [filtered])

  const resolvedCount = comments.filter((c) => c.parent_id === null && c.resolved).length

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold text-text-primary">
          Comments
          {comments.length > 0 && (
            <span className="ml-2 text-2xs text-text-tertiary font-normal">
              ({comments.filter((c) => c.parent_id === null).length})
            </span>
          )}
        </h2>
        <button
          className={cn(
            'text-2xs rounded px-2 py-1 border transition-colors',
            showResolved
              ? 'border-accent text-accent bg-accent-muted'
              : 'border-border text-text-tertiary hover:text-text-secondary hover:border-border-focus',
          )}
          onClick={() => setShowResolved((p) => !p)}
        >
          {showResolved ? 'Hide resolved' : `Show resolved (${resolvedCount})`}
        </button>
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto divide-y divide-border-secondary">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
          </div>
        )}

        {!isLoading && sorted.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center px-6 animate-fade-in">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-bg-tertiary text-text-tertiary mb-3">
              <MessageSquare className="h-6 w-6" />
            </div>
            <p className="text-sm text-text-secondary font-medium">No comments yet</p>
            <p className="text-xs text-text-tertiary mt-1">
              Add a comment below to start the review
            </p>
          </div>
        )}

        {!isLoading &&
          sorted.map((comment) => (
            <div key={comment.id} className="px-4">
              <CommentItem
                comment={comment}
                currentUserId={currentUserId}
                onResolve={onResolve}
                onDelete={onDelete}
                onAddReaction={onAddReaction}
                onRemoveReaction={onRemoveReaction}
                onReply={onReply}
              />
            </div>
          ))}
      </div>
    </div>
  )
}
