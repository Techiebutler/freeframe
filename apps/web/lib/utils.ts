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

/**
 * Time remaining as the uploads panel words it, rounded up to the minute
 * e.g. 20 → "< 1 min left", 180 → "3 min left", 4800 → "1 h 20 min left"
 */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return '< 1 min left'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`
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
 * Compare two names the way people read them: numbers by value, so
 * "Project 2" sorts before "Project 10", and case ignored.
 */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Truncate a string to the given length, appending "..." if truncated
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

/**
 * The expiry instant for a day picked in an `<input type="date">`: the last
 * millisecond of that day in the user's local time zone, as an ISO string.
 *
 * Every share-link path that turns a picked date into `expires_at` goes
 * through here. Do not use `new Date('YYYY-MM-DD')`: a date-only string parses
 * as UTC midnight, so west of UTC the link expired the evening before the
 * picked day (and east of UTC, in the early morning of it).
 */
export function endOfDayISO(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
}

/**
 * The value for an `<input type="date">` showing a stored `expires_at`: the
 * calendar day that instant falls on in the user's local time zone. The
 * inverse of `endOfDayISO`; reading it back with `toISOString()` would show
 * the UTC day, which is the next day for anyone west of UTC.
 */
export function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Copy text to the clipboard. Returns true only when the text was written.
 *
 * Uses the async Clipboard API when the page has it. Plain-HTTP origins (a LAN
 * IP, a self-hosted box without TLS) are not secure contexts and have no
 * `navigator.clipboard`, so the fallback runs `document.execCommand('copy')`
 * and writes the text from inside the `copy` event it fires. Copying the
 * selection of an off-screen textarea is not enough on its own: inside a Radix
 * dialog the focus trap pulls focus back as soon as the textarea is selected,
 * the selection is lost, and the copy succeeds with an empty string.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Refused (e.g. permissions policy, document not focused): try the
      // execCommand route before reporting failure.
    }
  }
  return copyWithExecCommand(text)
}

function copyWithExecCommand(text: string): boolean {
  let written = false
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
    written = true
  }

  const previousFocus = document.activeElement as HTMLElement | null
  // The selected textarea is still needed: Safari enables the copy command
  // only when something is selected (or a beforecopy handler says otherwise).
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.contentEditable = 'true'
  textarea.readOnly = false
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '-9999px'

  document.addEventListener('copy', onCopy, true)
  try {
    document.body.appendChild(textarea)
    if (navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad')) {
      // iOS Safari requires selection on editable elements
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
    // A true return only says the command ran; the listener says our text was
    // what it put on the clipboard.
    return document.execCommand('copy') && written
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy, true)
    textarea.remove()
    if (previousFocus && previousFocus !== document.activeElement && document.contains(previousFocus)) {
      previousFocus.focus?.()
    }
  }
}

/**
 * The name to offer for a file being uploaded: the filename without its
 * extension.
 *
 * One home for it because the upload paths disagreed. Picking a single file
 * put `cut-v3` in the name field; picking several uploaded them as
 * `cut-v3.mov`, so the same drop produced differently named assets depending
 * on how many files were in it. Dropping onto the asset area had a third copy
 * of the regex, and uses this too.
 *
 * A name that is nothing but an extension keeps it: `.gitignore` is the whole
 * name, and stripping it would leave an asset called "".
 */
export function assetNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "") || fileName
}

/**
 * The name one file of a selection is uploaded under.
 *
 * A name typed into the upload dialog belongs to one file. With several
 * selected there is one field and no way to say which of them it names, so
 * each keeps its own -- otherwise picking three clips and typing nothing
 * uploaded them as `A047C012.mov`, extension and all, while picking one gave
 * `A047C012`, because the field had been prefilled with the stripped name and
 * the multi-file path read the raw filename instead.
 */
export function uploadNameForFile(
  fileName: string,
  typedName: string,
  fileCount: number,
): string {
  if (fileCount === 1) return typedName.trim() || assetNameFromFile(fileName)
  return assetNameFromFile(fileName)
}
