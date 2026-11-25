'use client'

import * as React from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { VerdictControlsView } from '@/components/review/verdict-controls'
import { signInAgain } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import {
  continueAsGuest, hasStoredToken, isSignInExpired, prepareShareWrite, shareCallerKey,
  shareRequest, unreachable, type ShareGuest,
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
  // The guest choice itself lives in `lib/share-request`, bound to the refused
  // token it was made over. This only renders again once it is made, so the
  // read below moves to the guest's key.
  const [, rerender] = React.useReducer((n: number) => n + 1, 0)

  /** The guest to send as, read at call time so a just-saved identity counts. */
  const sendAs = () => guestIdentity ?? named.current

  const listPath =
    `/verdicts?asset_id=${encodeURIComponent(assetId)}&version_id=${encodeURIComponent(versionId)}`
  const readList = (guest: ShareGuest | null) =>
    shareRequest<Verdict[]>(token, listPath, { method: 'GET', shareSession, guest })

  // Who the read goes as is part of the key (`shareCallerKey`): the list is
  // scoped to the caller, so naming yourself, a sign-in refreshing or lapsing,
  // or choosing to go on as a guest, reads it again.
  const readAs = shareCallerKey(guestIdentity)
  const key = shareVerdictsKey(token, assetId, versionId, shareSession, readAs)
  const { data } = useSWR<Verdict[]>(key, () => readList(guestIdentity))

  const { mutate } = useSWRConfig()
  // Every identity's key for this version, not only the one this render read:
  // a prompt that just named the guest has already moved the key on.
  const revalidate = () =>
    mutate(
      (k) =>
        Array.isArray(k) && k[0] === SHARE_VERDICTS && k[1] === token && k[2] === assetId && k[3] === versionId,
    )

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
  //
  // Then clear-or-give is decided against the presser's own verdict. The list
  // on screen was read as `readAs` (an account, a guest, or nobody) at that
  // render. A lapsed sign-in is refreshed now, and if the caller, by that same
  // key, is no longer who the list was read as, it is read again as them and
  // the press decides against that. A re-read that fails stops the press with
  // its message, and nothing is sent. What this does not cover: the caller
  // changing again (another tab) in the moment between this read and the write.
  const beforePress = async (): Promise<boolean | Verdict[]> => {
    if (!hasStoredToken() && !sendAs() && !(await askWhoTheyAre())) return false
    await prepareShareWrite()
    if (shareCallerKey(sendAs()) === readAs) return true
    let fresh: Verdict[]
    try {
      fresh = await readList(sendAs())
    } catch (err) {
      // The server's own words when it gave some; otherwise "try again".
      const detail = (err as { detail?: unknown } | null)?.detail
      throw typeof detail === 'string' && detail ? err : unreachable()
    }
    void revalidate()
    return fresh
  }

  // A lapsed sign-in that would not refresh (or a bearer the server could not
  // resolve): the person chooses, rather than being made a guest for them.
  const errorActions = (
    error: unknown,
    { redo, dismiss }: { redo: () => Promise<void>; dismiss: () => void },
  ) => {
    if (!isSignInExpired(error)) return null
    return (
      <ShareSignInActions onContinueAsGuest={async () => {
        if (!sendAs()) {
          // The prompt is a modal under this popover: put it away first.
          dismiss()
          if (!(await askWhoTheyAre())) return
        }
        continueAsGuest(error)
        rerender()
        // The press again, as the guest: re-read as them and decide afresh.
        await redo()
      }} />
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
        })
      }
      clear={() =>
        shareRequest(
          token,
          `/verdict?version_id=${encodeURIComponent(versionId)}&asset_id=${encodeURIComponent(assetId)}`,
          { method: 'DELETE', shareSession, guest: sendAs() },
        )
      }
      revalidate={revalidate}
    />
  )
}

export function ShareSignInActions({ onContinueAsGuest, onCancel }: {
  onContinueAsGuest: () => void | Promise<void>
  onCancel?: () => void
}) {
  const from = currentAppPath()
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <a
        href={withBasePath(`/login?from=${encodeURIComponent(from)}`)}
        onClick={(event) => {
          event.preventDefault()
          onCancel?.()
          signInAgain(currentAppPath())
        }}
        className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-medium text-white outline-none
          hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
      >
        Sign in
      </a>
      <button
        type="button"
        onClick={onContinueAsGuest}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-text-secondary
          outline-none hover:bg-bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent"
      >
        Continue as guest
      </button>
      {onCancel && (
        <button type="button" autoFocus onClick={onCancel} className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors">
          Cancel
        </button>
      )}
    </div>
  )
}

/** This page's path and query, without the basePath: what /login's `from` takes. */
export function currentAppPath(): string {
  if (typeof window === 'undefined') return '/'
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || ''
  const { pathname, search } = window.location
  const path = basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname
  return `${path}${search}`
}
