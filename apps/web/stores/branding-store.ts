import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export interface InstanceBranding {
  id: string
  org_name: string
  logo_light_key: string | null
  logo_dark_key: string | null
  favicon_key: string | null
  apple_icon_key: string | null
  login_logo_key: string | null
  logo_light_url: string | null
  logo_dark_url: string | null
  favicon_url: string | null
  apple_icon_url: string | null
  login_logo_url: string | null
  primary_color: string | null
  powered_by_freeframe: boolean
  created_at: string
  updated_at: string
}

interface BrandingState {
  orgName: string
  orgLogoDark: string | null
  orgLogoLight: string | null
  faviconUrl: string | null
  appleIconUrl: string | null
  loginLogoUrl: string | null
  poweredByFreeframe: boolean
  primaryColor: string | null
  /** When branding was last synced from the server — used to expire persisted logo URLs. */
  brandingFetchedAt: number | null
  loaded: boolean
  loading: boolean

  setOrgName: (name: string) => void
  setOrgLogoDark: (url: string | null) => void
  setOrgLogoLight: (url: string | null) => void
  setFaviconUrl: (url: string | null) => void
  setAppleIconUrl: (url: string | null) => void
  setLoginLogoUrl: (url: string | null) => void
  setPoweredByFreeframe: (value: boolean) => void
  setPrimaryColor: (color: string | null) => void
  fetchBranding: () => Promise<void>
  syncBranding: (data: InstanceBranding) => void
}

export const HARDCODED_DEFAULTS = {
  orgName: 'FreeFrame',
  orgLogoDark: null,
  orgLogoLight: null,
  faviconUrl: null,
  appleIconUrl: null,
  loginLogoUrl: null,
  poweredByFreeframe: true,
  primaryColor: '#7c3aed',
}

// Logo URLs are presigned S3 links the API signs for an hour. They're persisted so a
// reload doesn't flash the default brand, but a URL older than this would render as a
// broken image, so treat anything past the margin as unusable until the refetch lands.
const LOGO_URL_MAX_AGE_MS = 45 * 60 * 1000

export const useBrandingStore = create<BrandingState>()(
  persist(
    (set, get) => ({
      ...HARDCODED_DEFAULTS,
      brandingFetchedAt: null,
      loaded: false,
      loading: false,

      setOrgName: (name) => set({ orgName: name }),
      setOrgLogoDark: (url) => set({ orgLogoDark: url }),
      setOrgLogoLight: (url) => set({ orgLogoLight: url }),
      setFaviconUrl: (url) => set({ faviconUrl: url }),
      setAppleIconUrl: (url) => set({ appleIconUrl: url }),
      setLoginLogoUrl: (url) => set({ loginLogoUrl: url }),
      setPoweredByFreeframe: (value) => set({ poweredByFreeframe: value }),
      setPrimaryColor: (color) => set({ primaryColor: color }),

      syncBranding: (data: InstanceBranding) => {
        set({
          orgName: data.org_name || HARDCODED_DEFAULTS.orgName,
          orgLogoDark: data.logo_dark_url ?? null,
          orgLogoLight: data.logo_light_url ?? null,
          faviconUrl: data.favicon_url ?? null,
          appleIconUrl: data.apple_icon_url ?? null,
          loginLogoUrl: data.login_logo_url ?? null,
          poweredByFreeframe: data.powered_by_freeframe ?? true,
          primaryColor: data.primary_color ?? HARDCODED_DEFAULTS.primaryColor,
          brandingFetchedAt: Date.now(),
          loaded: true,
          loading: false,
        })
      },

      fetchBranding: async () => {
        try {
          set({ loading: true })
          const res = await fetch(`${API_URL}/instance/branding`)
          if (!res.ok) throw new Error('Failed to fetch branding')
          const data: InstanceBranding = await res.json()
          get().syncBranding(data)
        } catch {
          set({ loaded: true, loading: false })
        }
      },
    }),
    {
      name: 'ff-branding',
      version: 5,
      migrate: () => ({
        ...HARDCODED_DEFAULTS,
        brandingFetchedAt: null,
        loaded: false,
        loading: false,
      }),
      partialize: (state) => ({
        orgName: state.orgName,
        poweredByFreeframe: state.poweredByFreeframe,
        primaryColor: state.primaryColor,
        orgLogoDark: state.orgLogoDark,
        orgLogoLight: state.orgLogoLight,
        faviconUrl: state.faviconUrl,
        appleIconUrl: state.appleIconUrl,
        loginLogoUrl: state.loginLogoUrl,
        brandingFetchedAt: state.brandingFetchedAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const fetchedAt = state.brandingFetchedAt
        if (fetchedAt && Date.now() - fetchedAt < LOGO_URL_MAX_AGE_MS) return
        // Signed too long ago (or from a build that didn't record when) — drop the
        // URLs so the default marks render until fetchBranding() signs fresh ones.
        state.setOrgLogoDark(null)
        state.setOrgLogoLight(null)
        state.setFaviconUrl(null)
        state.setAppleIconUrl(null)
        state.setLoginLogoUrl(null)
      },
    },
  ),
)
