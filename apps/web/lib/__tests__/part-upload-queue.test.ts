import { expect, it } from 'vitest'
import { createUploadQueue } from '../part-upload-queue'
it('bounds concurrent transfers across separate drops and continues after failure', async () => {
  const queue = createUploadQueue(2)
  const running: number[] = []
  const release: (() => void)[] = []
  const work = (n: number) => queue(async () => { running.push(n); await new Promise<void>(resolve => release[n] = resolve); if (n === 0) throw new Error('retry'); return n })
  const a = work(0).catch(() => -1), b = work(1), c = work(2)
  await Promise.resolve()
  expect(running).toEqual([0, 1])
  release[0]()
  expect(await a).toBe(-1)
  await Promise.resolve()
  expect(running).toEqual([0, 1, 2])
  release[1](); release[2]()
  expect(await Promise.all([b, c])).toEqual([1, 2])
})

it('frees the slot on release while the work itself is still waiting, without freeing it twice', async () => {
  const queue = createUploadQueue(1)
  const running: string[] = []
  const finish: Record<string, () => void> = {}
  const job = (name: string, onStart?: (release: () => void) => void) => queue(async release => {
    running.push(name)
    onStart?.(release)
    await new Promise<void>(resolve => { finish[name] = resolve })
  })
  const a = job('a', release => { release(); release() }), b = job('b'), c = job('c')
  await Promise.resolve(); await Promise.resolve()
  expect(running).toEqual(['a', 'b'])
  finish.a(); await a
  await Promise.resolve()
  // a's own end must not hand out a second slot: b still holds the only one.
  expect(running).toEqual(['a', 'b'])
  finish.b(); await b
  await Promise.resolve()
  expect(running).toEqual(['a', 'b', 'c'])
  finish.c(); await c
})
