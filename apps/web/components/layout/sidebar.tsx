'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  Home,
  BookOpen,
  Timer,
  Layers,
  Bell,
  Upload,
  Settings,
  LogOut,
  User,
  ChevronsLeft,
  Bot,
  Eye,
} from 'lucide-react'
import { partsEnabled } from '@/lib/iterations'
import { canManageWorkspace, canManageWorkspaceReally, setViewingAsEditor, viewingAsEditor } from '@/lib/workspace-access'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore } from '@/stores/upload-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useBrandingStore } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'
import { Avatar } from '@/components/shared/avatar'
import { NotificationDrawer } from './notification-drawer'
import { AutoreviewNav } from './autoreview-nav'
import useSWR from 'swr'
import { api } from '@/lib/api'
import { StorageUsage, StorageRing } from '@/components/shared/storage-usage'
import type { InstanceSettings, Project } from '@/types'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
}

// Platform v2 order (serial position): what came back, what is checked, what it saved, then the
// raw projects underneath.
const ownerNavItems: NavItem[] = [
  { href: '/home', label: 'Overview', icon: Home },
  { href: '/rules', label: 'Brand rules', icon: BookOpen },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/insights', label: 'Time saved', icon: Timer },
  { href: '/projects', label: 'Projects', icon: Layers },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname()
  const { user, logout, isSuperAdmin } = useAuthStore()
  const { data: projects } = useSWR<Project[]>('/projects', () => api.get<Project[]>('/projects'))
  const manager = canManageWorkspace(user, projects)
  // Offered only to someone who really runs a workspace; while on, it says how to go back.
  const asEditor = viewingAsEditor()
  const canSwitchView = asEditor || canManageWorkspaceReally(user, projects)
  const navItems: NavItem[] = manager ? [...ownerNavItems, ...(partsEnabled ? [{ href: '/parts', label: 'Reusable parts', icon: Layers }] : [])] : [
    { href: '/handin', label: 'Hand in', icon: Upload },
    { href: '/home', label: 'Submissions', icon: Home },
    { href: '/projects', label: 'Projects', icon: Layers },
  ]
  const { files: uploadFiles, togglePanel, panelOpen } = useUploadStore()
  const { unreadCount, fetchNotifications } = useNotificationStore()
  const { orgName, orgLogoDark, orgLogoLight } = useBrandingStore()
  const { theme } = useThemeStore()
  // Pick logo based on resolved theme; fall back to the other if only one is set
  const customLogo = theme === 'light'
    ? (orgLogoLight ?? orgLogoDark)
    : (orgLogoDark ?? orgLogoLight)
  const [notifOpen, setNotifOpen] = React.useState(false)
  const activeUploads = uploadFiles.filter((f) => f.status === 'uploading' || f.status === 'pending' || f.status === 'processing').length
  const { data: instance } = useSWR<InstanceSettings>(
    '/instance/settings',
    () => api.get<InstanceSettings>('/instance/settings'),
  )

  // Fetch notifications on mount
  React.useEffect(() => { fetchNotifications() }, [fetchNotifications])

  return (
    <>
    <aside
      className={cn(
        'fixed left-0 top-0 z-30 hidden h-screen flex-col border-r border-border md:flex',
        'bg-bg-secondary transition-[width] duration-200 overflow-hidden',
        collapsed ? 'w-[72px]' : 'w-[220px]',
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-16 items-center shrink-0 border-b border-border',
          collapsed ? 'justify-center px-0' : 'px-4 gap-2.5',
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={customLogo || '/autoreview-icon.png'} alt={orgName} className="h-8 w-8 shrink-0 rounded-lg object-contain" />
        {!collapsed && (
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            {orgName}
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-5 px-3 space-y-2">
        {navItems.map((item) => {
          const isActive =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setNotifOpen(false)}
              className={cn(
                'group relative flex items-center rounded-md transition-colors duration-100',
                collapsed ? 'justify-center h-11 w-11 mx-auto' : 'gap-3 px-3 h-11',
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

        <AutoreviewNav collapsed={collapsed} />

        {/* Notifications button */}
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            collapsed ? 'justify-center h-11 w-11 mx-auto' : 'gap-3 px-3 h-11',
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
            collapsed ? 'justify-center h-11 w-11 mx-auto' : 'gap-3 px-3 h-11',
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
        {/* Instance storage indicator — ring when collapsed, used/limit bar when expanded */}
        {instance && manager && (
          <div className={cn(collapsed ? 'flex justify-center py-1' : 'px-2.5 py-1.5')}>
            {collapsed ? (
              <StorageRing
                used={instance.storage_used_bytes}
                limit={instance.storage_limit_bytes}
              />
            ) : (
              <StorageUsage
                used={instance.storage_used_bytes}
                limit={instance.storage_limit_bytes}
                variant="sidebar"
              />
            )}
          </div>
        )}
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
                  href={isSuperAdmin ? '/settings/admin' : '/settings/appearance'}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <Settings className="h-4 w-4" />
                  Settings
                </Link>
              </DropdownMenu.Item>
              {canSwitchView && (
                <DropdownMenu.Item
                  onSelect={() => setViewingAsEditor(!asEditor)}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:outline-none"
                >
                  <Eye className="h-4 w-4" />
                  {asEditor ? 'Back to owner view' : 'View as editor'}
                </DropdownMenu.Item>
              )}
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

        <div className={cn('flex items-center gap-1.5 py-2 text-[10px] text-text-tertiary', collapsed ? 'justify-center' : 'px-2.5')} title="By Aditor">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/aditor-logo.png" alt="Aditor" className="h-4 w-4 object-contain opacity-70" />
          {!collapsed && <span>by Aditor</span>}
        </div>
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

    <nav aria-label="Main navigation" className="fixed inset-x-0 bottom-0 z-40 grid auto-cols-fr grid-flow-col border-t border-border bg-bg-secondary pb-[env(safe-area-inset-bottom)] md:hidden">
      {navItems.map(item => <Link key={item.href} href={item.href} aria-current={pathname.startsWith(item.href) ? 'page' : undefined} className={cn('flex min-h-[72px] flex-col items-center justify-center gap-1 text-[11px]', pathname.startsWith(item.href) ? 'font-semibold text-accent' : 'text-text-secondary')}><item.icon size={20} /><span>{item.label}</span></Link>)}
    </nav>
    {/* Notification Drawer */}
    <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
  </>
  )
}
