/**
 * Platform v2 client: file requests, the anonymous try, rules and time saved.
 * Spec: docs/superpowers/specs/2026-09-28-review-platform-v2-design.md.
 *
 * Two backends:
 *   - FreeFrame's own API (`api`) for everything an owner or an editor-with-a-link does;
 *   - Auto Review (GATE_BASE, review.aditor.ai) ONLY for the anonymous try, straight from the
 *     browser - there is no account and no FreeFrame project behind it.
 */
import { api } from './api'
import { GATE_BASE } from './handin'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

// ── Types ──────────────────────────────────────────────────────────────────────

export type GateStatus = 'reviewing' | 'held' | 'clear' | 'unavailable'

export interface FileRequest {
  id: string
  token: string
  url: string
  title: string
  project_id: string
  project_name: string
  review_share_token?: string | null
  folder_id?: string | null
  brief_excerpt: string | null
  last_uploader_name: string | null
  assets: number
  state: 'live' | 'revoked' | 'expired'
  status: GateStatus
  open_must_fixes: number
  created_at: string | null
  checklist_binding_id?: string | null
  checklist?: import('./checklist').ChecklistState | null
}

export interface EditorStats {
  email: string
  name: string
  videos: number
  rated: number
  first_try_rate: number | null
  avg_versions: number | null
  open_must_fixes: number
  /** 'agent' for paired AI agents; absent on older API builds. */
  kind?: 'human' | 'agent'
  program?: string | null
}
export interface EditorInsights { editors: EditorStats[]; reviewed: boolean }
export const getEditors = () => api.get<EditorInsights>('/insights/editors')

/** Equal weight per editor: uploaded assets may be attributed to multiple people. */
export function editorAccuracy(editors: EditorStats[]) {
  const rated = editors.filter((e): e is EditorStats & { first_try_rate: number } => e.rated > 0 && e.first_try_rate !== null)
  const average = rated.length ? rated.reduce((sum, e) => sum + e.first_try_rate, 0) / rated.length : null
  const established = rated.filter(e => e.rated >= 5)
  const outliers = average === null || established.length < 3 ? [] : established
    .filter(e => Math.abs(e.first_try_rate - average) >= .2 - Number.EPSILON)
    .map(e => ({ email: e.email, direction: e.first_try_rate > average ? 'above' as const : 'below' as const }))
  return { average, count: rated.length, outliers }
}

export interface ReviewComment { id?: string; t: number | null; body: string; must_fix?: boolean; weight?: 'must_fix' | 'optional'; review_source?: import('@/types').ReviewSource | null }

export interface TimeSaved {
  days: number
  videos: number
  watchSec: number
  typeSec: number
  totalSec: number
  perDay: { day: string; sec: number }[]
  perBrand: { brand: string; sec: number; videos: number }[]
  assumptions: { wpm: number; watches: number }
}

// ── Pure helpers (tested) ──────────────────────────────────────────────────────

/** "0:07", "1:23", "1:02:05" - the timestamp chip on a comment. */
export function timecode(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Big, human: "12 h 5 min", "48 min", "under a minute". */
export function humanDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return 'under a minute'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

/** Hours with one decimal for the hero number: 12.1 */
export function hours(sec: number): string {
  return (Math.max(0, sec) / 3600).toFixed(sec >= 36000 ? 0 : 1)
}

export function formatBytes(b: number): string {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** What the owner reads on a request row. One label, one tone - never a number without words. */
export function statusLabel(r: Pick<FileRequest, 'status' | 'open_must_fixes' | 'assets' | 'state'>): { label: string; tone: 'neutral' | 'progress' | 'warn' | 'ok' } {
  if (r.state !== 'live') return { label: r.state === 'revoked' ? 'Closed' : 'Expired', tone: 'neutral' }
  if (!r.assets) return { label: 'Waiting for files', tone: 'neutral' }
  if (r.status === 'unavailable') return { label: 'Review unavailable', tone: 'warn' }
  if (r.status === 'reviewing') return { label: 'Reviewing', tone: 'progress' }
  if (r.status === 'held') {
    const n = r.open_must_fixes
    return { label: `Editor is fixing ${n} ${n === 1 ? 'thing' : 'things'}`, tone: 'warn' }
  }
  return { label: 'Ready', tone: 'ok' }
}

/** Split a file into the Worker's upload slices (under its ~100MB request cap). */
export const TRY_PART_BYTES = 16 * 1024 * 1024
export function sliceRanges(size: number, part = TRY_PART_BYTES): [number, number][] {
  const out: [number, number][] = []
  for (let start = 0; start < size; start += part) out.push([start, Math.min(size, start + part)])
  return out
}

/** Read a video's duration locally, before any byte leaves the machine. */
export function videoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    const url = URL.createObjectURL(file)
    const done = (d: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0) }
    v.onloadedmetadata = () => done(v.duration)
    v.onerror = () => done(0)
    v.src = url
  })
}

