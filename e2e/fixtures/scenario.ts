import { expect, type Page, type Request } from '@playwright/test'
import fs from 'node:fs'
import { accessToken, json, primary } from './accounts'
import { liveFilesDir, makeFiles } from './files'
import { createProject, rows, signIn, type UploadRow } from './stack'

/**
 * Helpers the Phase 3 scenarios (unreadable.spec.ts, network.spec.ts) share:
 * a project to drop into, PNGs on disk in a folder the test may change, a
 * recorder of what the page sent, and the polling that reads the panel.
 *
 * `tests/queue.spec.ts` keeps its own copies of the ones it uses; the two sets
 * are meant to behave the same.
 */

export const MB = 1024 * 1024
export const MAX_ACTIVE_FILES = 3

/** What a row says when the file behind it changed or moved (the app's copy, verbatim). */
export const FILE_CHANGED_COPY = 'The file changed or was moved after it was added. Add it again.'

// ─── Files and projects ────────────────────────────────────────────────────────

export type Dropped = {
  /** The asset name: the file's name without its extension, which is what the panel shows. */
  name: string
  /** The name as the browser sends it (`original_filename`). */
  fileName: string
  file: string
  bytes: number
}

const madeDirs: string[] = []

/**
 * PNG files in a folder of their own under `.live-files/` (where a scenario may
 * touch or delete files its page is reading), named `<tag>-<stamp>-<nn>` with a
 * stamp no earlier run used, since the panel lists earlier uploads too.
 * `removeScenarioFiles` deletes them.
 */
export async function pngs(tag: string, sizes: number[]): Promise<Dropped[]> {
  const stamp = Date.now().toString(36)
  const dir = liveFilesDir(`${tag}-${stamp}`)
  madeDirs.push(dir)
  const specs = sizes.map((bytes, i) => ({ name: `${tag}-${stamp}-${String(i + 1).padStart(2, '0')}.png`, bytes }))
  const paths = await makeFiles(dir, specs)
  // Files a person picks were saved a while ago. WebKit compares a file's modification time
  // at one-second resolution (measured: a `touch` 350 ms after the write went unnoticed in
  // one run of three), so a file written a moment ago could not be told from a touched one.
  const then = new Date(Date.now() - 60_000)
  for (const file of paths) await fs.promises.utimes(file, then, then)
  return specs.map((spec, i) => ({
    name: spec.name.replace(/\.png$/, ''),
    fileName: spec.name,
    file: paths[i],
    bytes: spec.bytes,
  }))
}

