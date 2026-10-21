import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  createUploadQueue,
  MAX_ACTIVE_FILES,
  SINGLE_PART_BYTES,
  type ActiveInfo,
  type QueueEntry,
  type QueueKind,
} from '@/lib/upload-queue'

const MB = 1024 * 1024
const GB = 1024 * MB

function entry(id: string, sizeBytes = GB, kind: QueueKind = 'new', ownerId = 'user-1'): QueueEntry {
  return { id, kind, sizeBytes, ownerId }
}

function active(id: string, unfinishedParts: number | 'unknown', sizeBytes = GB): ActiveInfo {
  return { id, sizeBytes, unfinishedParts }
}

function ids(entries: readonly QueueEntry[]): string[] {
  return entries.map((e) => e.id)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('constants', () => {
  it('allows three active files and treats 5 MiB as a single part', () => {
    expect(MAX_ACTIVE_FILES).toBe(3)
    expect(SINGLE_PART_BYTES).toBe(5 * 1024 * 1024)
  })
})

describe('nextToStart', () => {
  it('starts at most one large file while its initiate is outstanding', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b'), entry('c')], 'back')

    expect(queue.nextToStart([], 5)).toEqual(['a'])
    expect(queue.nextToStart([active('a', 'unknown')], 5)).toEqual([])
  })

  it('starts the next file when unfinished parts drop below budget', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('b')], 'back')

    expect(queue.nextToStart([active('a', 5)], 5)).toEqual([])
    expect(queue.nextToStart([active('a', 6)], 5)).toEqual([])
    expect(queue.nextToStart([active('a', 4)], 5)).toEqual(['b'])
    expect(queue.nextToStart([active('a', 0)], 5)).toEqual(['b'])
  })

  it('adds up the unfinished parts of every active file', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('c')], 'back')

    expect(queue.nextToStart([active('a', 2), active('b', 3)], 5)).toEqual([])
    expect(queue.nextToStart([active('a', 2), active('b', 2)], 5)).toEqual(['c'])
  })

  it('never exceeds 3 active', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', MB), entry('b', MB), entry('c', MB), entry('d', MB)], 'back')

    expect(queue.nextToStart([active('x', 1), active('y', 1), active('z', 1)], 16)).toEqual([])
    expect(queue.nextToStart([active('x', 1), active('y', 1)], 16)).toEqual(['a'])
    expect(queue.nextToStart([active('x', 1)], 16)).toEqual(['a', 'b'])
    expect(queue.nextToStart([], 16)).toEqual(['a', 'b', 'c'])
  })

  it('counts a small initiating file as one part', () => {
    const queue = createUploadQueue()
    queue.enqueue(
      [entry('a', MB), entry('b', MB), entry('c', MB), entry('d', MB), entry('e', MB)],
      'back',
    )

    expect(queue.nextToStart([], 5)).toEqual(['a', 'b', 'c'])
  })

  it('a small and a large entry with nothing active, budget 5: returns both', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('small', MB), entry('large', GB)], 'back')

    expect(queue.nextToStart([], 5)).toEqual(['small', 'large'])
  })

  it('stops at a large entry that does not fit and does not skip past it', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('large', GB), entry('small', MB)], 'back')

    // The large one takes the whole budget, so the small one behind it waits its turn.
    expect(queue.nextToStart([], 5)).toEqual(['large'])
  })

  it('counts an initiating small active file as one part and a large one as the whole budget', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('next', GB)], 'back')

    expect(queue.nextToStart([active('a', 'unknown', MB)], 5)).toEqual(['next'])
    expect(queue.nextToStart([active('a', 'unknown', GB)], 5)).toEqual([])
  })

  it('treats exactly 5 MiB as a single part and one byte more as the whole budget', () => {
    const atLimit = createUploadQueue()
    atLimit.enqueue([entry('a', SINGLE_PART_BYTES), entry('b', GB)], 'back')
    expect(atLimit.nextToStart([], 5)).toEqual(['a', 'b'])

    const overLimit = createUploadQueue()
    overLimit.enqueue([entry('a', SINGLE_PART_BYTES + 1), entry('b', GB)], 'back')
    expect(overLimit.nextToStart([], 5)).toEqual(['a'])

    const activeAtLimit = createUploadQueue()
    activeAtLimit.enqueue([entry('n', GB)], 'back')
    expect(activeAtLimit.nextToStart([active('a', 'unknown', SINGLE_PART_BYTES)], 5)).toEqual(['n'])

    const activeOverLimit = createUploadQueue()
    activeOverLimit.enqueue([entry('n', GB)], 'back')
    expect(activeOverLimit.nextToStart([active('a', 'unknown', SINGLE_PART_BYTES + 1)], 5)).toEqual([])
  })

  it('starts a lone large file even when the budget is 1', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')

    expect(queue.nextToStart([], 1)).toEqual(['a'])
    expect(queue.nextToStart([active('a', 1)], 1)).toEqual([])
  })

  it.each([0, -1, Number.NaN])('starts nothing when the budget is %s', (budget) => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', MB)], 'back')

    expect(queue.nextToStart([], budget)).toEqual([])
  })

  it('is pure: it neither removes entries nor changes its answer', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    const infos = [active('x', 2)]
    const before = JSON.stringify(infos)

    const first = queue.nextToStart(infos, 5)
    const second = queue.nextToStart(infos, 5)

    expect(first).toEqual(['a'])
    expect(second).toEqual(first)
    expect(ids(queue.waiting())).toEqual(['a', 'b'])
    expect(JSON.stringify(infos)).toBe(before)
  })

  it('returns [] for an empty queue', () => {
    expect(createUploadQueue().nextToStart([], 5)).toEqual([])
  })

  it('does not return an entry that has been started or removed', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', MB), entry('b', MB), entry('c', MB)], 'back')
    queue.markStarted('a')
    queue.remove('b')

    expect(queue.nextToStart([active('a', 1)], 5)).toEqual(['c'])
  })
})

