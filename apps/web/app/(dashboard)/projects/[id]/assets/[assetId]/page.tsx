'use client'

import { use, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
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
import { VersionSwitcher, type ProcessingProgress } from '@/components/review/version-switcher'
import { ShareDialog } from '@/components/review/share-dialog'
import { CompareOverlay } from '@/components/review/compare/compare-overlay'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { useSSE } from '@/hooks/use-sse'
import { api } from '@/lib/api'
import { projectFolderHref } from '@/lib/project-links'
import { useUploadStore, visibleFiles } from '@/stores/upload-store'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useViewStore } from '@/stores/view-store'
import { sortAssets } from '@/lib/sort-assets'
import { canCompare } from '@/lib/compare-time'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Columns2,
  GripHorizontal,
  Upload,
  GitCompareArrows,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'
import { usePageTitle } from '@/hooks/use-page-title'
import { useMobileReviewSplit } from '@/hooks/use-mobile-review-split'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/shared/toast'
import type { Project, ProjectBranding, AssetResponse, AssetVersion, ProjectMember, FolderTreeNode } from '@/types'

const acceptByType: Record<string, string> = {
  video: 'video/*',
  audio: 'audio/*',
  image: 'image/*',
  image_carousel: 'image/*',
}

function ReviewScreenInner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { asset, versions, isLoading, refetchComments, refetchVersions } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, seekTo, setFocusedCommentId, setActiveAnnotation } = useReviewStore()
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)
  const { user } = useAuthStore()
  const toast = useToast()
  const startVersionUpload = useUploadStore((s) => s.startVersionUpload)
  const versionFileInputRef = useRef<HTMLInputElement>(null)
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs)
  const setLabel = useBreadcrumbStore((s) => s.setLabel)
  usePageTitle(asset?.name ?? null)
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [activeTab, setActiveTab] = useState<'comments' | 'fields'>('comments')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const mobileSplit = useMobileReviewSplit()
  const deepLinkApplied = useRef(false)
  const knownCommentIds = useRef<Set<string> | null>(null)
  const [newCommentIds, setNewCommentIds] = useState<string[]>([])
  const [versionToDelete, setVersionToDelete] = useState<AssetVersion | null>(null)
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null)

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
      ...folderPath.map((f) => ({ label: f.name, href: projectFolderHref(projectId, f.id) })),
      { label: asset.name }, // asset name — no href (current page)
    ])
  }, [asset?.id, asset?.name, asset?.folder_id, folderTree, setExtraCrumbs])

  // Fetch project info for breadcrumb + register project name as label
  const { data: project } = useSWR<Project>(
    `/projects/${projectId}`,
    () => api.get<Project>(`/projects/${projectId}`),
  )
  const { data: projectBranding } = useSWR<ProjectBranding>(
    `/projects/${projectId}/branding`,
    () => api.get<ProjectBranding>(`/projects/${projectId}/branding`),
  )
  const projectAccentColor = projectBranding?.primary_color ?? 'var(--accent)'
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
  // delete_comment lets a project owner (or a superadmin) remove anyone's
  // comment; editing stays with the author.
  const canModerate = Boolean(user?.is_superadmin) || currentRole === 'owner'
  const canManageVersions = user?.is_superadmin || currentRole === 'owner' || currentRole === 'editor'

  // Prev/next walks the asset's own folder in the order the project view shows
  // it, not the whole project. Same key as the project page, so the list is
  // usually already cached.
  const { data: folderAssets } = useSWR<AssetResponse[]>(
    asset ? `/projects/${projectId}/assets?folder_id=${asset.folder_id ?? 'root'}` : null,
    (key: string) => api.get<AssetResponse[]>(key),
  )
  const sortKey = useViewStore((s) => s.sortKey)
  const sortDirection = useViewStore((s) => s.sortDirection)
  const navAssets = useMemo(
    () => (folderAssets ? sortAssets(folderAssets, sortKey, sortDirection) : undefined),
    [folderAssets, sortKey, sortDirection],
  )

  const {
    comments,
    isLoading: commentsLoading,
    createComment,
    resolveComment,
    updateComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '')

  useEffect(() => {
    knownCommentIds.current = null
    setNewCommentIds([])
  }, [asset?.id, currentVersion?.id])

  useEffect(() => {
    if (commentsLoading) return
    const flatten = (items: typeof comments): typeof comments =>
      items.flatMap((comment) => [
        comment,
        ...(comment.replies?.length ? flatten(comment.replies) : []),
      ])
    const allComments = flatten(comments)
    const currentIds = new Set(allComments.map((comment) => comment.id))

    if (knownCommentIds.current === null) {
      knownCommentIds.current = currentIds
      return
    }

    const addedBySomeoneElse = allComments
      .filter((comment) => !knownCommentIds.current!.has(comment.id))
      .filter((comment) => comment.author_id !== user?.id)
      .map((comment) => comment.id)
    if (addedBySomeoneElse.length) {
      setNewCommentIds((previous) =>
        Array.from(new Set(previous.concat(addedBySomeoneElse))),
      )
    }
    knownCommentIds.current = currentIds
  }, [comments, commentsLoading, user?.id])

  // Keep the version list live: when a new version transcodes, revalidate so it
  // appears/updates in the switcher without a hard refresh (#118). The review
  // provider's versions are plain state, not SWR, so nothing else refetches them.
  const refetchIfThisAsset = (eventAssetId: string) => {
    if (eventAssetId === asset?.id) void refetchVersions()
  }
  const latestVersion = versions.reduce<AssetVersion | null>(
    (newest, version) => !newest || version.version_number > newest.version_number ? version : newest,
    null,
  )
  useSSE(asset?.project_id, {
    onTranscodeProgress: (d) => {
      if (
        !d.version_id ||
        !latestVersion ||
        d.asset_id !== asset?.id ||
        d.version_id !== latestVersion.id ||
        latestVersion.processing_status !== 'processing'
      ) return
      setProcessingProgress({ versionId: d.version_id, percent: d.percent })
    },
    onTranscodeComplete: (d) => {
      if (d.asset_id !== asset?.id) return
      setProcessingProgress((current) => current?.versionId === d.version_id ? null : current)
      refetchIfThisAsset(d.asset_id)
    },
    onTranscodeFailed: (d) => {
      if (d.asset_id !== asset?.id) return
      setProcessingProgress((current) => current?.versionId === d.version_id ? null : current)
      refetchIfThisAsset(d.asset_id)
    },
    onNewComment: (d) => {
      if (d.asset_id === asset?.id) void refetchComments()
    },
    onCommentResolved: (d) => {
      if (d.asset_id === asset?.id) void refetchComments()
    },
  })

  useEffect(() => {
    setProcessingProgress(null)
  }, [asset?.id])
  // Transcode events are not the only thing that changes this list. Discarding
  // an upload deletes its version and produces no event at all, so the switcher
  // went on offering a version that was gone -- still labelled "Uploading",
  // which was the one thing it certainly was not.
  //
  // The store says when it has changed versions behind the panel -- a discard,
  // or a cancel, which is sent as one -- and says it after the server has
  // answered, since refetching earlier would race the request that does the
  // deleting and fetch the version back.
  const versionsRevision = useUploadStore((s) => s.versionsRevision)
  const lastVersionsRevision = useRef(versionsRevision)
  // Not gated on `asset` having loaded. The ref moves either way, so a bump
  // arriving while `GET /assets/{id}` was in flight used to be dropped for good,
  // and `refetchVersions` needs only the route's `assetId`.
  useEffect(() => {
    if (lastVersionsRevision.current === versionsRevision) return
    lastVersionsRevision.current = versionsRevision
    refetchVersions()
  }, [versionsRevision, refetchVersions])

  // A New Version file waits for its turn behind the other uploads. Until its
  // initiate has answered there is no version to show, so the page says what
  // is going on instead of looking as if nothing was picked. The same counter
  // as above is bumped when the version exists, which is when the list is
  // refetched: no guess at how long the wait is.
  //
  // Only this asset's own version rows: a queued new asset has no `assetId`.
  //
  // The row the queue is holding on (the probe) says why instead, as it does in
  // the panel: "waiting for other uploads" is not true of it. A string, so the
  // selector is stable between renders.
  const assetIdForQueue = asset?.id
  const versionQueueLine = useUploadStore((s) => {
    if (assetIdForQueue === undefined) return ''
    const queued = visibleFiles(s).filter((f) => f.status === 'queued' && f.assetId === assetIdForQueue)
    if (queued.length === 0) return ''
    const reason = queued.find((f) => f.holdReason)?.holdReason
    if (reason === 'connection') return 'Waiting for connection'
    if (reason === 'storage') return 'Waiting for storage'
    return 'New version queued, waiting for other uploads'
  })

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

  // Version-compare overlay: driven entirely by the ?compare= URL param so it
  // survives refresh/deep-link (?right= names the right pane, see ReviewPage).
  // closeCompare strips all the compare params.
  const compareOpen = Boolean(searchParams.get('compare'))
  const closeCompare = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString())
    p.delete('compare'); p.delete('right'); p.delete('mode'); p.delete('offA'); p.delete('offB'); p.delete('offFor')
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [router, pathname, searchParams])

  // Asset navigation
  const currentIndex = navAssets?.findIndex((a) => a.id === asset?.id) ?? -1
  const totalAssets = navAssets?.length ?? 0
  const prevAsset = currentIndex > 0 ? navAssets?.[currentIndex - 1] : null
  const nextAsset = currentIndex < totalAssets - 1 ? navAssets?.[currentIndex + 1] : null

  const navigateAsset = (assetId: string) => {
    router.push(`/projects/${projectId}/assets/${assetId}`)
  }

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
    const comment = await createComment(
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
    return comment
  }

  const handleSubmitReply = async (parentId: string, body: string) => {
    const comment = await createComment(body, undefined, undefined, undefined, parentId)
    refetchComments()
    return comment
  }

  const deleteVersion = async () => {
    if (!asset || !versionToDelete) return
    const deletedVersion = versionToDelete
    await api.delete(`/assets/${asset.id}/versions/${deletedVersion.id}`)

    const fallback = [...versions]
      .filter((version) => version.id !== deletedVersion.id)
      .sort((a, b) => b.version_number - a.version_number)[0]
    if (currentVersion?.id === deletedVersion.id && fallback) {
      setCurrentVersion(fallback)
    }

    await Promise.all([refetchVersions(), refetchComments()])
    toast.success(`Version v${deletedVersion.version_number} moved to trash`)
  }

  const versionReady = currentVersion?.processing_status === 'ready'
  const versionProcessing =
    currentVersion?.processing_status === 'queued' ||
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
                  <p className="text-sm font-medium text-text-primary">
                    {currentVersion?.processing_status === 'queued' ? 'Waiting for processing worker' : 'Processing asset'}
                  </p>
                  <p className="text-xs text-text-tertiary mt-1">
                    {currentVersion?.processing_status === 'queued'
                      ? 'This version will start automatically when a processing worker is available.'
                      : 'This may take a few minutes depending on file size.'}
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

  // The comment panel's pieces, rendered by the sidebar (a column beside the
  // media above `md`, the lower half of the resizable split below it).
  const panelTabs = (
    <>
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
    </>
  )

  const commentPanelNode = (
    <CommentPanel
      comments={comments as any}
      currentUserId={user?.id}
      newCommentIds={newCommentIds}
      canModerate={canModerate}
      onResolve={resolveComment}
      onUpdate={updateComment}
      onDelete={deleteComment}
      onAddReaction={addReaction}
      onRemoveReaction={removeReaction}
      onReply={() => {}}
      onSubmitReply={handleSubmitReply}
      onAttachmentsUploaded={refetchComments}
      onDeleteAttachment={async (commentId, attachmentId) => {
        await api.delete(`/comments/${commentId}/attachments/${attachmentId}`)
        await refetchComments()
      }}
    />
  )

  const commentInputNode = canComment ? (
    <CommentInput
      assetId={asset.id}
      projectId={asset.project_id}
      assetType={asset.asset_type}
      onSubmit={handleSubmitComment}
      annotationData={annotationData}
      onAttachmentsUploaded={refetchComments}
    />
  ) : null

  const fieldsBody = (
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
              currentVersion.processing_status === 'queued' && 'text-status-info',
              currentVersion.processing_status === 'failed' && 'text-status-error',
              currentVersion.processing_status === 'uploading' && 'text-text-tertiary',
            )}>
              {currentVersion.processing_status}
            </span>
          </div>
        )}
      </div>
    </div>
  )


  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* ─── Top bar (Frame.io style) ──────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        {/* Left: back + breadcrumb. The name is the first thing the bar gives
            up; `min-w-7` keeps the back arrow, which at zero width spilled out
            into the centre group and had the navigator drawn over it. */}
        <div className="flex items-center gap-1 min-w-7 flex-1">
          {/* Back to the folder the asset is in, as a share link's back arrow
              does; it used to go to the project root from anywhere. */}
          <Link
            href={projectFolderHref(asset.project_id, asset.folder_id)}
            aria-label={asset.folder_id ? 'Back to folder' : 'Back to project'}
            title={asset.folder_id ? 'Back to folder' : 'Back to project'}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          {/* Asset name only. Truncated, so it needs a title: this is the only
              place the full name is shown, and it is the first thing the bar
              gives up when the window is narrow. */}
          <span
            className="text-[13px] text-text-primary font-medium truncate"
            title={asset.name}
          >
            {asset.name}
          </span>
        </div>

        {/* Center: asset navigation, then the credit.

            One group, not two things each centred on its own. The credit used
            to be absolutely positioned at the middle of the bar, and the
            navigator lands there too -- the blocks either side of it are both
            flex-1 -- so on any asset with a neighbour "Powered by FreeFrame"
            was drawn straight across "5 of 7", and won the hit test on the
            chevron. What is centred now is the group: with a neighbour the
            navigator therefore sits a little left of the bar's centre line,
            which is the cost of the two not overlapping. With no neighbour the
            navigator is not rendered and the credit is centred alone, exactly
            as before.

            The block on the right does not shrink, and anything that leaves
            the bar past its right edge is clipped by the page root's
            `overflow-hidden`, where no scroll reaches it -- the sidebar toggle
            first. So once the asset name is down to nothing, the credit is
            what gives way: this group can shrink (`min-w-0`, no `shrink-0`),
            the navigator inside it cannot, and the credit truncates its text.
            Gating the credit on viewport width alone did not cover it: the bar
            is also 168px narrower with the rail expanded, and a raised browser
            text size grows every rem while the `lg` media query stays put. At
            1024px, rail expanded, Compare and the navigator showing, 57px of
            name was all that was left, and at a 20px text size the toggle was
            off-screen.

            The credit is still `hidden` below `lg`, where the room it would
            take is room the controls need at every width. Out of flow there,
            the thresholds are the ones this page had before the credit joined
            the bar at all. */}
        <div className="flex items-center gap-3 min-w-0">
          {totalAssets > 1 && (
            <div className="hidden sm:flex items-center gap-1 shrink-0">
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
          <PoweredByBadge showIcon className="hidden lg:inline-flex min-w-0 [&>span]:truncate" />
        </div>

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
              // No row without a session: the upload would belong to nobody.
              if (startVersionUpload(file, asset.id, asset.name, asset.project_id, project?.name) === null) {
                toast.error('Sign in to upload')
              }
              e.target.value = ''
              // The new version (it starts as "uploading") is fetched when the
              // upload store says it exists, through `versionsRevision`; SSE
              // transcode events then drive it through processing → ready (#118).
            }}
          />
          <div className="hidden md:block">
            <VersionSwitcher
              versions={versions}
              processingProgress={processingProgress}
              canDelete={canManageVersions}
              onDeleteVersion={setVersionToDelete}
            />
          </div>
          <div className="md:hidden">
            <VersionSwitcher
              versions={versions}
              compact
              processingProgress={processingProgress}
              canDelete={canManageVersions}
              onDeleteVersion={setVersionToDelete}
            />
          </div>
          {asset && canCompare(asset.asset_type, versions) && (
            <button
              onClick={() => {
                const readyVersions = versions
                  .filter((v) => v.processing_status === 'ready')
                  .sort((a, b) => a.version_number - b.version_number)
                const cur = currentVersion ?? readyVersions[readyVersions.length - 1]
                const prev = [...readyVersions].reverse().find((v) => v.version_number < cur.version_number)
                  ?? readyVersions.find((v) => v.id !== cur.id)
                if (!prev) return
                const p = new URLSearchParams(searchParams.toString())
                p.set('compare', prev.id)
                p.set('right', cur.id)
                router.replace(`${pathname}?${p.toString()}`, { scroll: false })
              }}
              className="hidden md:inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Compare versions"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Compare
            </button>
          )}
          <button
            onClick={() => versionFileInputRef.current?.click()}
            className="hidden md:inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Upload new version"
          >
            <Upload className="h-3.5 w-3.5" />
            New Version
          </button>
          <ShareDialog assetId={asset.id} assetName={asset.name} projectId={projectId} asset={asset} />
          <button
            onClick={() => setSidebarOpen((p) => !p)}
            style={sidebarOpen ? { color: projectAccentColor } : undefined}
            className={cn(
              'mobile-touch-target flex items-center justify-center h-8 w-8 rounded-md transition-colors',
              sidebarOpen
                ? 'bg-bg-hover'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
            title="Toggle sidebar"
          >
            <Columns2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ─── Main content: viewer + sidebar ────────────────────────────── */}
      {compareOpen && asset && currentVersion && canCompare(asset.asset_type, versions) ? (
        <CompareOverlay asset={asset} versions={versions} rightVersion={currentVersion} onClose={closeCompare} canComment={canComment} canModerate={canModerate} />
      ) : (
      <div ref={mobileSplit.containerRef} className="flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row">
        {/* Left: viewer column */}
        <div
          className={cn('flex min-h-[220px] flex-col bg-bg-primary overflow-hidden min-w-0 md:min-h-0 md:flex-1', sidebarOpen ? 'flex-none' : 'flex-1')}
          style={mobileSplit.isMobile && sidebarOpen ? { height: `${mobileSplit.mediaPercent}%` } : undefined}
        >
          {/* What a New Version is waiting for, over the media and not over the
              comments beside it. A zero-height anchor rather than a row, so it
              never changes the stage's size. The region is always mounted and
              only its text changes: one created together with its text is not
              reliably announced. */}
          <div className="relative z-10 h-0 shrink-0">
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-3"
            >
              {versionQueueLine ? (
                <span className="rounded-md border border-border bg-bg-secondary/95 px-3 py-1.5 text-xs text-text-secondary shadow-lg">
                  {versionQueueLine}
                </span>
              ) : null}
            </div>
          </div>
          {/* Media viewer */}
          {renderMediaViewer()}
        </div>

        {sidebarOpen && (
          <div className="relative z-10 h-0 shrink-0 md:hidden">
            <div
              role="separator"
              aria-label="Resize media and comments"
              aria-orientation="horizontal"
              className="absolute -top-4 left-0 flex h-8 w-full touch-none cursor-row-resize items-center justify-center"
              onPointerDown={mobileSplit.onPointerDown}
              onPointerMove={mobileSplit.onPointerMove}
              onPointerUp={mobileSplit.onPointerUp}
              onPointerCancel={mobileSplit.onPointerCancel}
            >
              <span className="pointer-events-none flex h-3 w-8 items-center justify-center rounded-full bg-accent text-text-tertiary">
                <GripHorizontal className="h-2.5 w-3.5" />
              </span>
            </div>
          </div>
        )}

        {/* Right: comments sidebar */}
        {sidebarOpen && (
          <div
            className="w-full min-h-0 flex flex-col border-t border-border bg-bg-secondary shrink-0 md:w-[360px] md:min-h-0 md:border-t-0 md:border-l animate-in slide-in-from-right-2 duration-150"
            style={mobileSplit.isMobile ? { height: `${100 - mobileSplit.mediaPercent}%` } : undefined}
          >
            {panelTabs}

            {/* Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {activeTab === 'comments' ? (
                <>
                  {commentPanelNode}
                  {commentInputNode}
                </>
              ) : (
                fieldsBody
              )}
            </div>
          </div>
        )}
      </div>
      )}
      <ConfirmDialog
        open={versionToDelete !== null}
        onOpenChange={(open) => !open && setVersionToDelete(null)}
        title={`Delete v${versionToDelete?.version_number ?? ''}?`}
        description="This version will be moved to trash. Its comments and files are kept until the retention period ends."
        confirmLabel="Delete version"
        variant="danger"
        onConfirm={deleteVersion}
      />
    </div>
  )
}

export default function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>
}) {
  const { id: projectId, assetId } = use(params)
  // The right compare pane is the store's current version, which a reload does
  // not keep, so a compare URL names it and the provider opens on it (#299).
  const searchParams = useSearchParams()
  const initialVersionId = searchParams.get('compare') ? searchParams.get('right') : null

  return (
    <ReviewProvider assetId={assetId} initialVersionId={initialVersionId}>
      <ReviewScreenInner projectId={projectId} />
    </ReviewProvider>
  )
}
