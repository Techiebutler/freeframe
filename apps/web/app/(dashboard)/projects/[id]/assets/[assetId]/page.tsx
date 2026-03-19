'use client'

import { use, useState } from 'react'
import { ReviewProvider, useReview } from '@/components/review/review-provider'
import { VideoPlayer } from '@/components/review/video-player'
import { AudioPlayer } from '@/components/review/audio-player'
import { ImageViewer } from '@/components/review/image-viewer'
import { AnnotationCanvas } from '@/components/review/annotation-canvas'
import { CommentPanel } from '@/components/review/comment-panel'
import { CommentInput } from '@/components/review/comment-input'
import { ApprovalBar } from '@/components/review/approval-bar'
import { VersionSwitcher } from '@/components/review/version-switcher'
import { ShareDialog } from '@/components/review/share-dialog'
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { ArrowLeft, MessageSquare, Info } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

function ReviewScreenInner() {
  const { asset, versions, isLoading, refetchComments } = useReview()
  const { currentVersion, isDrawingMode } = useReviewStore()
  const { user } = useAuthStore()
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'comments' | 'fields'>('comments')

  const {
    comments,
    createComment,
    resolveComment,
    deleteComment,
    addReaction,
    removeReaction,
  } = useComments(asset?.id || '', currentVersion?.id || '')

  if (isLoading || !asset) {
    return (
      <div className="flex h-full items-center justify-center animate-fade-in">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-xs text-text-tertiary animate-pulse-soft">Loading asset...</span>
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
  ) => {
    await createComment(
      body,
      timecodeStart,
      timecodeEnd,
      annotation || annotationData || undefined,
      parentId || replyToId || undefined,
    )
    setAnnotationData(null)
    setReplyToId(null)
    refetchComments()
  }

  const renderMediaViewer = () => {
    switch (asset.asset_type) {
      case 'video':
        return (
          <div className="relative w-full">
            <VideoPlayer
              assetId={asset.id}
              comments={comments}
            />
            {isDrawingMode && (
              <AnnotationCanvas
                onSave={(data) => setAnnotationData(data)}
              />
            )}
          </div>
        )
      case 'audio':
        return (
          <AudioPlayer
            asset={asset}
            version={currentVersion}
            comments={comments}
          />
        )
      case 'image':
      case 'image_carousel':
        return (
          <ImageViewer
            asset={asset}
            version={currentVersion as any}
            annotationCanvas={
              isDrawingMode ? (
                <AnnotationCanvas
                  onSave={(data) => setAnnotationData(data)}
                />
              ) : undefined
            }
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-bg-secondary/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${asset.project_id}`}
            className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-all duration-150"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-semibold text-text-primary">{asset.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <ShareDialog assetId={asset.id} assetName={asset.name} />
          <VersionSwitcher versions={versions} />
        </div>
      </div>

      {/* Approval bar */}
      {currentVersion && (
        <ApprovalBar
          assetId={asset.id}
          versionId={currentVersion.id}
          currentUserId={user?.id}
        />
      )}

      {/* Main content: viewer + comments */}
      <div className="flex flex-1 overflow-hidden">
        {/* Media viewer */}
        <div className="flex-1 flex items-center justify-center bg-bg-primary p-4 overflow-hidden animate-fade-in">
          {renderMediaViewer()}
        </div>

        {/* Sidebar panel */}
        <div className="w-[380px] flex flex-col border-l border-border bg-bg-secondary">
          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border px-2 pt-2 bg-bg-tertiary">
            <button
              onClick={() => setActiveTab('comments')}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
                activeTab === 'comments' 
                  ? "border-accent text-accent" 
                  : "border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-t-md"
              )}
            >
              <MessageSquare className="h-4 w-4" />
              Comments
            </button>
            <button
              onClick={() => setActiveTab('fields')}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-b-2",
                activeTab === 'fields' 
                  ? "border-accent text-accent" 
                  : "border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded-t-md"
              )}
            >
              <Info className="h-4 w-4" />
              Fields
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col min-h-0">
            {activeTab === 'comments' ? (
              <>
                <CommentPanel
                  comments={comments as any}
                  currentUserId={user?.id}
                  onResolve={resolveComment}
                  onDelete={deleteComment}
                  onAddReaction={addReaction}
                  onRemoveReaction={removeReaction}
                  onReply={(parentId) => setReplyToId(parentId)}
                />
                <CommentInput
                  assetId={asset.id}
                  projectId={asset.project_id}
                  onSubmit={handleSubmitComment}
                  annotationData={annotationData}
                  replyToId={replyToId}
                  onCancelReply={() => setReplyToId(null)}
                />
              </>
            ) : (
              <div className="p-6 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary mb-3">
                  <Info className="h-6 w-6 text-text-tertiary" />
                </div>
                <h3 className="text-sm font-medium text-text-primary mb-1">Asset Info & Fields</h3>
                <p className="text-xs text-text-tertiary">
                  Custom fields and asset metadata will appear here.
                </p>
                
                <div className="mt-6 space-y-4 text-left">
                  <div>
                    <label className="text-xs font-medium text-text-secondary">Type</label>
                    <p className="text-sm text-text-primary capitalize mt-1">{asset.asset_type}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary">Created By</label>
                    <p className="text-sm text-text-primary mt-1">{asset.created_by}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-text-secondary">Status</label>
                    <div className="mt-1 flex items-center">
                      <span className="inline-flex items-center rounded-full bg-status-warning/10 px-2 py-0.5 text-xs font-medium text-status-warning">
                        Needs Review
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ReviewPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>
}) {
  const { assetId } = use(params)

  return (
    <ReviewProvider assetId={assetId}>
      <ReviewScreenInner />
    </ReviewProvider>
  )
}
