/**
 * The API and the storage backend, as the upload queue tests drive them.
 *
 * The test file must mock `@/lib/api` keeping the real `ApiError`
 * (`vi.mock('@/lib/api', async (orig) => ({ ...(await orig()), api: {...} }))`),
 * so `code` and `retryAfter` reach the classification as they would in the
 * browser. Everything here then talks to that mock.
 */
import { vi } from 'vitest'
import { api } from '@/lib/api'
import { useUploadStore, type UploadFile } from '@/stores/upload-store'
import { installXhrFake, ok } from '@/test/xhr-fake'

export const MB = 1024 * 1024
export const CHUNK = 10 * MB

/**
 * A file that says it is `size` bytes without allocating them. The parts cut
 * from it are empty, which the fake storage never looks at.
 */
export function fileOf(name: string, size = 50 * MB, type = 'video/quicktime'): File {
  const file = new File([new Uint8Array(1)], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/** At most 5 MiB: certainly one part, so it counts 1 against the budget while it starts. */
export const small = (name: string) => fileOf(name, 1 * MB, 'image/jpeg')

type Body = Record<string, unknown>

export interface Initiate {
  body: Body
  resolve: (over?: Record<string, unknown>) => void
  reject: (err: unknown) => void
}

/**
 * `plan` decides each initiate as it arrives: `'answer'` answers it at once,
 * `'wait'` leaves it to the test (`initiates[i].resolve()` / `.reject()`), and
 * anything else is the error it fails with. With `parts: 'hang'` every part PUT
 * waits for the test to `finish()` it.
 */
export function fakeServer(
  plan: (body: Body, index: number) => unknown = () => 'answer',
  parts: 'ok' | 'hang' = 'ok',
) {
  const initiates: Initiate[] = []
  /** Initiates, presigns, completes and aborts, in the order they were sent. */
  const calls: string[] = []
  const inFlight: Array<{ url: string; finish: () => void }> = []

  vi.mocked(api.post).mockImplementation(((path: string, body?: unknown) => {
    const b = (body ?? {}) as Body
    if (path === '/upload/initiate' || /^\/assets\/[^/]+\/versions$/.test(path)) {
      const n = initiates.length + 1
      calls.push(`initiate ${String(b.original_filename)}`)
      let resolve!: (value: unknown) => void
      let reject!: (err: unknown) => void
      const answer = new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
      const entry: Initiate = {
        body: b,
        resolve: (over = {}) =>
          resolve({
            upload_id: `u${n}`, s3_key: `k${n}`, asset_id: `a${n}`, version_id: `v${n}`,
            chunk_size_bytes: CHUNK, ...over,
          }),
        reject,
      }
      initiates.push(entry)
      const decided = plan(b, n - 1)
      if (decided === 'answer') entry.resolve()
      else if (decided !== 'wait') entry.reject(decided)
      return answer
    }
    if (path === '/upload/presign-part') {
      calls.push(`presign ${String(b.upload_id)}`)
      return Promise.resolve({ presigned_url: `https://s3.test/${String(b.upload_id)}/${String(b.part_number)}` })
    }
    if (path === '/upload/abort') calls.push(`abort ${String(b.upload_id)}`)
    if (path === '/upload/complete') calls.push(`complete ${String(b.upload_id)}`)
    return Promise.resolve({})
  }) as never)

  installXhrFake((url) => {
    if (parts === 'ok') return ok('"e"')
    return new Promise((resolve) => inFlight.push({ url, finish: () => resolve(ok('"e"')) }))
  })

  return {
    initiates,
    calls,
    inFlight,
    /** The file name of every initiate, in the order they were sent. */
    names: () => initiates.map((i) => String(i.body.original_filename)),
    /** Every request that is not an initiate. */
    others: () => calls.filter((c) => !c.startsWith('initiate ')),
    /** Finishes the oldest part PUT still on the wire. */
    finishOne: () => inFlight.shift()!.finish(),
  }
}

export function drop(files: File[], projectId = 'p1'): string[] {
  return useUploadStore.getState().startUploads(
    files.map((file) => ({ file, assetName: file.name.replace(/\.[^.]+$/, '') })),
    projectId,
    'Project',
    null,
  )
}

export const rowOf = (id: string) => useUploadStore.getState().files.find((f) => f.id === id)!
export const files = () => useUploadStore.getState().files
export const stored = (): UploadFile[] =>
  JSON.parse(window.localStorage.getItem('ff-uploads') ?? '{}').state?.files ?? []

/** Lets every promise job and zero-delay timer that is due run, with real timers. */
export async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

/** The same, under fake timers, without moving the clock. */
export async function flush() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

/** What zustand's persist middleware does on the way in. */
export function rehydrate(rows: UploadFile[]): UploadFile[] {
  const opts = (useUploadStore as unknown as {
    persist: { getOptions: () => { merge?: (p: unknown, c: unknown) => { files: UploadFile[] } } }
  }).persist.getOptions()
  return opts.merge!({ files: rows }, { files: [] }).files
}

/** `GET /upload/{v}/parts` for an upload that still takes parts. */
export function resumable(over: Record<string, unknown> = {}) {
  return {
    state: 'resumable', upload_id: 'ru', s3_key: 'rk', asset_id: 'ra', version_id: 'rv',
    chunk_size_bytes: CHUNK, file_size_bytes: MB, original_filename: 'clip.mp4', mime_type: 'video/mp4',
    held_part_numbers: [], last_activity_at: null,
    ...over,
  }
}