describe('enqueue and waiting order', () => {
  it('keeps back entries in the order they were added', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.enqueue([entry('c')], 'back')

    expect(ids(queue.waiting())).toEqual(['a', 'b', 'c'])
  })

  it('next goes ahead of waiting files, FIFO among nexts', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.enqueue([entry('r1', GB, 'resume')], 'next')
    queue.enqueue([entry('r2', GB, 'resume')], 'next')
    queue.enqueue([entry('c')], 'back')

    expect(ids(queue.waiting())).toEqual(['r1', 'r2', 'a', 'b', 'c'])
  })

  it('keeps the order inside one batch of nexts', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.enqueue([entry('x'), entry('y'), entry('z')], 'next')

    expect(ids(queue.waiting())).toEqual(['x', 'y', 'z', 'a'])
  })

  it('puts a new next behind the nexts still waiting but ahead of the rest, even after one has started', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.enqueue([entry('r1'), entry('r2')], 'next')
    queue.markStarted('r1')
    queue.enqueue([entry('r3')], 'next')

    expect(ids(queue.waiting())).toEqual(['r2', 'r3', 'a', 'b'])

    queue.remove('r2')
    queue.enqueue([entry('r4')], 'next')

    expect(ids(queue.waiting())).toEqual(['r3', 'r4', 'a', 'b'])
  })

  it('is a no-op for an empty batch', () => {
    const queue = createUploadQueue()
    queue.enqueue([], 'back')
    queue.enqueue([], 'next')

    expect(queue.waiting()).toEqual([])
  })

  it('keeps an id that is already waiting where it is instead of adding it twice', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.enqueue([entry('a'), entry('c'), entry('c')], 'next')

    expect(ids(queue.waiting())).toEqual(['c', 'a', 'b'])
    expect(queue.queueSeq('a')).toBeLessThan(queue.queueSeq('b'))
  })

  it('hands back the entries as given, owner included', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', 123, 'resume', 'user-9')], 'back')

    expect(queue.waiting()).toEqual([{ id: 'a', kind: 'resume', sizeBytes: 123, ownerId: 'user-9' }])
  })

  it('returns a snapshot that later changes do not alter', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    const snapshot = queue.waiting()
    queue.enqueue([entry('b')], 'back')
    queue.markStarted('a')

    expect(ids(snapshot)).toEqual(['a'])
  })

  it('order survives Date.now going backwards', () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now -= 10_000
      return now
    })
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now -= 10_000
      return now
    })
    const queue = createUploadQueue()

    queue.enqueue([entry('a')], 'back')
    queue.enqueue([entry('b')], 'back')
    queue.enqueue([entry('r', GB, 'resume')], 'next')
    queue.enqueue([entry('c')], 'back')

    expect(ids(queue.waiting())).toEqual(['r', 'a', 'b', 'c'])
    expect(queue.queueSeq('a')).toBeLessThan(queue.queueSeq('b'))
    expect(queue.queueSeq('b')).toBeLessThan(queue.queueSeq('r'))
    expect(queue.queueSeq('r')).toBeLessThan(queue.queueSeq('c'))
    expect(queue.markStarted('a')).toBeLessThan(queue.markStarted('b'))
    expect(queue.nextToStart([], 5)).toEqual(['r'])
  })
})

