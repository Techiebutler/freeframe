'use client'

import * as React from 'react'
import { Loader2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface CommentAuthor {
  id: string
  name: string
  avatar_url?: string | null
}

export interface GuestAuthor {
  id: string
  name: string
  email?: string
}

export interface GuestComment {
  id: string
  body: string
  author?: CommentAuthor | null
  guest_author?: GuestAuthor | null
  created_at: string
  timecode_start?: number | null
  /** The drawing made with the comment (ink.v1 or older), when it has one. */
  annotation?: { drawing_data?: unknown } | null
}

export type CommentsResponse = GuestComment[]

// ─── Guest comment item ───────────────────────────────────────────────────────

interface GuestCommentItemProps {
  comment: GuestComment
  /** Embed player: clicking a comment goes to its time and shows its drawing. */
  onSelect?: (comment: GuestComment) => void
  selected?: boolean
}

export function GuestCommentItem({ comment, onSelect, selected }: GuestCommentItemProps) {
  const displayName = comment.guest_author?.name || comment.author?.name || 'Unknown'
  const avatarUrl = comment.author?.avatar_url ?? null
  const [imgError, setImgError] = React.useState(false)

  return (
    <div
      className={cn('rounded-lg bg-white/[0.03] border border-white/5 px-3 py-2.5', onSelect && 'press cursor-pointer text-left hover:bg-white/[0.06]', selected && 'border-white/20 bg-white/[0.07]')}
      {...(onSelect ? { role: 'button', tabIndex: 0, 'aria-pressed': !!selected, onClick: () => onSelect(comment), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(comment) } } } : {})}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-2xs font-medium text-purple-400">
          {avatarUrl && !imgError ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={avatarUrl}
              alt=""
              className="h-full w-full rounded-full object-cover"
              referrerPolicy="no-referrer"
              onError={() => setImgError(true)}
            />
          ) : (
            displayName.charAt(0).toUpperCase()
          )}
        </div>
        <span className="text-xs font-medium text-zinc-200">{displayName}</span>
        {comment.timecode_start != null && (
          <span className="text-2xs text-zinc-500 font-mono bg-white/5 px-1.5 py-0.5 rounded">
            {Math.floor(comment.timecode_start / 60)}:
            {String(Math.floor(comment.timecode_start % 60)).padStart(2, '0')}
          </span>
        )}
        <span className="ml-auto text-2xs text-zinc-600">
          {new Date(comment.created_at).toLocaleDateString()}
        </span>
      </div>
      <p className="text-sm text-zinc-300 leading-relaxed">{comment.body}</p>
    </div>
  )
}

// ─── Guest comment list (for right panel) ────────────────────────────────────

interface GuestCommentListProps {
  token: string
  refreshKey: number
  /** Folder / project shares: which asset's comments (the latest ready version). */
  assetId?: string
  /** Embed player: the loaded comments (for the player's markers). */
  onLoaded?: (comments: GuestComment[]) => void
  onSelect?: (comment: GuestComment) => void
  selectedId?: string | null
}

export function GuestCommentList({ token, refreshKey, assetId, onLoaded, onSelect, selectedId }: GuestCommentListProps) {
  const [comments, setComments] = React.useState<GuestComment[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    setLoading(true)
    const qs = assetId ? `?asset_id=${assetId}&latest_only=true` : ''
    fetch(`${API_URL}/share/${token}/comments${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve([])))
      .then((data: CommentsResponse) => { setComments(data); onLoaded?.(data) })
      .catch(() => { setComments([]); onLoaded?.([]) })
      .finally(() => setLoading(false))
  }, [token, refreshKey, assetId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (comments.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
          <MessageSquare className="h-6 w-6 text-zinc-600" />
        </div>
        <p className="text-sm font-medium text-zinc-300">No comments — yet</p>
        <p className="text-xs text-zinc-500 mt-1">
          Be the first to leave feedback on this asset.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
      {comments.map((comment) => (
        <GuestCommentItem key={comment.id} comment={comment} onSelect={onSelect} selected={selectedId === comment.id} />
      ))}
    </div>
  )
}
