import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ViewLayout } from './view-store'

/**
 * Cards or rows, per admin panel tab.
 *
 * The same `ViewLayout` the projects page uses, through the same
 * `Segment`-based switch, so there is one grid/list control in the app rather
 * than a second one that drifts. Persisted the way `view-store` persists the
 * folder view: this is per-device chrome, not an account setting, and the panel
 * is a tool one person opens on one machine.
 *
 * Only the two tabs that have both views are in here. Storage stays a list: the
 * question it answers is which project is biggest, which is a column of bars
 * read top to bottom, and it expands into files and versions. Cards would break
 * the comparison and have nowhere to put the tree. External sharing stays a
 * list for the same reason: rights, expiry and who made a link are four short
 * facts that line up in columns and have no picture.
 */
export type AdminViewTab = 'projects' | 'internal'

export const ADMIN_VIEW_STORAGE_KEY = 'freeframe-admin-view'

/**
 * Projects opens as cards, because a poster is how people recognise a project
 * and it is what the projects page shows. Internal sharing opens as a list,
 * because it is read down the role column: who owns what, and who else is in.
 */
export const ADMIN_VIEW_DEFAULTS: Record<AdminViewTab, ViewLayout> = {
  projects: 'grid',
  internal: 'list',
}

interface AdminViewStore {
  layouts: Record<AdminViewTab, ViewLayout>
  setLayout: (tab: AdminViewTab, layout: ViewLayout) => void
}

export const useAdminViewStore = create<AdminViewStore>()(
  persist(
    (set) => ({
      layouts: { ...ADMIN_VIEW_DEFAULTS },

      setLayout: (tab, layout) =>
        set((s) => ({ layouts: { ...s.layouts, [tab]: layout } })),
    }),
    {
      name: ADMIN_VIEW_STORAGE_KEY,
      // A stored value from an older release may be missing a tab that has since
      // gained a grid, so the defaults fill in rather than leaving it undefined.
      merge: (persisted, current) => {
        const saved = (persisted as { layouts?: Partial<Record<AdminViewTab, ViewLayout>> })
          ?.layouts
        const valid = (v: unknown): v is ViewLayout => v === 'grid' || v === 'list'
        return {
          ...current,
          layouts: {
            projects: valid(saved?.projects) ? saved.projects : ADMIN_VIEW_DEFAULTS.projects,
            internal: valid(saved?.internal) ? saved.internal : ADMIN_VIEW_DEFAULTS.internal,
          },
        }
      },
    },
  ),
)
