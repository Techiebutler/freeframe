// Reference images in a comment (spec 2026-11-07): create the row, PUT the file, confirm it.
// Every step is safe to repeat: the server reuses the row for the same file, and complete is idempotent.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 4

/** Keeps the images that may be attached, up to the limit; says why any were left out. */
export function pickImages(current: File[], incoming: File[]): { images: File[]; skipped: string | null } {
  const ok = incoming.filter(f => IMAGE_TYPES.includes(f.type) && f.size > 0 && f.size <= MAX_IMAGE_BYTES)
  const images = [...current, ...ok].slice(0, MAX_IMAGES)
  const left = incoming.length - (images.length - current.length)
  if (!left) return { images, skipped: null }
  return { images, skipped: images.length >= MAX_IMAGES ? `Up to ${MAX_IMAGES} images per comment.` : 'Only PNG, JPEG, WebP or GIF images up to 10 MB.' }
}

/** Images pasted or dropped: the files inside a DataTransfer (clipboard or drag). */
export const imagesFrom = (dt: DataTransfer | null): File[] =>
  dt ? Array.from(dt.files ?? []).filter(f => f.type.startsWith('image/')) : []

export interface ImageRoute {
  /** POST target for a new attachment row, e.g. `${API}/comments/{id}/attachments`. */
  base: string
  query?: string
  headers?: Record<string, string>
  /** Share links identify a guest by the email that wrote the comment. */
  guestEmail?: string | null
}

async function postJson(url: string, body: unknown, headers?: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  if (!res.ok) {
    const detail = await res.json().then(d => (typeof d?.detail === 'string' ? d.detail : null)).catch(() => null)
    throw Object.assign(new Error(detail ?? `image_${res.status}`), { status: res.status, detail: detail ?? 'The image could not be saved.' })
  }
  return res.json()
}

export async function uploadImages(route: ImageRoute, images: File[]): Promise<void> {
  const who = route.guestEmail ? { guest_email: route.guestEmail } : {}
  const q = route.query ?? ''
  for (const f of images) {
    const slot = await postJson(`${route.base}${q}`, { file_name: f.name || 'image.png', file_size: f.size, content_type: f.type, ...who }, route.headers)
    const put = await fetch(slot.upload_url, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f })
    if (!put.ok) throw new Error(`image_put_${put.status}`)
    await postJson(`${route.base}/${slot.attachment_id}/complete${q}`, who, route.headers)
  }
}
