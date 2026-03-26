import { create } from 'zustand'

interface Crumb {
  label: string
  href?: string
}

interface BreadcrumbStore {
  /** Map of path segments (e.g. UUID) → display label */
  labels: Record<string, string>
  /** Extra crumbs injected after the URL-based crumbs (e.g. folder path) */
  extraCrumbs: Crumb[]
  setLabel: (segment: string, label: string) => void
  setExtraCrumbs: (crumbs: Crumb[]) => void
  clearLabels: () => void
}

export const useBreadcrumbStore = create<BreadcrumbStore>((set) => ({
  labels: {},
  extraCrumbs: [],
  setLabel: (segment, label) =>
    set((s) => ({ labels: { ...s.labels, [segment]: label } })),
  setExtraCrumbs: (extraCrumbs) => set({ extraCrumbs }),
  clearLabels: () => set({ labels: {}, extraCrumbs: [] }),
}))
