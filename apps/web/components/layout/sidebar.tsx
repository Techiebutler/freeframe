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
  LogOut,
  User,
  ChevronsLeft,
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
        'fixed left-0 top-0 z-30 flex h-screen flex-col border-r border-border',
        'bg-bg-secondary transition-[width] duration-200',
        collapsed ? 'w-[52px]' : 'w-[220px]',
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-12 items-center shrink-0 border-b border-border',
          collapsed ? 'justify-center px-0' : 'px-4 gap-2.5',
        )}
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-white">
            <path d="M3 3h4v4H3V3zm6 0h4v4H9V3zm-6 6h4v4H3V9zm6 2a2 2 0 104 0 2 2 0 00-4 0z" fill="currentColor" />
          </svg>
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            FreeFrame
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group relative flex items-center rounded-md transition-colors duration-100',
                collapsed ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
                isActive
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.5} />
              {!collapsed && (
                <span className={cn('text-[13px]', isActive && 'font-medium')}>
                  {item.label}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border p-2 space-y-1 shrink-0">
        {/* User dropdown */}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              className={cn(
                'flex w-full items-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors',
                collapsed ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2 py-1.5',
              )}
              title={collapsed ? (user?.name ?? 'Account') : undefined}
            >
              <Avatar
                src={user?.avatar_url}
                name={user?.name}
                size="sm"
              />
              {!collapsed && (
                <div className="flex flex-col items-start overflow-hidden min-w-0">
                  <span className="truncate text-[13px] font-medium text-text-primary leading-tight w-full text-left">
                    {user?.name ?? 'User'}
                  </span>
                  <span className="truncate text-[10px] text-text-tertiary leading-tight w-full text-left">
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
              sideOffset={8}
              className="z-50 min-w-[180px] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl animate-slide-up"
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
                  href="/settings"
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                onSelect={logout}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-status-error hover:bg-status-error/10 focus:outline-none"
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
            'flex w-full items-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-secondary transition-colors',
            collapsed ? 'justify-center h-8 w-8 mx-auto' : 'gap-2 px-2.5 h-8',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>
  )
}
