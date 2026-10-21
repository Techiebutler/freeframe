/**
 * Who is signed in, for upload tests.
 *
 * Upload rows belong to the account that added them, read from the access
 * token's `sub` (spec goal 9). A test that starts uploads without a token, or
 * builds rows without an owner, passes today and breaks the day owner gating
 * lands. So every upload test signs in with `signInAs` and builds its rows with
 * `row`, which gives them the signed-in owner.
 */
import type { UploadFile } from '@/stores/upload-store'

const ACCESS_TOKEN_KEY = 'ff_access_token'

let signedIn = 'user-1'

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Writes a JWT-shaped access token whose payload is `{ sub }`. The signature is not checked by the client. */
export function signInAs(sub: string): void {
  signedIn = sub
  window.localStorage.setItem(
    ACCESS_TOKEN_KEY,
    `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub })}.signature`,
  )
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
