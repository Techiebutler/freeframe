import { api } from '@/lib/api'
import { prepareLogo } from '@/lib/avatar-image'

/** `project_brandings.custom_footer` is 500 characters; the API refuses more. */
export const CUSTOM_FOOTER_MAX = 500

/**
 * The logo a share page puts in its header for a project, as the share API
 * resolves it: the project cover when the project uses it as its logo and has
 * one, else the uploaded logo, else none (the page then shows the instance's).
 *
 * The settings preview calls this with unsaved values, so it shows what the
 * page will render once they are saved.
 */
export function resolveShareLogoUrl({
  useCoverAsLogo,
  coverUrl,
  logoUrl,
}: {
  useCoverAsLogo: boolean
  coverUrl: string | null | undefined
  logoUrl: string | null | undefined
}): string | null {
  if (useCoverAsLogo && coverUrl) return coverUrl
  return logoUrl || null
}

/**
 * Uploads a picked logo for a project and returns the storage key to save.
 *
 * The file is scaled down and re-encoded as WebP first, as avatars are. The
 * key is only uploaded here; it reaches the project when the caller sends it
 * as `logo_s3_key` in PUT /projects/{id}/branding.
 */
export async function uploadProjectLogo(projectId: string, file: File): Promise<string> {
  const blob = await prepareLogo(file)
  const { upload_url, key } = await api.post<{ upload_url: string; key: string }>(
    `/projects/${projectId}/branding/logo-upload`,
  )
  // A presigned PUT: no Authorization header, and the Content-Type the URL was
  // signed for. The endpoint signs for WebP only; a browser that cannot encode
  // WebP hands back a PNG, which still displays, since browsers sniff images.
  const res = await fetch(upload_url, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': 'image/webp' },
  })
  if (!res.ok) throw new Error('The logo could not be uploaded')
  return key
}
