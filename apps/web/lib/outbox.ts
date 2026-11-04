// Notes are saved in the background the moment they exist: queued -> sending -> saved | failed -> retry.
// The outbox lives in IndexedDB, so a reload or a closed tab never loses a note; it goes out the next time the page opens.

export type OutboxStatus = 'queued' | 'sending' | 'saved' | 'failed'
export interface OutboxEntry<P = unknown> {
  /** Client UUID; also the Idempotency-Key, so a resend never creates a duplicate comment. */
  id: string
  payload: P
  status: OutboxStatus
  attempts: number
  error?: string
  created_at: number
}

export interface OutboxStore {
  all(): Promise<OutboxEntry[]>
  put(e: OutboxEntry): Promise<void>
  delete(id: string): Promise<void>
}

export function memoryStore(): OutboxStore & { map: Map<string, OutboxEntry> } {
  const map = new Map<string, OutboxEntry>()
  return {
    map,
    all: async () => Array.from(map.values()).map(e => ({ ...e })),
    put: async e => { map.set(e.id, { ...e }) },
    delete: async id => { map.delete(id) },
  }
}

/** IndexedDB when the browser has it (and allows it), memory otherwise: the outbox must never throw into the UI. */
export function idbStore(name: string): OutboxStore {
  const fallback = memoryStore()
  let dbp: Promise<IDBDatabase> | null = null
  const open = () => {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(name, 1)
        req.onupgradeneeded = () => req.result.createObjectStore('notes', { keyPath: 'id' })
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      } catch (e) { reject(e) }
    })
    return dbp
  }
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const req = f(db.transaction('notes', mode).objectStore('notes'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  const guard = async <T,>(f: () => Promise<T>, alt: () => Promise<T>) => { try { return await f() } catch { return alt() } }
  return {
    all: () => guard(() => run<OutboxEntry[]>('readonly', s => s.getAll()), () => fallback.all()),
    put: e => guard(() => run('readwrite', s => s.put(e)).then(() => undefined), () => fallback.put(e)),
    delete: id => guard(() => run('readwrite', s => s.delete(id)).then(() => undefined), () => fallback.delete(id)),
  }
}

export interface OutboxSummary { saved: number; pending: number; failed: number; total: number }
export const summarize = (entries: OutboxEntry[]): OutboxSummary => ({
  saved: entries.filter(e => e.status === 'saved').length,
  pending: entries.filter(e => e.status === 'queued' || e.status === 'sending').length,
  failed: entries.filter(e => e.status === 'failed').length,
  total: entries.length,
})

export interface StatusPart { text: string; tone: 'neutral' | 'ok' | 'error' }
/** Only the failure and the final tick carry colour; the counts stay neutral. */
export function statusLine(s: OutboxSummary): { text: string; tone: 'pending' | 'ok' | 'error'; parts: StatusPart[] } | null {
  if (!s.total) return null
  if (s.pending === 0 && s.failed === 0) return { text: 'All saved ✓', tone: 'ok', parts: [{ text: 'All saved ', tone: 'neutral' }, { text: '✓', tone: 'ok' }] }
  const parts: StatusPart[] = [{ text: `${s.saved} saved`, tone: 'neutral' }]
  if (s.pending > 0) parts.push({ text: ` · ${s.pending} sending…`, tone: 'neutral' })
  if (s.failed > 0) parts.push({ text: ` · ${s.failed} failed`, tone: 'error' })
  return { text: parts.map(x => x.text).join(''), tone: s.failed > 0 ? 'error' : 'pending', parts }
}

export interface OutboxOptions {
  store: OutboxStore
  send: (payload: any, id: string) => Promise<void>
  isOnline?: () => boolean
  wait?: (ms: number) => Promise<void>
  /** Subscribe to "the network is back"; returns the unsubscribe. */
  onOnline?: (cb: () => void) => () => void
  backoff?: number[]
}

const statusOf = (e: unknown): number | null => {
  const s = (e as { status?: unknown })?.status
  return typeof s === 'number' ? s : null
}
const detailOf = (e: unknown): string => (e as { detail?: string })?.detail || (e instanceof Error ? e.message : '') || 'Could not save'

export function createOutbox(opts: OutboxOptions) {
  const isOnline = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const wait = opts.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const backoff = opts.backoff ?? [1000, 2000, 4000]
  let list: OutboxEntry[] = []
  const subs = new Set<() => void>()
  let running = false
  const notify = () => subs.forEach(cb => cb())
  const persist = (e: OutboxEntry) => (e.status === 'saved' ? opts.store.delete(e.id) : opts.store.put(e)).catch(() => {})
  const set = (id: string, patch: Partial<OutboxEntry>) => {
    list = list.map(e => (e.id === id ? { ...e, ...patch } : e))
    const e = list.find(x => x.id === id)!
    notify()
    return persist(e)
  }

  async function attempt(e: OutboxEntry): Promise<void> {
    await set(e.id, { status: 'sending', error: undefined })
    let retries = 0
    for (;;) {
      try {
        await opts.send(e.payload, e.id)
        await set(e.id, { status: 'saved', attempts: e.attempts + retries + 1 })
        return
      } catch (err) {
        const status = statusOf(err)
        if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          await set(e.id, { status: 'failed', error: detailOf(err), attempts: e.attempts + retries + 1 })
          return
        }
        if (status === null && !isOnline()) { await set(e.id, { status: 'queued' }); return } // wait for the online event
        if (retries >= backoff.length) { await set(e.id, { status: 'failed', error: detailOf(err), attempts: e.attempts + retries + 1 }); return }
        await wait(backoff[retries++])
      }
    }
  }

  async function drain(): Promise<void> {
    if (running) return
    running = true
    try {
      for (;;) {
        if (!isOnline()) return
        const next = list.filter(e => e.status === 'queued').sort((a, b) => a.created_at - b.created_at)[0]
        if (!next) return
        await attempt(next)
      }
    } finally { running = false }
  }

  const off = opts.onOnline?.(() => { void drain() })
  let clock = 0
  return {
    entries: () => list,
    subscribe(cb: () => void) { subs.add(cb); return () => { subs.delete(cb) } },
    async enqueue(id: string, payload: unknown) {
      const e: OutboxEntry = { id, payload, status: 'queued', attempts: 0, created_at: Date.now() * 1000 + (clock++ % 1000) }
      list = [...list, e]
      notify()
      await persist(e)
      void drain()
    },
    async retry(id: string) { await set(id, { status: 'queued', error: undefined }); void drain() },
    /** Entries left over from an earlier visit: half-sent ones go back to queued, then everything goes out. */
    async load() {
      const stored = (await opts.store.all().catch(() => [])).filter(e => !list.some(l => l.id === e.id))
      list = [...list, ...stored.map(e => (e.status === 'sending' ? { ...e, status: 'queued' as const } : e))]
      notify()
      void drain()
    },
    async dispose() { off?.(); subs.clear() },
  }
}
export type Outbox = ReturnType<typeof createOutbox>