// ── Anonymous try (browser → Auto Review) ──────────────────────────────────────

export class TryError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

const TRY_MESSAGES: Record<string, string> = {
  'try-limit': 'That was today’s three free reviews. Continue with your email to keep going.',
  'too-big': 'That file is over 300 MB. Export a lighter version and drop it again.',
  'too-long': 'Free reviews are for ads up to 3 minutes. Continue with your email for longer videos.',
  'review-failed': 'The review did not come back this time. Drop the file again in a moment.',
}

export async function tryReview(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ comments: ReviewComment[]; left: number }> {
  if (!GATE_BASE) throw new TryError('off', 'Free reviews are not switched on here.')
  const durationSec = await videoDuration(file)
  if (durationSec > 180) throw new TryError('too-long', TRY_MESSAGES['too-long'])
  if (file.size > 300 * 1024 * 1024) throw new TryError('too-big', TRY_MESSAGES['too-big'])
  const id = (crypto.randomUUID?.() || String(Date.now())).replace(/[^a-zA-Z0-9-]/g, '')
  const ranges = sliceRanges(file.size)
  let sent = 0
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i]
    const r = await fetch(`${GATE_BASE}/api/v1/try/part?id=${id}&i=${i}`, { method: 'POST', body: file.slice(a, b) })
    if (!r.ok) {
      const j = await r.json().catch(() => ({}))
      throw new TryError(j.error || 'upload', TRY_MESSAGES[j.error] || 'The upload stopped. Drop the file again.')
    }
    sent += b - a
    onProgress(sent / file.size)
  }
  const r = await fetch(`${GATE_BASE}/api/v1/try`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload: id, parts: ranges.length, len: file.size, name: file.name, durationSec }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new TryError(j.error || 'review-failed', TRY_MESSAGES[j.error] || TRY_MESSAGES['review-failed'])
  return { comments: j.comments || [], left: j.left ?? 0 }
}

// ── Owner ──────────────────────────────────────────────────────────────────────

export const listRequests = () => api.get<FileRequest[]>('/requests')
export const createRequest = (body: { project_id: string; title: string; idempotency_key?: string; brief_text?: string; brief_url?: string; brief_pdf_base64?: string; brief_docx_base64?: string; receive_iterations?: boolean; aspect_ratio?: string }) =>
  api.post<FileRequest>('/requests', body)
export const revokeRequest = (id: string) => api.delete(`/requests/${id}`)
export const getTimeSaved = (days = 30) => api.get<TimeSaved>(`/insights/time-saved?days=${days}`)
export const getRules = (projectId: string) => api.get<{ brand: string; rules: RuleRow[]; suggestions: SuggestionRow[] }>(`/insights/rules?project_id=${projectId}`)
export const importRules = (body: { project_id: string; text?: string; url?: string; pdf_base64?: string; docx_base64?: string }) =>
  api.post<{ drafted: number; found: number }>('/insights/rules/import', body)

export const decideSuggestion = (body: { project_id: string; suggestion_id: string; action: 'accept' | 'dismiss' }) =>
  api.post<{ ok: boolean }>('/insights/rules/suggestion', body)

// ── Brand logo (white-label request pages) ────────────────────────────────────

