import { api } from '@/lib/api'
import { authHeaders } from '@/lib/auth-headers'
import { getLiveAccessToken } from '@/lib/auth'
import type { AssetVersion } from '@/types'

// Switching files must be instant: the review screen's first GETs for the briefing's other files are
// started early and handed over once. ponytail: take-once, 60 s, in memory; a revisit warms up again.
const TTL = 60_000
const warm = new Map<string, { at: number; p: Promise<unknown> }>()

/** The warmed-up result for `key` if there is a fresh one (used once), else `load()`. */
export function take<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = warm.get(key)
  warm.delete(key)
  return hit && Date.now() - hit.at < TTL ? (hit.p as Promise<T>) : load()
}

function warmUp<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = warm.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.p as Promise<T>
  const p = load()
  p.catch(() => warm.delete(key))
  warm.set(key, { at: Date.now(), p })
  return p
}

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/** Share links: the same requests the review provider makes, with the same keys. */
export const shareStreamKey = (token: string, assetId: string, ss: string) => `${API_URL()}/share/${token}/stream/${assetId}?_=1${ss}`
export const shareVersionsKey = (token: string, assetId: string, ss: string) => `${API_URL()}/share/${token}/assets/${assetId}/versions?_=1${ss}`
export const shareJson = (url: string) => fetch(url, { headers: { ...authHeaders(getLiveAccessToken()) } }).then(r => (r.ok ? r.json() : null))

export const newestReady = (versions: AssetVersion[]) =>
  [...versions].sort((a, b) => b.version_number - a.version_number).find(v => v.processing_status === 'ready')

/** HLS: master -> variant playlists -> first segment, so the next video's first frame is already in the browser cache. */
async function warmVideo(streamUrl?: string | null) {
  if (!streamUrl || !streamUrl.includes('.m3u8')) return
  const lines = (txt: string) => txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  const master = streamUrl.startsWith('/') ? `${API_URL()}${streamUrl}` : streamUrl
  for (const v of lines(await (await fetch(master)).text()).slice(0, 3)) {
    const variant = new URL(v, master).href
    const seg = lines(await (await fetch(variant)).text())[0]
    if (seg) await fetch(new URL(seg, variant).href)
  }
}

/** Starts loading the other files of a briefing so opening one does not wait on the network. */
export function prefetchReviews(ids: string[], share?: { token: string; session?: string | null }) {
  for (const id of ids.slice(0, 12)) {
    if (share) {
      const ss = share.session ? `&share_session=${encodeURIComponent(share.session)}` : ''
      const streamKey = shareStreamKey(share.token, id, ss)
      void warmUp(streamKey, () => shareJson(streamKey)).then((d: { url?: string } | null) => warmVideo(d?.url)).catch(() => {})
      const versionsKey = shareVersionsKey(share.token, id, ss)
      void warmUp(versionsKey, () => shareJson(versionsKey)).catch(() => {})
      continue
    }
    void warmUp(`/assets/${id}`, () => api.get(`/assets/${id}`)).catch(() => {})
    void warmUp(`/assets/${id}/comments`, () => api.get(`/assets/${id}/comments`)).catch(() => {})
    void warmUp(`/assets/${id}/versions`, () => api.get<AssetVersion[]>(`/assets/${id}/versions`))
      .then(vs => {
        const v = newestReady(vs ?? [])
        if (v) { const path = `/assets/${id}/stream?version_id=${v.id}`; void warmUp(path, () => api.get<{ url: string }>(path)).then(d => warmVideo(d?.url)).catch(() => {}) }
      })
      .catch(() => {})
  }
}
