import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Format seconds into "M:SS" or "H:MM:SS"
 * e.g. 83 → "1:23", 3725 → "1:02:05"
 */
export function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds)
  const hrs = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * Format seconds into SMPTE timecode "HH:MM:SS:FF" at 24fps
 * e.g. 83.5 → "00:01:23:12"
 */
export function formatTimecode(seconds: number, fps = 24): string {
  const totalFrames = Math.floor(seconds * fps)
  const frames = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const secs = totalSeconds % 60
  const mins = Math.floor(totalSeconds / 60) % 60
  const hrs = Math.floor(totalSeconds / 3600)

  return [
    String(hrs).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
    String(frames).padStart(2, '0'),
  ].join(':')
}

/**
 * Format seconds as frame count at given fps
 * e.g. 83.5 at 24fps → "2004"
 */
export function formatFrames(seconds: number, fps = 24): string {
  return String(Math.floor(seconds * fps))
}

/**
 * Format bytes into human-readable size string
 * e.g. 1_610_612_736 → "1.5 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${parseFloat(value.toFixed(1))} ${units[i]}`
}

export const GB = 1024 ** 3

export function gbToBytes(gb: number): number {
  return Math.round(gb * GB)
}

export function bytesToGb(bytes: number): number {
  return bytes / GB
}

export function storageMeterState(
  used: number,
  limit: number,
): { unlimited: boolean; pct: number; level: 'ok' | 'warn' | 'critical' } {
  if (limit <= 0) return { unlimited: true, pct: 0, level: 'ok' }
  const pct = Math.min(100, (used / limit) * 100)
  const level = pct >= 90 ? 'critical' : pct >= 80 ? 'warn' : 'ok'
  return { unlimited: false, pct, level }
}

/**
 * Format an ISO date string into a relative time string
 * e.g. "2 hours ago", "3 days ago", "just now"
 */
export function formatRelativeTime(date: string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const diffSecs = Math.floor(diffMs / 1000)

  if (diffSecs < 60) return 'just now'

  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`

  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`

  const diffYears = Math.floor(diffMonths / 12)
  return `${diffYears} year${diffYears !== 1 ? 's' : ''} ago`
}

/**
 * Truncate a string to the given length, appending "..." if truncated
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

export function endOfDayISO(dateStr: string): string {
  const d = new Date(dateStr)
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
}

/**
 * Copy text to clipboard with modern API + fallback.
 * Handles iOS Safari where execCommand('copy') requires a selected editable element.
 * Returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern async clipboard API
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  // Fallback for older browsers (including iOS Safari < 13.4)
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.contentEditable = 'true'
    textarea.readOnly = false
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '-9999px'
    document.body.appendChild(textarea)

    try {
      // iOS Safari requires selection on editable elements
      if (navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad')) {
        const range = document.createRange()
        range.selectNodeContents(textarea)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        textarea.setSelectionRange(0, text.length)
      } else {
        textarea.select()
        textarea.setSelectionRange(0, text.length)
      }

      return document.execCommand('copy')
    } finally {
      // Always remove the off-screen node, even if selection/execCommand throws.
      textarea.remove()
    }
  } catch {
    return false
  }
}
