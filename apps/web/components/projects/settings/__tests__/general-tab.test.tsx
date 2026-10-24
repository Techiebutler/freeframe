import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import type { Project, ProjectBranding } from '@/types'

const { api, push } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
  push: vi.fn(),
}))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}))
// jsdom cannot decode or encode images.
vi.mock('@/lib/avatar-image', async (orig) => ({
  ...(await orig<typeof import('@/lib/avatar-image')>()),
  prepareLogo: vi.fn(async () => new Blob(['webp'], { type: 'image/webp' })),
}))

import { ProjectGeneralTab } from '../general-tab'
import { useBrandingStore } from '@/stores/branding-store'

// The General tab saves the project's details, its cover and its share-page
// branding with one Save, each to its own endpoint, sending only what changed.
// A part that fails is named and stays unsaved; the rest is saved.

const PROJECT: Project = {
  id: 'p1',
  name: 'Launch film',
  description: 'Old description',
  created_by: 'u1',
  project_type: 'personal',
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  is_public: false,
  poster_url: 'https://cdn.example/cover.jpg',
  role: 'owner',
}

const BRANDING: ProjectBranding = {
  id: 'b1',
  project_id: 'p1',
  logo_s3_key: 'branding/p1/logo/1.webp',
  logo_url: 'https://cdn.example/logo.webp',
  primary_color: '#cc3300',
  secondary_color: null,
  custom_title: null,
  custom_footer: 'Confidential',
  viewer_layout: 'grid',
  featured_field: null,
  use_cover_as_logo: false,
}

let calls: string[] = []
let blobCount = 0

function renderTab(project: Project = PROJECT) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectGeneralTab project={project} />
    </SWRConfig>,
  )
}

async function loaded() {
  await screen.findByLabelText('Primary colour hex')
}

function saveButton() {
  return screen.getByRole('button', { name: 'Save' })
}

async function save() {
  await act(async () => {
    fireEvent.click(saveButton())
  })
}

function saveBar() {
  return screen.getByRole('region', { name: 'Save changes' })
}

function frame() {
  return screen.getByTestId('share-preview-frame')
}

function pick(testId: string, name: string, type = 'image/png') {
  const file = new File(['img'], name, { type })
  fireEvent.change(screen.getByTestId(testId), { target: { files: [file] } })
  return file
}

