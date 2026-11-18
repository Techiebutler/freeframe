'use client'

import * as React from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { VerdictControlsView } from '@/components/review/verdict-controls'
import { hasUsableToken, shareRequest, type ShareGuest } from '@/lib/share-request'
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

  // Signed in with a good token, or a guest who has named themselves, may go
  // straight on. Anyone else is asked first, and a cancelled prompt sends
  // nothing. A lapsed login with no guest identity is asked too, rather than
  // sent as nobody to a server that can only refuse it.
  const beforePress = async (): Promise<boolean> => {
    if (hasUsableToken() || sendAs()) return true
    const saved = await requestIdentity()
    if (!saved) return false
    named.current = saved
    return true
  }

  return (
    <VerdictControlsView
      verdicts={data}
      canGive
      canRemove={false}
      variant={variant}
      beforePress={beforePress}
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
