import { api } from './api'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const POLL_INTERVAL_MS = 3000
const MAX_WAIT_MS = 5 * 60 * 1000

interface DownloadResponse {
  url?: string
  status?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve a download URL for an asset the current user is signed in to see.
 * When a watermark must be burned in first, the API answers 202/"preparing" —
 * poll until the watermarked copy is ready.
 */
export async function getAssetDownloadUrl(
  assetId: string,
  onPreparing?: () => void,
): Promise<string | null> {
  const deadline = Date.now() + MAX_WAIT_MS
  let notified = false
  while (Date.now() < deadline) {
    const data = await api.get<DownloadResponse>(`/assets/${assetId}/stream?download=true`)
    if (data?.url) return data.url
    if (data?.status !== 'preparing') return null
    if (!notified) {
      onPreparing?.()
      notified = true
    }
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

/**
 * Resolve a download URL for an asset in a public share link, polling while a
 * watermarked copy is prepared.
 */
export async function getShareDownloadUrl(
  token: string,
  assetId: string,
  shareSession?: string | null,
  onPreparing?: () => void,
): Promise<string | null> {
  const sp = shareSession ? `&share_session=${encodeURIComponent(shareSession)}` : ''
  const deadline = Date.now() + MAX_WAIT_MS
  let notified = false
  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/share/${token}/stream/${assetId}?download=true${sp}`)
    if (res.status === 202) {
      if (!notified) {
        onPreparing?.()
        notified = true
      }
      await sleep(POLL_INTERVAL_MS)
      continue
    }
    if (!res.ok) return null
    const data: DownloadResponse = await res.json()
    return data?.url ?? null
  }
  return null
}

/** Trigger a browser download for a presigned URL via a hidden iframe. */
export function triggerUrlDownload(url: string): void {
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = url
  document.body.appendChild(iframe)
  setTimeout(() => iframe.remove(), 30000)
}
