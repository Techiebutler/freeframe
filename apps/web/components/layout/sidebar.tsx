'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Layers,
  Bell,
  Upload,
  Settings,
  LogOut,
  User,
  ChevronsLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore } from '@/stores/upload-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useBrandingStore } from '@/stores/branding-store'
import { Avatar } from '@/components/shared/avatar'
import { NotificationDrawer } from './notification-drawer'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
}

const navItems: NavItem[] = [
  { href: '/projects', label: 'Projects', icon: Layers },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname()
  const { user, logout } = useAuthStore()
  const { files: uploadFiles, togglePanel, panelOpen } = useUploadStore()
  const { unreadCount, fetchNotifications } = useNotificationStore()
  const { orgName, orgLogoUrl } = useBrandingStore()
  const [notifOpen, setNotifOpen] = React.useState(false)
  const activeUploads = uploadFiles.filter((f) => f.status === 'uploading' || f.status === 'pending' || f.status === 'processing').length

  // Fetch notifications on mount
  React.useEffect(() => { fetchNotifications() }, [fetchNotifications])

  return (
    <>
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
        {/* Logo: custom if set, otherwise default FreeFrame icons */}
        {orgLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={orgLogoUrl}
            alt={orgName}
            className="h-7 w-7 shrink-0 object-contain rounded"
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-dark"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon-dark.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-light"
            />
          </>
        )}
        {!collapsed && (
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            {orgName}
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
              onClick={() => setNotifOpen(false)}
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

        {/* Notifications button */}
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            collapsed ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
            notifOpen
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
          )}
          title={collapsed ? 'Notifications' : undefined}
        >
          <div className="relative shrink-0">
            <Bell className="h-[18px] w-[18px]" strokeWidth={notifOpen ? 2 : 1.5} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-error px-0.5 text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </div>
          {!collapsed && (
            <span className={cn('text-[13px]', notifOpen && 'font-medium')}>
              Notifications
            </span>
          )}
        </button>

        {/* Uploads button */}
        <button
          onClick={() => { setNotifOpen(false); togglePanel() }}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            collapsed ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9',
            panelOpen
              ? 'bg-bg-hover text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary',
          )}
          title={collapsed ? 'Uploads' : undefined}
        >
          <div className="relative shrink-0">
            <Upload className="h-[18px] w-[18px]" strokeWidth={panelOpen ? 2 : 1.5} />
            {activeUploads > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold text-white">
                {activeUploads}
              </span>
            )}
          </div>
          {!collapsed && (
            <span className={cn('text-[13px]', panelOpen && 'font-medium')}>
              Uploads
            </span>
          )}
        </button>
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

    {/* Notification Drawer */}
    <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
  </>
  )
}
