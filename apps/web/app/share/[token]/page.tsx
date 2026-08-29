'use client'

import * as React from 'react'
import {
  Lock,
  AlertTriangle,
  Clock,
  Loader2,
} from 'lucide-react'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { FolderShareViewer } from '@/components/share/folder-share-viewer'
import { ShareReviewScreen } from '@/components/share/share-review-screen'
import { useBrandingStore } from '@/stores/branding-store'
import { useShareAppearance } from '@/hooks/use-share-appearance'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'

import type { Asset, SharePermission, ProjectBranding, ShareLinkAppearance } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShareValidateResponse {
  asset?: Asset
  asset_id?: string | null
  folder_id?: string | null
  project_id?: string | null
  folder_name?: string
  project_name?: string
  title?: string
  description?: string | null
  permission?: SharePermission
  allow_download?: boolean
  show_versions?: boolean
  show_watermark?: boolean
  appearance?: ShareLinkAppearance | null
  visibility?: string
  requires_password?: boolean
  requires_auth?: boolean
  share_session?: string | null
  expired?: boolean
  created_by_name?: string | null
  viewer_name?: string | null
  viewer_email?: string | null
  branding?: ProjectBranding | null
  error?: string
}




// ─── Utility ──────────────────────────────────────────────────────────────────

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

