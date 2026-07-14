'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type { Comment, Annotation, CommentReaction } from '@/types'

// ─── Extended comment type with nested data ───────────────────────────────────

export interface CommentWithReplies extends Comment {
  replies: CommentWithReplies[]
  annotation: Annotation | null
  reactions: CommentReaction[]
  author: {
    id: string
    name: string
    avatar_url: string | null
  } | null
  guest_author: {
    id: string
    name: string
    email: string
  } | null
}

interface CreateCommentPayload {
  body: string
  version_id?: string
  timecode_start?: number
  timecode_end?: number
  annotation?: {
    drawing_data: Record<string, unknown>
    frame_number?: number
    carousel_position?: number
  }
  parent_id?: string
  visibility?: string
}

function buildSWRKey(assetId: string | null, versionId: string | null): string | null {
  if (!assetId || !versionId) return null
  return `/assets/${assetId}/comments?version_id=${versionId}`
}

/**
 * Insert a freshly-created comment into the cached tree without a refetch:
 * a top-level comment appends to the root, a reply nests under its parent.
 * Pure — drives the optimistic cache update so the composer clears after one
 * round-trip instead of blocking on a full re-fetch of every comment.
 */
export function insertCommentIntoTree(
  comments: CommentWithReplies[],
  newComment: CommentWithReplies,
  parentId?: string,
): CommentWithReplies[] {
  if (!parentId) return [...comments, newComment]
  return comments.map((c) =>
    c.id === parentId
      ? { ...c, replies: [...(c.replies ?? []), newComment] }
      : c.replies?.length
        ? { ...c, replies: insertCommentIntoTree(c.replies, newComment, parentId) }
        : c,
  )
}

export function useComments(assetId: string | null, versionId: string | null) {
  const swrKey = buildSWRKey(assetId, versionId)

  const { data, error, isLoading, mutate } = useSWR<CommentWithReplies[]>(
    swrKey,
    (key: string) => api.get<CommentWithReplies[]>(key),
    {
      revalidateOnFocus: false,
    },
  )

  const comments = data ?? []

  // ─── Create comment ─────────────────────────────────────────────────────────

  async function createComment(
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotationData?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ): Promise<CommentWithReplies> {
    if (!assetId) throw new Error('No asset selected')
    if (!versionId) throw new Error('No version selected')

    const payload: CreateCommentPayload = { body, version_id: versionId }
    if (timecodeStart !== undefined) payload.timecode_start = timecodeStart
    if (timecodeEnd !== undefined) payload.timecode_end = timecodeEnd
    if (annotationData) payload.annotation = { drawing_data: annotationData }
    if (parentId) payload.parent_id = parentId
    if (visibility) payload.visibility = visibility
    if (mentionUserIds?.length) (payload as any).mention_user_ids = mentionUserIds

    const endpoint = parentId
      ? `/assets/${assetId}/comments/${parentId}/replies`
      : `/assets/${assetId}/comments`

    const newComment = await api.post<CommentWithReplies>(endpoint, payload)
    // Optimistically insert the authoritative POST response into the cache, then
    // revalidate in the BACKGROUND (not awaited) — the composer clears after the
    // single POST round-trip instead of also waiting on a full re-fetch of every
    // comment. Server truth reconciles when the background revalidation lands.
    void mutate(
      (current) => insertCommentIntoTree(current ?? [], newComment, parentId),
      { revalidate: true },
    )
    return newComment
  }

  // ─── Resolve comment ─────────────────────────────────────────────────────────

  async function resolveComment(commentId: string): Promise<void> {
    await api.post(`/comments/${commentId}/resolve`)
    await mutate()
  }

  // ─── Delete comment ──────────────────────────────────────────────────────────

  async function deleteComment(commentId: string): Promise<void> {
    await api.delete(`/comments/${commentId}`)
    await mutate()
  }

  // ─── Reactions ───────────────────────────────────────────────────────────────

  async function addReaction(commentId: string, emoji: string): Promise<void> {
    await api.post(`/comments/${commentId}/react`, { emoji })
    await mutate()
  }

  async function removeReaction(commentId: string, emoji: string): Promise<void> {
    await api.post(`/comments/${commentId}/react`, { emoji })
    await mutate()
  }

  return {
    comments,
    isLoading,
    error,
    mutate,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  }
}
