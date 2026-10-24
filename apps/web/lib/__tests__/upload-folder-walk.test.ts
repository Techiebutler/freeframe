/**
 * Reading a drop or a pick: a dropped folder is walked to its last file, and
 * whatever the browser will not read is counted rather than lost.
 *
 * The File and Directory Entries API is stood in for with plain objects shaped
 * like Chrome's: `readEntries` answers at most 100 entries a call and an empty
 * page at the end, and `file()` / `readEntries()` report failure through their
 * error callback.
 */
import { describe, it, expect, afterEach } from 'vitest'

import { collectDataTransfer, collectInputFiles, WALK_LIMITS } from '../upload-folder-walk'

type Entry = FileEntry | DirEntry
interface FileEntry {
  isFile: true
  isDirectory: false
  name: string
  file: (ok: (f: File) => void, fail?: (e: unknown) => void) => void
}
interface DirEntry {
  isFile: false
  isDirectory: true
  name: string
  createReader: () => { readEntries: (ok: (e: Entry[]) => void, fail?: (e: unknown) => void) => void }
}

const PAGE = 100

function fileEntry(name: string, opts: { unreadable?: boolean; size?: number } = {}): FileEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok, fail) => {
      setTimeout(() => {
        if (opts.unreadable) fail?.(new DOMException('gone', 'NotFoundError'))
        else ok(new File([new Uint8Array(opts.size ?? 1)], name))
      }, 0)
    },
  }
}

function dirEntry(name: string, children: Entry[], opts: { failAfterPages?: number } = {}): DirEntry & { reads: number } {
  const d = {
    isFile: false as const,
    isDirectory: true as const,
    name,
    reads: 0,
    createReader: () => {
      let at = 0
      return {
        readEntries: (ok: (e: Entry[]) => void, fail?: (e: unknown) => void) => {
          d.reads++
          setTimeout(() => {
            if (opts.failAfterPages !== undefined && at >= opts.failAfterPages * PAGE) {
              fail?.(new DOMException('denied', 'SecurityError'))
              return
            }
            const page = children.slice(at, at + PAGE)
            at += page.length
            ok(page)
          }, 0)
        },
      }
    },
  }
  return d
}

/** A DataTransfer holding `entries` as items, whose items stop answering once
 *  `expire()` is called, as a real drop's do after the event's turn. */
function transfer(entries: Array<Entry | File>, files: File[] = []) {
  let live = true
  const items = entries.map((e) => ({
    kind: 'file',
    webkitGetAsEntry: () => (live && !(e instanceof File) ? e : null),
    getAsFile: () => (live ? (e instanceof File ? e : new File([], (e as Entry).name)) : null),
  }))
  const dt = { items: Object.assign(items, { length: items.length }), files, types: ['Files'] }
  return { dt: dt as unknown as DataTransfer, expire: () => { live = false } }
}

const paths = (files: { file: File; dirs: string[] }[]) => files.map((f) => [...f.dirs, f.file.name].join('/'))

afterEach(() => {
  WALK_LIMITS.maxDepth = 64
  WALK_LIMITS.maxEntries = 100_000
})

