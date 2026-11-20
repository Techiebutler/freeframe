import { Bell, HardDrive, Palette, Settings, User, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SettingsSection = 'account' | 'instance' | 'projects'

export interface SettingsNavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const ACCOUNT_ITEMS: readonly SettingsNavItem[] = [
  { href: '/settings/profile', label: 'Profile', icon: User },
  { href: '/settings/appearance', label: 'Appearance', icon: Palette },
  { href: '/settings/notifications', label: 'Notifications', icon: Bell },
]

/** The Instance pages, one per `/settings/instance/<key>`. */
export const INSTANCE_SECTIONS = ['users', 'storage', 'settings', 'branding'] as const

export type InstanceSection = (typeof INSTANCE_SECTIONS)[number]

export const INSTANCE_ITEMS: readonly (SettingsNavItem & { key: InstanceSection })[] = [
  { key: 'users', href: '/settings/instance/users', label: 'Users', icon: Users },
  { key: 'storage', href: '/settings/instance/storage', label: 'Storage', icon: HardDrive },
  { key: 'settings', href: '/settings/instance/settings', label: 'Instance settings', icon: Settings },
  { key: 'branding', href: '/settings/instance/branding', label: 'Branding', icon: Palette },
]

export function isInstanceSection(value: string | null | undefined): value is InstanceSection {
  return INSTANCE_SECTIONS.some((s) => s === value)
}

/** Which of the three settings sections a pathname belongs to. */
export function settingsSection(pathname: string | null | undefined): SettingsSection {
  const path = pathname ?? ''
  if (path === '/settings/instance' || path.startsWith('/settings/instance/')) return 'instance'
  if (path === '/settings/projects' || path.startsWith('/settings/projects/')) return 'projects'
  return 'account'
}

// The Admin page used `?tab=instance` for what is now the Instance settings page.
const LEGACY_ADMIN_TABS: Record<string, InstanceSection> = {
  users: 'users',
  storage: 'storage',
  instance: 'settings',
  branding: 'branding',
}

/** Where an old `/settings/admin?tab=<tab>` link lands. Anything unknown opens Users. */
export function instanceHrefForLegacyTab(tab: string | null | undefined): string {
  const section = tab != null && Object.hasOwn(LEGACY_ADMIN_TABS, tab) ? LEGACY_ADMIN_TABS[tab] : 'users'
  return `/settings/instance/${section}`
}
