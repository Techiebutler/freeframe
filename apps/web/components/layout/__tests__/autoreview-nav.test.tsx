import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/components/shared/toast'
import { AutoreviewBrandButton } from '../autoreview-nav'

// Alan (2026-11-08): AutoReview moved from its own sidebar entry to a button on Brand rules, next to the brand.
const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', () => ({ api }))
const assign = vi.fn()

beforeEach(() => {
  api.get.mockReset()
  assign.mockReset()
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } })
})
afterEach(cleanup)

function mount(brands: { slug: string; name: string }[], props: { slug?: string | null; name: string }, fail = false) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/autoreview/brands') return { brands }
    if (path.startsWith('/autoreview/link?brand=')) {
      if (fail) throw new Error('down')
      return { url: `https://review.aditor.ai/brand/${path.split('=')[1]}?t=jwt` }
    }
    throw new Error(path)
  })
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ToastProvider><AutoreviewBrandButton {...props} /></ToastProvider>
    </SWRConfig>,
  )
}

it('renders nothing when the brand is not linked to AutoReview', async () => {
  mount([{ slug: 'mynd-organics', name: 'Mynd' }], { slug: 'audibene-gmbh', name: 'Audibene' })
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/autoreview/brands'))
  expect(screen.queryByRole('button', { name: /Open in AutoReview/ })).toBeNull()
})

it('opens the selected brand by its slug with a fresh link, in the same tab', async () => {
  mount([{ slug: 'audibene-gmbh', name: 'audibene-workspace' }, { slug: 'mynd-organics', name: 'Mynd' }], { slug: 'mynd-organics', name: 'Mynd' })
  fireEvent.click(await screen.findByRole('button', { name: /Open in AutoReview/ }))
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://review.aditor.ai/brand/mynd-organics?t=jwt'))
})

it('without a slug, it finds the brand by its name', async () => {
  mount([{ slug: 'audibene-gmbh', name: 'Audibene - Workspace' }], { slug: null, name: 'Audibene - Workspace' })
  fireEvent.click(await screen.findByRole('button', { name: /Open in AutoReview/ }))
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://review.aditor.ai/brand/audibene-gmbh?t=jwt'))
})

it('a failed link shows an error and does not navigate', async () => {
  mount([{ slug: 'audibene-gmbh', name: 'Audibene' }], { slug: 'audibene-gmbh', name: 'Audibene' }, true)
  fireEvent.click(await screen.findByRole('button', { name: /Open in AutoReview/ }))
  expect(await screen.findByText("Couldn't open AutoReview. Try again.")).toBeInTheDocument()
  expect(assign).not.toHaveBeenCalled()
})
