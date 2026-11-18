'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { SettingsProjectList } from '@/components/settings/project-list'
import {
  ACCOUNT_ITEMS,
  INSTANCE_ITEMS,
  settingsSection,
  type SettingsNavItem,
  type SettingsSection,
} from '@/lib/settings-nav'

const SECTION_LABELS: Record<SettingsSection, string> = {
  account: 'Account',
  instance: 'Instance',
  projects: 'Projects',
}

/**
 * Settings: three sections (Account, Instance, Projects) in a row of tabs, a
 * left rail for the one that is open, and the page beside it. The app sidebar
 * and header are not drawn here (see `(dashboard)/layout.tsx`), so this is the
 * whole screen.
 *
 * The layout must not read `useSearchParams`: the redirect pages under it are
 * static routes, and a search-params read without a Suspense boundary fails
 * the production build.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const params = useParams<{ id?: string }>()
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin)

  const section = settingsSection(pathname)
  const sections: { key: SettingsSection; href: string }[] = [
    { key: 'account', href: '/settings/profile' },
    ...(isSuperAdmin ? [{ key: 'instance' as const, href: '/settings/instance/users' }] : []),
    { key: 'projects', href: '/settings/projects' },
  ]

  // On a phone the project list is the page until a project is picked; from
  // `md` the rail and the page sit side by side. One list instance serves both.
  const listOnly = section === 'projects' && !params.id

  let rail: React.ReactNode = null
  let railClass = 'border-b md:border-b-0'
  if (section === 'projects') {
    rail = <SettingsProjectList selectedId={params.id} />
    railClass = listOnly ? 'min-h-0 flex-1 overflow-y-auto md:flex-none' : 'hidden md:block'
  } else if (section === 'account') {
    rail = <RailNav label="Account" items={ACCOUNT_ITEMS} pathname={pathname} />
  } else if (isSuperAdmin) {
    rail = <RailNav label="Instance" items={INSTANCE_ITEMS} pathname={pathname} />
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-1 px-4 pt-4 sm:px-6">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to projects
        </Link>
        <p className="text-xl font-semibold text-text-primary">Settings</p>
      </div>

      <nav
        aria-label="Settings sections"
        className="flex shrink-0 overflow-x-auto border-b border-border px-4 sm:px-6 [scrollbar-width:none]"
      >
        {sections.map(({ key, href }) => (
          <Link
            key={key}
            href={href}
            aria-current={key === section ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 -mb-px px-3 py-2 text-sm transition-colors',
              'border-transparent text-text-secondary hover:text-text-primary',
              'aria-[current=page]:border-accent aria-[current=page]:text-text-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            )}
          >
            {SECTION_LABELS[key]}
          </Link>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {rail && (
          <aside
            className={cn(
              'shrink-0 border-border bg-bg-secondary md:w-64 md:border-r md:overflow-y-auto',
              railClass,
            )}
          >
            {rail}
          </aside>
        )}
        <main className={cn('min-w-0 flex-1 overflow-y-auto', listOnly && 'hidden md:block')}>
          {children}
        </main>
      </div>
    </div>
  )
}

/** The rail of Account and Instance: a column from `md`, one scrolling strip on a phone. */
function RailNav({
  label,
  items,
  pathname,
}: {
  label: string
  items: readonly SettingsNavItem[]
  pathname: string | null
}) {
  return (
    <nav
      aria-label={label}
      className="flex gap-0.5 overflow-x-auto p-2 [scrollbar-width:none] md:flex-col md:overflow-x-visible"
    >
      {items.map((item) => {
        const isActive = pathname === item.href || !!pathname?.startsWith(item.href + '/')
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors',
              isActive
                ? 'bg-bg-hover text-text-primary font-medium'
                : 'text-text-secondary hover:bg-bg-hover/70 hover:text-text-primary',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