describe('collectDataTransfer', () => {
  it('walks a nested folder, keeping each file’s folders from the dropped folder down', async () => {
    const tree = dirEntry('Shoot', [
      fileEntry('a.mov'),
      dirEntry('Day 1', [fileEntry('b.mov'), dirEntry('Audio', [fileEntry('c.wav')])]),
      fileEntry('d.jpg'),
    ])
    const { dt } = transfer([tree])

    const out = await collectDataTransfer(dt)

    expect(paths(out.files)).toEqual(['Shoot/a.mov', 'Shoot/Day 1/b.mov', 'Shoot/Day 1/Audio/c.wav', 'Shoot/d.jpg'])
    expect(out.unreadable).toBe(0)
    expect(out.unreadableFolders).toBe(0)
  })

  it('reads every entry before its first await, so a drop whose items expire after the event is still read', async () => {
    const tree = dirEntry('Shoot', [fileEntry('a.mov')])
    const loose = new File([new Uint8Array(1)], 'loose.mov')
    const { dt, expire } = transfer([tree, loose])

    const pending = collectDataTransfer(dt)
    // The drop event's turn is over.
    expire()
    const out = await pending

    expect(paths(out.files)).toEqual(['Shoot/a.mov', 'loose.mov'])
  })

  it('keeps calling readEntries until it returns an empty page, past Chrome’s 100 per call', async () => {
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`clip-${String(i).padStart(3, '0')}.mov`))
    const folder = dirEntry('Big', many)
    const { dt } = transfer([folder])

    const out = await collectDataTransfer(dt)

    expect(out.files).toHaveLength(250)
    expect(out.files[249].file.name).toBe('clip-249.mov')
    // Three full-or-partial pages and the empty one that ends the listing.
    expect(folder.reads).toBe(4)
  })

  it('counts a file it cannot read and a folder it cannot list, and keeps the rest', async () => {
    const tree = dirEntry('Shoot', [
      fileEntry('ok.mov'),
      fileEntry('moved.mov', { unreadable: true }),
      dirEntry('Locked', [fileEntry('x.mov')], { failAfterPages: 0 }),
    ])
    const { dt } = transfer([tree])

    const out = await collectDataTransfer(dt)

    expect(paths(out.files)).toEqual(['Shoot/ok.mov'])
    expect(out.unreadable).toBe(1)
    expect(out.unreadableFolders).toBe(1)
  })

  it('keeps what a folder listed before a later page failed, and counts the folder', async () => {
    const many = Array.from({ length: 150 }, (_, i) => fileEntry(`c${i}.mov`))
    const { dt } = transfer([dirEntry('Half', many, { failAfterPages: 1 })])

    const out = await collectDataTransfer(dt)

    expect(out.files).toHaveLength(100)
    expect(out.unreadableFolders).toBe(1)
  })

  it('passes over hidden and system files and folders below the dropped folder, without counting them', async () => {
    const tree = dirEntry('Shoot', [
      fileEntry('.DS_Store'),
      fileEntry('._a.mov'),
      fileEntry('Thumbs.db'),
      fileEntry('desktop.ini'),
      fileEntry('Icon\r'),
      dirEntry('.git', [fileEntry('HEAD')]),
      dirEntry('__MACOSX', [fileEntry('a.mov')]),
      fileEntry('a.mov'),
    ])
    const { dt } = transfer([tree])

    const out = await collectDataTransfer(dt)

    expect(paths(out.files)).toEqual(['Shoot/a.mov'])
    expect(out.unreadable).toBe(0)
    expect(out.unreadableFolders).toBe(0)
  })

  it('walks a dropped folder whose own name starts with a dot', async () => {
    const { dt } = transfer([dirEntry('.footage', [fileEntry('a.mov')])])

    const out = await collectDataTransfer(dt)

    expect(paths(out.files)).toEqual(['.footage/a.mov'])
  })

  it('normalises folder names to NFC, so a macOS (NFD) name matches the same name typed elsewhere', async () => {
    const nfd = 'Café'
    const { dt } = transfer([dirEntry(nfd, [fileEntry('a.mov')])])

    const out = await collectDataTransfer(dt)

    expect(out.files[0].dirs).toEqual(['Café'])
  })

  it('stops at the depth limit and counts what it did not open', async () => {
    WALK_LIMITS.maxDepth = 2
    const tree = dirEntry('A', [fileEntry('a.mov'), dirEntry('B', [fileEntry('b.mov'), dirEntry('C', [fileEntry('c.mov')])])])
    const { dt } = transfer([tree])

    const out = await collectDataTransfer(dt)

    expect(paths(out.files)).toEqual(['A/a.mov', 'A/B/b.mov'])
    expect(out.unreadableFolders).toBe(1)
  })

  it('stops at the entry limit and counts what it did not list', async () => {
    WALK_LIMITS.maxEntries = 3
    const tree = dirEntry('A', [fileEntry('1.mov'), fileEntry('2.mov'), fileEntry('3.mov'), fileEntry('4.mov'), fileEntry('5.mov')])
    const { dt } = transfer([tree])

    const out = await collectDataTransfer(dt)

    expect(out.files).toHaveLength(3)
    expect(out.unreadable).toBe(2)
    expect(out.unreadableFolders).toBe(1)
  })

  it('takes the drop’s files as loose files when the browser offers no items', async () => {
    const f = new File([new Uint8Array(1)], 'a.mov')
    const dt = { files: [f], types: ['Files'] } as unknown as DataTransfer

    const out = await collectDataTransfer(dt)

    expect(out.files).toEqual([{ file: f, dirs: [] }])
  })

  it('takes an item with no entry through getAsFile', async () => {
    const f = new File([new Uint8Array(1)], 'a.mov')
    const { dt } = transfer([f])

    const out = await collectDataTransfer(dt)

    expect(out.files).toEqual([{ file: f, dirs: [] }])
  })
})

describe('collectInputFiles', () => {
  it('reads each file’s folders from webkitRelativePath, without the file name', () => {
    const a = new File([new Uint8Array(1)], 'a.mov')
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Shoot/Day 1/a.mov' })
    const b = new File([new Uint8Array(1)], 'b.mov')

    const out = collectInputFiles([a, b])

    expect(out.files).toEqual([
      { file: a, dirs: ['Shoot', 'Day 1'] },
      { file: b, dirs: [] },
    ])
    expect(out.unreadable).toBe(0)
  })

  it('normalises the folders to NFC', () => {
    const a = new File([new Uint8Array(1)], 'a.mov')
    Object.defineProperty(a, 'webkitRelativePath', { value: 'Café/a.mov' })

    expect(collectInputFiles([a]).files[0].dirs).toEqual(['Café'])
  })
})
