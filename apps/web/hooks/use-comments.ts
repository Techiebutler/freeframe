'use client'

import useSWR, { mutate as globalMutate } from 'swr'
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
  timecode_start?: number
  timecode_end?: number
  annotation_data?: Record<string, unknown>
  parent_id?: string
}

interface CommentsResponse {
  comments: CommentWithReplies[]
}

function buildSWRKey(assetId: string | null, versionId: string | null): string | null {
  if (!assetId || !versionId) return null
  return `/assets/${assetId}/comments?version_id=${versionId}`
}

export function useComments(assetId: string | null, versionId: string | null) {
  const swrKey = buildSWRKey(assetId, versionId)

  const { data, error, isLoading, mutate } = useSWR<CommentsResponse>(
    swrKey,
    (key: string) => api.get<CommentsResponse>(key),
    {
      revalidateOnFocus: false,
    },
  )

  const comments = data?.comments ?? []

  // ─── Create comment ─────────────────────────────────────────────────────────

  async function createComment(
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotationData?: Record<string, unknown>,
    parentId?: string,
  ): Promise<CommentWithReplies> {
    if (!assetId) throw new Error('No asset selected')

    const payload: CreateCommentPayload = { body }
    if (timecodeStart !== undefined) payload.timecode_start = timecodeStart
    if (timecodeEnd !== undefined) payload.timecode_end = timecodeEnd
    if (annotationData) payload.annotation_data = annotationData
    if (parentId) payload.parent_id = parentId

    const endpoint = parentId
      ? `/comments/${parentId}/replies`
      : `/assets/${assetId}/comments`

    const newComment = await api.post<CommentWithReplies>(endpoint, payload)
    await mutate()
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
    await api.post(`/comments/${commentId}/reactions`, { emoji })
    await mutate()
  }

  async function removeReaction(commentId: string, emoji: string): Promise<void> {
    await api.delete(`/comments/${commentId}/reactions/${encodeURIComponent(emoji)}`)
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
