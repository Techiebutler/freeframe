import type { InstanceBranding } from '@/stores/branding-store'

/** Complete branding response for tests. Override only the fields relevant to a case. */
export function makeInstanceBranding(
  overrides: Partial<InstanceBranding> = {},
): InstanceBranding {
  return {
    id: 'branding-1',
    org_name: 'Acme',
    logo_light_key: null,
    logo_dark_key: null,
    favicon_key: null,
    apple_icon_key: null,
    login_logo_key: null,
    logo_light_url: null,
    logo_dark_url: null,
    favicon_url: null,
    apple_icon_url: null,
    login_logo_url: null,
    primary_color: null,
    powered_by_freeframe: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}
