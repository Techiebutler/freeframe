import { describe, it, expect, vi } from 'vitest'
import { createPartBudget } from '@/lib/upload-budget'

/**
 * The budget grants slots on a microtask (so that `release()` + `sleeping()`, or
 * `woke()` + `acquire()`, made in one synchronous run are seen together), so every
 * assertion about who holds a slot comes after a flush.
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Tracked {
  state: 'pending' | 'granted' | 'rejected'
  release: () => void
  error: unknown
}

/** Watches an `acquire` promise without needing to await it. */
function track(promise: Promise<() => void>): Tracked {
  const tracked: Tracked = { state: 'pending', release: () => {}, error: undefined }
  promise.then(
    (release) => {
      tracked.state = 'granted'
      tracked.release = release
    },
    (error) => {
      tracked.state = 'rejected'
      tracked.error = error
    },
  )
  return tracked
}

function open(controller = new AbortController()) {
  return controller.signal
}

describe('createPartBudget', () => {
  it('exposes its size', () => {
    expect(createPartBudget(5).size).toBe(5)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a size of %s, which would hand out no slots or a fraction of one',
    (size) => {
      expect(() => createPartBudget(size)).toThrow(RangeError)
    },
  )

  it('grants up to size and queues the rest', async () => {
    const budget = createPartBudget(2)
    const first = track(budget.acquire('a', open(), 'fresh'))
    const second = track(budget.acquire('a', open(), 'fresh'))
    const third = track(budget.acquire('a', open(), 'fresh'))
    await flush()

    expect(first.state).toBe('granted')
    expect(second.state).toBe('granted')
    expect(third.state).toBe('pending')

    first.release()
    await flush()
    expect(third.state).toBe('granted')
  })

  it('serves the lowest rank first when a slot frees', async () => {
    const budget = createPartBudget(1)
    budget.setRank('a', 5)
    budget.setRank('b', 1)
    budget.setRank('c', 3)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    // Queued in an order that is neither rank order nor reverse rank order.
    const a = track(budget.acquire('a', open(), 'fresh'))
    const b = track(budget.acquire('b', open(), 'fresh'))
    const c = track(budget.acquire('c', open(), 'fresh'))
    await flush()
    expect([a.state, b.state, c.state]).toEqual(['pending', 'pending', 'pending'])

    holder.release()
    await flush()
    expect([a.state, b.state, c.state]).toEqual(['pending', 'granted', 'pending'])

    b.release()
    await flush()
    expect([a.state, c.state]).toEqual(['pending', 'granted'])

    c.release()
    await flush()
    expect(a.state).toBe('granted')
  })

  it('reads a file rank when the slot frees, not when the request was queued', async () => {
    const budget = createPartBudget(1)
    budget.setRank('a', 1)
    budget.setRank('b', 2)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const a = track(budget.acquire('a', open(), 'fresh'))
    const b = track(budget.acquire('b', open(), 'fresh'))
    await flush()

    budget.setRank('b', 0)
    holder.release()
    await flush()

    expect([a.state, b.state]).toEqual(['pending', 'granted'])
  })

  it('serves a file with no rank after every ranked file, and equal ranks in the order the files first appeared', async () => {
    const budget = createPartBudget(1)
    budget.setRank('ranked', 9)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const unranked = track(budget.acquire('unranked', open(), 'fresh'))
    const ranked = track(budget.acquire('ranked', open(), 'fresh'))
    await flush()

    holder.release()
    await flush()
    expect([unranked.state, ranked.state]).toEqual(['pending', 'granted'])

    // 'one' and 'two' share a rank; 'one' was seen first, though 'two' asked first.
    const tied = createPartBudget(1)
    tied.setRank('one', 4)
    tied.setRank('two', 4)
    const tiedHolder = track(tied.acquire('holder', open(), 'fresh'))
    await flush()
    const two = track(tied.acquire('two', open(), 'fresh'))
    const one = track(tied.acquire('one', open(), 'fresh'))
    await flush()
    tiedHolder.release()
    await flush()
    expect([one.state, two.state]).toEqual(['granted', 'pending'])
  })

  it('serves a retry before a fresh part of the same file', async () => {
    const budget = createPartBudget(1)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const fresh = track(budget.acquire('a', open(), 'fresh'))
    const retry = track(budget.acquire('a', open(), 'retry'))
    await flush()

    holder.release()
    await flush()

    expect(retry.state).toBe('granted')
    expect(fresh.state).toBe('pending')
  })

  it('serves requests of one file and one kind first come, first served', async () => {
    const budget = createPartBudget(1)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const early = track(budget.acquire('a', open(), 'fresh'))
    const late = track(budget.acquire('a', open(), 'fresh'))
    await flush()

    holder.release()
    await flush()

    expect([early.state, late.state]).toEqual(['granted', 'pending'])
  })

  it('does not give a slot freed by a sleeping part to a fresh part of the same file', async () => {
    const budget = createPartBudget(2)
    const first = track(budget.acquire('a', open(), 'fresh'))
    const second = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    expect([first.state, second.state]).toEqual(['granted', 'granted'])

    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    expect(aFresh.state).toBe('pending')

    // Part one fails and goes to sleep in backoff, handing its slot back.
    budget.sleeping('a')
    first.release()
    const bFresh = track(budget.acquire('b', open(), 'fresh'))
    await flush()

    expect(aFresh.state).toBe('pending')
    expect(bFresh.state).toBe('granted')
  })

  it('is indifferent to whether sleeping() or the release comes first in a synchronous run', async () => {
    const budget = createPartBudget(2)
    const first = track(budget.acquire('a', open(), 'fresh'))
    track(budget.acquire('a', open(), 'fresh'))
    await flush()
    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    await flush()

    // Release first, then sleeping(): the freed slot must still not reach aFresh.
    first.release()
    budget.sleeping('a')
    await flush()

    expect(aFresh.state).toBe('pending')
  })

  it('lets the file start fresh parts again once its sleeping part wakes', async () => {
    const budget = createPartBudget(2)
    const first = track(budget.acquire('a', open(), 'fresh'))
    track(budget.acquire('a', open(), 'fresh'))
    await flush()
    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    budget.sleeping('a')
    first.release()
    await flush()
    expect(aFresh.state).toBe('pending')

    // The sleeper woke and gave up on the part; one slot is free, nobody holds the cap.
    budget.woke('a')
    await flush()

    expect(aFresh.state).toBe('granted')
  })

  it('does not cap a retry by the file sleeping parts', async () => {
    const budget = createPartBudget(2)
    const first = track(budget.acquire('a', open(), 'fresh'))
    track(budget.acquire('a', open(), 'fresh'))
    await flush()
    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    budget.sleeping('a')
    first.release()
    await flush()

    // Woke from backoff; the retry takes the free slot, the fresh part keeps waiting.
    budget.woke('a')
    const retry = track(budget.acquire('a', open(), 'retry'))
    await flush()

    expect(retry.state).toBe('granted')
    expect(aFresh.state).toBe('pending')
  })

  it('caps a file fresh parts at its dispatched plus sleeping parts, not either alone', async () => {
    const budget = createPartBudget(3)
    const parts = [
      track(budget.acquire('a', open(), 'fresh')),
      track(budget.acquire('a', open(), 'fresh')),
      track(budget.acquire('a', open(), 'fresh')),
    ]
    await flush()
    // Two parts fail and sleep: 1 dispatched + 2 sleeping = 3, with two slots free in the pool.
    budget.sleeping('a')
    parts[0].release()
    budget.sleeping('a')
    parts[1].release()
    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    expect(aFresh.state).toBe('pending')

    // One wakes: 1 dispatched + 1 sleeping = 2 < 3.
    budget.woke('a')
    await flush()
    expect(aFresh.state).toBe('granted')
  })

  it('rejects a waiter with AbortError when its signal aborts and removes it', async () => {
    const budget = createPartBudget(1)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const controller = new AbortController()
    const aborted = track(budget.acquire('a', controller.signal, 'fresh'))
    const next = track(budget.acquire('b', open(), 'fresh'))
    await flush()
    expect(aborted.state).toBe('pending')

    controller.abort()
    await flush()
    expect(aborted.state).toBe('rejected')
    expect(aborted.error).toBeInstanceOf(DOMException)
    expect((aborted.error as DOMException).name).toBe('AbortError')

    // The slot goes to the next waiter and the aborted one is never granted.
    holder.release()
    await flush()
    expect(next.state).toBe('granted')
    expect(aborted.state).toBe('rejected')
  })

  it('rejects at once with AbortError when the signal is already aborted, and takes no slot', async () => {
    const budget = createPartBudget(1)
    const controller = new AbortController()
    controller.abort()

    const rejected = track(budget.acquire('a', controller.signal, 'fresh'))
    await flush()
    expect(rejected.state).toBe('rejected')
    expect((rejected.error as DOMException).name).toBe('AbortError')

    // The only slot is still free.
    const next = track(budget.acquire('b', open(), 'fresh'))
    await flush()
    expect(next.state).toBe('granted')
  })

  it('stops listening to a signal once its request is granted', async () => {
    const budget = createPartBudget(1)
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const granted = track(budget.acquire('a', controller.signal, 'fresh'))
    await flush()
    expect(granted.state).toBe('granted')

    // A file signal lives as long as the file, and every part attempt adds a listener to it.
    // None may be left behind once its request is granted.
    expect(added).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1])

    // Aborting after the grant must not touch the slot the part now holds.
    controller.abort()
    const waiting = track(budget.acquire('b', open(), 'fresh'))
    await flush()
    expect(waiting.state).toBe('pending')
    expect(granted.state).toBe('granted')

    granted.release()
    await flush()
    expect(waiting.state).toBe('granted')
  })

  it('stops listening to a signal once forget rejects its request', async () => {
    const budget = createPartBudget(1)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    const waiter = track(budget.acquire('a', controller.signal, 'fresh'))
    await flush()
    expect(waiter.state).toBe('pending')

    budget.forget('a')
    await flush()

    expect(waiter.state).toBe('rejected')
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0][1])
    holder.release()
  })

  it('forget rejects the file waiters and frees its slots', async () => {
    const budget = createPartBudget(2)
    const heldOne = track(budget.acquire('a', open(), 'fresh'))
    const heldTwo = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    const aWaiter = track(budget.acquire('a', open(), 'fresh'))
    const aRetry = track(budget.acquire('a', open(), 'retry'))
    const bWaiter = track(budget.acquire('b', open(), 'fresh'))
    await flush()
    expect(aWaiter.state).toBe('pending')
    expect(bWaiter.state).toBe('pending')

    budget.forget('a')
    await flush()

    for (const waiter of [aWaiter, aRetry]) {
      expect(waiter.state).toBe('rejected')
      expect((waiter.error as DOMException).name).toBe('AbortError')
    }
    // Both of a's slots are free again, so b's waiter is granted.
    expect(bWaiter.state).toBe('granted')
    const more = track(budget.acquire('c', open(), 'fresh'))
    await flush()
    expect(more.state).toBe('granted')

    // A's stale release functions, called late, do not free slots that now belong to b and c.
    heldOne.release()
    heldTwo.release()
    heldOne.release()
    const extra = track(budget.acquire('d', open(), 'fresh'))
    await flush()
    expect(extra.state).toBe('pending')
  })

  it('does not carry a forgotten file sleeping count or rank into a later run of the same key', async () => {
    const budget = createPartBudget(2)
    budget.setRank('a', 7)
    budget.forget('a')
    // A late call from a runner that already ended must not leave state behind.
    budget.sleeping('a')
    budget.sleeping('a')

    const first = track(budget.acquire('a', open(), 'fresh'))
    const second = track(budget.acquire('a', open(), 'fresh'))
    await flush()

    expect([first.state, second.state]).toEqual(['granted', 'granted'])
  })

  it('forget on a file the budget has never seen does nothing', async () => {
    const budget = createPartBudget(1)
    budget.forget('never-seen')
    const granted = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    expect(granted.state).toBe('granted')
  })

  it('double release is a no-op', async () => {
    const budget = createPartBudget(1)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const first = track(budget.acquire('a', open(), 'fresh'))
    const second = track(budget.acquire('b', open(), 'fresh'))
    await flush()

    holder.release()
    holder.release()
    await flush()

    // One slot was freed, so one waiter holds it and the other still waits.
    expect([first.state, second.state]).toEqual(['granted', 'pending'])
  })

  it('treats a woke() with no matching sleeping() as nothing', async () => {
    const budget = createPartBudget(1)
    const part = track(budget.acquire('a', open(), 'fresh'))
    await flush()
    // A stray woke() must not leave a negative count that a real sleeping() later cancels out.
    budget.woke('a')
    budget.sleeping('a')
    part.release()
    const aFresh = track(budget.acquire('a', open(), 'fresh'))
    await flush()

    expect(aFresh.state).toBe('pending')
  })

  it('treats a rank of NaN as no rank', async () => {
    const budget = createPartBudget(1)
    budget.setRank('nan', Number.NaN)
    budget.setRank('ranked', 3)
    const holder = track(budget.acquire('holder', open(), 'fresh'))
    await flush()
    const nan = track(budget.acquire('nan', open(), 'fresh'))
    const ranked = track(budget.acquire('ranked', open(), 'fresh'))
    await flush()

    holder.release()
    await flush()

    expect([nan.state, ranked.state]).toEqual(['pending', 'granted'])
  })
})
