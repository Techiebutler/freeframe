/**
 * Fixture builders for the admin panel tests.
 *
 * Shared because the storage tab and the other three tabs read the same shapes;
 * two copies of these drifted apart once already. The `vi.mock` of the API
 * client stays in each test file, since it has to be hoisted there.
 */
import type {
  AdminProjectRow,
  ExternalShareRow,
  InternalShareRow,
  StorageOverview,
  StorageProjectFiles,
  TrashOverview,
} from '@/types'

export const MB = 1024 * 1024
export const GB = 1024 * MB
export const HOUR_AGO = new Date(Date.now() - 3600_000).toISOString()
export const IN_A_WEEK = new Date(Date.now() + 7 * 86_400_000).toISOString()

export function summary(
  partial: Partial<StorageOverview['summary']> = {},
): StorageOverview['summary'] {
  return {
    used_bytes: 400 * MB,
    capacity_bytes: null,
    free_bytes: null,
    unmeasured_files: 0,
    trash_bytes: 0,
    retention_days: 30,
    ...partial,
  }
}

export function overview(partial: Partial<StorageOverview> = {}): StorageOverview {
  return {
    summary: summary(),
    project_count: 2,
    limit: 200,
    projects: [
      { project_id: 'p-big', name: 'Big Campaign', total_bytes: 320 * MB },
      { project_id: 'p-small', name: 'Small Teaser', total_bytes: 80 * MB },
    ],
    ...partial,
  }
}

export function files(): StorageProjectFiles {
  return {
    project_id: 'p-big',
    name: 'Big Campaign',
    assets: [
      {
        asset_id: 'a-1', name: 'Hero Cut.mov', total_bytes: 300 * MB,
        versions: [
          { version_id: 'v-3', version_number: 3, total_bytes: 150 * MB, is_latest: true },
          { version_id: 'v-2', version_number: 2, total_bytes: 100 * MB, is_latest: false },
          { version_id: 'v-1', version_number: 1, total_bytes: 50 * MB, is_latest: false },
        ],
      },
    ],
  }
}

export function trash(partial: Partial<TrashOverview> = {}): TrashOverview {
  return { retention_days: 30, total_bytes: 0, projects: [], assets: [], versions: [], ...partial }
}

/**
 * A trash holding one root project, one asset blocked by it, one asset whose
 * project is live and one version of a live file, which is every case a row
 * can be in.
 */
export const FULL_BIN = trash({
  total_bytes: 2.5 * GB,
  projects: [
    { project_id: 'p-gone', name: 'Last Year Reel', deleted_at: null, days_left: 28, total_bytes: 1.5 * GB },
  ],
  assets: [
    { asset_id: 'a-stuck', name: 'Stuck.mov', project_id: 'p-gone',
      project_name: 'Last Year Reel', deleted_at: null, days_left: 28,
      blocked_by_project: true, total_bytes: null },
    { asset_id: 'a-gone', name: 'Old Master.mov', project_id: 'p-big',
      project_name: 'Big Campaign', deleted_at: null, days_left: 12,
      blocked_by_project: false, total_bytes: 0.5 * GB },
  ],
  versions: [
    { version_id: 'v-gone', version_number: 2, asset_id: 'a-1',
      asset_name: 'Hero Cut.mov', project_id: 'p-big', project_name: 'Big Campaign',
      deleted_at: null, days_left: 30, blocked_by_parent: false, total_bytes: 0.5 * GB },
  ],
})

export const PROJECTS: AdminProjectRow[] = [
  { project_id: 'p-1', name: 'Sportbrand Campaign Autumn Winter Launch Film Director Cut',
    poster_url: 'https://example.invalid/poster.jpg',
    member_count: 5, total_bytes: 250 * GB, last_activity_at: HOUR_AGO },
  { project_id: 'p-2', name: 'Archive 2024', poster_url: null,
    member_count: 1, total_bytes: 2 * GB, last_activity_at: null },
]

export const INTERNAL: InternalShareRow[] = [
  {
    project_id: 'p-1', project_name: 'Sportbrand Campaign', has_live_people: true,
    people: [
      { user_id: 'u-1', name: 'Olive Owner', email: 'olive@example.com',
        avatar_url: null, avatar_color: '#ff8800', role: 'owner' },
      { user_id: 'u-2', name: 'Sam Editor', email: 'sam@example.com',
        avatar_url: null, avatar_color: null, role: 'editor' },
    ],
  },
  { project_id: 'p-2', project_name: 'Orphaned Project', has_live_people: false, people: [] },
]

export const EXTERNAL: ExternalShareRow[] = [
  { token: 'tok-download', kind: 'asset', what: 'Hero 4K Master', title: null,
    permission: 'view', allow_download: true, has_password: false,
    expires_at: null, created_by_name: 'Sam Example', created_at: HOUR_AGO },
  { token: 'tok-plain', kind: 'project', what: 'Sportbrand Campaign', title: null,
    permission: 'comment', allow_download: false, has_password: true,
    expires_at: IN_A_WEEK, created_by_name: 'Alex Example', created_at: HOUR_AGO },
]

