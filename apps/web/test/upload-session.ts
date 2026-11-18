/**
 * Who is signed in, for upload tests.
 *
 * Upload rows belong to the account that added them, read from the access
 * token's `sub` (spec goal 9). A test that starts uploads without a token, or
 * builds rows without an owner, sees no rows at all: the store creates none
 * without a token and shows only the signed-in account's. So every upload test
 * signs in with `signInAs` and builds its rows with `row`, which gives them the
 * signed-in owner.
 */
import type { UploadFile } from '@/stores/upload-store'

const ACCESS_TOKEN_KEY = 'ff_access_token'

let signedIn = 'user-1'

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A JWT-shaped access token whose payload is `{ sub }`. The signature is not checked by the client. */
export function tokenFor(sub: string): string {
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub })}.signature`
}

/** What the browser tells every other tab when one of them writes the token. */
function announce(newValue: string | null): void {
  window.dispatchEvent(
    new StorageEvent('storage', { key: ACCESS_TOKEN_KEY, newValue, storageArea: window.localStorage }),
  )
}

/**
 * Signs in as `sub`, and tells the upload store the way the browser tells a tab
 * that another tab signed in: a `storage` event. A tab is never told of its own
 * writes, so without the event the store would go on showing the account it
 * last heard of. Signing in as the account already signed in tells it nothing.
 */
export function signInAs(sub: string): void {
  signedIn = sub
  const token = tokenFor(sub)
  window.localStorage.setItem(ACCESS_TOKEN_KEY, token)
  announce(token)
}

/**
 * Writes `sub`'s token without telling anyone: another tab signed in and its
 * `storage` event has not reached this tab yet. Rows built with `row` still
 * belong to whoever `signInAs` last signed in.
 */
export function writeTokenUnannounced(sub: string): void {
  window.localStorage.setItem(ACCESS_TOKEN_KEY, tokenFor(sub))
}

/** Another tab signs out: the token goes, and this tab hears of it. */
export function signOutElsewhere(): void {
  window.localStorage.removeItem(ACCESS_TOKEN_KEY)
  announce(null)
}

/** An upload row owned by whoever `signInAs` last signed in. Override any field. */
export function row(partial: Partial<UploadFile> = {}): UploadFile {
  return {
    id: 'row-1',
    fileName: 'clip.mp4',
    fileSize: 1024,
    fileType: 'video/mp4',
    projectId: 'project-1',
    assetName: 'clip',
    progress: 0,
    processingProgress: 0,
    status: 'interrupted',
    createdAt: Date.now(),
    ownerId: signedIn,
    ...partial,
  }
}
