/** postMessage bridge for the share page's ?embed=1 mode: the page tells its parent window what happens. */

export const EMBED_PARENT_ORIGINS = ['https://gen.aditor.ai', 'https://app.aditor.ai', 'https://web.telegram.org']

/** `asset_id` names the asset on screen (a folder share embeds several); `index` is 1-based. */
export type EmbedMessage = (
  | { type: 'ar:ready'; width: number; height: number; duration: number; index?: number; count?: number }
  | { type: 'ar:play' | 'ar:pause' | 'ar:ended' | 'ar:sent' | 'ar:approved' }
  | { type: 'ar:comment'; t: number }
  | { type: 'ar:asset'; index: number; count: number }
) & { asset_id?: string }

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

/** Parts of the request: how many modules are approved of how many; `complete` is the server's word (Gen decides "done" from it). */
export type PartsProgress = { approved: number; total: number; complete: boolean }

/**
 * The hand-off contract with Gen (AR -> Gen, all via postMessage to the parent):
 *  - round_sent: the feedback round closed (Send, or every module reviewed)
 *  - approved:   EVERY approve tap, with `parts`
 *  - notes:      the number of new comments in the open round changed (0 after a send)
 */
export type AutoreviewEvent =
  | { type: 'autoreview'; event: 'round_sent'; request_id: string; asset_id?: string }
  | { type: 'autoreview'; event: 'approved'; request_id: string; asset_id?: string; parts: PartsProgress }
  | { type: 'autoreview'; event: 'notes'; request_id: string; count: number }

export type AutoreviewPayload = AutoreviewEvent extends infer E ? (E extends AutoreviewEvent ? Omit<E, 'type'> : never) : never

/** Gen -> AR: the tile was folded or the card switched. Belt and braces next to the iframe's own `pagehide`. */
export type GenCloseMessage = { type: 'gen:close'; reason: 'left' }

/** True for a `gen:close` message that came from an allowlisted parent window. */
export function isGenClose(e: { data: unknown; origin: string }): boolean {
  const d = e.data as Partial<GenCloseMessage> | null
  return !!d && typeof d === 'object' && d.type === 'gen:close' && d.reason === 'left' && EMBED_PARENT_ORIGINS.includes(e.origin)
}

/**
 * Posts the hand-off event to the parent. Never "*": it goes to the parent's own origin when that is known (and allowlisted),
 * otherwise (no ancestorOrigins, referrer stripped) to each allowlisted origin, where the browser drops every mismatch.
 * A known foreign parent, no parent (top-level, Telegram WebView) or no request id: nothing.
 */
export function sendAutoreviewEvent(msg: AutoreviewPayload, win: Window = window): boolean {
  if (win.parent === win || !msg.request_id) return false
  const ancestors = (win.location as Location & { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins
  const full: AutoreviewEvent = { type: 'autoreview', ...msg }
  const known = parentOrigin(ancestors, win.document.referrer)
  if (known) { win.parent.postMessage(full, known); return true }
  if (ancestors?.[0] || win.document.referrer) return false
  EMBED_PARENT_ORIGINS.forEach((o) => win.parent.postMessage(full, o))
  return true
}