beforeEach(() => {
  calls = []
  blobCount = 0
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/projects/p1/branding') return BRANDING
    throw new Error(`unexpected GET ${url}`)
  })
  api.patch.mockReset().mockImplementation(async (url: string, body: unknown) => {
    calls.push(`PATCH ${url}`)
    return { ...PROJECT, ...(body as object) }
  })
  api.put.mockReset().mockImplementation(async (url: string, body: Record<string, unknown>) => {
    calls.push(`PUT ${url}`)
    return {
      ...BRANDING,
      ...body,
      logo_url: 'logo_s3_key' in body ? (body.logo_s3_key ? 'https://cdn.example/new-logo.webp' : null) : BRANDING.logo_url,
    }
  })
  api.post.mockReset().mockImplementation(async (url: string) => {
    calls.push(`POST ${url}`)
    return { upload_url: 'https://s3.example/put-here', key: 'branding/p1/logo/2.webp' }
  })
  api.delete.mockReset().mockImplementation(async (url: string) => {
    calls.push(`DELETE ${url}`)
  })
  api.upload.mockReset().mockImplementation(async (url: string) => {
    calls.push(`UPLOAD ${url}`)
    return { ...PROJECT, poster_url: 'https://cdn.example/new-cover.jpg' }
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`)
    return { ok: true }
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pick-${++blobCount}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  push.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useBrandingStore.setState({ loaded: false, primaryColor: null })
})

describe('project details', () => {
  it('sends only the fields that changed, and an emptied description as null', async () => {
    renderTab()
    await loaded()
    expect(saveButton()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('switch', { name: /Private/ }))
    expect(within(saveBar()).getByText('Unsaved changes')).toBeInTheDocument()
    await save()

    expect(api.patch).toHaveBeenCalledTimes(1)
    expect(api.patch).toHaveBeenCalledWith('/projects/p1', { description: null, is_public: true })
    expect(api.put).not.toHaveBeenCalled()
    expect(within(saveBar()).getByText('Saved.')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('describes visibility the way the API applies it', async () => {
    renderTab()
    await loaded()
    expect(screen.getByText('Only invited members can access this project.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /Private/ }))
    expect(screen.getByText('All users in the system can view this project.')).toBeInTheDocument()
  })

  it('will not save without a name', async () => {
    renderTab()
    await loaded()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } })
    expect(screen.getByText('A project needs a name.')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('uploads a new cover, and removes one with DELETE', async () => {
    renderTab()
    await loaded()
    pick('cover-input', 'cover.png')
    expect(screen.getByAltText('Project cover')).toHaveAttribute('src', 'blob:pick-1')
    await save()
    expect(calls).toEqual(['UPLOAD /projects/p1/poster'])
    expect(screen.getByAltText('Project cover')).toHaveAttribute('src', 'https://cdn.example/new-cover.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Remove cover' }))
    expect(screen.queryByAltText('Project cover')).toBeNull()
    await save()
    expect(calls).toEqual(['UPLOAD /projects/p1/poster', 'DELETE /projects/p1/poster'])
  })

  it('refuses a cover the API would refuse, before any request', async () => {
    renderTab()
    await loaded()
    pick('cover-input', 'cover.svg', 'image/svg+xml')
    expect(screen.getByText('Choose a JPG, PNG, WEBP or GIF image')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })
})

describe('branding fields', () => {
  it('clearing the colour sends an explicit null, and nothing else', async () => {
    renderTab()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Clear primary colour' }))
    await save()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { primary_color: null })
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('an emptied footer is sent as null', async () => {
    renderTab()
    await loaded()
    const footer = screen.getByLabelText('Footer text')
    expect(footer).toHaveAttribute('maxLength', '500')
    fireEvent.change(footer, { target: { value: '' } })
    await save()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { custom_footer: null })
  })

  it('removing the logo sends logo_s3_key: null', async () => {
    renderTab()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await save()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { logo_s3_key: null })
  })

  it('the cover switch is sent as use_cover_as_logo and hides the logo picker', async () => {
    renderTab()
    await loaded()
    fireEvent.click(screen.getByRole('switch', { name: /Use project cover as share logo/ }))
    expect(screen.queryByTestId('logo-input')).toBeNull()
    await save()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { use_cover_as_logo: true })
  })

  it('a new logo is uploaded to its presigned URL before the branding write that names it', async () => {
    renderTab()
    await loaded()
    pick('logo-input', 'logo.png')
    await save()
    expect(calls).toEqual([
      'POST /projects/p1/branding/logo-upload',
      'PUT https://s3.example/put-here',
      'PUT /projects/p1/branding',
    ])
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { logo_s3_key: 'branding/p1/logo/2.webp' })
    const s3Put = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(s3Put.headers).toEqual({ 'Content-Type': 'image/webp' })
    expect(screen.getByAltText('Share page logo')).toHaveAttribute('src', 'https://cdn.example/new-logo.webp')
  })
})

describe('saving several parts', () => {
  it('saves cover, details, logo and branding in that order', async () => {
    renderTab()
    await loaded()
    pick('cover-input', 'cover.png')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch film v2' } })
    pick('logo-input', 'logo.png')
    fireEvent.change(screen.getByLabelText('Footer text'), { target: { value: 'New footer' } })
    await save()
    expect(calls).toEqual([
      'UPLOAD /projects/p1/poster',
      'PATCH /projects/p1',
      'POST /projects/p1/branding/logo-upload',
      'PUT https://s3.example/put-here',
      'PUT /projects/p1/branding',
    ])
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', {
      logo_s3_key: 'branding/p1/logo/2.webp',
      custom_footer: 'New footer',
    })
  })

  it('names the part that failed, saves the rest, and keeps the failed part to retry', async () => {
    api.patch.mockRejectedValueOnce(new Error('Name already taken'))
    renderTab()
    await loaded()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clash' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear primary colour' }))
    await save()

    const bar = saveBar()
    expect(within(bar).getByText('Some changes were not saved.')).toBeInTheDocument()
    expect(within(bar).getByText('Project details: Name already taken')).toBeInTheDocument()
    expect(within(bar).queryByText(/Branding:/)).toBeNull()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { primary_color: null })

    // Only the details are left to save.
    api.put.mockClear()
    await save()
    expect(api.patch).toHaveBeenLastCalledWith('/projects/p1', { name: 'Clash' })
    expect(api.put).not.toHaveBeenCalled()
    expect(within(saveBar()).getByText('Saved.')).toBeInTheDocument()
  })

  it('a failed logo upload is reported and the other branding fields are still saved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    renderTab()
    await loaded()
    pick('logo-input', 'logo.png')
    fireEvent.change(screen.getByLabelText('Footer text'), { target: { value: 'Still saved' } })
    await save()
    expect(within(saveBar()).getByText('Logo: The logo could not be uploaded')).toBeInTheDocument()
    expect(api.put).toHaveBeenCalledWith('/projects/p1/branding', { custom_footer: 'Still saved' })
    expect(within(saveBar()).queryByText('Saved.')).toBeNull()
  })

  it('a failed branding write is reported with the details still saved', async () => {
    api.put.mockRejectedValueOnce(new Error('custom_footer: too long'))
    renderTab()
    await loaded()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByLabelText('Footer text'), { target: { value: 'x' } })
    await save()
    expect(within(saveBar()).getByText('Branding: custom_footer: too long')).toBeInTheDocument()
    expect(api.patch).toHaveBeenCalledWith('/projects/p1', { name: 'Renamed' })
  })

  it('Discard puts every field back', async () => {
    renderTab()
    await loaded()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other' } })
    fireEvent.change(screen.getByLabelText('Footer text'), { target: { value: 'Other footer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Launch film')
    expect(screen.getByLabelText('Footer text')).toHaveValue('Confidential')
    expect(saveButton()).toBeDisabled()
  })
})

describe('share page preview', () => {
  it('shows the unsaved colour, footer and logo', async () => {
    useBrandingStore.setState({ loaded: true, primaryColor: '#00aa00' })
    renderTab()
    await loaded()
    expect(frame().style.getPropertyValue('--accent')).toBe('#cc3300')
    expect(within(frame()).getByAltText('Project logo')).toHaveAttribute('src', 'https://cdn.example/logo.webp')
    expect(within(frame()).getByText('Confidential')).toBeInTheDocument()

    const hex = screen.getByLabelText('Primary colour hex')
    fireEvent.change(hex, { target: { value: '112233' } })
    fireEvent.blur(hex)
    expect(frame().style.getPropertyValue('--accent')).toBe('#112233')

    fireEvent.change(screen.getByLabelText('Footer text'), { target: { value: 'Draft footer' } })
    expect(within(frame()).getByText('Draft footer')).toBeInTheDocument()

    pick('logo-input', 'logo.png')
    expect(within(frame()).getByAltText('Project logo')).toHaveAttribute('src', 'blob:pick-1')
    expect(api.put).not.toHaveBeenCalled()
  })

  it('falls back to the instance colour once the project colour is cleared', async () => {
    useBrandingStore.setState({ loaded: true, primaryColor: '#00aa00' })
    renderTab()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Clear primary colour' }))
    expect(frame().style.getPropertyValue('--accent')).toBe('#00aa00')
  })

  it('shows the cover as the logo when the switch is on, the instance logo with neither', async () => {
    renderTab()
    await loaded()
    fireEvent.click(screen.getByRole('switch', { name: /Use project cover as share logo/ }))
    expect(within(frame()).getByAltText('Project logo')).toHaveAttribute('src', 'https://cdn.example/cover.jpg')

    fireEvent.click(screen.getByRole('switch', { name: /Use project cover as share logo/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(within(frame()).queryByAltText('Project logo')).toBeNull()
    expect(within(frame()).getByAltText('FreeFrame')).toBeInTheDocument()
  })

  it('previews the theme picked for it, in the frame only', async () => {
    renderTab()
    await loaded()
    expect(frame()).toHaveAttribute('data-theme', 'dark')
    fireEvent.click(screen.getByRole('button', { name: 'Light' }))
    expect(frame()).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('light')
  })
})

describe('when branding cannot be loaded', () => {
  it('says so with a Retry, and the project part still saves', async () => {
    api.get.mockImplementation(async () => {
      throw new Error('Server error')
    })
    renderTab()
    expect(await screen.findByText('Branding could not be loaded: Server error')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    await save()
    expect(api.patch).toHaveBeenCalledWith('/projects/p1', { name: 'Renamed' })
    expect(api.put).not.toHaveBeenCalled()

    api.get.mockImplementation(async () => BRANDING)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await loaded()
  })
})

describe('leaving with unsaved changes', () => {
  function beforeUnloadPrevented() {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  }

  function LinkOut() {
    return <a href="/projects">All projects</a>
  }

  it('asks the browser to confirm closing the tab only while there are changes', async () => {
    renderTab()
    await loaded()
    expect(beforeUnloadPrevented()).toBe(false)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited' } })
    expect(beforeUnloadPrevented()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(beforeUnloadPrevented()).toBe(false)
  })

  it('holds an in-app link back and offers to leave', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <LinkOut />
        <ProjectGeneralTab project={PROJECT} />
      </SWRConfig>,
    )
    await loaded()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited' } })

    const clicked = fireEvent.click(screen.getByText('All projects'))
    expect(clicked).toBe(false)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('All projects'))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects'))
  })

  it('lets links through when nothing is unsaved', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <LinkOut />
        <ProjectGeneralTab project={PROJECT} />
      </SWRConfig>,
    )
    await loaded()
    // Stands in for the router: the click reaches it, and it handles the navigation.
    const router = vi.fn((e: MouseEvent) => e.preventDefault())
    document.addEventListener('click', router)
    fireEvent.click(screen.getByText('All projects'))
    document.removeEventListener('click', router)
    expect(router).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
