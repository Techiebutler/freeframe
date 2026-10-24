/**
 * What a drop or a picker holds: every file, each with the folders it sits in
 * from the dropped or picked folder's own name down, and a count of what could
 * not be read.
 *
 * A dropped folder reaches the page as a single placeholder in
 * `DataTransfer.files`: a `File` with the folder's name and no readable bytes.
 * Its contents can only be read through the File and Directory Entries API
 * (`webkitGetAsEntry`), which every browser the app supports implements.
 *
 * Which of the files are uploaded is `planDrop`'s decision
 * (`lib/upload-media-types`); this module only reads.
 */
import { isHiddenFile, isHiddenFolder } from '@/lib/upload-media-types'

/** One file of a drop or a pick. */
export interface DropFile {
  file: File
  /** The folders it was in, from the dropped or picked folder down, in NFC.
   *  Empty for a file dropped or picked on its own. */
  dirs: string[]
}

/** What a drop or a picker held. */
export interface Collected {
  files: DropFile[]
  /** Files the browser would not read (moved, deleted or not permitted since
   *  the drop), and files the walk's limits left unread. */
  unreadable: number
  /** Folders the browser would not list, or not to the end, and folders the
   *  walk's limits left unopened. */
  unreadableFolders: number
}

/** How far a walk goes. Past either limit, what is left is counted as unread
 *  rather than read, so a drop of a whole disk cannot hang the tab. Mutable so
 *  a test can lower them. */
export const WALK_LIMITS = { maxDepth: 64, maxEntries: 100_000 }

/* The parts of the File and Directory Entries API the walk uses. Structural,
 * so a test can stand in for the browser. */
interface WalkEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
}
interface WalkFileEntry extends WalkEntry {
  file: (ok: (f: File) => void, fail?: (err: unknown) => void) => void
}
interface WalkDirectoryReader {
  readEntries: (ok: (entries: WalkEntry[]) => void, fail?: (err: unknown) => void) => void
}
interface WalkDirectoryEntry extends WalkEntry {
  createReader: () => WalkDirectoryReader
}

type Dropped = { entry: WalkEntry } | { file: File }

/** One walk's running totals, shared by every folder in it. */
interface WalkState {
  listed: number
  unreadable: number
  unreadableFolders: number
}

const nfc = (s: string) => s.normalize('NFC')

/**
 * Every file of a drop, in the order it was dropped, with its folders.
 *
 * A `DataTransfer`'s items can be read only during the drop event's own turn:
 * by the time anything awaited has resolved, `items` is empty. So this has to be
 * called synchronously in the drop handler, and it reads every
 * `webkitGetAsEntry()` before its first await. An item with no entry is taken
 * with `getAsFile()`, and one with neither is counted as unreadable. When no
 * item could be read, the drop's `files` are taken as loose files.
 *
 * Never rejects: whatever cannot be read is counted instead.
 */
export function collectDataTransfer(dt: DataTransfer): Promise<Collected> {
  const dropped: Dropped[] = []
  let lost = 0
  const items = dt.items as DataTransferItemList | undefined
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || item.kind !== 'file') continue
      let entry: WalkEntry | null = null
      try {
        entry = typeof item.webkitGetAsEntry === 'function' ? (item.webkitGetAsEntry() as WalkEntry | null) : null
      } catch {
        entry = null
      }
      if (entry) {
        dropped.push({ entry })
        continue
      }
      const file = item.getAsFile()
      if (file) dropped.push({ file })
      else lost++
    }
  }
  if (dropped.length === 0) {
    const files = Array.from(dt.files ?? []).map((file) => ({ file, dirs: [] }))
    return Promise.resolve({ files, unreadable: files.length > 0 ? 0 : lost, unreadableFolders: 0 })
  }
  return walkAll(dropped, lost)
}

