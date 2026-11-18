/**
 * A dropped folder, for drop-site tests.
 *
 * A real drop's `DataTransfer.items` answer only during the drop event's own
 * turn; afterwards `webkitGetAsEntry()` gives nothing. `folderDrop` behaves the
 * same once `expire()` is called, so a drop site that reads the items later
 * (after an await, in a callback) reads nothing, as it would in a browser.
 * `files` holds what Chrome puts there for a dropped folder: one placeholder
 * `File` named after the folder, which cannot be read.
 */
import { vi } from 'vitest'

interface FakeEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
}

function fileEntry(name: string): FakeEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => setTimeout(() => ok(new File([new Uint8Array(4)], name)), 0),
  } as FakeEntry
}

function dirEntry(name: string, children: FakeEntry[]): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false
      return {
        readEntries: (ok: (e: FakeEntry[]) => void) =>
          setTimeout(() => {
            ok(done ? [] : children)
            done = true
          }, 0),
      }
    },
  } as FakeEntry
}

/** A drop of one folder, `name`, holding `files` (by name). */
export function folderDrop(name = 'Shoot', files: string[] = ['a.mov']) {
  let live = true
  const root = dirEntry(name, files.map(fileEntry))
  const webkitGetAsEntry = vi.fn(() => (live ? root : null))
  const item = { kind: 'file', webkitGetAsEntry, getAsFile: () => (live ? placeholder : null) }
  const placeholder = new File([], name)
  const items = Object.assign([item], { length: 1 })
  return {
    dataTransfer: { types: ['Files'], items, files: [placeholder], dropEffect: 'none' },
    /** The drop event's turn is over. */
    expire: () => {
      live = false
    },
    webkitGetAsEntry,
    placeholder,
  }
}

/** `dirs/name` for each file a drop site handed on. */
export function droppedPaths(collected: { files: { file: File; dirs: string[] }[] }): string[] {
  return collected.files.map((f) => [...f.dirs, f.file.name].join('/'))
}