/** Delete every folder `pngs` made. Call it from `test.afterEach`. */
export function removeScenarioFiles(): void {
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

/** A fresh project, open in `page`, signed in as primary. */
export async function openProject(page: Page, label: string) {
  const account = await primary()
  await signIn(page, account)
  const project = await createProject(account, `E2E ${label} ${Date.now()}`)
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No assets')).toBeVisible()
  return { account, project }
}

/** Names of the assets in a project's root, through the API. */
export async function assetNames(projectId: string): Promise<string[]> {
  const token = await accessToken(await primary())
  const assets = await json<Array<{ name: string }>>('GET', `/projects/${projectId}/assets?folder_id=root`, { token })
  return assets.map((a) => a.name)
}

// ─── What the page sent ────────────────────────────────────────────────────────

const INITIATE = /\/(upload\/initiate|assets\/[^/]+\/versions)(\?|$)/
const PART = /[?&]partNumber=\d+/

export type InitiateCall = {
  /** `asset_name` as sent. */
  name: string
  /** `original_filename` as sent. */
  file: string
  at: number
  /** The answer's status; null while unanswered or when the request failed before an answer. */
  status: number | null
  /** The browser's error text when the request failed without an answer ("net::ERR_INTERNET_DISCONNECTED", ...). */
  failed: string | null
  uploadId: string | null
}
export type PutCall = {
  uploadId: string
  partNumber: number
  at: number
  status: number | null
  doneAt: number | null
  failed: string | null
}

/**
 * Initiates, part PUTs, presigns, completes and aborts the page sent, with the
 * time each was sent (ms since the epoch, the test's clock). Passive: it never
 * touches the traffic.
 */
export function recordUploadCalls(page: Page) {
  const initiates: InitiateCall[] = []
  const puts: PutCall[] = []
  const presigns: number[] = []
  const completes: Array<{ uploadId: string; at: number; status: number | null }> = []
  const aborts: Array<{ uploadId: string; at: number }> = []
  const calls = new Map<Request, InitiateCall | PutCall | { status: number | null }>()

  const body = (request: Request): Record<string, any> => {
    try {
      return (request.postDataJSON() as Record<string, any>) ?? {}
    } catch {
      return {}
    }
  }

  page.on('request', (request) => {
    const url = request.url()
    const method = request.method()
    const at = Date.now()
    if (method === 'POST' && INITIATE.test(url)) {
      const b = body(request)
      const call: InitiateCall = {
        name: String(b.asset_name ?? ''),
        file: String(b.original_filename ?? ''),
        at,
        status: null,
        failed: null,
        uploadId: null,
      }
      initiates.push(call)
      calls.set(request, call)
    } else if (method === 'PUT' && PART.test(url)) {
      const u = new URL(url)
      const call: PutCall = {
        uploadId: u.searchParams.get('uploadId') ?? '',
        partNumber: Number(u.searchParams.get('partNumber')),
        at,
        status: null,
        doneAt: null,
        failed: null,
      }
      puts.push(call)
      calls.set(request, call)
    } else if (method === 'POST' && /\/upload\/presign-part$/.test(url)) {
      presigns.push(at)
    } else if (method === 'POST' && /\/upload\/complete$/.test(url)) {
      const call = { uploadId: String(body(request).upload_id ?? ''), at, status: null as number | null }
      completes.push(call)
      calls.set(request, call)
    } else if (method === 'POST' && /\/upload\/abort$/.test(url)) {
      aborts.push({ uploadId: String(body(request).upload_id ?? ''), at })
    }
  })
  page.on('response', async (response) => {
    const call = calls.get(response.request())
    if (!call) return
    call.status = response.status()
    if ('doneAt' in call) call.doneAt = Date.now()
    if ('uploadId' in call && 'file' in call) {
      const answer = await response.json().catch(() => null)
      call.uploadId = answer?.upload_id ?? null
    }
  })
  page.on('requestfailed', (request) => {
    const call = calls.get(request)
    if (call && 'failed' in call) call.failed = request.failure()?.errorText ?? 'failed'
  })

  return { initiates, puts, presigns, completes, aborts }
}
export type UploadCalls = ReturnType<typeof recordUploadCalls>

/** Initiate calls for the given files, in the order the page sent them. */
export const initiatesOf = (calls: UploadCalls, files: Array<{ fileName: string }>) => {
  const names = new Set(files.map((f) => f.fileName))
  return calls.initiates.filter((c) => names.has(c.file))
}

// ─── What the panel shows ──────────────────────────────────────────────────────

export const mineOf = (all: UploadRow[], files: Array<{ name: string }>) => {
  const names = new Set(files.map((f) => f.name))
  return all.filter((r) => names.has(r.name))
}
export const summary = (list: UploadRow[]) =>
  list.map((r) => `${r.name}:${r.status}${r.kind ? `/${r.kind}` : ''}${r.status === 'failed' || r.status === 'interrupted' ? ` "${r.detail}"` : ''}`).join('  ')
export const count = (list: UploadRow[], ...statuses: string[]) => list.filter((r) => statuses.includes(r.status)).length
export const FINISHED_UPLOADING = ['processing', 'complete']

/** The exact line the panel shows for each kind of waiting row. */
export const WAITING_COPY: Record<string, string> = {
  'waiting-to-start': 'Waiting to start',
  'waiting-for-connection': 'Waiting for connection',
  'waiting-for-storage': 'Waiting for storage',
  'waiting-to-resume': 'Waiting to resume',
  starting: 'Starting…',
  resuming: 'Resuming…',
}
/** Rows whose line is not the copy for their kind, as strings for a failure message. */
export const wrongCopy = (list: UploadRow[]) =>
  list.filter((r) => r.kind in WAITING_COPY && r.detail !== WAITING_COPY[r.kind]).map((r) => `${r.name}: ${r.kind} reads "${r.detail}"`)

/**
 * Wait until `ok` holds for the rows of `files`, and return them. On a timeout
 * the error says what the panel did show, which `expect.poll` would not.
 */
export async function until(
  page: Page,
  files: Array<{ name: string }>,
  what: string,
  ok: (mine: UploadRow[]) => boolean,
  timeoutMs = 60_000,
): Promise<UploadRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const mine = mineOf(await rows(page), files)
    if (ok(mine)) return mine
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}. Rows: ${summary(mine)}`)
    await page.waitForTimeout(250)
  }
}
