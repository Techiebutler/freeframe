/**
 * Download helpers shared by the share-link grid and the share review screen.
 *
 * They lived in folder-share-viewer until the review screen moved out of it
 * (#117, #123); importing them back from there would make the two modules
 * circular, so they live here instead.
 */
import type { DownloadOption } from '@/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export function triggerDownload(url: string) {
  // Let the server's Content-Disposition filename win — don't set `a.download`,
  // since it would strip the extension the backend appended.
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener noreferrer'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1000)
}

/**
 * `rendition` is an id from fetchShareDownloadOptions; left out, the transcode.
 * `preferOriginal` (Download All) asks for the original when the instance allows it.
 * `versionId` is the version to download, on a link that shows all versions;
 * left out, or on a link that does not, the latest ready version.
 */
export async function fetchDownloadUrl(
  token: string, assetId: string, shareSession?: string | null, rendition?: string,
  preferOriginal = false, versionId?: string,
): Promise<string | null> {
  let sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  if (rendition) sp += `&rendition=${encodeURIComponent(rendition)}`
  if (preferOriginal) sp += '&prefer_original=true'
  if (versionId) sp += `&version_id=${encodeURIComponent(versionId)}`
  try {
    const response = await fetch(`${API_URL}/share/${token}/stream/${assetId}?download=true${sp}`)
    if (!response.ok) return null
    const data = await response.json()
    return data?.url ?? null
  } catch {
    return null
  }
}

export async function handleDownload(
  token: string, assetId: string, shareSession?: string | null, rendition?: string,
  versionId?: string,
) {
  const url = await fetchDownloadUrl(token, assetId, shareSession, rendition, false, versionId)
  if (url) triggerDownload(url)
}

/**
 * What an asset in a share link can be downloaded as: the original, then the
 * transcode. `versionId` as in fetchDownloadUrl: each version has its own files.
 */
export async function fetchShareDownloadOptions(
  token: string, assetId: string, shareSession?: string | null, versionId?: string,
): Promise<DownloadOption[] | null> {
  const params = new URLSearchParams()
  if (shareSession) params.set('share_session', shareSession)
  if (versionId) params.set('version_id', versionId)
  const query = params.toString()
  const sp = query ? `?${query}` : ''
  try {
    const response = await fetch(`${API_URL}/share/${token}/downloads/${assetId}${sp}`)
    if (!response.ok) return null
    return (await response.json()) as DownloadOption[]
  } catch {
    return null
  }
}