async function walkAll(dropped: Dropped[], lost: number): Promise<Collected> {
  const state: WalkState = { listed: 0, unreadable: lost, unreadableFolders: 0 }
  const out = await Promise.all(
    dropped.map((d) => ('file' in d ? [{ file: d.file, dirs: [] }] : walk(d.entry, [], state))),
  )
  return { files: out.flat(), unreadable: state.unreadable, unreadableFolders: state.unreadableFolders }
}

/**
 * `entry`'s files: itself when it is a file, every file below it when it is a
 * folder, in the order the folder lists them (the reads run side by side, the
 * result keeps that order). Below the dropped item, hidden and system files and
 * folders are passed over unread. The dropped item itself is never treated as
 * hidden: a folder called `.footage` that someone dragged in is what they want
 * uploaded.
 */
async function walk(entry: WalkEntry, dirs: string[], state: WalkState): Promise<DropFile[]> {
  const name = nfc(entry.name)
  const below = dirs.length > 0
  if (entry.isFile) {
    if (below && isHiddenFile(name)) return []
    const file = await fileOf(entry as WalkFileEntry)
    if (file) return [{ file, dirs }]
    state.unreadable++
    return []
  }
  if (!entry.isDirectory) return []
  if (below && isHiddenFolder(name)) return []
  const inside = [...dirs, name]
  if (inside.length > WALK_LIMITS.maxDepth) {
    state.unreadableFolders++
    return []
  }
  const children = await readAll(entry as WalkDirectoryEntry, state)
  const out = await Promise.all(children.map((child) => walk(child, inside, state)))
  return out.flat()
}

/** A file entry's `File`, or null when the browser will not read it. */
function fileOf(entry: WalkFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    try {
      entry.file(resolve, () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/**
 * Everything a folder lists, within the walk's entry budget.
 *
 * `readEntries` answers a page at a time (Chrome's pages hold 100), and only an
 * empty page says the folder has been listed to the end, so it is called until
 * one comes back. A failed read counts the folder as unreadable and keeps what
 * was listed before it. Entries past the budget are counted as unread, each as
 * what it is.
 */
async function readAll(dir: WalkDirectoryEntry, state: WalkState): Promise<WalkEntry[]> {
  let reader: WalkDirectoryReader
  try {
    reader = dir.createReader()
  } catch {
    state.unreadableFolders++
    return []
  }
  const all: WalkEntry[] = []
  for (;;) {
    const page = await new Promise<WalkEntry[] | null>((resolve) => {
      try {
        reader.readEntries(resolve, () => resolve(null))
      } catch {
        resolve(null)
      }
    })
    if (page === null) {
      state.unreadableFolders++
      return all
    }
    if (page.length === 0) return all
    const room = Math.max(0, WALK_LIMITS.maxEntries - state.listed)
    all.push(...page.slice(0, room))
    state.listed += Math.min(room, page.length)
    if (page.length > room) {
      for (const left of page.slice(room)) countUnwalked(left, state)
      // The budget is spent: whatever the folder still holds is never listed.
      state.unreadableFolders++
      return all
    }
  }
}

/** An entry the walk's limits left unread, counted as what it is. Hidden
 *  entries are not counted, as they would not have been uploaded. */
function countUnwalked(entry: WalkEntry, state: WalkState): void {
  const name = nfc(entry.name)
  if (entry.isFile && !isHiddenFile(name)) state.unreadable++
  else if (entry.isDirectory && !isHiddenFolder(name)) state.unreadableFolders++
}

/**
 * A file or folder picker's files, in order. For a folder picker
 * (`<input webkitdirectory>`) each file's folders come from its
 * `webkitRelativePath`, which starts with the picked folder's own name; a file
 * picked on its own has none. A picker hands over only what it could read, so
 * nothing is counted as unread.
 */
export function collectInputFiles(list: FileList | File[]): Collected {
  const files = Array.from(list).map((file) => {
    const segments = (file.webkitRelativePath ?? '').split('/').filter((s) => s.length > 0)
    return { file, dirs: segments.slice(0, -1).map(nfc) }
  })
  return { files, unreadable: 0, unreadableFolders: 0 }
}