/** Any image → a square-bounded WebP (the branding bucket stores WebP), transparency kept. */
export async function toWebp(file: File, max = 512): Promise<Blob> {
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(file) }
  catch { throw new Error('Could not read that image. Choose a PNG, JPG or WebP file.') }
  try {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('Could not read that image. Try another browser.')
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    return await new Promise<Blob>((resolve, reject) => c.toBlob(blob => {
      if (blob?.type === 'image/webp') resolve(blob)
      else reject(new Error('Your browser could not create a WebP logo. Try another browser.'))
    }, 'image/webp', 0.92))
  } finally { bmp.close() }
}

export async function uploadBrandLogo(projectId: string, file: File): Promise<string | null> {
  const body = await toWebp(file)
  const { upload_url, key } = await api.post<{ upload_url: string; key: string }>(`/projects/${projectId}/branding/logo-upload`, {})
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'content-type': 'image/webp' }, body })
  if (!put.ok) throw new Error('The logo did not upload. Try again.')
  const b = await api.put<{ logo_url: string | null }>(`/projects/${projectId}/branding`, { logo_s3_key: key })
  return b.logo_url
}

export const getBrandLogo = (projectId: string) =>
  api.get<{ logo_url: string | null }>(`/projects/${projectId}/branding`).then((b) => b.logo_url)

export interface RuleRow { id: string; name: string; what: string; scope: string; severity: string; active: boolean }
export interface SuggestionRow { id: string; name?: string; what?: string; source?: string }

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

// ── Editor with a link (no account) ────────────────────────────────────────────

export interface RequestView {
  receive_iterations?: boolean
  iteration_manifest?: import('./iterations').IterationManifest | null
  completed_at?: string | null
  title: string
  brand: string
  logo_url?: string | null
  brief_excerpt: string | null
  brief_text?: string | null
  brief_url?: string | null
  review_share_token: string
  assets: { id: string; name: string }[]
  expires_at: string | null
}

export interface ReviewTimeRange {
  lowerSeconds: number; upperSeconds: number; sampleCount: number
  scope: 'submission-to-publication' | 'phase-conditioned-remaining' | 'analysis'
}
export interface ReviewTiming {
  schema_version: 'autoreview.timing.v1'; calibration: 'measured' | 'collecting'
  started_at?: number; server_now?: number; phase_started_at?: number; phase?: string
  total?: ReviewTimeRange; remaining?: ReviewTimeRange; analysis?: ReviewTimeRange
}
export interface ReviewProgress {
  elapsedSeconds?: number; timing?: ReviewTiming
  stage: 'waiting' | 'reading' | 'failed' | 'skipped' | 'done'
  step?: 'preparing' | 'measuring' | 'analysing' | 'finishing'
  version_id?: string; queued_at?: string
  startedAgoSeconds?: number; quietSeconds?: number; retrying?: boolean
  failedKind?: 'too-large' | 'on-our-side' | 'unreadable'
  estimate?: { lowerSeconds: number; upperSeconds: number; sampleCount: number } | null
}
export interface RequestAsset {
  asset_id: string; name: string; version: number; version_id?: string; processing: string; comments: ReviewComment[]
  asset_type?: string; media_url?: string | null; thumbnail_url?: string | null; duration_seconds?: number | null
  review_state?: 'reviewing' | 'held' | 'clear' | 'unavailable' | 'upload_incomplete'
  review_progress?: ReviewProgress | null
  versions?: { id: string; version_number: number; processing: string }[]
}
export interface RequestReview {
  completed_at?: string | null
  assets: RequestAsset[]
  gate: { status: GateStatus; open_must_fixes: number }
  review_share_token: string
}

