'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ReviewProvider, useReview } from '@/components/review/review-provider'
import { VideoPlayer } from '@/components/review/video-player'
import { AudioPlayer } from '@/components/review/audio-player'
import { ImageViewer } from '@/components/review/image-viewer'
import { AnnotationCanvas } from '@/components/review/annotation-canvas'
import { AnnotationOverlay } from '@/components/review/annotation-overlay'
import { CommentPanel } from '@/components/review/comment-panel'
import { CommentInput } from '@/components/review/comment-input'
// ApprovalBar removed for now
import { VersionSwitcher } from '@/components/review/version-switcher'
import { ShareDialog } from '@/components/review/share-dialog'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { api } from '@/lib/api'
import { useUploadStore } from '@/stores/upload-store'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Columns2,
  Upload,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { usePageTitle } from '@/hooks/use-page-title'
import type { Project, AssetResponse, ProjectMember, FolderTreeNode } from '@/types'

const acceptByType: Record<string, string> = {
  video: 'video/*',
  audio: 'audio/*',
  image: 'image/*',
  image_carousel: 'image/*',
}

function ReviewScreenInner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { asset, versions, isLoading, refetchComments, refetchVersions } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, seekTo, setFocusedCommentId, setActiveAnnotation } = useReviewStore()
  const { user } = useAuthStore()
  const startVersionUpload = useUploadStore((s) => s.startVersionUpload)
  const versionFileInputRef = useRef<HTMLInputElement>(null)
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs)
  const setLabel = useBreadcrumbStore((s) => s.setLabel)
  usePageTitle(asset?.name ?? null)
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [activeTab, setActiveTab] = useState<'comments' | 'fields'>('comments')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const deepLinkApplied = useRef(false)

  // Fetch folder tree to build the folder path for the breadcrumb
  const { data: folderTree } = useSWR<FolderTreeNode[]>(
    asset ? `/projects/${projectId}/folder-tree` : null,
    () => api.get<FolderTreeNode[]>(`/projects/${projectId}/folder-tree`),
  )

  // Set extra crumbs = [folder path..., asset name]
  // Don't register asset UUID as a label — use extraCrumbs for correct ordering
  useEffect(() => {
    if (!asset?.name) return

    function findPath(
      nodes: FolderTreeNode[],
      targetId: string,
      trail: { id: string; name: string }[],
    ): { id: string; name: string }[] | null {
      for (const node of nodes) {
        const next = [...trail, { id: node.id, name: node.name }]
        if (node.id === targetId) return next
        const found = findPath(node.children, targetId, next)
        if (found) return found
      }
      return null
    }

    const folderPath = asset.folder_id && folderTree
      ? (findPath(folderTree, asset.folder_id, []) ?? [])
      : []

    setExtraCrumbs([
      ...folderPath.map((f) => ({ label: f.name, href: `/projects/${projectId}?folder=${f.id}` })),
      { label: asset.name }, // asset name — no href (current page)
    ])
  }, [asset?.id, asset?.name, asset?.folder_id, folderTree, setExtraCrumbs])

  // Fetch project info for breadcrumb + register project name as label
  const { data: project } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )
  useEffect(() => {
    if (project?.name) setLabel(projectId, project.name)
  }, [project?.name, projectId, setLabel])

  // Role-based permissions
  const { data: members } = useSWR<ProjectMember[]>(
    `/projects/${projectId}/members`,
    () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
  )
  const currentMember = members?.find((m) => m.user_id === user?.id)
  const currentRole = currentMember?.role ?? 'viewer'
  const canComment = currentRole !== 'viewer'

  // Fetch all assets for navigation (1 of N)
  const { data: allAssets } = useSWR<AssetResponse[]>(
    `/projects/${projectId}/assets`,
    () => api.get<AssetResponse[]>(`/projects/${projectId}/assets`),
  )

  const {
    comments,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '')

  // Deep-link to a specific comment from notification (?commentId=...)
  // Runs once after comments are loaded — seeks to timecode, focuses comment, shows annotation
  useEffect(() => {
    const commentId = searchParams.get('commentId')
    if (!commentId || deepLinkApplied.current || comments.length === 0) return
    const target = comments.find((c: any) => c.id === commentId)
    if (!target) return
    deepLinkApplied.current = true
    setFocusedCommentId(commentId)
    setActiveTab('comments')
    if ((target as any).timecode_start !== null && (target as any).timecode_start !== undefined) {
      seekTo((target as any).timecode_start, true)
    }
    if ((target as any).annotation?.drawing_data) {
      setActiveAnnotation((target as any).annotation.drawing_data)
    }
  }, [comments, searchParams, seekTo, setFocusedCommentId, setActiveAnnotation])

  // Asset navigation
  const currentIndex = allAssets?.findIndex((a) => a.id === asset?.id) ?? -1
  const totalAssets = allAssets?.length ?? 0
  const prevAsset = currentIndex > 0 ? allAssets?.[currentIndex - 1] : null
  const nextAsset = currentIndex < totalAssets - 1 ? allAssets?.[currentIndex + 1] : null

  const navigateAsset = (assetId: string) => {
    router.push(`/projects/${projectId}/assets/${assetId}`)
  }

  // Keyboard navigation for prev/next asset
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft' && prevAsset) {
        e.preventDefault()
        navigateAsset(prevAsset.id)
      }
      if (e.key === 'ArrowRight' && nextAsset) {
        e.preventDefault()
        navigateAsset(nextAsset.id)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [prevAsset, nextAsset])

  if (isLoading || !asset) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-text-tertiary">Loading asset...</span>
        </div>
      </div>
    )
  }

  const handleSubmitComment = async (
    body: string,
    timecodeStart?: number,
    timecodeEnd?: number,
    annotation?: Record<string, unknown>,
    parentId?: string,
    visibility?: string,
    mentionUserIds?: string[],
  ) => {
    await createComment(
      body,
      timecodeStart,
      timecodeEnd,
      annotation || annotationData || undefined,
      parentId,
      visibility,
      mentionUserIds,
    )
    setAnnotationData(null)
    refetchComments()
  }

  const handleSubmitReply = async (parentId: string, body: string) => {
    await createComment(body, undefined, undefined, undefined, parentId)
    refetchComments()
  }

  const versionReady = currentVersion?.processing_status === 'ready'
  const versionProcessing =
    currentVersion?.processing_status === 'processing' ||
    currentVersion?.processing_status === 'uploading'

  const renderMediaViewer = () => {
    if (!currentVersion || !versionReady) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center px-6">
            {versionProcessing ? (
              <>
                <div className="h-12 w-12 rounded-full bg-accent/10 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-accent" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing asset</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This may take a few minutes depending on file size.
                  </p>
                </div>
              </>
            ) : currentVersion?.processing_status === 'failed' ? (
              <>
                <div className="h-12 w-12 rounded-full bg-status-error/10 flex items-center justify-center">
                  <Info className="h-6 w-6 text-status-error" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Processing failed</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    Try uploading a new version of this asset.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="h-12 w-12 rounded-full bg-bg-tertiary flex items-center justify-center">
                  <Info className="h-6 w-6 text-text-tertiary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Version not ready</p>
                  <p className="text-xs text-text-tertiary mt-1">
                    This version is still being prepared.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )
    }

    switch (asset.asset_type) {
      case 'video':
        return (
          <VideoPlayer
            assetId={asset.id}
            comments={comments}
            className="flex-1 min-h-0"
            overlay={
              <>
                <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                {isDrawingMode && (
                  <AnnotationCanvas
                    onSave={(data) => setAnnotationData(data)}
                  />
                )}
              </>
            }
          />
        )
      case 'audio':
        return (
          <AudioPlayer
            asset={asset}
            version={currentVersion}
            comments={comments}
            className="flex-1"
          />
        )
      case 'image':
      case 'image_carousel':
        return (
          <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
            <ImageViewer
              asset={asset}
              version={currentVersion as any}
              annotationCanvas={
                <>
                  <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                  {isDrawingMode && (
                    <AnnotationCanvas
                      onSave={(data) => setAnnotationData(data)}
                    />
                  )}
                </>
              }
            />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* ─── Top bar (Frame.io style) ──────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        {/* Left: back + breadcrumb */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <Link
            href={`/projects/${asset.project_id}`}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          {/* Asset name only */}
          <span className="text-[13px] text-text-primary font-medium truncate">
            {asset.name}
          </span>
        </div>

        {/* Center: asset navigation */}
        {totalAssets > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => prevAsset && navigateAsset(prevAsset.id)}
              disabled={!prevAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Previous asset (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-text-secondary tabular-nums px-1">
              {currentIndex + 1} of {totalAssets}
            </span>
            <button
              onClick={() => nextAsset && navigateAsset(nextAsset.id)}
              disabled={!nextAsset}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="Next asset (→)"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Right: version, share, sidebar toggle */}
        <div className="flex items-center gap-2 shrink-0 flex-1 justify-end">
          {/* Hidden file input for new version upload */}
          <input
            ref={versionFileInputRef}
            type="file"
            className="hidden"
            accept={acceptByType[asset.asset_type] ?? '*/*'}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file || !asset) return
              startVersionUpload(file, asset.id, asset.name, asset.project_id)
              e.target.value = ''
              // Refetch versions after a short delay to show the new uploading version
              setTimeout(() => refetchVersions(), 800)
            }}
          />
          <VersionSwitcher versions={versions} />
          <button
            onClick={() => versionFileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Upload new version"
          >
            <Upload className="h-3.5 w-3.5" />
            New Version
          </button>
          <ShareDialog assetId={asset.id} assetName={asset.name} projectId={projectId} asset={asset} />
          <button
            onClick={() => setSidebarOpen((p) => !p)}
            className={cn(
              'flex items-center justify-center h-8 w-8 rounded-md transition-colors',
              sidebarOpen
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
            title="Toggle sidebar"
          >
            <Columns2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Main content: viewer + sidebar ────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: viewer column */}
        <div className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0">
          {/* Media viewer */}
          {renderMediaViewer()}
        </div>

        {/* Right: comments sidebar */}
        {sidebarOpen && (
          <div className="w-[360px] flex flex-col border-l border-border bg-bg-secondary shrink-0 animate-in slide-in-from-right-2 duration-150">
            {/* Tabs (Frame.io pill style) */}
            <div className="px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center bg-bg-tertiary rounded-lg p-0.5">
                <button
                  onClick={() => setActiveTab('comments')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'comments'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Comments
                </button>
                <button
                  onClick={() => setActiveTab('fields')}
                  className={cn(
                    'flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all',
                    activeTab === 'fields'
                      ? 'bg-bg-hover text-text-primary shadow-sm'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  Fields
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {activeTab === 'comments' ? (
                <>
                  <CommentPanel
                    comments={comments as any}
                    currentUserId={user?.id}
                    onResolve={resolveComment}
                    onDelete={deleteComment}
                    onAddReaction={addReaction}
                    onRemoveReaction={removeReaction}
                    onReply={() => {}}
                    onSubmitReply={handleSubmitReply}
                  />
                  {canComment && (
                    <CommentInput
                      assetId={asset.id}
                      projectId={asset.project_id}
                      assetType={asset.asset_type}
                      onSubmit={handleSubmitComment}
                      annotationData={annotationData}
                    />
                  )}
                </>
              ) : (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-tertiary">Name</span>
                      <span className="text-xs text-text-primary font-medium truncate ml-4">{asset.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-tertiary">Type</span>
                      <span className="text-xs text-text-primary capitalize">{asset.asset_type.replace('_', ' ')}</span>
                    </div>
                    {currentVersion && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Version</span>
                        <span className="text-xs text-text-primary">v{currentVersion.version_number}</span>
                      </div>
                    )}
                    {currentVersion && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Processing</span>
                        <span className={cn(
                          'text-xs capitalize',
                          currentVersion.processing_status === 'ready' && 'text-status-success',
                          currentVersion.processing_status === 'processing' && 'text-status-warning',
                          currentVersion.processing_status === 'failed' && 'text-status-error',
                          currentVersion.processing_status === 'uploading' && 'text-text-tertiary',
                        )}>
                          {currentVersion.processing_status}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ReviewPage({
  params,
}: {
  params: { id: string; assetId: string }
}) {
  const { id: projectId, assetId } = params

  return (
    <ReviewProvider assetId={assetId}>
      <ReviewScreenInner projectId={projectId} />
    </ReviewProvider>
  )
}
