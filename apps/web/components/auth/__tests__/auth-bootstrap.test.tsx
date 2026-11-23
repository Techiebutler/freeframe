import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { RefreshOutcome } from '@/lib/auth'

const bootstrapSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth', () => ({ bootstrapSession }))
vi.mock('@/lib/auth-transport', () => ({ usesRefreshCookie: () => true }))

it('does not mount the dashboard until the cookie session resolves', async () => {
  const { AuthBootstrap } = await import('../auth-bootstrap')
  let finish!: (outcome: RefreshOutcome) => void
  bootstrapSession.mockReturnValue(new Promise<RefreshOutcome>(resolve => { finish = resolve }))
  render(<AuthBootstrap><div>Dashboard contents</div></AuthBootstrap>)
  expect(screen.queryByText('Dashboard contents')).not.toBeInTheDocument()
  await act(async () => finish({ token: 'in-memory' }))
  expect(screen.getByText('Dashboard contents')).toBeInTheDocument()
})
