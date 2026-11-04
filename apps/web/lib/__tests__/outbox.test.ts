import { describe, expect, it, vi } from 'vitest'
import { createOutbox, memoryStore, statusLine, summarize, type OutboxEntry } from '../outbox'

const flush = () => new Promise(r => setTimeout(r, 0))
const err = (status: number, detail = 'x') => Object.assign(new Error(detail), { status, detail })
function setup(over: { send?: (p: unknown, id: string) => Promise<void>; online?: () => boolean; store?: ReturnType<typeof memoryStore> } = {}) {
  const store = over.store ?? memoryStore()
  const waits: number[] = []
  const listeners = new Map<string, () => void>()
  let online = true
  const box = createOutbox({
    store,
    send: over.send ?? vi.fn().mockResolvedValue(undefined),
    isOnline: over.online ?? (() => online),
    wait: async ms => { waits.push(ms) },
    onOnline: cb => { listeners.set('online', cb); return () => listeners.delete('online') },
  })
  return { box, store, waits, goOnline: () => { online = true; listeners.get('online')?.() }, setOnline: (v: boolean) => { online = v } }
}

describe('outbox state machine', () => {
  it('goes queued -> sending -> saved, sends with the entry id as idempotency key and drops it from the store', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { box, store } = setup({ send })
    const seen: string[] = []
    box.subscribe(() => seen.push(box.entries().map(e => e.status).join()))
    await box.enqueue('n1', { text: 'a' })
    await flush()
    expect(send).toHaveBeenCalledWith({ text: 'a' }, 'n1')
    expect(box.entries()[0].status).toBe('saved')
    expect(seen).toContain('queued')
    expect(seen).toContain('sending')
    expect(await store.all()).toEqual([])
  })

  it('a 4xx fails with the server text, never retries on its own, and Retry sends again', async () => {
    const send = vi.fn().mockRejectedValueOnce(err(403, 'This share link does not allow commenting')).mockResolvedValue(undefined)
    const { box, waits } = setup({ send })
    await box.enqueue('n1', {})
    await flush()
    expect(box.entries()[0]).toMatchObject({ status: 'failed', error: 'This share link does not allow commenting' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
    await box.retry('n1'); await flush()
    expect(box.entries()[0].status).toBe('saved')
  })

  it('a 5xx retries three times with backoff, then fails but keeps the payload', async () => {
    const send = vi.fn().mockRejectedValue(err(503))
    const { box, waits, store } = setup({ send })
    await box.enqueue('n1', { text: 'keep me' })
    await flush()
    expect(send).toHaveBeenCalledTimes(4)
    expect(waits).toEqual([1000, 2000, 4000])
    expect(box.entries()[0]).toMatchObject({ status: 'failed', payload: { text: 'keep me' } })
    expect((await store.all())[0].payload).toEqual({ text: 'keep me' })
  })

  it('succeeds on a later retry', async () => {
    const send = vi.fn().mockRejectedValueOnce(err(502)).mockRejectedValueOnce(err(500)).mockResolvedValue(undefined)
    const { box, waits } = setup({ send })
    await box.enqueue('n1', {}); await flush()
    expect(waits).toEqual([1000, 2000])
    expect(box.entries()[0].status).toBe('saved')
  })

  it('offline: stays queued and goes out on the online event', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { box, setOnline, goOnline } = setup({ send })
    setOnline(false)
    await box.enqueue('n1', {}); await flush()
    expect(send).not.toHaveBeenCalled()
    expect(box.entries()[0].status).toBe('queued')
    setOnline(true); goOnline(); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(box.entries()[0].status).toBe('saved')
  })

  it('a network error while offline stays queued instead of burning retries', async () => {
    const send = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { box, setOnline, goOnline } = setup({ send })
    send.mockImplementationOnce(async () => { setOnline(false); throw new TypeError('Failed to fetch') })
    await box.enqueue('n1', {}); await flush()
    expect(box.entries()[0].status).toBe('queued')
    send.mockResolvedValue(undefined)
    setOnline(true); goOnline(); await flush()
    expect(box.entries()[0].status).toBe('saved')
  })

  it('survives a reload: queued and half-sent entries come back from the store and go out', async () => {
    const store = memoryStore()
    const first = setup({ store, online: () => false })
    await first.box.enqueue('n1', { text: 'one' })
    await store.put({ id: 'n2', payload: { text: 'two' }, status: 'sending', attempts: 1, created_at: 2 } as OutboxEntry)
    await first.box.dispose?.()
    const send = vi.fn().mockResolvedValue(undefined)
    const second = setup({ store, send })
    await second.box.load(); await flush()
    expect(send.mock.calls.map(c => c[1]).sort()).toEqual(['n1', 'n2'])
    expect(second.box.entries().every(e => e.status === 'saved')).toBe(true)
  })

  it('sends in the order the notes were made', async () => {
    const order: string[] = []
    const { box } = setup({ send: async (_p, id) => { order.push(id) } })
    await box.enqueue('a', {}); await box.enqueue('b', {}); await box.enqueue('c', {}); await flush()
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('status line', () => {
  const e = (status: OutboxEntry['status']) => ({ id: Math.random().toString(), payload: {}, status, attempts: 0, created_at: 0 }) as OutboxEntry
  it('counts saved and sending', () => {
    const s = summarize([e('saved'), e('saved'), e('sending'), e('queued')])
    expect(s).toEqual({ saved: 2, pending: 2, failed: 0, total: 4 })
    expect(statusLine(s)).toMatchObject({ text: '2 saved · 2 sending…', tone: 'pending' })
  })
  it('still mentions a failed note while others are on their way', () => {
    expect(statusLine(summarize([e('saved'), e('sending'), e('failed')]))).toMatchObject({ text: '1 saved · 1 sending… · 1 failed', tone: 'error' })
  })
  it('colours only the failed segment and the final tick', () => {
    const mixed = statusLine(summarize([e('saved'), e('sending'), e('failed')]))!
    expect(mixed.parts.filter(p => p.tone === 'error').map(p => p.text.trim())).toEqual(['· 1 failed'])
    expect(mixed.parts.filter(p => p.tone === 'neutral').length).toBe(2)
    const ok = statusLine(summarize([e('saved')]))!
    expect(ok.parts.filter(p => p.tone === 'ok').map(p => p.text)).toEqual(['✓'])
    expect(ok.parts[0].tone).toBe('neutral')
  })
  it('says All saved when nothing is open', () => {
    expect(statusLine(summarize([e('saved'), e('saved')]))).toMatchObject({ text: 'All saved ✓', tone: 'ok' })
  })
  it('shows failures plainly and is empty without notes', () => {
    expect(statusLine(summarize([e('saved'), e('failed')]))).toMatchObject({ text: '1 saved · 1 failed', tone: 'error' })
    expect(statusLine(summarize([]))).toBeNull()
  })
})
