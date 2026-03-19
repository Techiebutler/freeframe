'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  LayoutDashboard,
  FolderOpen,
  Layers,
  Bell,
  Settings,
  ChevronLeft,
  ChevronRight,
  LogOut,
  User,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { Avatar } from '@/components/shared/avatar'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
}

const navItems: NavItem[] = [
  { href: '/', label: 'Home', icon: LayoutDashboard },
  { href: '/assets', label: 'My Assets', icon: FolderOpen },
  { href: '/projects', label: 'Projects', icon: Layers },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/settings', label: 'Settings', icon: Settings },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname()
  const { user, logout } = useAuthStore()

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-30 flex h-screen flex-col bg-bg-secondary border-r border-border transition-all duration-200 ease-in-out',
        collapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Logo / Wordmark */}
      <div
        className={cn(
          'flex h-14 items-center border-b border-border shrink-0 px-3',
          collapsed ? 'justify-center' : 'gap-2',
        )}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-text-inverse font-bold text-sm">
          F
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            FreeFrame
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-1.5 space-y-0.5">
        {navItems.map((item) => {
          const isActive =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors',
                collapsed ? 'justify-center' : '',
                isActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
              title={collapsed ? item.label : undefined}
            >
              {/* Active left border indicator */}
              {isActive && (
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-accent" />
              )}
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          )
        })}
      </nav>

      {/* Bottom: User + Collapse */}
      <div className="border-t border-border p-2 space-y-1 shrink-0">
        {/* User dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors',
                collapsed ? 'justify-center' : '',
              )}
              title={collapsed ? (user?.name ?? 'Account') : undefined}
            >
              <Avatar
                src={user?.avatar_url}
                name={user?.name}
                size="sm"
              />
              {!collapsed && (
                <div className="flex flex-col items-start overflow-hidden">
                  <span className="truncate text-xs font-medium text-text-primary max-w-[140px]">
                    {user?.name ?? 'User'}
                  </span>
                  <span className="truncate text-2xs text-text-tertiary max-w-[140px]">
                    {user?.email ?? ''}
                  </span>
                </div>
              )}
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="top"
              align={collapsed ? 'start' : 'end'}
              sideOffset={6}
              className="z-50 min-w-44 rounded-lg border border-border bg-bg-elevated p-1 shadow-xl animate-slide-up"
            >
              <DropdownMenu.Item asChild>
                <Link
                  href="/settings"
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <User className="h-4 w-4" />
                  Profile
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Item asChild>
                <Link
                  href="/settings"
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border-secondary" />
              <DropdownMenu.Item
                onSelect={logout}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-status-error hover:bg-[oklch(0.35_0.1_25/0.2)] focus:outline-none"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors',
            collapsed ? 'justify-center' : '',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <>
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  )
}
