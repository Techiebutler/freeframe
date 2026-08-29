import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }))

const sendMagicCode = vi.fn()
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => sendMagicCode(...args) },
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
}))
vi.mock('@/lib/auth', () => ({ setTokens: vi.fn() }))

import { LoginForm } from '../login-form'

/** Walk the email step and land on the code screen for `email`. */
async function requestCodeFor(email: string) {
  const view = render(<LoginForm />)
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: /send magic code/i }))
  await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument())
  return view
}

describe('LoginForm magic-code step (#248)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The endpoint answers identically for known and unknown addresses, on
    // purpose — that is what stops it being used to enumerate accounts.
    sendMagicCode.mockResolvedValue({})
  })

  it('does not claim a code was sent, because the API never said one was', async () => {
    await requestCodeFor('nobody@example.invalid')

    // The old copy asserted a fact the server never promised, stranding anyone
    // who mistyped their address on a screen waiting for mail that cannot come.
    expect(screen.queryByText(/we sent a 6-digit code/i)).not.toBeInTheDocument()
    expect(screen.getByText(/has an account/i)).toBeInTheDocument()
    expect(screen.getByText('nobody@example.invalid')).toBeInTheDocument()
  })

  it('offers the one check a person can act on without being told the account exists', async () => {
    await requestCodeFor('typo@example.invalid')
    expect(screen.getByText(/check the address for typos/i)).toBeInTheDocument()
  })

  it('keeps the wording identical for a registered and an unregistered address', async () => {
    // The whole anti-enumeration property lives here: if these two screens ever
    // differ, the login form leaks which addresses have accounts.
    const first = await requestCodeFor('registered@example.test')
    const registered = screen.getByText(/has an account/i).textContent
    first.unmount()

    await requestCodeFor('unknown@example.invalid')
    const unknown = screen.getByText(/has an account/i).textContent

    expect(registered?.replace('registered@example.test', 'X'))
      .toBe(unknown?.replace('unknown@example.invalid', 'X'))
  })

  it('lets the user back out to correct the address', async () => {
    await requestCodeFor('wrong@example.invalid')
    fireEvent.click(screen.getByRole('button', { name: /use a different email/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send magic code/i })).toBeInTheDocument(),
    )
  })
})