describe('remove', () => {
  it('drops a waiting entry and reports whether it was there', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b'), entry('c')], 'back')

    expect(queue.remove('b')).toBe(true)
    expect(ids(queue.waiting())).toEqual(['a', 'c'])
    expect(queue.remove('b')).toBe(false)
    expect(queue.remove('nope')).toBe(false)
  })

  it('does not remove an entry that has already started', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.markStarted('a')

    expect(queue.remove('a')).toBe(false)
    expect(ids(queue.waiting())).toEqual(['b'])
  })

  it('lets an id be enqueued again once it was removed', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.remove('a')
    queue.enqueue([entry('a')], 'back')

    expect(ids(queue.waiting())).toEqual(['b', 'a'])
  })
})

describe('sequence numbers', () => {
  it('queueSeq grows with every enqueued entry, whichever side it goes on', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.enqueue([entry('r')], 'next')
    queue.enqueue([entry('c')], 'back')

    const seqs = ['a', 'b', 'r', 'c'].map((id) => queue.queueSeq(id))
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
    expect(new Set(seqs).size).toBe(4)
  })

  it('queueSeq stays available after the entry started', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    const before = queue.queueSeq('b')
    queue.markStarted('b')

    expect(queue.queueSeq('b')).toBe(before)
  })

  it('queueSeq is -1 for an id that was never enqueued', () => {
    expect(createUploadQueue().queueSeq('ghost')).toBe(-1)
  })

  it('startSeq follows start order, not enqueue order', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('A'), entry('B')], 'back')
    queue.enqueue([entry('R', GB, 'resume')], 'next')

    const startR = queue.markStarted('R')
    const startA = queue.markStarted('A')

    expect(startR).toBeLessThan(startA)
    // queueSeq is the panel order and says the opposite: R was enqueued last.
    expect(queue.queueSeq('R')).toBeGreaterThan(queue.queueSeq('A'))
  })

  it('startSeq is not the queueSeq, and keeps rising across files started later', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('A'), entry('B'), entry('C')], 'back')

    const first = queue.markStarted('C')
    const second = queue.markStarted('A')
    const third = queue.markStarted('B')

    expect(first).toBeLessThan(second)
    expect(second).toBeLessThan(third)
    expect(first).not.toBe(queue.queueSeq('C'))
  })

  it('markStarted takes the entry off the waiting list', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.markStarted('a')

    expect(ids(queue.waiting())).toEqual(['b'])
  })

  it('markStarted still ranks an id that is not waiting, such as a handed-off probe', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    const first = queue.markStarted('a')
    const again = queue.markStarted('a')

    expect(again).toBeGreaterThan(first)
  })
})

describe('hold', () => {
  it('starts out with no probe and no reason', () => {
    const queue = createUploadQueue()

    expect(queue.hold.probeId).toBeNull()
    expect(queue.hold.reason).toBeNull()
  })

  it('holds: returns nothing while a hold is in effect', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', MB), entry('b', MB)], 'back')
    expect(queue.nextToStart([], 5)).toEqual(['a', 'b'])

    queue.hold.begin('probe', 'connection', undefined)

    expect(queue.hold.probeId).toBe('probe')
    expect(queue.hold.reason).toBe('connection')
    expect(queue.nextToStart([], 5)).toEqual([])

    queue.hold.end()

    expect(queue.hold.probeId).toBeNull()
    expect(queue.hold.reason).toBeNull()
    expect(queue.nextToStart([], 5)).toEqual(['a', 'b'])
  })

  it('keeps the waiting list while the hold is in effect', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.hold.begin('probe', 'storage', undefined)

    expect(ids(queue.waiting())).toEqual(['a', 'b'])
  })

  it('never lists the probe as waiting', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('probe'), entry('b')], 'back')
    queue.hold.begin('probe', 'connection', undefined)

    expect(ids(queue.waiting())).toEqual(['b'])

    queue.enqueue([entry('probe')], 'next')
    expect(ids(queue.waiting())).toEqual(['b'])
  })

  it('next during a hold waits behind the probe', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a', MB)], 'back')
    queue.hold.begin('probe', 'storage', undefined)
    queue.enqueue([entry('n', GB, 'resume')], 'next')

    // It is ahead of the other waiting files, but nothing starts until the hold ends.
    expect(ids(queue.waiting())).toEqual(['n', 'a'])
    expect(queue.hold.probeId).toBe('probe')
    expect(queue.nextToStart([], 5)).toEqual([])

    queue.hold.end()
    expect(queue.nextToStart([], 5)).toEqual(['n'])
  })

  it('a second begin while another probe is in charge changes nothing', () => {
    const queue = createUploadQueue()
    queue.hold.begin('first', 'connection', 7_000)
    queue.hold.begin('second', 'storage', 30_000)

    expect(queue.hold.probeId).toBe('first')
    expect(queue.hold.reason).toBe('connection')
    expect(queue.hold.nextDelayMs()).toBe(7_000)
  })

  it('end() forgets the backoff, so the next hold starts from the beginning', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'connection', undefined)
    queue.hold.nextDelayMs()
    queue.hold.nextDelayMs()
    queue.hold.end()
    queue.hold.begin('q', 'storage', undefined)

    expect(queue.hold.nextDelayMs()).toBe(2_000)
  })

  it('asking for a delay with no hold in effect answers 2 s and leaves nothing for the next hold', () => {
    const queue = createUploadQueue()

    expect(queue.hold.nextDelayMs()).toBe(2_000)
    expect(queue.hold.nextDelayMs()).toBe(2_000)

    queue.hold.begin('p', 'connection', undefined)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
    expect(queue.hold.nextDelayMs()).toBe(4_000)
  })

  it('end() is harmless when no hold is in effect', () => {
    const queue = createUploadQueue()
    queue.hold.end()

    expect(queue.hold.probeId).toBeNull()
  })

  it('begin takes the probe out of the waiting list if it was still there', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('p'), entry('b')], 'back')
    queue.hold.begin('p', 'connection', undefined)

    expect(ids(queue.waiting())).toEqual(['b'])
  })
})

