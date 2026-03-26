import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface BrandingState {
  orgName: string
  orgLogoUrl: string | null
  setOrgName: (name: string) => void
  setOrgLogoUrl: (url: string | null) => void
}

export const useBrandingStore = create<BrandingState>()(
  persist(
    (set) => ({
      orgName: 'FreeFrame',
      orgLogoUrl: null,
      setOrgName: (name) => set({ orgName: name }),
      setOrgLogoUrl: (url) => set({ orgLogoUrl: url }),
    }),
    { name: 'ff-branding' },
  ),
)
