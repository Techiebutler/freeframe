'use client'

/**
 * The review screen a share link shows for one asset.
 *
 * Extracted from folder-share-viewer so the single-asset share path can render
 * the same thing the folder path does. Those were two different component trees:
 * the folder path reused the real review stack (ReviewProvider, VideoPlayer,
 * CommentInput, VersionSwitcher) while a single-asset link got a bespoke player
 * with a plain textarea, no timecode control and no version concept at all
 * (#117, #123).
 */
import * as React from 'react'
import { ArrowLeft, Download, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useReview, type CreateCommentPayload } from '@/components/review/review-provider'
import { useReviewStore } from '@/stores/review-store'
import type { SharePermission } from '@/types'
import { handleDownload } from './share-download'

export function ShareReviewScreen({
  token, shareSession, assetId, assetName, permission, allowDownload, showVersions, onBack,
}: {
  token: string; shareSession?: string | null; assetId: string; assetName: string; permission: SharePermission; allowDownload: boolean; showVersions: boolean; onBack?: () => void
}) {
  const [ReviewProvider, setProvider] = React.useState<any>(null)
  const [VideoPlayer, setVideoPlayer] = React.useState<any>(null)
  const [ImageViewer, setImageViewer] = React.useState<any>(null)
  const [AudioPlayer, setAudioPlayer] = React.useState<any>(null)
  const [CommentPanel, setCommentPanel] = React.useState<any>(null)
  const [CommentInput, setCommentInput] = React.useState<any>(null)
  const [VersionSwitcher, setVersionSwitcher] = React.useState<any>(null)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    // Dynamic import to avoid SSR issues
    Promise.all([
      import('@/components/review/review-provider'),
      import('@/components/review/video-player'),
      import('@/components/review/image-viewer'),
      import('@/components/review/audio-player'),
      import('@/components/review/comment-panel'),
      import('@/components/review/comment-input'),
      import('@/components/review/version-switcher'),
    ]).then(([provider, video, image, audio, comments, input, versionSwitcher]) => {
      setProvider(() => provider.ReviewProvider)
      setVideoPlayer(() => video.VideoPlayer)
      setImageViewer(() => image.ImageViewer)
      setAudioPlayer(() => audio.AudioPlayer)
      setCommentPanel(() => comments.CommentPanel)
      setCommentInput(() => input.CommentInput)
      setVersionSwitcher(() => versionSwitcher.VersionSwitcher)
      setLoaded(true)
    })
  }, [])

  if (!loaded || !ReviewProvider) {
    return <div className="flex items-center justify-center h-screen bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <ReviewProvider assetId={assetId} shareToken={token} shareSession={shareSession}>
      <ShareReviewInner
        token={token}
        shareSession={shareSession}
        assetName={assetName}
        permission={permission}
        allowDownload={allowDownload}
        showVersions={showVersions}
        onBack={onBack}
        VideoPlayer={VideoPlayer}
        ImageViewer={ImageViewer}
        AudioPlayer={AudioPlayer}
        CommentPanel={CommentPanel}
        CommentInput={CommentInput}
        VersionSwitcher={VersionSwitcher}
      />
    </ReviewProvider>
  )
}

