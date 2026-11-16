export interface DeliveryRef { token: string; share_url: string }

const API_URL = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

/** What an approve call hands back: the delivery page the reviewer can copy, or null when the server made none. */
export function deliveryOf(body: unknown): DeliveryRef | null {
  const d = (body as { delivery?: Partial<DeliveryRef> } | null)?.delivery
  return d?.token && d.share_url ? { token: d.token, share_url: d.share_url } : null
}

/** The link was copied: the request leaves the overview for the Delivered archive. Best effort, idempotent. */
export async function markHandedOn(token: string): Promise<void> {
  try { await fetch(`${API_URL()}/deliveries/${token}/handed-on`, { method: 'POST' }) } catch { /* the link is already copied; the archive catches up on the next copy */ }
}
