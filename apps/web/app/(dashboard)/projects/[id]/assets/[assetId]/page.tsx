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
import { useReviewStore } from '@/stores/review-store'
import { useAuthStore } from '@/stores/auth-store'
import { useComments } from '@/hooks/use-comments'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'

function ReviewScreenInner() {
  const { asset, versions, isLoading, refetchComments } = useReview()
  const { currentVersion, isDrawingMode } = useReviewStore()
  const { user } = useAuthStore()
  const [annotationData, setAnnotationData] = useState<Record<string, unknown> | null>(null)
  const [replyToId, setReplyToId] = useState<string | null>(null)

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
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
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
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${asset.project_id}`}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-sm font-medium">{asset.name}</h1>
        </div>
        <VersionSwitcher versions={versions} />
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
        <div className="flex-1 flex items-center justify-center bg-bg-primary p-4 overflow-hidden">
          {renderMediaViewer()}
        </div>

        {/* Comment panel */}
        <div className="w-[380px] flex flex-col border-l border-border bg-bg-secondary">
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
