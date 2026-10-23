/**
 * The settings screen previews an uploaded logo from the PUT response's URL.
 *
 * That URL is now a path into the API (`/instance/branding/logo/<slot>?v=<id>`),
 * so used as-is it would resolve against the web app's own origin and preview a
 * broken image. Both upload paths have to point it at the API first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

const post = vi.fn()
const put = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    delete: vi.fn(),
  },
}))

import { BrandingLogoUpload } from '../branding-logo-upload'
import { BrandingTab } from '../branding-tab'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore, HARDCODED_DEFAULTS } from '@/stores/branding-store'
import type { User } from '@/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
const admin = { id: 'me', name: 'Me', email: 'me@example.com', is_superadmin: true } as User

function pickFile(input: HTMLInputElement) {
  fireEvent.change(input, { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } })
}

beforeEach(() => {
  post.mockReset().mockImplementation((path: string) => {
    const slot = path.match(/^\/instance\/branding\/(.+)-upload/)![1]
    return Promise.resolve({ upload_url: `https://s3.test/put/${slot}`, key: `branding/${slot}/k1` })
  })
  put.mockReset().mockImplementation((_path: string, body: Record<string, string>) => {
    const [field] = Object.keys(body)
    const slot = field.replace(/_key$/, '').replace(/_/g, '-')
    return Promise.resolve({ [field.replace(/_key$/, '_url')]: `/instance/branding/logo/${slot}?v=k1` })
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('logo upload previews', () => {
  it('a single slot hands back a URL on the API', async () => {
    const onUpload = vi.fn()
    const { container } = render(
      <BrandingLogoUpload
        slotKey="logo_light"
        label="Light logo"
        description="Sidebar"
        acceptedFormats={['PNG']}
        minResolution="512x512"
        currentUrl={null}
        onUpload={onUpload}
        onRemove={vi.fn()}
      />,
    )

    pickFile(container.querySelector('input[type="file"]') as HTMLInputElement)

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1))
    expect(onUpload).toHaveBeenCalledWith(
      `${API_URL}/instance/branding/logo/logo-light?v=k1`,
      'branding/logo-light/k1',
    )
  })

  it('the upload-to-every-slot button fills the store with URLs on the API', async () => {
    useAuthStore.setState({ user: admin, isSuperAdmin: true })
    useBrandingStore.setState({ ...HARDCODED_DEFAULTS, loaded: true })
    const { container } = render(<BrandingTab />)

    // The quick upload's input is the first one on the tab.
    pickFile(container.querySelector('input[type="file"]') as HTMLInputElement)

    await waitFor(() => expect(useBrandingStore.getState().loginLogoUrl).not.toBeNull())
    const state = useBrandingStore.getState()
    expect(state.orgLogoLight).toBe(`${API_URL}/instance/branding/logo/logo-light?v=k1`)
    expect(state.orgLogoDark).toBe(`${API_URL}/instance/branding/logo/logo-dark?v=k1`)
    expect(state.faviconUrl).toBe(`${API_URL}/instance/branding/logo/favicon?v=k1`)
    expect(state.appleIconUrl).toBe(`${API_URL}/instance/branding/logo/apple-icon?v=k1`)
    expect(state.loginLogoUrl).toBe(`${API_URL}/instance/branding/logo/login-logo?v=k1`)
  })
})