describe('hold backoff', () => {
  it('without a retry-after it doubles from 2 s and stops at 60 s', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'connection', undefined)

    const delays = Array.from({ length: 8 }, () => queue.hold.nextDelayMs())

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })

  it('hold backoff honours retryAfter then doubles, capped at 60 s', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'storage', 5_000)

    const delays = Array.from({ length: 7 }, () => queue.hold.nextDelayMs())

    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000])
  })

  it.each([60_001, 3_600_000, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY])(
    'clamps a retry-after of %s to 60 s',
    (retryAfterMs) => {
      const queue = createUploadQueue()
      queue.hold.begin('p', 'storage', retryAfterMs)

      expect(queue.hold.nextDelayMs()).toBe(60_000)
      expect(queue.hold.nextDelayMs()).toBe(60_000)
    },
  )

  it.each([-1, -5_000, Number.NEGATIVE_INFINITY, Number.NaN])(
    'treats a retry-after of %s as absent',
    (retryAfterMs) => {
      const queue = createUploadQueue()
      queue.hold.begin('p', 'storage', retryAfterMs)

      expect(queue.hold.nextDelayMs()).toBe(2_000)
      expect(queue.hold.nextDelayMs()).toBe(4_000)
    },
  )

  it('honours a retry-after of 0 once, then backs off from 2 s instead of staying at 0', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'storage', 0)

    expect(queue.hold.nextDelayMs()).toBe(0)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
    expect(queue.hold.nextDelayMs()).toBe(4_000)
  })

  it('never doubles below 2 s after a short retry-after', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'storage', 500)

    expect(queue.hold.nextDelayMs()).toBe(500)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
  })

  it('a fresh retry-after for the same probe replaces the next delay but keeps the ladder', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'storage', undefined)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
    expect(queue.hold.nextDelayMs()).toBe(4_000)

    queue.hold.begin('p', 'storage', 9_000)

    expect(queue.hold.nextDelayMs()).toBe(9_000)
    expect(queue.hold.nextDelayMs()).toBe(18_000)
  })

  it('a repeated begin for the same probe can change the reason', () => {
    const queue = createUploadQueue()
    queue.hold.begin('p', 'connection', undefined)
    queue.hold.begin('p', 'storage', undefined)

    expect(queue.hold.reason).toBe('storage')
    expect(queue.hold.probeId).toBe('p')
  })
})

