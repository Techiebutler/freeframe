'use client'

import * as React from 'react'
import { useState, useEffect, useRef, useCallback } from 'react'
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
import { VersionSwitcher } from '@/components/review/version-switcher'
import { VersionStage } from '@/components/review/version-stage'
import { ShareDialog } from '@/components/review/share-dialog'
import { CompareOverlay } from '@/components/review/compare/compare-overlay'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { useSSE } from '@/hooks/use-sse'
import { api } from '@/lib/api'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { canCompare } from '@/lib/compare-time'
import { useIsNarrow } from '@/hooks/use-is-narrow'
import { FlowView } from '@/components/review/flow-view'
import { SendToAgent, useAgentRequest, useRequestHeartbeat } from '@/components/agents/send-to-agent'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Columns2,
  GitCompareArrows,
  Check,
  Smartphone,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { usePageTitle } from '@/hooks/use-page-title'
import type { Project, AssetResponse, ProjectMember, ProjectRole, FolderTreeNode } from '@/types'


function ReviewScreenInner({ projectId }: { projectId: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { asset, versions, isLoading, refetchComments, refetchVersions } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, seekTo, setFocusedCommentId, setActiveAnnotation } = useReviewStore()
  const { user } = useAuthStore()
  const setExtraCrumbs = useBreadcrumbStore((s) => s.setExtraCrumbs)
  const setLabel = useBreadcrumbStore((s) => s.setLabel)
  usePageTitle(asset?.name ?? null)
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const deepLinkApplied = useRef(false)
  const isNarrow = useIsNarrow()
  const [phoneView, setPhoneView] = useState(false)
  const flow = isNarrow || phoneView

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
  // The server is the authority on what the caller may do here: a role can come
  // from an instance-wide rule with no membership row behind it, and /members is
  // unreadable to anyone who holds no role at all. Fall back to the member list
  // only for the shape of response that predates project.role being populated.
  const currentRole = (project?.role as ProjectRole | null | undefined) ?? currentMember?.role ?? 'viewer'
  const canComment = currentRole !== 'viewer'

  // The briefing's other files (hooks, cut-downs): navigation stays inside this one folder
  const folderKey = asset ? (asset.folder_id ?? 'root') : null
  const { data: allAssets } = useSWR<AssetResponse[]>(
    folderKey ? `/projects/${projectId}/assets?folder_id=${folderKey}` : null,
    (url: string) => api.get<AssetResponse[]>(url),
  )

  // Agents: the owner can hand this folder's comments to the agents paired with its request
  const isOwner = currentRole === 'owner'
  const { request: agentRequest, agents: requestAgents } = useAgentRequest(asset?.folder_id, isOwner)
  useRequestHeartbeat(isOwner ? agentRequest?.id : null)

  // Approve = this version is accepted; the server is the authority, the button just mirrors it
  const { data: approvals, mutate: mutateApprovals } = useSWR<{ version_id: string; status: string }[]>(
    asset ? `/assets/${asset.id}/approvals` : null,
    (url: string) => api.get<{ version_id: string; status: string }[]>(url),
  )
  const [approving, setApproving] = useState(false)

  const {
    comments,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '', currentVersion?.created_at)

  // Keep the version list live: when a new version transcodes, revalidate so it
  // appears/updates in the switcher without a hard refresh (#118). The review
  // provider's versions are plain state, not SWR, so nothing else refetches them.
  const refetchIfThisAsset = (eventAssetId: string) => {
    if (eventAssetId === asset?.id) refetchVersions()
  }
  useSSE(asset?.project_id, {
    onTranscodeProgress: (d) => refetchIfThisAsset(d.asset_id),
    onTranscodeComplete: (d) => refetchIfThisAsset(d.asset_id),
    onTranscodeFailed: (d) => refetchIfThisAsset(d.asset_id),
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
    if ((target as any).timecode_start !== null && (target as any).timecode_start !== undefined) {
      seekTo((target as any).timecode_start, true)
    }
    if ((target as any).annotation?.drawing_data) {
      setActiveAnnotation((target as any).annotation.drawing_data)
    }
  }, [comments, searchParams, seekTo, setFocusedCommentId, setActiveAnnotation])

  // Version-compare overlay: driven entirely by the ?compare= URL param so it
  // survives refresh/deep-link. closeCompare strips all four compare params.
  const compareOpen = Boolean(searchParams.get('compare'))
  const closeCompare = useCallback(() => {
    const p = new URLSearchParams(searchParams.toString())
    p.delete('compare'); p.delete('mode'); p.delete('offA'); p.delete('offB')
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }, [router, pathname, searchParams])

  // Asset navigation
  const currentIndex = allAssets?.findIndex((a) => a.id === asset?.id) ?? -1
  const totalAssets = allAssets?.length ?? 0
  const prevAsset = currentIndex > 0 ? allAssets?.[currentIndex - 1] : null
  const nextAsset = currentIndex < totalAssets - 1 ? allAssets?.[currentIndex + 1] : null

  const approved = !!currentVersion && !!approvals?.some((a) => a.version_id === currentVersion.id && a.status === 'approved')
  const approve = async () => {
    if (!asset || !currentVersion || approved) return
    setApproving(true)
    try {
      await api.post(`/assets/${asset.id}/approve`, { version_id: currentVersion.id })
      await mutateApprovals()
      if (nextAsset) navigateAsset(nextAsset.id)
    } finally {
      setApproving(false)
    }
  }

  const navigateAsset = (assetId: string) => {
    router.push(`/projects/${projectId}/assets/${assetId}`)
  }

  // Keyboard navigation for prev/next asset
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (searchParams.get('compare')) return
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
  }, [prevAsset, nextAsset, searchParams])

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

  const renderMediaViewer = (inkOverlay?: React.ReactNode) => {
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
            compact={!!inkOverlay}
            overlay={
              <>
                <AnnotationOverlay key={focusedCommentId ?? 'none'} />
                {inkOverlay ?? (isDrawingMode && (
                  <AnnotationCanvas
                    onSave={(data) => setAnnotationData(data)}
                  />
                ))}
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

  const flowView = (
    <FlowView
      renderMedia={(ink) => renderMediaViewer(ink)}
      files={(allAssets ?? [asset]).map((a) => ({ id: a.id, name: a.name }))}
      currentFileId={asset.id}
      onSelectFile={navigateAsset}
      getPlayhead={() => useReviewStore.getState().playheadTime}
      onPause={() => seekTo(useReviewStore.getState().playheadTime, true)}
      onSeek={(t) => seekTo(t, true)}
      canComment={canComment}
      onSendNotes={async (notes) => {
        for (const n of notes) await createComment(n.text, n.t, undefined, n.annotation || undefined)
        refetchComments()
      }}
      onApprove={approve}
      approved={approved}
      onExit={isNarrow ? () => router.push(`/projects/${projectId}`) : () => setPhoneView(false)}
      exitLabel={isNarrow ? 'Back' : 'Desktop view'}
    />
  )

  if (isNarrow) {
    return <div className="absolute inset-0 overflow-hidden">{flowView}</div>
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden">
      {/* ─── Top bar (Frame.io style) ──────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        {/* Left: back + breadcrumb */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <Link
            href="/projects"
            aria-label="Back to projects"
            className="flex items-center justify-center h-11 w-11 -ml-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
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
          <VersionSwitcher versions={versions} />
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
                router.replace(`${pathname}?${p.toString()}`, { scroll: false })
              }}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-medium border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Compare versions"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Compare
            </button>
          )}
          <ShareDialog assetId={asset.id} assetName={asset.name} projectId={projectId} asset={asset} />
          {isOwner && agentRequest && requestAgents.length > 0 && (
            <SendToAgent requestId={agentRequest.id} agents={requestAgents} />
          )}
          {canComment && (
            <button
              onClick={approve}
              disabled={!versionReady || approved || approving}
              aria-live="polite"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 h-8 text-xs font-semibold transition-colors',
                approved
                  ? 'bg-status-success/15 text-status-success cursor-default'
                  : 'bg-accent text-white hover:bg-accent/90 disabled:opacity-50',
              )}
              title={nextAsset ? 'Approve and open the next file' : 'Approve this version'}
            >
              {approving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {approved ? 'Approved' : 'Approve'}
            </button>
          )}
          <button
            onClick={() => setPhoneView((p) => !p)}
            aria-pressed={phoneView}
            className={cn(
              'inline-flex h-11 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
              phoneView ? 'bg-bg-hover text-text-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
            Phone view
          </button>
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

      {/* Where the newest version is: upload, processing, review */}
      {asset && <VersionStage assetId={asset.id} versions={versions} />}

      {/* ─── Main content: viewer + sidebar ────────────────────────────── */}
      {compareOpen && asset && currentVersion && canCompare(asset.asset_type, versions) ? (
        <CompareOverlay asset={asset} versions={versions} rightVersion={currentVersion} onClose={closeCompare} canComment={canComment} />
      ) : phoneView ? (
        <div className="flex min-h-0 flex-1 justify-center bg-bg-secondary">
          <div className="h-full w-full max-w-[430px] border-x border-border">{flowView}</div>
        </div>
      ) : (
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: viewer column */}
        <div className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0">
          {/* Media viewer */}
          {renderMediaViewer()}

          {/* The briefing's files: switch hooks without leaving the player */}
          {totalAssets > 1 && (
            <nav aria-label="Files in this briefing" className="shrink-0 border-t border-border bg-bg-secondary px-3 py-2">
              <ul className="flex gap-2 overflow-x-auto">
                {allAssets!.map((a) => (
                  <li key={a.id} className="shrink-0">
                    <button
                      onClick={() => a.id !== asset.id && navigateAsset(a.id)}
                      aria-current={a.id === asset.id ? 'true' : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-lg p-1 pr-3 min-h-11 max-w-[220px] text-left transition-colors',
                        a.id === asset.id ? 'bg-bg-hover ring-1 ring-accent' : 'hover:bg-bg-hover',
                      )}
                    >
                      <span className="h-12 w-[27px] shrink-0 overflow-hidden rounded bg-bg-tertiary">
                        {a.thumbnail_url && <img src={a.thumbnail_url} alt="" className="h-full w-full object-cover" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-text-primary">{a.name}</span>
                        {a.latest_version && <span className="block text-[11px] text-text-tertiary">v{a.latest_version.version_number}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>

        {/* Right: comments sidebar */}
        {sidebarOpen && (
          <div className="w-[360px] flex flex-col border-l border-border bg-bg-secondary shrink-0 animate-in slide-in-from-right-2 duration-150">
            {/* Content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <>
                  <CommentPanel
                    comments={comments as any}
                    currentUserId={user?.id}
                    canComment={canComment}
                    onResolve={resolveComment}
                    onDelete={deleteComment}
                    onAddReaction={addReaction}
                    onRemoveReaction={removeReaction}
                    onReply={() => {}}
                    onSubmitReply={handleSubmitReply}
                  />
                  {canComment ? (
                    <CommentInput
                      assetId={asset.id}
                      projectId={asset.project_id}
                      assetType={asset.asset_type}
                      onSubmit={handleSubmitComment}
                      annotationData={annotationData}
                    />
                  ) : (
                    <div className="px-4 py-3 border-t border-border shrink-0">
                      <p className="text-xs text-text-tertiary text-center">
                        View-only access. Comments are disabled.
                      </p>
                    </div>
                  )}
              </>
            </div>
          </div>
        )}
      </div>
      )}
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
