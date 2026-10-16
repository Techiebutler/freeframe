import { api } from '@/lib/api'
import type { DownloadOption } from '@/types'

/** What an asset can be downloaded as: the original, then the transcode. */
export function fetchAssetDownloadOptions(assetId: string): Promise<DownloadOption[]> {
  return api.get<DownloadOption[]>(`/assets/${assetId}/downloads`)
}

/**
 * Download an asset. `rendition` is an id from fetchAssetDownloadOptions;
 * left out, the server serves the transcode where there is one. `preferOriginal`
 * (bulk downloads) asks for the original when the instance allows originals.
 */
export async function downloadAsset(
  assetId: string, rendition?: string, preferOriginal = false,
): Promise<void> {
  let query = rendition ? `&rendition=${encodeURIComponent(rendition)}` : ''
  if (preferOriginal) query += '&prefer_original=true'
  const data = await api.get<{ url: string }>(`/assets/${assetId}/stream?download=true${query}`)
  if (!data?.url) return
  // An iframe rather than navigation, so several downloads in a row (bulk)
  // do not cancel each other, and the page is never left.
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  iframe.src = data.url
  document.body.appendChild(iframe)
  setTimeout(() => iframe.remove(), 30000)
}
