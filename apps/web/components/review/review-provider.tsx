'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { api } from '@/lib/api'
import { useReviewStore } from '@/stores/review-store'
import type { AssetResponse, AssetVersion, Comment } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateCommentPayload {
  body: string
  version_id: string
  parent_id?: string
  timecode_start?: number
  timecode_end?: number
  annotation?: Record<string, unknown>
}

interface ReviewContextValue {
  assetId: string
  asset: AssetResponse | null
  versions: AssetVersion[]
  comments: Comment[]
  isLoading: boolean
  error: string | null
  addComment: (payload: CreateCommentPayload) => Promise<Comment>
  resolveComment: (commentId: string) => Promise<void>
  seekTo: (time: number) => void
  refetchComments: () => Promise<void>
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ReviewContext = createContext<ReviewContextValue | null>(null)

// ─── Provider ─────────────────────────────────────────────────────────────────

interface ReviewProviderProps {
  assetId: string
  children: React.ReactNode
}

export function ReviewProvider({ assetId, children }: ReviewProviderProps) {
  const [asset, setAsset] = useState<AssetResponse | null>(null)
  const [versions, setVersions] = useState<AssetVersion[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { setCurrentAsset, setCurrentVersion, setPlayheadTime } = useReviewStore()

  // Track whether component is still mounted to avoid state updates after unmount
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const fetchAsset = useCallback(async () => {
    try {
      // Backend returns flat AssetResponse with latest_version embedded
      const data = await api.get<AssetResponse>(`/assets/${assetId}`)
      if (!mountedRef.current) return

      setAsset(data)
      setCurrentAsset(data)

      // Fetch all versions for the version switcher
      const allVersions = await api.get<AssetVersion[]>(`/assets/${assetId}/versions`)
      if (!mountedRef.current) return
      setVersions(allVersions ?? [])

      // Set the latest ready version as current
      const readyVersion = (allVersions ?? [])
        .sort((a, b) => b.version_number - a.version_number)
        .find((v) => v.processing_status === 'ready')
      if (readyVersion) {
        setCurrentVersion(readyVersion)
      } else if (data.latest_version) {
        // Fallback to latest version even if not ready (shows processing state)
        setCurrentVersion(data.latest_version)
      }
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load asset')
    }
  }, [assetId, setCurrentAsset, setCurrentVersion])

  const fetchComments = useCallback(async () => {
    try {
      const data = await api.get<Comment[]>(`/assets/${assetId}/comments`)
      if (!mountedRef.current) return
      setComments(data ?? [])
    } catch {
      // Comments failing silently — asset is still viewable
    }
  }, [assetId])

  const refetchComments = useCallback(async () => {
    await fetchComments()
  }, [fetchComments])

  useEffect(() => {
    setIsLoading(true)
    setError(null)
    Promise.all([fetchAsset(), fetchComments()]).finally(() => {
      if (mountedRef.current) setIsLoading(false)
    })
  }, [fetchAsset, fetchComments])

  const addComment = useCallback(
    async (payload: CreateCommentPayload): Promise<Comment> => {
      const comment = await api.post<Comment>(`/assets/${assetId}/comments`, payload)
      if (mountedRef.current) {
        setComments((prev) => [...prev, comment])
      }
      return comment
    },
    [assetId],
  )

  const resolveComment = useCallback(async (commentId: string): Promise<void> => {
    await api.post(`/comments/${commentId}/resolve`)
    if (mountedRef.current) {
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? { ...c, resolved: true } : c)),
      )
    }
  }, [])

  const seekTo = useCallback(
    (time: number) => {
      setPlayheadTime(time)
    },
    [setPlayheadTime],
  )

  const value = useMemo<ReviewContextValue>(
    () => ({
      assetId,
      asset,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
    }),
    [
      assetId,
      asset,
      versions,
      comments,
      isLoading,
      error,
      addComment,
      resolveComment,
      seekTo,
      refetchComments,
    ],
  )

  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useReview(): ReviewContextValue {
  const ctx = useContext(ReviewContext)
  if (!ctx) {
    throw new Error('useReview must be used inside <ReviewProvider>')
  }
  return ctx
}
