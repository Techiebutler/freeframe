import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const post = vi.fn()
const patch = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}))

const prepareAvatar = vi.fn()
vi.mock('@/lib/avatar-image', () => ({
  AVATAR_INPUT_TYPES: ['image/png', 'image/jpeg', 'image/webp'],
  prepareAvatar: (...a: unknown[]) => prepareAvatar(...a),
}))

import { ProfileAvatarEditor } from '../profile-avatar-editor'
import { useAuthStore } from '@/stores/auth-store'
import type { User } from '@/types'

function makeUser(over: Partial<User> = {}): User {
  return {
    id: 'me',
    name: 'Jane Doe',
    email: 'jane@example.com',
    avatar_url: null,
    avatar_color: null,
    status: 'active',
    is_superadmin: false,
    email_verified: true,
    preferences: {},
    created_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    ...over,
  } as User
}

describe('ProfileAvatarEditor', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    post.mockReset()
    patch.mockReset()
    del.mockReset()
    prepareAvatar.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    useAuthStore.setState({ user: makeUser() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uploads the prepared image through presign, PUT and confirm', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' })
    prepareAvatar.mockResolvedValue(blob)
    post
      .mockResolvedValueOnce({ upload_url: 'https://s3.test/put', key: 'avatars/me/a.webp' })
      .mockResolvedValueOnce(makeUser({ avatar_url: 'https://s3.test/get' }))
    fetchMock.mockResolvedValue({ ok: true })

    render(<ProfileAvatarEditor />)
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByTestId('avatar-file-input'), { target: { files: [file] } })

    await waitFor(() => expect(screen.getByRole('button', { name: /replace/i })).toBeInTheDocument())
    expect(prepareAvatar).toHaveBeenCalledWith(file)
    expect(post).toHaveBeenNthCalledWith(1, '/users/me/avatar-upload?content_type=image%2Fwebp')
    expect(fetchMock).toHaveBeenCalledWith('https://s3.test/put', {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/webp' },
    })
    expect(post).toHaveBeenNthCalledWith(2, '/users/me/avatar-confirm', { key: 'avatars/me/a.webp' })
  })

  it('does not confirm when the upload to storage fails', async () => {
    prepareAvatar.mockResolvedValue(new Blob(['x'], { type: 'image/webp' }))
    post.mockResolvedValueOnce({ upload_url: 'https://s3.test/put', key: 'avatars/me/a.webp' })
    fetchMock.mockResolvedValue({ ok: false })

    render(<ProfileAvatarEditor />)
    fireEvent.change(screen.getByTestId('avatar-file-input'), {
      target: { files: [new File(['x'], 'me.png', { type: 'image/png' })] },
    })

    expect(await screen.findByText(/failed to upload image/i)).toBeInTheDocument()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('shows why an image was refused', async () => {
    prepareAvatar.mockRejectedValue(new Error('Image must be under 10 MB'))

    render(<ProfileAvatarEditor />)
    fireEvent.change(screen.getByTestId('avatar-file-input'), {
      target: { files: [new File(['x'], 'big.png', { type: 'image/png' })] },
    })

    expect(await screen.findByText(/under 10 MB/i)).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })

  it('removes the picture', async () => {
    useAuthStore.setState({ user: makeUser({ avatar_url: 'https://s3.test/get' }) })
    del.mockResolvedValue(makeUser())

    render(<ProfileAvatarEditor />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    await waitFor(() => expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument())
    expect(del).toHaveBeenCalledWith('/users/me/avatar')
  })

  it('hides the circle color while there is a picture', () => {
    useAuthStore.setState({ user: makeUser({ avatar_url: 'https://s3.test/get' }) })
    render(<ProfileAvatarEditor />)
    expect(screen.queryByText(/circle color/i)).not.toBeInTheDocument()
  })

  it('saves a circle color', async () => {
    patch.mockResolvedValue(makeUser({ avatar_color: '#112233' }))

    render(<ProfileAvatarEditor />)
    fireEvent.change(screen.getByLabelText('Circle color hex'), { target: { value: '#112233' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/users/me', { avatar_color: '#112233' }))
    expect(await screen.findByRole('button', { name: /reset/i })).toBeInTheDocument()
  })

  it('will not save a color that is not six-digit hex', () => {
    render(<ProfileAvatarEditor />)
    fireEvent.change(screen.getByLabelText('Circle color hex'), { target: { value: '#123' } })
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })

  it('resets the circle color to the default', async () => {
    useAuthStore.setState({ user: makeUser({ avatar_color: '#112233' }) })
    patch.mockResolvedValue(makeUser())

    render(<ProfileAvatarEditor />)
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/users/me', { avatar_color: null }))
  })
})
