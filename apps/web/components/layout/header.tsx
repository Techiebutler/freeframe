'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Search, Bell, Upload, Settings, LogOut, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore } from '@/stores/upload-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useBrandingStore } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'
import { Avatar } from '@/components/shared/avatar'
import { useDelayedUnmount } from '@/hooks/use-delayed-unmount'
import { NotificationDrawer } from './notification-drawer'

interface HeaderProps {
  onSearchOpen: () => void
}

const LABEL_MAP: Record<string, string> = {
  projects: 'Projects',
  notifications: 'Notifications',
  settings: 'Settings',
  new: 'New',
  upload: 'Upload',
}

/** Looks like a UUID (8-4-4-4-12 hex) */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/**
 * Route path segments that are structural only and should not appear in the breadcrumb.
 * e.g. /projects/{id}/assets/{assetId} — "assets" is just a route prefix, not a meaningful label.
 */
const SKIP_SEGMENTS = new Set(['assets', 'collections'])

function buildBreadcrumbs(pathname: string, dynamicLabels: Record<string, string>): { label: string; href: string }[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  let path = ''
  for (const segment of segments) {
    path += `/${segment}`
    // Skip structural route segments
    if (SKIP_SEGMENTS.has(segment)) continue
    // Skip UUID segments that don't have a label registered
    if (isUuid(segment) && !dynamicLabels[segment]) continue
    const label =
      dynamicLabels[segment] ??
      LABEL_MAP[segment] ??
      segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ')
    crumbs.push({ label, href: path })
  }

  return crumbs
}