export async function pub<T>(method: string, path: string, body?: unknown, editorSession?: string): Promise<T> {
  const r = await fetch(`${API_URL}${path}`, {
    method,
    headers: body || editorSession ? { ...(body ? { 'content-type': 'application/json' } : {}), ...(editorSession ? { Authorization: `Bearer ${editorSession}` } : {}) } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    const detail = typeof j.detail === 'string' ? j.detail : 'Something went wrong. Try again.'
    throw Object.assign(new Error(detail), { status: r.status })
  }
  return r.status === 204 ? (undefined as T) : r.json()
}

export const viewRequest = (token: string) => pub<RequestView>('GET', `/r/${token}`)
export const finishRequest = (token: string) => pub<{ completed_at: string }>('POST', `/r/${token}/finish`)
export const requestVersion = (token: string, assetId: string, versionId: string) => pub<RequestAsset>('GET', `/r/${token}/assets/${assetId}/versions/${versionId}`)
export const requestReview = (token: string) => pub<RequestReview>('GET', `/r/${token}/review`)
export const objectToNote = (token: string, body: { asset_id: string; version_id?: string; comment_id?: string; body: string; text: string; name?: string }) =>
  pub<{ withdrawn: boolean; why: string }>('POST', `/r/${token}/object`, body)

const CHUNK = 10 * 1024 * 1024

/** Remove a file whose transfer never completed, so the editor can start it over. */
export const discardUpload = (token: string, body: { asset_id: string; version_id: string }) =>
  pub<void>('POST', `/r/${token}/upload/discard`, body)

/** Multipart upload into the request's folder, the same presigned-part path a signed-in editor uses. */
export async function uploadToRequest(
  token: string,
  who: { name: string; email: string },
  file: File,
  onProgress: (fraction: number) => void,
  options?: {
    slotId?: string
    assetId?: string
    onTransferred?: () => void
    identity?: () => Promise<{ name: string; email: string }>
    /** With this set, details the server refuses are asked for again; the transferred bytes stay put. */
    onIdentityRejected?: (who: { name: string; email: string }) => void
  },
): Promise<{ asset_id: string; version_number: number }> {
  const init = await pub<{ upload_id: string; s3_key: string; asset_id: string; version_id: string; version_number: number }>(
    'POST', `/r/${token}/upload/initiate`, {
      ...(!options?.identity && who.name.trim() && who.email.trim() ? { name: who.name, email: who.email } : {}), original_filename: file.name,
      mime_type: file.type || 'video/mp4', file_size_bytes: file.size,
      ...(options?.assetId ? { asset_id: options.assetId } : {}),
      ...(options?.slotId ? { slot_id: options.slotId } : {}),
    })
  const parts: { PartNumber: number; ETag: string }[] = []
  const total = Math.ceil(file.size / CHUNK)
  try {
    let next = 1, sent = 0
    let failed = false
    // Three in flight hide per-part network latency without flooding a laptop uplink.
    // Wait for all workers before aborting: no part may still be writing after cleanup.
    const results = await Promise.allSettled(Array.from({ length: Math.min(3, total) }, async () => {
      while (next <= total && !failed) {
        const n = next++
        try {
          const chunk = file.slice((n - 1) * CHUNK, Math.min(n * CHUNK, file.size))
          const { presigned_url } = await pub<{ presigned_url: string }>('POST', `/r/${token}/upload/presign-part`,
            { s3_key: init.s3_key, upload_id: init.upload_id, part_number: n })
          let put = await fetch(presigned_url, { method: 'PUT', body: chunk }).catch(() => null)
          if (!put || !put.ok) put = await fetch(presigned_url, { method: 'PUT', body: chunk })
          if (!put.ok) throw new Error('The upload stopped. Drop the file again.')
          const etag = put.headers.get('ETag')
          if (!etag) throw new Error('The upload could not be verified. Try again.')
          parts.push({ PartNumber: n, ETag: etag })
          sent += chunk.size
          onProgress(sent / file.size)
        } catch (error) { failed = true; throw error }
      }
    }))
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) throw failure.reason
    parts.sort((a, b) => a.PartNumber - b.PartNumber)
    // All bytes are up. The details below only name the submission, and can take as long as they take.
    options?.onTransferred?.()
    let identity = options?.identity ? await options.identity() : who
    for (;;) {
      try {
        await pub('POST', `/r/${token}/upload/complete`, { s3_key: init.s3_key, upload_id: init.upload_id, parts, ...identity })
        break
      } catch (e) {
        if ((e as { status?: number }).status !== 422 || !options?.identity || !options.onIdentityRejected) throw e
        options.onIdentityRejected(identity)
        identity = await options.identity()
      }
    }
  } catch (e) {
    await pub('POST', `/r/${token}/upload/abort`, { s3_key: init.s3_key, upload_id: init.upload_id, part_number: 1 }).catch(() => {})
    throw e
  }
  return { asset_id: init.asset_id, version_number: init.version_number }
}
