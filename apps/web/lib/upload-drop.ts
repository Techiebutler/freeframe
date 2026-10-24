/**
 * Starting a drop or a pick.
 *
 * What came in is filtered (`planDrop`), the folders it was in are found or
 * made under the folder it landed on (`POST /projects/{id}/folders/ensure`),
 * and then every file is queued, in the order it came, each into its own
 * folder. Whatever was left out is said in the Uploads panel as a drop note, and
 * a drop that ends with nothing uploaded always leaves one: a drop is never
 * silently lost.
 *
 * The folders are made before anything is queued, and when that fails nothing
 * is: half a folder tree uploaded into the wrong place is harder to put right
 * than a drop that can be made again.
 *
 * A drop belongs to the account signed in when it was made. Tokens are shared
 * by every tab, so another tab can sign in as someone else while the drop is
 * read or its folders are made: the folders are asked for as the drop's
 * account only (`pinSubject`), and if the tab is no longer acting as it once
 * they exist, nothing is queued.
 */
import { mutate as swrMutate } from 'swr'

import { api, ApiError } from '@/lib/api'
import { currentSubject } from '@/lib/upload-owner'
import type { Collected } from '@/lib/upload-folder-walk'
import { assetNameFor, planDrop, planNotes } from '@/lib/upload-media-types'
import { useUploadStore, type StartItem } from '@/stores/upload-store'

/** How many folders deep a dropped tree is made: the server's
 *  MAX_FOLDER_DEPTH. The server also cuts each path to the room left under
 *  the folder dropped onto. */
export const UPLOAD_FOLDER_DEPTH = 10
/** Paths per ensure request (the server refuses more). */
export const MAX_ENSURE_PATHS = 500
/** Distinct folders per ensure request, every prefix of every path counted
 *  once (the server refuses more). */
export const MAX_ENSURE_NODES = 2_000

export const NOTHING_TO_UPLOAD = 'There were no files to upload.'

export function unreadableNote(n: number): string {
  return n === 1 ? '1 file or folder could not be read' : `${n} files or folders could not be read`
}

export function ensureFailedNote(reason: string): string {
  return `Could not create folders: ${reason.replace(/[.\s]+$/, '')}. Nothing was uploaded.`
}

export interface DropDestination {
  projectId: string
  projectName?: string
  /** The folder the drop landed on; null for the project root. */
  folderId: string | null
}

export type DropOutcome =
  /** Queued; `ids` are the new rows, in the order the files came. */
  | { kind: 'queued'; ids: string[] }
  /** Nothing to upload; a note says why. */
  | { kind: 'nothing' }
  /** The folders could not be made, so nothing was queued; a note says why. */
  | { kind: 'failed' }
  /** Nobody is signed in in this tab: nothing was asked or queued, and the
   *  caller tells the user to sign in. */
  | { kind: 'signed-out' }
  /** Another account signed in after the drop was made: nothing was queued,
   *  and nothing is said to the new account in the panel. */
  | { kind: 'account-changed' }

interface EnsureResponse {
  folders: Array<{ path: string[]; folder_id: string | null }>
}

const keyOf = (path: string[]) => JSON.stringify(path)

/** `paths` in requests the server takes: at most MAX_ENSURE_PATHS paths and
 *  MAX_ENSURE_NODES distinct folders each, in the order given. */
