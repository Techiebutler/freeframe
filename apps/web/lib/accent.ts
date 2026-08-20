/**
 * Deriving the accent CSS variables from one colour.
 *
 * Two places set an accent: instance branding (applied to the whole app) and a
 * share link's own appearance (applied only to that page, and which must win
 * there). They share this so a share link overriding the accent also overrides
 * the hover and muted shades — otherwise the button repaints but its hover
 * state stays the instance's colour.
 */

/** The tokens every accent-painted surface resolves through. */
export const ACCENT_VAR_NAMES = ['--accent', '--accent-hover', '--accent-muted'] as const

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Perceived brightness, used to decide which way the hover shade moves: a dark
 *  accent reads as "pressed" when lightened, a light one when darkened. */
function luminance([r, g, b]: [number, number, number]): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function shift(rgb: [number, number, number], amount: number): string {
  const to = amount > 0 ? 255 : 0
  const t = Math.abs(amount)
  const [r, g, b] = rgb.map((c) => Math.round(c + (to - c) * t)) as [number, number, number]
  return `rgb(${r} ${g} ${b})`
}

/** The three accent variables for a colour, or null if it isn't a 6-digit hex. */
export function accentVars(color: string | null | undefined): Record<string, string> | null {
  const rgb = color ? parseHex(color) : null
  if (!rgb || !color) return null
  return {
    '--accent': color,
    '--accent-hover': shift(rgb, luminance(rgb) > 0.6 ? -0.14 : 0.16),
    '--accent-muted': `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / 0.18)`,
  }
}
