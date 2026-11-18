'use client'

import * as React from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { VerdictControlsView } from '@/components/review/verdict-controls'
import { signInAgain } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import {
  hasStoredToken, hasUsableToken, isSignInExpired, shareRequest, type ShareGuest,
} from '@/lib/share-request'
import type { Verdict, VerdictValue } from '@/types'

/** Every share verdict key starts with this, so a write can revalidate them. */
const SHARE_VERDICTS = 'share-verdicts'

/**
 * The SWR key for the verdicts a share page shows on one version. Who is
 * asking is part of it: the list is scoped to the caller (their own verdict is
 * `is_mine`), so naming yourself, or a login lapsing, must read it again.
 */
export function shareVerdictsKey(
  token: string,
  assetId: string,
  versionId: string,
  shareSession: string | null | undefined,
  as: string | null,
) {
  return [SHARE_VERDICTS, token, assetId, versionId, shareSession ?? null, as] as const
}

export interface ShareVerdictControlsProps {
  token: string
  assetId: string
  /** The version on screen. Verdicts are per version. */
  versionId: string
  shareSession?: string | null
  /** The guest's stored name and email, if they have given one. */
  guestIdentity: ShareGuest | null
  /**
   * Opens the name-and-email prompt and resolves with what was saved, or
   * `null` when it was cancelled.
   */
  requestIdentity: () => Promise<ShareGuest | null>
  variant?: 'toolbar' | 'row'
}

/**
 * Approve / Changes needed / Reject on a share link set to `approve`, and the
 * verdicts this caller may see: their own and other outsiders' through this
 * same link, never the team's. Nobody removes anyone's verdict from here.
 *
 * Remounts on a version switch, as the team's controls do.
 */
export function ShareVerdictControls(props: ShareVerdictControlsProps) {
  return <ShareVerdictControlsFor key={`${props.assetId}:${props.versionId}`} {...props} />
}

function ShareVerdictControlsFor({
  token, assetId, versionId, shareSession, guestIdentity, requestIdentity, variant = 'toolbar',
}: ShareVerdictControlsProps) {
  // The identity a prompt just resolved, for the writes. The prop catches up
  // on the next render (the screen stores what was saved), but the press that
  // asked is already running with the old one.
  const named = React.useRef<ShareGuest | null>(null)
  // Set by "Continue as guest": with no usable sign-in, the writes go as the
  // guest instead of refreshing. A usable bearer still wins (`shareRequest`).
  const asGuest = React.useRef(false)

  const signedIn = hasUsableToken()
  const key = shareVerdictsKey(
    token, assetId, versionId, shareSession, signedIn ? 'bearer' : guestIdentity?.email ?? null,
  )
  const { data } = useSWR<Verdict[]>(key, () =>
    shareRequest<Verdict[]>(
      token,
      `/verdicts?asset_id=${encodeURIComponent(assetId)}&version_id=${encodeURIComponent(versionId)}`,
      { method: 'GET', shareSession, guest: guestIdentity },
    ),
  )

  const { mutate } = useSWRConfig()
  // Every identity's key for this version, not only the one this render read:
  // a prompt that just named the guest has already moved the key on.
  const revalidate = () =>
    mutate(
      (k) =>
        Array.isArray(k) && k[0] === SHARE_VERDICTS && k[1] === token && k[2] === assetId && k[3] === versionId,
    )

  /** The guest to send as, read at call time so a just-saved identity counts. */
  const sendAs = () => guestIdentity ?? named.current

  /** Asks for a guest identity; false when the prompt was cancelled. */
  const askWhoTheyAre = async (): Promise<boolean> => {
    const saved = await requestIdentity()
    if (!saved) return false
    named.current = saved
    return true
  }

  // Anyone who has signed in on this browser, lapsed or not, goes straight on:
  // their write refreshes the sign-in or asks them what to do, and is never
  // quietly turned into a guest's. So does a guest who has named themselves.
  // Only someone with neither is asked for a name first, and a cancelled
  // prompt sends nothing.
  const beforePress = async (): Promise<boolean> => {
    if (hasStoredToken() || sendAs()) return true
    return askWhoTheyAre()
  }

  // A lapsed sign-in that would not refresh (or a bearer the server could not
  // resolve): the person chooses, rather than being made a guest for them.
  const errorActions = (
    error: unknown,
    { retry, dismiss }: { retry: () => Promise<boolean>; dismiss: () => void },
  ) => {
    if (!isSignInExpired(error)) return null
    const from = currentAppPath()
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <a
          href={withBasePath(`/login?from=${encodeURIComponent(from)}`)}
          onClick={(event) => {
            event.preventDefault()
            signInAgain(from)
          }}
          className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-white outline-none
            hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          Sign in
        </a>
        <button
          type="button"
          onClick={async () => {
            if (!sendAs()) {
              // The prompt is a modal under this popover: put it away first.
              dismiss()
              if (!(await askWhoTheyAre())) return
            }
            asGuest.current = true
            await retry()
          }}
          className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-text-secondary
            outline-none hover:bg-bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent"
        >
          Continue as guest
        </button>
      </div>
    )
  }

  return (
    <VerdictControlsView
      verdicts={data}
      canGive
      canRemove={false}
      variant={variant}
      beforePress={beforePress}
      errorActions={errorActions}
      give={(status: VerdictValue, note?: string) =>
        shareRequest(token, '/verdict', {
          method: 'PUT',
          body: { version_id: versionId, asset_id: assetId, status, ...(note ? { note } : {}) },
          shareSession,
          guest: sendAs(),
          asGuest: asGuest.current,
        })
      }
      clear={() =>
        shareRequest(
          token,
          `/verdict?version_id=${encodeURIComponent(versionId)}&asset_id=${encodeURIComponent(assetId)}`,
          { method: 'DELETE', shareSession, guest: sendAs(), asGuest: asGuest.current },
        )
      }
      revalidate={revalidate}
    />
  )
}

/** This page's path and query, without the basePath: what /login's `from` takes. */
function currentAppPath(): string {
  if (typeof window === 'undefined') return '/'
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const { pathname, search } = window.location
  const path = basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname
  return `${path}${search}`
}
