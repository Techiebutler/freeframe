/**
 * Which files a drop or a pick uploads, and as what type.
 *
 * A dropped folder holds whatever sits beside the media in it: notes, project
 * files, archives, the operating system's own files. Only the types the server
 * accepts are uploaded. The rest are left out here, before anything reaches the
 * server, and the Uploads panel says how many were left out in one line.
 * Hidden and system files are left out without a word.
 *
 * `ALLOWED_MIME_TYPES` mirrors the set `/upload/initiate` checks
 * (`apps/api/schemas/upload.py`); `upload-media-types-match-server.test.ts`
 * reads that file and fails when the two differ.
 */
import type { DropFile } from '@/lib/upload-folder-walk'

/** Every type `/upload/initiate` accepts, aliases included. */
export const ALLOWED_MIME_TYPES: readonly string[] = [
  // Images
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff', 'image/gif',
  // Audio
  'audio/mpeg', 'audio/aac', 'audio/ogg',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/x-pn-wav',
  'audio/aiff', 'audio/x-aiff',
  'audio/flac', 'audio/x-flac',
  'audio/x-m4a', 'audio/mp4',
  // Video
  'video/mp4', 'video/x-m4v', 'video/quicktime',
  'video/x-msvideo', 'video/avi',
  'video/x-matroska', 'video/matroska',
  'video/webm', 'video/mpeg', 'video/x-ms-wmv',
]

const ALLOWED = new Set(ALLOWED_MIME_TYPES)

/**
 * A lower-cased extension to the accepted type a file with it is sent as.
 *
 * Needed because the browser's `File.type` is often empty: every file read out
 * of a dropped folder, and a .mov or .mkv on Windows, arrives with `""`, which
 * the server refuses. Every value here must be in `ALLOWED_MIME_TYPES`.
 */
export const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.bwf': 'audio/wav',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.flac': 'audio/flac',
  '.m4a': 'audio/x-m4a',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.wmv': 'video/x-ms-wmv',
}

/** `name`'s extension, lower-cased and with its dot ('.mov'); '' when it has
 *  none. A name that is only a leading dot and a word is a hidden file, not an
 *  extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * The type a file is uploaded as: the browser's own type when the server
 * accepts it, otherwise the type its extension stands for. Null when the file
 * is not one the server accepts.
 */
export function uploadMimeFor(name: string, type: string): string | null {
  if (ALLOWED.has(type)) return type
  return TYPE_BY_EXTENSION[extensionOf(name)] ?? null
}

/** System files that are not dotfiles, compared without case. `icon\r` is the
 *  file macOS keeps a folder's custom icon in. */
const SYSTEM_FILES = new Set(['thumbs.db', 'desktop.ini', 'icon\r'])

/** Whether a folder is hidden or the system's own (.git, .Trashes, __MACOSX).
 *  Nothing inside one is uploaded, and the folder walk never opens it. */
export function isHiddenFolder(name: string): boolean {
  return name.startsWith('.') || name === '__MACOSX'
}

/** Whether a file is hidden or the system's own: a dotfile (.DS_Store, the
 *  `._clip.mov` resource forks macOS writes to other disks), Thumbs.db,
 *  desktop.ini or `Icon\r`. */
export function isHiddenFile(name: string): boolean {
  return name.startsWith('.') || SYSTEM_FILES.has(name.toLowerCase())
}

/** The server's limit on an asset's name (`assets.name`). */
export const MAX_ASSET_NAME_LENGTH = 255
/** The server's limit on a file's name (`media_files.original_filename`). */
export const MAX_FILE_NAME_LENGTH = 500
/** Longer than this, an "extension" is not worth keeping over the name. */
const MAX_KEPT_EXTENSION_LENGTH = 32

/** `s` cut to at most `n` UTF-16 units, never through a surrogate pair. */
function cutTo(s: string, n: number): string {
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/** The asset name a file is uploaded under: its own name in NFC, cut to 255
 *  characters with the extension kept. */
export function assetNameFor(fileName: string): string {
  const name = fileName.normalize('NFC')
  if (name.length <= MAX_ASSET_NAME_LENGTH) return name
  const ext = extensionOf(name)
  if (ext.length === 0 || ext.length > MAX_KEPT_EXTENSION_LENGTH) return cutTo(name, MAX_ASSET_NAME_LENGTH)
  const stem = name.slice(0, name.length - ext.length)
  return cutTo(stem, MAX_ASSET_NAME_LENGTH - ext.length) + name.slice(name.length - ext.length)
}

/** A file the drop uploads, with the type it is sent as. */
export interface PlannedFile extends DropFile {
  mimeType: string
}

/** What a drop or a pick comes to once filtered. */
export interface DropPlan {
  /** The files to upload, in the order they came. */
  upload: PlannedFile[]
  /** Files of a type the server does not accept, and their extensions, most
   *  common first. A file with no extension adds to the count only. */
  skipped: { count: number; extensions: string[] }
  /** Files with nothing in them: there is nothing to upload. */
  empty: number
  /** Files whose name is longer than the server stores. */
  nameTooLong: number
}

/**
 * Filters a drop or a pick, keeping the order it came in.
 *
 * Hidden and system files, and anything inside a hidden folder, are left out
 * and not counted. The folder that was dropped or picked (`dirs[0]`) is never
 * treated as hidden: the person chose it, whatever it is called.
 */
export function planDrop(files: DropFile[]): DropPlan {
  const upload: PlannedFile[] = []
  const extensions = new Map<string, number>()
  let skipped = 0
  let empty = 0
  let nameTooLong = 0
  for (const f of files) {
    if (isHiddenFile(f.file.name) || f.dirs.slice(1).some(isHiddenFolder)) continue
    const mimeType = uploadMimeFor(f.file.name, f.file.type)
    if (mimeType === null) {
      skipped++
      const ext = extensionOf(f.file.name)
      if (ext) extensions.set(ext, (extensions.get(ext) ?? 0) + 1)
      continue
    }
    if (f.file.size <= 0) {
      empty++
      continue
    }
    if (f.file.name.length > MAX_FILE_NAME_LENGTH) {
      nameTooLong++
      continue
    }
    upload.push({ ...f, mimeType })
  }
  // Most common first; a tie keeps the order they were first seen in, which a
  // Map's iteration order is.
  const ranked = [...extensions.entries()]
    .map(([ext, n], i) => ({ ext, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((e) => e.ext)
  return { upload, skipped: { count: skipped, extensions: ranked }, empty, nameTooLong }
}

/** How many extensions a skipped line names before "and N more". */
const NAMED_EXTENSIONS = 5

const files = (n: number) => (n === 1 ? '1 file' : `${n} files`)

/** The Uploads panel's lines about what a plan left out, one per reason. */
export function planNotes(plan: DropPlan): string[] {
  const lines: string[] = []
  if (plan.skipped.count > 0) {
    const n = plan.skipped.count
    let line = `Skipped ${files(n)} that can't be uploaded`
    const exts = plan.skipped.extensions
    if (exts.length > 0) {
      const more = exts.length - NAMED_EXTENSIONS
      line += ` (${exts.slice(0, NAMED_EXTENSIONS).join(', ')}${more > 0 ? ` and ${more} more` : ''})`
    }
    lines.push(line)
  }
  if (plan.empty > 0) lines.push(`Skipped ${files(plan.empty)} with nothing in ${plan.empty === 1 ? 'it' : 'them'}`)
  if (plan.nameTooLong > 0) {
    lines.push(`Skipped ${files(plan.nameTooLong)} whose name is longer than ${MAX_FILE_NAME_LENGTH} characters`)
  }
  return lines
}