function ShareReviewInner({
  token, shareSession, assetName, permission, allowDownload, showVersions, onBack,
  VideoPlayer, ImageViewer, AudioPlayer, CommentPanel, CommentInput, VersionSwitcher,
}: any) {
  const { asset, versions, isLoading, comments, refetchComments, addComment } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId } = useReviewStore()
  const [sidebarOpen, setSidebarOpen] = React.useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches)
  const [activeTab, setActiveTab] = React.useState<'comments' | 'fields'>('comments')
  const [AnnotationOverlay, setAnnotationOverlay] = React.useState<any>(null)
  const [AnnotationCanvas, setAnnotationCanvas] = React.useState<any>(null)

  React.useEffect(() => {
    Promise.all([
      import('@/components/review/annotation-overlay'),
      import('@/components/review/annotation-canvas'),
    ]).then(([overlayMod, canvasMod]) => {
      setAnnotationOverlay(() => overlayMod.AnnotationOverlay)
      setAnnotationCanvas(() => canvasMod.AnnotationCanvas)
    })
  }, [])

  const canComment = permission === 'comment' || permission === 'approve'
  const versionReady = currentVersion?.processing_status === 'ready'

  // Guest identity flow for non-authenticated users
  const [guestIdentity, setGuestIdentity] = React.useState<{ name: string; email: string } | null>(null)
  const [showGuestPrompt, setShowGuestPrompt] = React.useState(false)
  const pendingCommentRef = React.useRef<{ body: string; timecodeStart?: number; timecodeEnd?: number; annotationData?: Record<string, unknown> } | null>(null)
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem('ff_guest_identity')
      if (stored) setGuestIdentity(JSON.parse(stored))
    } catch {}
  }, [])
  const isLoggedIn = typeof window !== 'undefined' && !!localStorage.getItem('ff_access_token')

  const submitComment = React.useCallback(async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>) => {
    const payload: CreateCommentPayload = { body }
    if (currentVersion?.id) payload.version_id = currentVersion.id
    if (timecodeStart != null) payload.timecode_start = timecodeStart
    if (timecodeEnd != null) payload.timecode_end = timecodeEnd
    if (annotationData) payload.annotation = { drawing_data: annotationData }
    await addComment(payload)
    refetchComments().catch(() => {})
  }, [addComment, currentVersion, refetchComments])

  const handleGuestIdentitySave = React.useCallback(async (name: string, email: string) => {
    const identity = { name, email }
    setGuestIdentity(identity)
    localStorage.setItem('ff_guest_identity', JSON.stringify(identity))
    setShowGuestPrompt(false)

    // Auto-submit the pending comment
    if (pendingCommentRef.current) {
      const { body, timecodeStart, timecodeEnd, annotationData } = pendingCommentRef.current
      pendingCommentRef.current = null
      setTimeout(() => submitComment(body, timecodeStart, timecodeEnd, annotationData), 50)
    }
  }, [submitComment])

  if (isLoading || !asset) {
    return <div className="flex items-center justify-center h-screen bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
      {/* Top bar — same style as project review */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {/* A single-asset link has no grid to go back to, so there is nothing
              for this to do there. */}
          {onBack && (
            <button onClick={onBack} className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <span className="text-[13px] font-medium text-text-primary truncate">{assetName}</span>
        </div>
        <div className="flex items-center gap-2">
          {showVersions && VersionSwitcher && versions.length > 0 && (
            <VersionSwitcher versions={versions} />
          )}
          {allowDownload && (
            <button className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors" onClick={() => handleDownload(token, asset.id, shareSession)}>
              <Download className="h-3 w-3" /> Download
            </button>
          )}
          <button onClick={() => setSidebarOpen(v => !v)} className="flex items-center justify-center h-8 w-8 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
            {sidebarOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Main: viewer + sidebar */}
      <div className="relative flex flex-1 overflow-hidden min-h-0">
        {/* Media viewer — reuses project components */}
        <div className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0">
          {asset.asset_type === 'video' && versionReady && VideoPlayer ? (
            <VideoPlayer
              assetId={asset.id}
              comments={comments}
              className="flex-1"
              initialStreamUrl={(asset as any).stream_url}
              overlay={
                <>
                  {AnnotationOverlay && <AnnotationOverlay key={focusedCommentId ?? 'none'} />}
                  {isDrawingMode && AnnotationCanvas && <AnnotationCanvas />}
                </>
              }
            />
          ) : asset.asset_type === 'audio' && versionReady && AudioPlayer ? (
            <AudioPlayer asset={asset} version={currentVersion} comments={comments} className="flex-1" />
          ) : (asset.asset_type === 'image' || asset.asset_type === 'image_carousel') && versionReady && ImageViewer ? (
            <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
              <ImageViewer
                asset={asset}
                version={currentVersion}
                annotationCanvas={
                  <>
                    {AnnotationOverlay && <AnnotationOverlay key={focusedCommentId ?? 'none'} />}
                    {isDrawingMode && AnnotationCanvas && <AnnotationCanvas />}
                  </>
                }
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
            </div>
          )}
        </div>

        {/* Right sidebar — reuses project comment panel */}
        {sidebarOpen && (
          <div className="w-full md:w-[360px] absolute inset-y-0 right-0 z-20 md:static md:inset-auto flex flex-col border-l-0 md:border-l border-border bg-bg-secondary shrink-0">
            <div className="px-4 pt-3 pb-2 shrink-0">
              <div className="flex items-center bg-bg-tertiary rounded-lg p-0.5">
                <button onClick={() => setActiveTab('comments')} className={`flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all ${activeTab === 'comments' ? 'bg-bg-hover text-text-primary shadow-sm' : 'text-text-tertiary'}`}>
                  Comments
                </button>
                <button onClick={() => setActiveTab('fields')} className={`flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all ${activeTab === 'fields' ? 'bg-bg-hover text-text-primary shadow-sm' : 'text-text-tertiary'}`}>
                  Fields
                </button>
              </div>
            </div>

            {activeTab === 'comments' && CommentPanel && (
              <>
                <CommentPanel
                  comments={comments}
                  onResolve={() => {}}
                  onDelete={() => {}}
                  onAddReaction={() => {}}
                  onRemoveReaction={() => {}}
                  onReply={() => {}}
                  onSubmitReply={async () => {}}
                />
                {canComment && CommentInput && (
                  <CommentInput
                    assetId={asset.id}
                    projectId=""
                    assetType={asset.asset_type}
                    onSubmit={async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>) => {
                      const hasAuth = !!localStorage.getItem('ff_access_token')
                      const hasGuest = !!localStorage.getItem('ff_guest_identity')
                      if (!hasAuth && !hasGuest) {
                        pendingCommentRef.current = { body, timecodeStart, timecodeEnd, annotationData }
                        setShowGuestPrompt(true)
                        return
                      }
                      await submitComment(body, timecodeStart, timecodeEnd, annotationData)
                    }}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Guest identity prompt */}
      {showGuestPrompt && (
        <GuestIdentityPrompt
          onSave={handleGuestIdentitySave}
          onCancel={() => { setShowGuestPrompt(false); pendingCommentRef.current = null }}
        />
      )}
    </div>
  )
}

// ─── Guest Identity Prompt ───────────────────────────────────────────────────

function GuestIdentityPrompt({ onSave, onCancel }: { onSave: (name: string, email: string) => void; onCancel: () => void }) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Leave a comment</h3>
        <p className="text-xs text-text-tertiary mb-4">Enter your name and email to comment on this shared asset.</p>
        <div className="space-y-3">
          <input
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            autoFocus
          />
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
        </div>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
            Cancel
          </button>
          <button
            disabled={!name.trim() || !email.trim()}
            onClick={() => onSave(name.trim(), email.trim())}
            className="px-4 py-1.5 rounded-md bg-accent text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

