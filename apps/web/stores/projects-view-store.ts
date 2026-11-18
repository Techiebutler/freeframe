import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
import { useAuthStore } from './auth-store'
import { naturalSortDirection, type ViewLayout, type CardSize, type SortDirection } from './view-store'

/** Projects only have a name and a creation date to sort by. */
export type ProjectSortKey = 'date' | 'name'

/**
 * Projects page appearance. Saved to the user's account
 * (`preferences.projects_view`) so it follows them across devices;
 * localStorage only caches it so the page renders the right layout
 * before the user has loaded.
 *
 * The cache is not read when the store is created: the server renders the
 * defaults, so reading it then would make the first client render disagree
 * with the server's HTML. `useProjectsViewReady` reads it once mounted.
 */
interface ProjectsViewSettings {
  layout: ViewLayout
  cardSize: CardSize
  showCardInfo: boolean
  sortKey: ProjectSortKey
  sortDirection: SortDirection
}

interface ProjectsViewStore extends ProjectsViewSettings {
  setLayout: (layout: ViewLayout) => void
  setCardSize: (size: CardSize) => void
  setShowCardInfo: (show: boolean) => void
  setSortKey: (key: ProjectSortKey) => void
  toggleSortDirection: () => void
  /** Apply the account's saved value, if it has a valid one. */
  syncFromServer: (preferences: Record<string, unknown>) => void
}

export const PROJECTS_VIEW_STORAGE_KEY = 'freeframe-projects-view'

const LAYOUTS: ViewLayout[] = ['grid', 'list']
const CARD_SIZES: CardSize[] = ['S', 'M', 'L']
const SORT_KEYS: ProjectSortKey[] = ['date', 'name']
const SORT_DIRECTIONS: SortDirection[] = ['asc', 'desc']
const DEFAULTS: ProjectsViewSettings = {
  layout: 'grid',
  cardSize: 'M',
  showCardInfo: true,
  sortKey: 'date',
  sortDirection: 'desc',
}

type ProjectsViewPreference = {
  layout: ViewLayout
  card_size: CardSize
  show_card_info: boolean
  sort_key: ProjectSortKey
  sort_direction: SortDirection
}

// One PATCH at a time. The endpoint reads, merges and writes the whole
// preferences document without a lock, so two in flight can land out of order
// and store the older value. While one is out, only the latest change waits;
// it goes when the first settles.
let saving = false
let queued: ProjectsViewPreference | null = null

function sendToAccount(projects_view: ProjectsViewPreference) {
  if (saving) {
    queued = projects_view
    return
  }
  saving = true
  api.patch('/auth/me/preferences', { projects_view })
    .catch(() => {})
    .finally(() => {
      saving = false
      const next = queued
      queued = null
      if (next) sendToAccount(next)
    })
}

function saveToAccount({ layout, cardSize, showCardInfo, sortKey, sortDirection }: ProjectsViewSettings) {
  const projects_view: ProjectsViewPreference = {
    layout,
    card_size: cardSize,
    show_card_info: showCardInfo,
    sort_key: sortKey,
    sort_direction: sortDirection,
  }
  // Update the cached user first, so remounting the page re-syncs this value
  // rather than a stale one, whatever order the PATCH responses arrive in.
  const { user, setUser } = useAuthStore.getState()
  if (!user) return
  setUser({ ...user, preferences: { ...user.preferences, projects_view } })
  sendToAccount(projects_view)
}

export const useProjectsViewStore = create<ProjectsViewStore>()(
  persist(
    (set, get) => {
      const update = (patch: Partial<ProjectsViewSettings>) => {
        set(patch)
        saveToAccount(get())
      }

      return {
        ...DEFAULTS,

        setLayout: (layout) => update({ layout }),
        setCardSize: (cardSize) => update({ cardSize }),
        setShowCardInfo: (showCardInfo) => update({ showCardInfo }),
        setSortKey: (sortKey) => update({ sortKey, sortDirection: naturalSortDirection(sortKey) }),
        toggleSortDirection: () =>
          update({ sortDirection: get().sortDirection === 'asc' ? 'desc' : 'asc' }),

        syncFromServer: (preferences) => {
          const saved = preferences?.projects_view as
            | {
                layout?: unknown
                card_size?: unknown
                show_card_info?: unknown
                sort_key?: unknown
                sort_direction?: unknown
              }
            | undefined
          if (
            LAYOUTS.includes(saved?.layout as ViewLayout) &&
            CARD_SIZES.includes(saved?.card_size as CardSize)
          ) {
            set({
              layout: saved!.layout as ViewLayout,
              cardSize: saved!.card_size as CardSize,
              // Fields saved before these options existed fall back to the defaults.
              showCardInfo: saved!.show_card_info !== false,
              sortKey: SORT_KEYS.includes(saved!.sort_key as ProjectSortKey)
                ? (saved!.sort_key as ProjectSortKey)
                : DEFAULTS.sortKey,
              sortDirection: SORT_DIRECTIONS.includes(saved!.sort_direction as SortDirection)
                ? (saved!.sort_direction as SortDirection)
                : DEFAULTS.sortDirection,
            })
          } else {
            // Nothing saved on this account: don't keep another user's cached choice.
            set(DEFAULTS)
          }
        },
      }
    },
    {
      name: PROJECTS_VIEW_STORAGE_KEY,
      skipHydration: true,
      partialize: (s) => ({
        layout: s.layout,
        cardSize: s.cardSize,
        showCardInfo: s.showCardInfo,
        sortKey: s.sortKey,
        sortDirection: s.sortDirection,
      }),
    },
  ),
)
