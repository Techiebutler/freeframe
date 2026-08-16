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
  resetAll: () => void
  fetchBranding: () => Promise<void>
  syncBranding: (data: InstanceBranding) => void
}

const HARDCODED_DEFAULTS = {
  orgName: 'FreeFrame',
  orgLogoDark: null,
  orgLogoLight: null,
  faviconUrl: null,
  appleIconUrl: null,
  loginLogoUrl: null,
  poweredByFreeframe: true,
  primaryColor: '#7c3aed',
}

export const useBrandingStore = create<BrandingState>()(
  persist(
    (set, get) => ({
      ...HARDCODED_DEFAULTS,
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

      resetAll: () =>
        set({
          ...HARDCODED_DEFAULTS,
          loaded: true,
          loading: false,
        }),
    }),
    {
      name: 'ff-branding',
      version: 4,
      migrate: () => ({
        ...HARDCODED_DEFAULTS,
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
      }),
    },
  ),
)