export function Header({ onSearchOpen }: HeaderProps) {
  const pathname = usePathname()
  // Library page renders its own contextual app bar on mobile (spec 1b)
  const isProjectLibrary = /^\/projects\/[^/]+$/.test(pathname ?? '')
  const { labels, extraCrumbs } = useBreadcrumbStore()
  const { user, logout } = useAuthStore()
  const { files: uploadFiles, togglePanel, panelOpen, setPanelOpen } = useUploadStore()
  const { unreadCount, fetchNotifications } = useNotificationStore()
  const { orgName, orgLogoDark, orgLogoLight } = useBrandingStore()
  const { theme, setTheme } = useThemeStore()
  const [notifOpen, setNotifOpen] = React.useState(false)
  // One shared scrim for both header popovers: stays mounted while either is
  // open, so switching between them keeps the dim steady instead of two
  // per-panel scrims cross-fading (which flickered the background).
  const { mounted: scrimMounted, state: scrimState } = useDelayedUnmount(notifOpen || panelOpen)
  const [resolvedTheme, setResolvedTheme] = React.useState<'dark' | 'light'>(
    theme === 'light' ? 'light' : 'dark',
  )

  React.useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme)
      return
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => setResolvedTheme(media.matches ? 'dark' : 'light')
    syncTheme()
    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [theme])

  const isLight = resolvedTheme === 'light'
  const customLogo = isLight
    ? (orgLogoLight ?? orgLogoDark)
    : (orgLogoDark ?? orgLogoLight)

  const activeUploads = uploadFiles.filter(
    (f) => f.status === 'uploading' || f.status === 'pending' || f.status === 'processing',
  ).length

  React.useEffect(() => { fetchNotifications() }, [fetchNotifications])

  const urlCrumbs = buildBreadcrumbs(pathname, labels)
  const breadcrumbs = [...urlCrumbs, ...extraCrumbs.map((c) => ({ label: c.label, href: c.href ?? '' }))]

  return (
    <>
      <header className={cn(
        'sticky top-0 z-20 h-14 items-center justify-between border-b border-border bg-bg-primary/90 backdrop-blur-sm px-4 sm:px-6',
        isProjectLibrary ? 'hidden lg:flex' : 'flex',
      )}>
        {/* Left: logo + breadcrumbs */}
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="flex items-center gap-2 shrink-0" onClick={() => setNotifOpen(false)}>
            {customLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={customLogo}
                alt={orgName}
                className="h-7 w-7 shrink-0 object-contain rounded"
              />
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-accent shrink-0" aria-hidden />
                <span className="font-mono text-[15px] font-bold tracking-[-0.01em] text-text-primary">
                  freeframed
                </span>
              </>
            )}
          </Link>

          <nav className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.18em] min-w-0">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1
              return (
                <React.Fragment key={`${crumb.href}-${index}`}>
                  {index > 0 && (
                    <span className="text-text-tertiary/60 font-mono text-[10px]">/</span>
                  )}
                  {isLast ? (
                    <span className="inline-flex items-center gap-1.5 text-text-primary min-w-0">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" aria-hidden />
                      <span className="truncate max-w-[180px]">{crumb.label}</span>
                    </span>
                  ) : crumb.href ? (
                    <Link
                      href={crumb.href}
                      className="text-text-tertiary hover:text-text-primary transition-colors truncate max-w-[180px]"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="text-text-tertiary truncate max-w-[180px]">{crumb.label}</span>
                  )}
                </React.Fragment>
              )
            })}
          </nav>
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Notifications bell */}
          <button
            onClick={() => { setPanelOpen(false); setNotifOpen((v) => !v) }}
            className={cn(
              'relative flex h-[34px] w-[34px] items-center justify-center rounded border transition-colors',
              notifOpen
                ? 'border-border text-text-primary'
                : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary',
            )}
            title="Notifications"
          >
            <Bell className="h-4 w-4" strokeWidth={notifOpen ? 2 : 1.5} />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 font-dot text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Uploads button */}
          <button
            onClick={() => { setNotifOpen(false); togglePanel() }}
            className={cn(
              'relative hidden lg:flex h-[34px] w-[34px] items-center justify-center rounded border transition-colors',
              panelOpen
                ? 'border-border text-text-primary'
                : 'border-transparent text-text-secondary hover:border-border hover:text-text-primary',
            )}
            title="Uploads"
          >
            <Upload className="h-4 w-4" strokeWidth={panelOpen ? 2 : 1.5} />
            {activeUploads > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-text-primary px-0.5 font-dot text-[9px] font-bold text-bg-primary">
                {activeUploads}
              </span>
            )}
          </button>

          {/* Search trigger */}
          <button
            onClick={onSearchOpen}
            className="hidden lg:flex h-[34px] items-center gap-2 rounded border border-border bg-bg-tertiary px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-tertiary hover:border-border-strong hover:text-text-secondary transition-colors"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden sm:inline-flex items-center rounded-[2px] border border-border-strong bg-transparent px-[5px] py-px font-mono text-[10px] tracking-[0.06em] text-text-tertiary">⌘K</kbd>
          </button>

          <button
            type="button"
            aria-label="Toggle color theme"
            onClick={() => setTheme(isLight ? 'dark' : 'light')}
            className="hidden lg:flex h-[34px] items-center gap-2 rounded border border-border bg-bg-tertiary px-2 sm:px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-text-secondary hover:border-border-strong hover:text-text-primary transition-colors"
          >
            <span className="relative h-3.5 w-[26px] rounded-full border border-border-strong bg-bg-primary" aria-hidden>
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-text-secondary transition-transform duration-200 ease-spring',
                  isLight && 'translate-x-3 bg-accent',
                )}
              />
            </span>
            <span className="hidden sm:inline">{isLight ? 'Light' : 'Dark'}</span>
          </button>

          {/* User dropdown */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                title={user?.name ?? 'Account'}
              >
                <Avatar
                  src={user?.avatar_url}
                  name={user?.name}
                  size="sm"
                  accent
                />
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={8}
                className="z-50 min-w-[180px] rounded border border-border bg-bg-elevated shadow-xl p-1 animate-slide-up"
              >
                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/profile"
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                  >
                    <User className="h-4 w-4" />
                    Profile
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <Link
                    href="/settings/admin"
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                  >
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={logout}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-accent hover:bg-accent-muted focus:outline-none"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {scrimMounted && (
        <div
          data-state={scrimState}
          onClick={() => { setNotifOpen(false); setPanelOpen(false) }}
          className="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/40 duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        />
      )}

      <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
    </>
  )
}
