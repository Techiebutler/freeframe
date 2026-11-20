import { describe, it, expect, vi, beforeEach } from 'vitest'

// Old settings addresses stay as bookmarks and redirect to the new routes.
// They have to keep `?tab=`: dropping it lands everyone on the wrong page.

const redirect = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ redirect }))

import LegacyAdminPage from '../admin/page'
import BrandingPage from '../branding/page'
import InstanceIndexPage from '../instance/page'
import LegacyProjectSettingsPage from '../../projects/[id]/settings/page'

beforeEach(() => redirect.mockClear())

describe('/settings/admin', () => {
  it.each([
    [undefined, '/settings/instance/users'],
    ['users', '/settings/instance/users'],
    ['storage', '/settings/instance/storage'],
    ['instance', '/settings/instance/settings'],
    ['branding', '/settings/instance/branding'],
    ['nonsense', '/settings/instance/users'],
  ])('with tab %s goes to %s', async (tab, target) => {
    await LegacyAdminPage({ searchParams: Promise.resolve({ tab }) })
    expect(redirect).toHaveBeenCalledExactlyOnceWith(target)
  })

  it('opens Users when the tab is repeated in the query', async () => {
    await LegacyAdminPage({ searchParams: Promise.resolve({ tab: ['storage', 'branding'] }) })
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/settings/instance/users')
  })
})

describe('the other old Instance addresses', () => {
  it('/settings/branding goes straight to Branding, not through /settings/admin', () => {
    BrandingPage()
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/settings/instance/branding')
  })

  it('/settings/instance goes to Users', () => {
    InstanceIndexPage()
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/settings/instance/users')
  })
})

describe('/projects/{id}/settings', () => {
  it.each([
    [undefined, '/settings/projects/p1'],
    ['people', '/settings/projects/p1?tab=people'],
    ['danger', '/settings/projects/p1?tab=danger'],
    ['anything', '/settings/projects/p1?tab=anything'],
  ])('with tab %s goes to %s', async (tab, target) => {
    await LegacyProjectSettingsPage({
      params: Promise.resolve({ id: 'p1' }),
      searchParams: Promise.resolve({ tab }),
    })
    expect(redirect).toHaveBeenCalledExactlyOnceWith(target)
  })

  it('encodes a tab value that is not plain text', async () => {
    await LegacyProjectSettingsPage({
      params: Promise.resolve({ id: 'p1' }),
      searchParams: Promise.resolve({ tab: 'a&b=c' }),
    })
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/settings/projects/p1?tab=a%26b%3Dc')
  })
})
