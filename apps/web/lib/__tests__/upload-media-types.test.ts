/**
 * Filtering a drop: what is uploaded, as which type, and what the Uploads
 * panel says about the rest.
 */
import { describe, it, expect } from 'vitest'

import { assetNameFor, planDrop, planNotes, uploadMimeFor } from '../upload-media-types'

const f = (name: string, opts: { type?: string; size?: number; dirs?: string[] } = {}) => ({
  file: new File([new Uint8Array(opts.size ?? 1)], name, { type: opts.type ?? '' }),
  dirs: opts.dirs ?? [],
})

describe('uploadMimeFor', () => {
  it('keeps a type the server accepts', () => {
    expect(uploadMimeFor('a.wav', 'audio/x-wav')).toBe('audio/x-wav')
  })

  it('maps an empty type from the extension, whatever its case', () => {
    // Every file read out of a dropped folder, and a .mov on Windows, has type "".
    expect(uploadMimeFor('A001.MOV', '')).toBe('video/quicktime')
    expect(uploadMimeFor('take.mkv', '')).toBe('video/x-matroska')
    expect(uploadMimeFor('still.jpeg', '')).toBe('image/jpeg')
  })

  it('maps a type the server does not list from the extension', () => {
    expect(uploadMimeFor('a.mov', 'application/octet-stream')).toBe('video/quicktime')
  })

  it('answers null for a file the server would refuse', () => {
    expect(uploadMimeFor('notes.txt', 'text/plain')).toBeNull()
    expect(uploadMimeFor('README', '')).toBeNull()
    expect(uploadMimeFor('.mov', '')).toBeNull()
  })
})

describe('planDrop', () => {
  it('uploads media with the mapped type, in the order given', () => {
    const plan = planDrop([f('b.mov'), f('a.jpg', { type: 'image/jpeg' })])

    expect(plan.upload.map((p) => [p.file.name, p.mimeType])).toEqual([
      ['b.mov', 'video/quicktime'],
      ['a.jpg', 'image/jpeg'],
    ])
  })

  it('counts unsupported files with their extensions, most common first', () => {
    const plan = planDrop([f('a.zip'), f('n.txt'), f('m.txt'), f('README'), f('a.mov')])

    expect(plan.skipped).toEqual({ count: 4, extensions: ['.txt', '.zip'] })
    expect(plan.upload).toHaveLength(1)
  })

  it('skips and counts empty files', () => {
    const plan = planDrop([f('empty.mov', { size: 0 }), f('a.mov')])

    expect(plan.empty).toBe(1)
    expect(plan.upload.map((p) => p.file.name)).toEqual(['a.mov'])
  })

  it('refuses a file whose name is longer than the server stores', () => {
    const plan = planDrop([f(`${'x'.repeat(497)}.mov`), f(`${'x'.repeat(496)}.mov`)])

    expect(plan.nameTooLong).toBe(1)
    expect(plan.upload).toHaveLength(1)
  })

  it('leaves out hidden and system files and hidden folders silently, but never the picked folder itself', () => {
    const plan = planDrop([
      f('.DS_Store', { dirs: ['.footage'] }),
      f('Thumbs.db', { dirs: ['.footage'] }),
      f('a.mov', { dirs: ['.footage', '.cache'] }),
      f('b.mov', { dirs: ['.footage', '__MACOSX'] }),
      f('c.mov', { dirs: ['.footage'] }),
    ])

    expect(plan.upload.map((p) => p.file.name)).toEqual(['c.mov'])
    expect(plan.skipped.count).toBe(0)
  })
})

describe('planNotes', () => {
  it('says what was skipped in one line per reason', () => {
    const plan = planDrop([f('a.txt'), f('b.zip'), f('c.txt'), f('e.mov', { size: 0 }), f('ok.mov')])

    expect(planNotes(plan)).toEqual([
      "Skipped 3 files that can't be uploaded (.txt, .zip)",
      'Skipped 1 file with nothing in it',
    ])
  })

  it('names five extensions and counts the rest', () => {
    const plan = planDrop(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => f(`n.${x}`)))

    expect(planNotes(plan)).toEqual(["Skipped 7 files that can't be uploaded (.a, .b, .c, .d, .e and 2 more)"])
  })

  it('says nothing when nothing was left out', () => {
    expect(planNotes(planDrop([f('a.mov')]))).toEqual([])
  })
})

describe('assetNameFor', () => {
  it('drops the extension', () => {
    expect(assetNameFor('A047C012_230815_R1AB.mov')).toBe('A047C012_230815_R1AB')
  })

  it('drops only the last one', () => {
    expect(assetNameFor('rushes.tar.gz')).toBe('rushes.tar')
  })

  it('leaves a name that has no extension', () => {
    expect(assetNameFor('Rushes')).toBe('Rushes')
  })

  it('keeps a name that is nothing but an extension', () => {
    expect(assetNameFor('.gitignore')).toBe('.gitignore')
  })

  it('keeps a dot that is part of the name', () => {
    expect(assetNameFor('Ep04 v2.1 final.mov')).toBe('Ep04 v2.1 final')
  })

  it('cuts a long name to 255 characters', () => {
    expect(assetNameFor(`${'x'.repeat(300)}.mov`)).toBe('x'.repeat(255))
  })

  it('is NFC', () => {
    expect(assetNameFor('Cafe\u0301.mov')).toBe('Caf\u00e9')
  })
})
