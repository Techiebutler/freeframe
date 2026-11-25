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
import { ArrowLeft, ChevronDown, Download, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useReview, type CreateCommentPayload } from '@/components/review/review-provider'
import { useReviewStore } from '@/stores/review-store'
import { MobileCommentSheet, PEEK_PX, type SheetState } from '@/components/review/mobile-comment-sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useMediaTransport } from '@/hooks/use-media-transport'
import { formatTimecode } from '@/lib/utils'
import type { SharePermission } from '@/types'
import { fetchShareDownloadOptions, handleDownload } from './share-download'
import { DownloadMenu } from '@/components/shared/download-menu'
import { ShareBrandMark } from './share-brand-mark'
import { VERDICT_ROW_CLASS } from '@/components/review/verdict-controls'
import { continueAsGuest, hasStoredToken, isSignInExpired, readGuestIdentity } from '@/lib/share-request'
import { ShareSignInActions, ShareVerdictControls } from './share-verdict-controls'

/** Signed in, or a guest who has already given a name and email. */
function hasIdentity(): boolean {
  return hasStoredToken() || !!readGuestIdentity()
}

export function ShareReviewScreen({
  token, shareSession, assetId, assetName, permission, allowDownload, showVersions, theme = 'dark', projectLogoUrl, onBack,
}: {
  token: string; shareSession?: string | null; assetId: string; assetName: string; permission: SharePermission; allowDownload: boolean; showVersions: boolean
  /** The link's theme, which the page renders in; picks the logo variant. Dark, the share pages' default, when not given. */
  theme?: 'dark' | 'light'
  /** The project's logo from the link's branding, shown ahead of the instance's. */
  projectLogoUrl?: string | null
  onBack?: () => void
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
    return <div className="flex items-center justify-center h-dvh bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
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
        theme={theme}
        projectLogoUrl={projectLogoUrl}
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
  token, shareSession, assetName, permission, allowDownload, showVersions, theme, projectLogoUrl, onBack,
  VideoPlayer, ImageViewer, AudioPlayer, CommentPanel, CommentInput, VersionSwitcher,
}: any) {
  const { asset, versions, isLoading, comments, refetchComments, addComment, togglePlayback } = useReview()
  const { currentVersion, isDrawingMode, focusedCommentId, playheadTime } = useReviewStore()
  // An asset opens on its comments: that pane is the reason an asset link
  // exists. The folder grid is the surface that starts closed. Below `md` the
  // sheet's peek band stands in for it, as on the project review page.
  const [sidebarOpen, setSidebarOpen] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  )

  // Same rule as the project review screen: a bottom sheet on a portrait phone
  // so the media stays in view, the side-by-side column on a landscape one.
  const isWide = useMediaQuery('(min-width: 768px)')
  const isLandscape = useMediaQuery('(orientation: landscape)')
  const useSheet = !isWide && !isLandscape
  // Where the verdict buttons go, by the asset page's rule: the top bar from
  // `lg` up, and below that a row of their own under it. Clients often approve
  // from a phone, and the top bar there is already full.
  const verdictsInTopBar = useMediaQuery('(min-width: 1024px)')
  const canComment = permission === 'comment' || permission === 'approve'
  const versionReady = currentVersion?.processing_status === 'ready'
  // Only on a version the link shows (the API answers 404 for one still
  // processing), and only once the store holds this asset's version: in the
  // folder viewer it can briefly hold the previous asset's after a switch.
  const showsVerdicts =
    permission === 'approve' && !!asset && versionReady && currentVersion?.asset_id === asset.id
  const showsVerdictRow = showsVerdicts && !verdictsInTopBar
  const [sheetState, setSheetState] = React.useState<SheetState>('peek')
  const [sheetHeight, setSheetHeight] = React.useState(PEEK_PX)
  // One expression for the top-bar toggle's icon and its label, so the two
  // cannot disagree about whether the panel is up.
  const panelShown = useSheet ? sheetState !== 'peek' : sidebarOpen
  const { isPlaying, togglePlay, mediaRootRef } = useMediaTransport({ toggleVideo: togglePlayback })
  const reviewRootRef = React.useRef<HTMLDivElement>(null)
  const handleSheetHeight = React.useCallback((px: number) => setSheetHeight(px), [])

  // Drawing collapses the sheet to `compose`, which drops the comment list and
  // leaves only the composer and the drawing toolbar. Someone marking up a
  // frame is not reading older comments, and on a wide source the media is
  // short enough that the list was taking room the drawing surface needed.
  // Restored to `peek` on the way out rather than to whatever it was, so the
  // media is never left half covered by a sheet the user did not reopen.
  React.useEffect(() => {
    if (!useSheet) return
    setSheetState(isDrawingMode ? 'compose' : 'peek')
  }, [isDrawingMode, useSheet])

  // The sheet OVERLAYS the media, so the media has to fit in what is left above
  // it or the picture gets cropped: the stage is sized from the media's own
  // ratio (#344) and therefore has no slack to slide within, which is what made
  // the earlier translate-based version clip the top of the frame while the
  // sheet covered the bottom.
  //
  // Capping instead of shifting means the whole frame stays visible at every
  // sheet state and the picture scales rather than moves. 60px is the control
  // stack below it (12px progress wrapper + 48px transport row).
  React.useEffect(() => {
    const root = reviewRootRef.current
    if (!root) return
    if (!useSheet) {
      root.style.removeProperty('--ff-stage-max')
      return
    }
    const available = root.clientHeight - sheetHeight - 60
    root.style.setProperty('--ff-stage-max', `${Math.max(80, available)}px`)
    // The verdict row changes `root.clientHeight`, and it arrives after the
    // layout (it waits on the version), so it is measured again.
  }, [useSheet, sheetHeight, showsVerdictRow])

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


  // Guest identity flow for non-authenticated users
  const [guestIdentity, setGuestIdentity] = React.useState<{ name: string; email: string } | null>(null)
  const [showGuestPrompt, setShowGuestPrompt] = React.useState(false)
  // What was typed before the guest had a name. A reply also carries its parent
  // and the promise its InlineReplyInput is waiting on, so the typed text stays
  // in the box until it is really sent (or the prompt is dismissed).
  const pendingCommentRef = React.useRef<{
    body: string; timecodeStart?: number; timecodeEnd?: number; annotationData?: Record<string, unknown>
    parentId?: string
    settle?: { resolve: () => void; reject: (e: Error) => void }
  } | null>(null)
  React.useEffect(() => setGuestIdentity(readGuestIdentity()), [])
  const isLoggedIn = typeof window !== 'undefined' && !!localStorage.getItem('ff_access_token')

  // A verdict asks who the guest is through the same prompt a comment does.
  // The press waits on this promise: the prompt's Continue resolves it with the
  // identity just saved, its Cancel with null, which sends nothing.
  const identityResolver = React.useRef<((identity: { name: string; email: string } | null) => void) | null>(null)
  const [promptPurpose, setPromptPurpose] = React.useState<'comment' | 'verdict'>('comment')
  const settleIdentity = React.useCallback((identity: { name: string; email: string } | null) => {
    const resolve = identityResolver.current
    identityResolver.current = null
    resolve?.(identity)
  }, [])
  const requestIdentity = React.useCallback((purpose: keyof typeof PROMPT_COPY = 'verdict') => {
    // Only one prompt at a time: an older ask is answered "cancelled".
    settleIdentity(null)
    return new Promise<{ name: string; email: string } | null>((resolve) => {
      identityResolver.current = resolve
      setPromptPurpose(purpose)
      setShowGuestPrompt(true)
    })
  }, [settleIdentity])

  const signInResolver = React.useRef<((asGuest: boolean) => void) | null>(null)
  const [showSignInPrompt, setShowSignInPrompt] = React.useState(false)
  const settleSignIn = React.useCallback((asGuest: boolean) => {
    const resolve = signInResolver.current
    signInResolver.current = null
    setShowSignInPrompt(false)
    resolve?.(asGuest)
  }, [])
  const askToContinue = React.useCallback(() => new Promise<boolean>((resolve) => {
    signInResolver.current?.(false)
    signInResolver.current = resolve
    setShowSignInPrompt(true)
  }), [])

  // A press still waiting when the screen goes is let go, not left hanging.
  React.useEffect(() => () => {
    settleIdentity(null)
    signInResolver.current?.(false)
    signInResolver.current = null
  }, [settleIdentity])

  const submitComment = React.useCallback(async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>, parentId?: string) => {
    const payload: CreateCommentPayload = { body }
    if (currentVersion?.id) payload.version_id = currentVersion.id
    if (parentId) payload.parent_id = parentId
    if (timecodeStart != null) payload.timecode_start = timecodeStart
    if (timecodeEnd != null) payload.timecode_end = timecodeEnd
    if (annotationData) payload.annotation = { drawing_data: annotationData }
    try {
      await addComment(payload)
    } catch (err) {
      if (!isSignInExpired(err) || !(await askToContinue())) throw err
      if (!readGuestIdentity() && !(await requestIdentity('comment'))) throw err
      continueAsGuest(err)
      await addComment(payload)
    }
    // The optimistic append only ever shows top-level rows (CommentPanel renders
    // replies from their parent), so a reply is not on screen until the refetch.
    if (parentId) await refetchComments().catch(() => {})
    else refetchComments().catch(() => {})
  }, [addComment, askToContinue, currentVersion, refetchComments, requestIdentity])

  const submitReply = React.useCallback(async (parentId: string, body: string) => {
    if (!hasIdentity()) {
      // Resolved once the guest names themselves and the reply is sent; until
      // then the reply box keeps what was typed.
      return new Promise<void>((resolve, reject) => {
        pendingCommentRef.current = { body, parentId, settle: { resolve, reject } }
        setShowGuestPrompt(true)
      })
    }
    await submitComment(body, undefined, undefined, undefined, parentId)
  }, [submitComment])

  const handleGuestIdentitySave = React.useCallback(async (name: string, email: string) => {
    const identity = { name, email }
    setGuestIdentity(identity)
    localStorage.setItem('ff_guest_identity', JSON.stringify(identity))
    setShowGuestPrompt(false)
    setPromptPurpose('comment')
    settleIdentity(identity)

    // Auto-submit the pending comment
    if (pendingCommentRef.current) {
      const { body, timecodeStart, timecodeEnd, annotationData, parentId, settle } = pendingCommentRef.current
      pendingCommentRef.current = null
      setTimeout(() => {
        submitComment(body, timecodeStart, timecodeEnd, annotationData, parentId)
          .then(() => settle?.resolve())
          .catch((e) => settle?.reject(e instanceof Error ? e : new Error('Failed to post comment')))
      }, 50)
    }
  }, [submitComment, settleIdentity])

  if (isLoading || !asset) {
    return <div className="flex items-center justify-center h-dvh bg-bg-primary"><Loader2 className="h-8 w-8 animate-spin text-text-tertiary" /></div>
  }

  // Defined once so the desktop sidebar and the mobile sheet render the same
  // nodes and cannot drift apart.
  const panelTabs = (
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
  )

  const commentPanelNode = CommentPanel ? (
    <CommentPanel
      comments={comments}
      // A guest has no access token, and `exportComments` sends
      // nothing else, so the control could only ever 401 here.
      canExport={false}
      onResolve={() => {}}
      onDelete={() => {}}
      onAddReaction={() => {}}
      onRemoveReaction={() => {}}
      onReply={() => {}}
      // Undefined on a view-only link, which also hides Reply (#439).
      onSubmitReply={canComment ? submitReply : undefined}
    />
  ) : null

  const commentInputNode = canComment && CommentInput ? (
    <CommentInput
      assetId={asset.id}
      projectId=""
      assetType={asset.asset_type}
      allowInternal={false}
      onSubmit={async (body: string, timecodeStart?: number, timecodeEnd?: number, annotationData?: Record<string, unknown>) => {
        if (!hasIdentity()) {
          pendingCommentRef.current = { body, timecodeStart, timecodeEnd, annotationData }
          setShowGuestPrompt(true)
          return
        }
        await submitComment(body, timecodeStart, timecodeEnd, annotationData)
      }}
    />
  ) : null

  // Always names the asset: a folder or project link has no other way to say
  // which one the verdict is about.
  const verdictControls = (variant: 'toolbar' | 'row') =>
    currentVersion ? (
      <ShareVerdictControls
        token={token}
        assetId={asset.id}
        versionId={currentVersion.id}
        shareSession={shareSession}
        guestIdentity={guestIdentity}
        requestIdentity={requestIdentity}
        variant={variant}
      />
    ) : null

  return (
    <div className="flex flex-col h-dvh bg-bg-primary text-text-primary pl-safe pr-safe">
      {/* Top bar — same style as project review */}
      <div className="flex items-center justify-between border-b border-border px-3 h-12 bg-bg-secondary shrink-0">
        <div className="flex items-center gap-1 sm:gap-2 min-w-0 flex-1">
          {/* A single-asset link has no grid to go back to, so there is nothing
              for this to do there. */}
          {onBack && (
            <button onClick={onBack} className="flex items-center justify-center h-7 w-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <ShareBrandMark theme={theme} projectLogoUrl={projectLogoUrl} />
          {/* The name gives way last: the logo shrinks first (ShareBrandMark),
              and Download is icon-only on a phone. */}
          <span className="text-[13px] font-medium text-text-primary truncate min-w-[4rem]">{assetName}</span>
        </div>
        <div className="flex items-center gap-2">
          {showsVerdicts && verdictsInTopBar && verdictControls('toolbar')}
          {showVersions && VersionSwitcher && versions.length > 0 && (
            <VersionSwitcher versions={versions} />
          )}
          {allowDownload && (
            <DownloadMenu
              load={() => fetchShareDownloadOptions(token, asset.id, shareSession)}
              onPick={(rendition) => handleDownload(token, asset.id, shareSession, rendition)}
            >
              <button aria-label="Download" className="flex items-center gap-1.5 h-7 px-2 sm:px-3 rounded-md text-xs font-medium text-text-inverse bg-accent hover:bg-accent-hover transition-colors">
                <Download className="h-3 w-3" /> <span className="hidden sm:inline">Download</span>
                <ChevronDown className="h-3 w-3 opacity-70" />
              </button>
            </DownloadMenu>
          )}
          <button onClick={() => (useSheet ? setSheetState(st => (st === 'peek' ? 'half' : 'peek')) : setSidebarOpen(v => !v))} title={panelShown ? 'Hide panel' : 'Show panel'} className="flex items-center justify-center h-8 w-8 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
            {panelShown ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Verdicts on a phone or a narrow window: a row of their own, a fixed
          height whatever the data, so nothing in it can move the media. */}
      {showsVerdictRow && (
        <div
          data-testid="share-verdict-row"
          className={VERDICT_ROW_CLASS}
        >
          {verdictControls('row')}
        </div>
      )}

      {/* Main: viewer + sidebar */}
      {/* pb-14 reserves the sheet's peek band so the player's own transport
          row stays on screen and tappable underneath it. */}
      <div
        ref={reviewRootRef}
        className={`relative flex flex-1 overflow-hidden min-h-0 ${useSheet ? 'pb-14' : ''}`}
      >
        {/* Media viewer — reuses project components */}
        <div
          ref={mediaRootRef}
          className="flex-1 flex flex-col bg-bg-primary overflow-hidden min-w-0"
        >
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

        {/* Right sidebar. A column beside the media above `md` and on a
            landscape phone; below that the same nodes go into the sheet. */}
        {sidebarOpen && !useSheet && (
          <div className="w-full md:w-[360px] absolute inset-y-0 right-0 z-20 md:static md:inset-auto max-md:landscape:static max-md:landscape:inset-auto max-md:landscape:w-[45%] max-md:landscape:max-w-[360px] flex flex-col border-l-0 md:border-l max-md:landscape:border-l border-border bg-bg-secondary shrink-0">
            {panelTabs}
            {activeTab === 'comments' && (
              <>
                {commentPanelNode}
                {commentInputNode}
              </>
            )}
          </div>
        )}
      </div>

      {useSheet && (
        <MobileCommentSheet
          state={sheetState}
          onStateChange={setSheetState}
          onHeightChange={handleSheetHeight}
          commentCount={comments.length}
          isPlaying={isPlaying}
          onTogglePlay={togglePlay}
          currentTime={
            asset.asset_type === 'video' || asset.asset_type === 'audio'
              ? formatTimecode(playheadTime ?? 0)
              : ''
          }
          lockedToCompose={isDrawingMode}
          composer={activeTab === 'comments' ? commentInputNode : undefined}
        >
          {panelTabs}
          {activeTab === 'comments' ? commentPanelNode : null}
        </MobileCommentSheet>
      )}

      {showSignInPrompt && (
        <SharePrompt
          title="Your sign-in has expired."
          description="Sign in again or continue as a guest."
        >
          <ShareSignInActions
            onContinueAsGuest={() => settleSignIn(true)}
            onCancel={() => settleSignIn(false)}
          />
        </SharePrompt>
      )}

      {/* Guest identity prompt */}
      {showGuestPrompt && (
        <GuestIdentityPrompt
          purpose={promptPurpose}
          onSave={handleGuestIdentitySave}
          onCancel={() => {
            setShowGuestPrompt(false)
            setPromptPurpose('comment')
            settleIdentity(null)
            // A quiet abort: the reply box keeps its text and shows no error.
            pendingCommentRef.current?.settle?.reject(new Error(''))
            pendingCommentRef.current = null
          }}
        />
      )}
    </div>
  )
}

// ─── Guest Identity Prompt ───────────────────────────────────────────────────

const PROMPT_COPY = {
  comment: { title: 'Leave a comment', body: 'Enter your name and email to comment on this shared asset.' },
  verdict: { title: 'Give your verdict', body: 'Enter your name and email so the team knows who this verdict is from.' },
} as const

/** The modal frame the guest prompt has always used, shared with the sign-in prompt. */
function SharePrompt({ title, description, children }: {
  title: string; description: string; children: React.ReactNode
}) {
  const titleId = React.useId()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-5 shadow-xl">
        <h3 id={titleId} className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
        <p className="text-xs text-text-tertiary mb-4">{description}</p>
        {children}
      </div>
    </div>
  )
}

function GuestIdentityPrompt({ purpose = 'comment', onSave, onCancel }: { purpose?: keyof typeof PROMPT_COPY; onSave: (name: string, email: string) => void; onCancel: () => void }) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')

  return (
    <SharePrompt title={PROMPT_COPY[purpose].title} description={PROMPT_COPY[purpose].body}>
      <div className="space-y-3">
        <input
          type="text"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-[16px] [@media(hover:hover)]:text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          autoFocus
        />
        <input
          type="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-[16px] [@media(hover:hover)]:text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
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
    </SharePrompt>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

