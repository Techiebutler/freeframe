'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Bell, Search, ChevronRight } from 'lucide-react'
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
    <header className="sticky top-0 z-20 flex h-11 items-center justify-between border-b border-border bg-bg-primary/90 backdrop-blur-sm px-4">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-[13px]">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1
          return (
            <React.Fragment key={crumb.href}>
              {index > 0 && (
                <ChevronRight className="h-3 w-3 text-text-tertiary" />
              )}
              {isLast ? (
                <span className="font-medium text-text-primary">{crumb.label}</span>
              ) : (
                <Link
                  href={crumb.href}
                  className="text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  {crumb.label}
                </Link>
              )}
            </React.Fragment>
          )
        })}
      </nav>

      {/* Right side actions */}
      <div className="flex items-center gap-1.5">
        {/* Search trigger */}
        <button
          onClick={onSearchOpen}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary/60 px-2.5 py-1 text-xs text-text-tertiary hover:border-border-focus hover:text-text-secondary transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-bg-tertiary/50 px-1 py-0.5 font-mono text-[10px] text-text-tertiary">
            <span>⌘</span>K
          </kbd>
        </button>

        {/* Notification bell */}
        <Link
          href="/notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Link>
      </div>
    </header>
  )
}
