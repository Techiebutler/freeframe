/**
 * Download helpers shared by the share-link grid and the share review screen.
 *
 * They lived in folder-share-viewer until the review screen moved out of it
 * (#117, #123); importing them back from there would make the two modules
 * circular, so they live here instead.
 */
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

export async function fetchDownloadUrl(
  token: string, assetId: string, shareSession?: string | null,
): Promise<string | null> {
  const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
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
  token: string, assetId: string, shareSession?: string | null,
) {
  const url = await fetchDownloadUrl(token, assetId, shareSession)
  if (url) triggerDownload(url)
}
