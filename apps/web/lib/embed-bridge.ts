/** postMessage bridge for the share page's ?embed=1 mode: the page tells its parent window what happens. */

export const EMBED_PARENT_ORIGINS = ['https://gen.aditor.ai', 'https://app.aditor.ai']

export type EmbedMessage =
  | { type: 'ar:ready'; width: number; height: number; duration: number }
  | { type: 'ar:play' | 'ar:pause' | 'ar:ended' | 'ar:sent' | 'ar:approved' }
  | { type: 'ar:comment'; t: number }

/** The embedding page's origin if (and only if) it is allowlisted. Chrome/Safari give ancestorOrigins, Firefox only the referrer. */
export function parentOrigin(ancestors: ArrayLike<string> | undefined, referrer: string): string | null {
  let origin = ancestors?.[0]
  if (!origin && referrer) { try { origin = new URL(referrer).origin } catch { /* no usable referrer */ } }
  return origin && EMBED_PARENT_ORIGINS.includes(origin) ? origin : null
}

/** Posts to the parent frame, addressed to its own origin; silently nothing when not framed or framed by anyone else. */
export function sendToParent(msg: EmbedMessage, win: Window = window): boolean {
  if (win.parent === win) return false
  const origin = parentOrigin((win.location as Location & { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins, win.document.referrer)
  if (!origin) return false
  win.parent.postMessage(msg, origin)
  return true
}