async function fetchShareInfo(
  token: string,
  password?: string,
  logOpen?: boolean,
): Promise<ShareValidateResponse> {
  // Include auth token if user is already logged in (for secure links)
  const headers: Record<string, string> = {}
  let accessToken: string | null = null
  try {
    if (typeof window !== 'undefined') {
      accessToken = localStorage.getItem('ff_access_token')
    }
  } catch {}
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  // When a password is supplied, use POST /share/{token}/verify so the
  // password travels in the request body — not as a query string, which
  // would be logged by nginx, browser history, Referer headers, and
  // proxy/tunnel logs (SECURITY_AUDIT H3).
  if (password) {
    headers['Content-Type'] = 'application/json'
    const body = JSON.stringify({ password, log_open: !!logOpen })
    const resp = await fetch(`${API_URL}/share/${token}/verify`, {
      method: 'POST',
      headers,
      body,
    })
    if (!resp.ok) {
      if (resp.status === 403) {
        // /verify answers 403 both for a wrong password and for a `secure`
        // link whose viewer isn't signed in. Reporting the latter as
        // "Incorrect password" strands the viewer retyping a password that
        // was never the problem — they need the sign-in prompt instead.
        const detail = await resp
          .json()
          .then((d) => d?.detail)
          .catch(() => null)
        if (typeof detail === 'string' && detail.includes('Authentication required')) {
          return { requires_auth: true }
        }
        return { requires_password: true, error: 'Incorrect password' }
      }
      if (resp.status === 410) return { expired: true }
      return {}
    }
    return resp.json()
  }

  // No password — GET validates the link and either returns the full
  // response (no password set / authenticated creator) or
  // requires_password:true (password-protected, not yet verified).
  const params = new URLSearchParams()
  if (logOpen) params.set('log_open', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_URL}/share/${token}${qs}`, { headers })
  if (!response.ok) {
    if (response.status === 410) return { expired: true }
    return {}
  }
  return response.json()
}

// ─── Password gate ────────────────────────────────────────────────────────────

interface PasswordGateProps {
  onSubmit: (password: string) => void
  error?: string | null
  loading?: boolean
}

function PasswordGate({ onSubmit, error, loading }: PasswordGateProps) {
  const [password, setPassword] = React.useState('')

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.trim()) onSubmit(password.trim())
  }

  const { orgName, loginLogoUrl, orgLogoLight, orgLogoDark } =
    useBrandingStore()
  const theme = useResolvedTheme()
  const displayLogo = loginLogoUrl || (theme === 'dark' ? (orgLogoDark ?? orgLogoLight) : (orgLogoLight ?? orgLogoDark)) || undefined

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 shadow-xl">
        <div className="mb-4 flex flex-col items-center gap-3">
          {displayLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={displayLogo} alt={orgName} className="h-10 object-contain" />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-icon.png" alt="FreeFrame" className="logo-dark h-10 w-10" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-icon-dark.png" alt="" aria-hidden="true" className="logo-light h-10 w-10" />
            </>
          )}
          <div className="text-center">
            <h1 className="text-sm font-semibold text-text-primary">{orgName}</h1>
            <p className="text-xs text-text-tertiary mt-1">Password required to access this link</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password…"
            autoFocus
            className="flex h-9 w-full rounded-md border border-border bg-bg-tertiary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
          />
          {error && <p className="text-xs text-status-error">{error}</p>}
          <Button type="submit" size="sm" className="w-full" loading={loading}>
            Access link
          </Button>
        </form>
        <PoweredByBadge className="mt-6 text-center justify-center" />
      </div>
    </div>
  )
}

// ─── Error state ──────────────────────────────────────────────────────────────

interface ErrorStateProps {
  expired?: boolean
}

function ErrorState({ expired }: ErrorStateProps) {

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 text-center shadow-xl">
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-error/10">
            {expired ? (
              <Clock className="h-6 w-6 text-status-error" />
            ) : (
              <AlertTriangle className="h-6 w-6 text-status-error" />
            )}
          </div>
        </div>
        <h1 className="text-sm font-semibold text-text-primary">
          {expired ? 'Link expired' : 'Link not found'}
        </h1>
        <p className="mt-1 text-xs text-text-tertiary">
          {expired
            ? 'This share link has expired and is no longer accessible.'
            : 'This share link is invalid or has been removed.'}
        </p>
        <PoweredByBadge className="mt-6" showOrgName />
      </div>
    </div>
  )
}

// ─── Guest comment item ───────────────────────────────────────────────────────



// ─── Guest comment list (for right panel) ────────────────────────────────────



// ─── Guest approval actions ───────────────────────────────────────────────────



// ─── Share Top Bar ────────────────────────────────────────────────────────────



// ─── Share Media Viewer ───────────────────────────────────────────────────────

// The bespoke single-asset player (ShareMediaViewer) and its wrapper
// (ShareViewer) lived here. A single-asset link now renders the same
// ShareReviewScreen the folder path does, so they had no reachable caller left
// (#117, #123).

export default function SharePage({
  params,
}: {
  params: { token: string }
}) {
  const { token } = params

  type PageState =
    | { stage: 'loading' }
    | { stage: 'password_required'; error?: string; loading?: boolean }
    | { stage: 'expired' }
    | { stage: 'invalid' }
    | { stage: 'auth_required'; title?: string }
    | {
        stage: 'ready'
        asset: Asset & { thumbnail_url?: string; stream_url?: string }
        permission: SharePermission
        allowDownload: boolean
        showVersions: boolean
        appearance: ShareLinkAppearance | null
        branding: ProjectBranding | null
      }
    | {
        stage: 'folder_ready'
        folderName: string
        title: string
        description: string | null
        createdByName: string | null
        viewerName: string | null
        permission: SharePermission
        allowDownload: boolean
        showVersions: boolean
        appearance: ShareLinkAppearance
        branding: any
      }

  const [state, setState] = React.useState<PageState>({ stage: 'loading' })
  const [shareSession, setShareSession] = React.useState<string | null>(null)
  const openLogged = React.useRef(false)
  const { fetchBranding, loaded } = useBrandingStore()

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  async function validate(password?: string) {
    if (password) {
      setState({ stage: 'password_required', loading: true })
    }
    try {
      // Ask to log the open on whichever call first returns the full
      // response. Gating this on `!password` meant a password-protected link
      // never recorded one: the initial GET short-circuits at
      // requires_password and drops log_open, and the /verify that follows
      // always carried log_open:false because a password was supplied.
      const shouldLogOpen = !openLogged.current
      const data = await fetchShareInfo(token, password, shouldLogOpen)
      if (data.requires_auth) {
        setState({ stage: 'auth_required', title: data.title })
        return
      }
      if (data.requires_password) {
        setState({ stage: 'password_required', error: data.error || undefined })
        return
      }
      if (data.expired) {
        setState({ stage: 'expired' })
        return
      }
      if (!data.permission) {
        setState({ stage: 'invalid' })
        return
      }

      // Only now is the open actually recorded — the early returns above are
      // all cases the server did not log.
      if (shouldLogOpen) openLogged.current = true

      // Store share session from password-protected link validation
      if (data.share_session) {
        setShareSession(data.share_session)
      }

      if ((data.folder_id || data.project_id) && !data.asset_id) {
        const defaultAppearance: ShareLinkAppearance = {
          layout: 'grid',
          theme: 'dark',
          accent_color: null,
          open_in_viewer: true,
          sort_by: 'created_at',
          card_size: 'm',
          aspect_ratio: 'landscape',
          thumbnail_scale: 'fill',
          show_card_info: true,
        }
        const folderName = data.folder_name ?? data.project_name ?? 'Shared'
        setState({
          stage: 'folder_ready',
          folderName,
          title: data.title ?? folderName,
          description: data.description ?? null,
          createdByName: data.created_by_name ?? null,
          viewerName: data.viewer_name ?? null,
          permission: data.permission,
          allowDownload: data.allow_download ?? false,
          showVersions: data.show_versions ?? true,
          appearance: { ...defaultAppearance, ...(data.appearance ?? {}) },
          branding: data.branding ?? null,
        })
        return
      }

      if (!data.asset) {
        setState({ stage: 'invalid' })
        return
      }
      setState({
        stage: 'ready',
        asset: data.asset,
        permission: data.permission,
        allowDownload: data.allow_download ?? false,
        showVersions: data.show_versions ?? true,
        appearance: data.appearance ?? null,
        branding: data.branding ?? null,
      })
    } catch {
      setState({ stage: 'invalid' })
    }
  }

  React.useEffect(() => {
    validate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  if (state.stage === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <Loader2 className="h-8 w-8 animate-spin text-text-tertiary" />
      </div>
    )
  }

  if (state.stage === 'password_required') {
    return (
      <PasswordGate
        onSubmit={(pw) => validate(pw)}
        error={state.error}
        loading={state.loading}
      />
    )
  }

  if (state.stage === 'expired') {
    return <ErrorState expired />
  }

  if (state.stage === 'invalid') {
    return <ErrorState />
  }

  if (state.stage === 'auth_required') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-bg-secondary p-6 shadow-xl text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-muted">
            <Lock className="h-6 w-6 text-text-primary" />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">
            {state.title || 'Secure Share Link'}
          </h1>
          <p className="mt-2 text-sm text-text-tertiary">
            This link is private. Please sign in to view the shared content.
          </p>
          <a
            href={withBasePath('/login')}
            className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-text-primary hover:bg-accent/90 transition-colors"
          >
            Sign in to continue
          </a>
        </div>
      </div>
    )
  }

  if (state.stage === 'folder_ready') {
    return (
      <FolderShareViewer
        token={token}
        shareSession={shareSession}
        folderName={state.folderName}
        title={state.title}
        description={state.description}
        createdByName={state.createdByName}
        viewerName={state.viewerName}
        permission={state.permission}
        allowDownload={state.allowDownload}
        showVersions={state.showVersions}
        appearance={state.appearance}
        branding={state.branding}
      />
    )
  }

  return (
    <SingleAssetShareViewer
      token={token}
      asset={state.asset}
      permission={state.permission}
      allowDownload={state.allowDownload}
      showVersions={state.showVersions}
      appearance={state.appearance}
      branding={state.branding}
      shareSession={shareSession}
    />
  )
}

/**
 * A share link targeting one asset renders the same review screen the folder
 * path does, rather than the bespoke player it used to.
 *
 * That player had a plain textarea with no timecode control and no version
 * concept, so the same content behaved differently depending on whether it was
 * shared on its own or inside a folder (#117, #123). This is a thin wrapper:
 * it resolves the link's appearance, which the grid does for the folder path,
 * and then defers entirely.
 */
function SingleAssetShareViewer({
  token, asset, permission, allowDownload, showVersions, appearance, branding, shareSession,
}: {
  token: string
  asset: { id: string; name: string }
  permission: SharePermission
  allowDownload: boolean
  showVersions: boolean
  appearance?: ShareLinkAppearance | null
  branding?: { primary_color?: string | null } | null
  shareSession?: string | null
}) {
  // Same resolution the folder grid uses: the link's own accent wins over the
  // project's, which wins over the built-in. No fallback, so a link with no
  // accent keeps the stylesheet's rather than being repainted.
  const accentColor = appearance?.accent_color ?? branding?.primary_color
  useShareAppearance(accentColor, appearance?.theme !== 'light')

  return (
    <div className="fixed inset-0 z-50">
      <ShareReviewScreen
        token={token}
        shareSession={shareSession}
        assetId={asset.id}
        assetName={asset.name}
        permission={permission}
        allowDownload={allowDownload}
        showVersions={showVersions}
      />
    </div>
  )
}
