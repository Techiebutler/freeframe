'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Bell, Search } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useNotificationStore } from '@/stores/notification-store'

interface HeaderProps {
  onSearchOpen: () => void
}

function buildBreadcrumbs(pathname: string): { label: string; href: string }[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = [
    { label: 'Home', href: '/' },
  ]

  const labelMap: Record<string, string> = {
    assets: 'My Assets',
    projects: 'Projects',
    notifications: 'Notifications',
    settings: 'Settings',
    new: 'New',
    upload: 'Upload',
  }

  let path = ''
  for (const segment of segments) {
    path += `/${segment}`
    const label =
      labelMap[segment] ??
      segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ')
    crumbs.push({ label, href: path })
  }

  return crumbs
}

export function Header({ onSearchOpen }: HeaderProps) {
  const pathname = usePathname()
  const { unreadCount } = useNotificationStore()
  const breadcrumbs = buildBreadcrumbs(pathname)

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-bg-primary/80 backdrop-blur-md px-4">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-sm">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1
          return (
            <React.Fragment key={crumb.href}>
              {index > 0 && (
                <span className="text-text-tertiary">/</span>
              )}
              {isLast ? (
                <span className="font-medium text-text-primary">{crumb.label}</span>
              ) : (
                <Link
                  href={crumb.href}
                  className="text-text-secondary hover:text-text-primary transition-colors"
                >
                  {crumb.label}
                </Link>
              )}
            </React.Fragment>
          )
        })}
      </nav>

      {/* Right side actions */}
      <div className="flex items-center gap-2">
        {/* Search trigger */}
        <button
          onClick={onSearchOpen}
          className="flex items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-1.5 text-xs text-text-tertiary hover:border-border-focus hover:text-text-secondary transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border px-1 py-0.5 font-mono text-2xs">
            <span>⌘</span>K
          </kbd>
        </button>

        {/* Notification bell */}
        <Link
          href="/notifications"
          className={cn(
            'relative flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors',
          )}
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-bold text-text-inverse">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Link>
      </div>
    </header>
  )
}
