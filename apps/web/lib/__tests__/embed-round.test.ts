import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaveRound, createNotesReporter, roundSync, EmbedRoundState } from '../embed-round'

afterEach(() => vi.unstubAllGlobals())

describe('leaveRound (the embed went away)', () => {
  it('beacons by=left with the share session, and not while a note is recording, transcribing or uploading', () => {
    const beacon = vi.fn().mockReturnValue(true)
    expect(leaveRound({ token: 'tok', assetId: 'a1', shareSession: 's 1', busy: true }, { sendBeacon: beacon })).toBe(false)
    expect(beacon).not.toHaveBeenCalled()
    expect(leaveRound({ token: 'tok', assetId: 'a1', shareSession: 's 1', busy: false }, { sendBeacon: beacon })).toBe(true)
    expect(beacon.mock.calls[0][0]).toMatch(/\/share\/tok\/assets\/a1\/feedback-done\?by=left&share_session=s%201$/)
  })
  it('falls back to fetch keepalive when there is no beacon or it refuses', () => {
    const f = vi.fn().mockResolvedValue({}); vi.stubGlobal('fetch', f)
    leaveRound({ token: 'tok', assetId: 'a1', busy: false }, {})
    leaveRound({ token: 'tok', assetId: 'a1', busy: false }, { sendBeacon: () => false })
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', keepalive: true })
    expect(f.mock.calls[0][0]).toMatch(/feedback-done\?by=left$/)
  })
  it('sends only once per page life (pagehide + gen:close both fire)', () => {
    const beacon = vi.fn().mockReturnValue(true)
    const st = new EmbedRoundState()
    expect(st.leave({ token: 't', assetId: 'a', busy: false }, { sendBeacon: beacon })).toBe(true)
    expect(st.leave({ token: 't', assetId: 'a', busy: false }, { sendBeacon: beacon })).toBe(false)
    expect(beacon).toHaveBeenCalledTimes(1)
  })
  it('a busy attempt does not use up the one send', () => {
    const beacon = vi.fn().mockReturnValue(true)
    const st = new EmbedRoundState()
    expect(st.leave({ token: 't', assetId: 'a', busy: true }, { sendBeacon: beacon })).toBe(false)
    expect(st.leave({ token: 't', assetId: 'a', busy: false }, { sendBeacon: beacon })).toBe(true)
  })
})

describe('createNotesReporter', () => {
  it('reports only changes, including 0 after a send', () => {
    const out = vi.fn()
    const r = createNotesReporter('r1', out)
    r.report(0); r.report(0); r.report(1); r.report(1); r.report(2); r.report(0)
    expect(out.mock.calls.map(c => c[0])).toEqual([0, 1, 2, 0])
  })
  it('the first value always goes out (Gen starts from the embed, not from a guess)', () => {
    const out = vi.fn(); createNotesReporter('r2', out).report(0)
    expect(out).toHaveBeenCalledWith(0)
  })
})

describe('roundSync', () => {
  it('posts round-sync and returns notes + closed_by; failures are null', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ notes: 2, closed_by: 'all_reviewed' }) }); vi.stubGlobal('fetch', f)
    expect(await roundSync('tok', 'a1', 's1')).toEqual({ notes: 2, closed_by: 'all_reviewed' })
    expect(f.mock.calls[0][0]).toMatch(/\/share\/tok\/assets\/a1\/round-sync\?share_session=s1$/)
    f.mockRejectedValue(new Error('offline'))
    expect(await roundSync('tok', 'a1')).toBeNull()
  })
})
