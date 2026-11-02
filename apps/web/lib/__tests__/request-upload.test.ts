import { afterEach, expect, it, vi } from 'vitest'
import { uploadToRequest } from '../platform'

afterEach(() => vi.unstubAllGlobals())

it('uploads at most three parts together and completes in part order with byte progress', async () => {
  const releases: (() => void)[] = []
  let active = 0, peak = 0
  let complete: { parts: { PartNumber: number }[] } | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_number: 1 })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: `https://upload.test/${JSON.parse(String(opts.body)).part_number}` })
    if (url.startsWith('https://upload.test/')) {
      active++; peak = Math.max(peak, active)
      await new Promise<void>(resolve => releases.push(resolve))
      active--
      return new Response('', { headers: { ETag: 'etag' } })
    }
    if (url.endsWith('/complete')) complete = JSON.parse(String(opts.body))
    return Response.json({})
  }))
  const progress: number[] = []
  const job = uploadToRequest('t', { name: 'Editor', email: 'e@example.test' }, new File([new Uint8Array(31 * 1024 * 1024)], 'ad.mp4'), p => progress.push(p))
  await vi.waitFor(() => expect(releases.length).toBe(3))
  releases[2](); releases[0](); releases[1]()
  await vi.waitFor(() => expect(releases.length).toBe(4))
  releases[3]()
  await job
  expect(peak).toBe(3)
  expect(complete?.parts.map(p => p.PartNumber)).toEqual([1, 2, 3, 4])
  expect(progress[0]).toBeCloseTo(10 / 31)
  expect(progress.at(-1)).toBe(1)
})

it('settles in-flight parts before aborting and never completes a failed upload', async () => {
  let release: () => void = () => {}
  let aborted = false, completed = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: 'k', asset_id: 'a' })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: `https://upload.test/${JSON.parse(String(opts.body)).part_number}` })
    if (url === 'https://upload.test/1') return new Response('', { status: 500 })
    if (url.startsWith('https://upload.test/')) { await new Promise<void>(r => { release = r }); return new Response('', { headers: { ETag: 'ok' } }) }
    if (url.endsWith('/abort')) aborted = true
    if (url.endsWith('/complete')) completed = true
    return Response.json({})
  }))
  const result = uploadToRequest('t', { name: 'E', email: 'e@test.com' }, new File([new Uint8Array(11 * 1024 * 1024)], 'ad.mp4'), () => {}).catch(e => e)
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === 'https://upload.test/1')).toHaveLength(2))
  expect(aborted).toBe(false)
  release()
  expect(await result).toBeInstanceOf(Error)
  expect(aborted).toBe(true)
  expect(completed).toBe(false)
})

it('reports a finished transfer before it waits for the uploader details', async () => {
  const seen: string[] = []
  let giveIdentity: (who: { name: string; email: string }) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_number: 1 })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: `https://upload.test/${JSON.parse(String(opts.body)).part_number}` })
    if (url.startsWith('https://upload.test/')) { seen.push('part'); return new Response('', { headers: { ETag: 'etag' } }) }
    if (url.endsWith('/complete')) seen.push(`complete:${JSON.parse(String(opts.body)).name}`)
    return Response.json({})
  }))
  const job = uploadToRequest('t', { name: '', email: '' }, new File([new Uint8Array(11 * 1024 * 1024)], 'ad.mp4'), () => {}, {
    onTransferred: () => seen.push('transferred'),
    identity: () => { seen.push('identity'); return new Promise(resolve => { giveIdentity = resolve }) },
  })
  await vi.waitFor(() => expect(seen).toEqual(['part', 'part', 'transferred', 'identity']))
  giveIdentity({ name: 'Nico', email: 'n@example.test' })
  await job
  expect(seen.at(-1)).toBe('complete:Nico')
})

it('does not report a transfer that failed as finished', async () => {
  const onTransferred = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: 'k', asset_id: 'a' })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: 'https://upload.test/1' })
    if (url.startsWith('https://upload.test/')) return new Response('', { status: 500 })
    return Response.json({})
  }))
  await expect(uploadToRequest('t', { name: 'E', email: 'e@test.com' }, new File(['x'], 'ad.mp4'), () => {}, { onTransferred })).rejects.toThrow()
  expect(onTransferred).not.toHaveBeenCalled()
})

it('asks again when the server refuses the details, without aborting or resending the file', async () => {
  const sent: string[] = []
  let aborted = false, parts = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
    if (url.endsWith('/initiate')) return Response.json({ upload_id: 'u', s3_key: 'k', asset_id: 'a', version_number: 1 })
    if (url.endsWith('/presign-part')) return Response.json({ presigned_url: 'https://upload.test/1' })
    if (url.startsWith('https://upload.test/')) { parts++; return new Response('', { headers: { ETag: 'etag' } }) }
    if (url.endsWith('/abort')) aborted = true
    if (url.endsWith('/complete')) {
      const email = JSON.parse(String(opts.body)).email
      sent.push(email)
      return email === 'typo@bad' ? Response.json({ detail: [] }, { status: 422 }) : Response.json({})
    }
    return Response.json({})
  }))
  const answers = ['typo@bad', 'nico@example.com']
  const rejected: string[] = []
  await uploadToRequest('t', { name: '', email: '' }, new File(['x'], 'ad.mp4'), () => {}, {
    identity: async () => ({ name: 'Nico', email: answers.shift()! }),
    onIdentityRejected: who => rejected.push(who.email),
  })
  expect(sent).toEqual(['typo@bad', 'nico@example.com'])
  expect(rejected).toEqual(['typo@bad'])
  expect(parts).toBe(1)
  expect(aborted).toBe(false)
})