describe('hold handOff', () => {
  it('handOff passes the probe role and the current delay to the next entry', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('first'), entry('second')], 'back')
    queue.hold.begin('old', 'storage', undefined)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
    expect(queue.hold.nextDelayMs()).toBe(4_000)

    const handed = queue.hold.handOff()

    expect(handed).toBe('first')
    expect(queue.hold.probeId).toBe('first')
    expect(queue.hold.reason).toBe('storage')
    // Not reset to 2 s, and not pushed on to 8 s: the new probe waits what the old one was waiting.
    expect(queue.hold.nextDelayMs()).toBe(4_000)
    expect(queue.hold.nextDelayMs()).toBe(8_000)
    // The hold is still in effect for everyone else.
    expect(queue.nextToStart([], 5)).toEqual([])
  })

  it('takes the entry out of the waiting list', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('first'), entry('second')], 'back')
    queue.hold.begin('old', 'connection', undefined)

    queue.hold.handOff()

    expect(ids(queue.waiting())).toEqual(['second'])
    expect(queue.remove('first')).toBe(false)
  })

  it('hands the role to a next entry that waited behind the probe', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.hold.begin('old', 'connection', undefined)
    queue.enqueue([entry('n', GB, 'resume')], 'next')

    expect(queue.hold.handOff()).toBe('n')
    expect(ids(queue.waiting())).toEqual(['a'])
  })

  it('hands the role down the line one cancel at a time', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a'), entry('b')], 'back')
    queue.hold.begin('old', 'connection', undefined)

    expect(queue.hold.handOff()).toBe('a')
    expect(queue.hold.handOff()).toBe('b')
    expect(queue.hold.probeId).toBe('b')
    expect(queue.hold.handOff()).toBeNull()
  })

  it('returns null when nothing is waiting, and leaves the ending of the hold to the caller', () => {
    const queue = createUploadQueue()
    queue.hold.begin('old', 'connection', 3_000)

    expect(queue.hold.handOff()).toBeNull()
    expect(queue.hold.probeId).toBe('old')
    expect(queue.nextToStart([], 5)).toEqual([])

    queue.hold.end()
    expect(queue.hold.probeId).toBeNull()
  })

  it('returns null when there is no hold', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')

    expect(queue.hold.handOff()).toBeNull()
    expect(ids(queue.waiting())).toEqual(['a'])
    expect(queue.hold.probeId).toBeNull()
  })

  it('passes on a retry-after the old probe never used', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.hold.begin('old', 'storage', 12_000)

    queue.hold.handOff()

    expect(queue.hold.nextDelayMs()).toBe(12_000)
    expect(queue.hold.nextDelayMs()).toBe(24_000)
  })

  it('keeps a retry-after that arrived after the last delay instead of replaying the old one', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.hold.begin('old', 'storage', undefined)
    queue.hold.nextDelayMs()
    queue.hold.begin('old', 'storage', 9_000)

    queue.hold.handOff()

    expect(queue.hold.nextDelayMs()).toBe(9_000)
  })

  it('passes on a delay of 0 as 0, then backs off from 2 s', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.hold.begin('old', 'storage', 0)
    expect(queue.hold.nextDelayMs()).toBe(0)

    queue.hold.handOff()

    expect(queue.hold.nextDelayMs()).toBe(0)
    expect(queue.hold.nextDelayMs()).toBe(2_000)
  })

  it('starts the new probe at the 60 s cap if the old one had reached it', () => {
    const queue = createUploadQueue()
    queue.enqueue([entry('a')], 'back')
    queue.hold.begin('old', 'storage', undefined)
    for (let i = 0; i < 7; i++) queue.hold.nextDelayMs()

    queue.hold.handOff()

    expect(queue.hold.nextDelayMs()).toBe(60_000)
  })
})

describe('performance', () => {
  it('nextToStart over 5,000 waiting entries runs under 50 ms', () => {
    const queue = createUploadQueue()
    const entries: QueueEntry[] = []
    for (let i = 0; i < 5_000; i++) entries.push(entry(`file-${i}`, i % 2 === 0 ? MB : GB))
    queue.enqueue(entries, 'back')
    const infos = [active('running', 2)]
    const calls = 100

    const start = performance.now()
    for (let i = 0; i < calls; i++) queue.nextToStart(infos, 5)
    const elapsed = performance.now() - start

    expect(elapsed / calls).toBeLessThan(0.5)
    expect(elapsed).toBeLessThan(50)
  })

  it('enqueues, reads and drains 5,000 entries quickly', () => {
    const queue = createUploadQueue()
    const entries: QueueEntry[] = []
    for (let i = 0; i < 5_000; i++) entries.push(entry(`file-${i}`, MB))

    const start = performance.now()
    queue.enqueue(entries, 'back')
    queue.enqueue([entry('first')], 'next')
    expect(queue.waiting()).toHaveLength(5_001)
    queue.markStarted('first')
    for (const e of entries) queue.markStarted(e.id)
    const elapsed = performance.now() - start

    expect(queue.waiting()).toHaveLength(0)

    expect(elapsed).toBeLessThan(2_000)
  })
})