function ensureChunks(paths: string[][]): string[][][] {
  const chunks: string[][][] = []
  let chunk: string[][] = []
  let nodes = new Set<string>()
  for (const path of paths) {
    const prefixes = path.map((_, i) => keyOf(path.slice(0, i + 1)))
    const added = prefixes.filter((p) => !nodes.has(p)).length
    if (chunk.length > 0 && (chunk.length >= MAX_ENSURE_PATHS || nodes.size + added > MAX_ENSURE_NODES)) {
      chunks.push(chunk)
      chunk = []
      nodes = new Set()
    }
    chunk.push(path)
    for (const p of prefixes) nodes.add(p)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Finds or makes every folder of `paths` under `parentId` (null: the project
 * root), and answers each path's folder id, keyed by `keyOf(path)`. A null id
 * means the path did not fit under the parent's depth, and its files go into
 * the parent itself.
 *
 * Each path is asked for once, parents before children, in requests one after
 * another, so a request never names a folder whose parent a request still on
 * its way is making. Rejects when any request fails.
 */
export async function ensureUploadFolders(
  projectId: string,
  parentId: string | null,
  paths: string[][],
  owner: string,
): Promise<Map<string, string | null>> {
  const seen = new Set<string>()
  const distinct: string[][] = []
  for (const path of paths) {
    if (path.length === 0) continue
    const key = keyOf(path)
    if (seen.has(key)) continue
    seen.add(key)
    distinct.push(path)
  }
  // Stable: parents before children, otherwise in the order the files came.
  distinct.sort((a, b) => a.length - b.length)

  const out = new Map<string, string | null>()
  for (const chunk of ensureChunks(distinct)) {
    const answer = await api.post<EnsureResponse>(
      `/projects/${encodeURIComponent(projectId)}/folders/ensure`,
      { parent_id: parentId, paths: chunk },
      { pinSubject: owner },
    )
    const folders = answer?.folders ?? []
    // One answer per path asked, in the order asked. Matched by position, not
    // by the path echoed back, which the server may have tidied (stripped,
    // normalised) on the way.
    if (folders.length !== chunk.length) throw new Error('The server did not answer for every folder')
    chunk.forEach((path, i) => out.set(keyOf(path), folders[i].folder_id ?? null))
  }
  return out
}

/** Refetches every folder list of the project, so the folders a drop made
 *  show up in the tree and the grid. Never throws: a list that failed to
 *  refetch shows them on its next read. */
async function revalidateFolderCaches(projectId: string): Promise<void> {
  const tree = `/projects/${projectId}/folder-tree`
  const lists = `/projects/${projectId}/folders?`
  try {
    await swrMutate(
      (key: unknown) => typeof key === 'string' && (key === tree || key.startsWith(lists)),
      undefined,
      { revalidate: true, populateCache: false },
    )
  } catch {
    // See above.
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof ApiError) return err.detail
  if (err instanceof Error && err.message) return err.message
  return 'the server did not answer'
}

/** What a drop comes to when this tab is no longer acting as `owner`. */
function ownerGone(owner: string): DropOutcome | null {
  const now = currentSubject()
  if (now === owner) return null
  return now === null ? { kind: 'signed-out' } : { kind: 'account-changed' }
}

/**
 * Starts a drop or a pick into `dest`, as `owner`.
 *
 * `collected` may be the promise `collectDataTransfer` returned during the
 * drop event: the walk goes on after the event, and this waits for it.
 *
 * `owner` is the account the drop was made as. It defaults to the one signed
 * in when this is called, so call it during the drop event, or pass the
 * account read then (a drop held until the role is known).
 */
export async function startDrop(
  collected: Collected | Promise<Collected>,
  dest: DropDestination,
  owner: string | null = currentSubject(),
): Promise<DropOutcome> {
  // An upload belongs to the account that added it; with no session there is
  // nobody to make folders as, either.
  if (owner === null) return { kind: 'signed-out' }
  const got = await collected
  const goneWhileReading = ownerGone(owner)
  if (goneWhileReading) return goneWhileReading

  const store = useUploadStore.getState()
  const plan = planDrop(got.files)
  const notes = planNotes(plan)
  const unread = got.unreadable + got.unreadableFolders
  if (unread > 0) notes.push(unreadableNote(unread))

  if (plan.upload.length === 0) {
    for (const text of notes.length > 0 ? notes : [NOTHING_TO_UPLOAD]) store.addDropNote(text, owner)
    return { kind: 'nothing' }
  }

  const dirsOf = plan.upload.map((f) => f.dirs.slice(0, UPLOAD_FOLDER_DEPTH).map((s) => s.normalize('NFC')))
  let folders = new Map<string, string | null>()
  if (dirsOf.some((d) => d.length > 0)) {
    try {
      folders = await ensureUploadFolders(dest.projectId, dest.folderId, dirsOf, owner)
    } catch (err) {
      // A pinned request refused because the account changed is not a
      // failure to tell the new account about.
      const goneWhileAsking = ownerGone(owner)
      if (goneWhileAsking) return goneWhileAsking
      for (const text of notes) store.addDropNote(text, owner)
      store.addDropNote(ensureFailedNote(reasonOf(err)), owner)
      return { kind: 'failed' }
    }
    await revalidateFolderCaches(dest.projectId)
  }

  // Checked in the same turn as the queueing, which reads the account again.
  const goneBeforeQueueing = ownerGone(owner)
  if (goneBeforeQueueing) return goneBeforeQueueing

  const items: StartItem[] = plan.upload.map((f, i) => ({
    file: f.file,
    assetName: assetNameFor(f.file.name),
    mimeType: f.mimeType,
    folderId: dirsOf[i].length > 0 ? (folders.get(keyOf(dirsOf[i])) ?? dest.folderId) : dest.folderId,
  }))
  const ids = useUploadStore.getState().startUploads(items, dest.projectId, dest.projectName, dest.folderId)
  if (ids.length === 0) return { kind: 'signed-out' }
  for (const text of notes) useUploadStore.getState().addDropNote(text, owner)
  return { kind: 'queued', ids }
}
