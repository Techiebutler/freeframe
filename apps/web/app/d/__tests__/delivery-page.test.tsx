import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import DeliveryPage from '../[token]/page'

const file = (name: string, mime = 'video/mp4') => ({ name, url: `https://x/${name}`, size_bytes: 4_200_000, mime_type: mime })
const data = { title: 'Kollagen Hooks', brand: 'Glow25', version: 2, video_url: 'https://x/v.mp4', files: [file('a.mp4')], approved_by: 'Alan', approved_at: '2026-11-18T10:00:00Z' }

function show(res: Partial<Response> & { ok: boolean }) {
  globalThis.fetch = vi.fn().mockResolvedValue(res) as unknown as typeof fetch
  return render(<SWRConfig value={{ provider: () => new Map() }}><DeliveryPage params={{ token: 't' }} /></SWRConfig>)
}

describe('delivery page', () => {
  it('shows brand - title and one Download, with no usage instructions', async () => {
    show({ ok: true, json: async () => ({ ...data, live_notes: ['Upload it to Meta.'] }) })
    await screen.findByText('Glow25 - Kollagen Hooks')
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', 'https://x/a.mp4')
    expect(document.body.textContent).not.toMatch(/how to use it/i)
    expect(document.body.textContent).not.toMatch(/upload it to meta/i)
  })
  it('says calmly when the link is gone', async () => {
    show({ ok: false, status: 404 })
    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeInTheDocument())
  })
  it('shows n of m while parts are open', async () => {
    show({ ok: false, status: 409, json: async () => ({ detail: { error: 'parts_open', approved: 2, total: 3 } }) })
    await screen.findByText('2 of 3 videos approved')
  })
})
