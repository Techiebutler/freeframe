'use client'

import * as React from 'react'
import {
  Bell,
  AtSign,
  UserCheck,
  MessageSquare,
  CheckCircle,
  X,
  Settings,
} from 'lucide-react'
import Link from 'next/link'
import { useNotificationStore } from '@/stores/notification-store'
import { formatRelativeTime } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { Notification, NotificationType } from '@/types'

const notificationIcons: Record<NotificationType, React.ElementType> = {
  mention: AtSign,
  assignment: UserCheck,
  due_soon: UserCheck,
  comment: MessageSquare,
  approval: CheckCircle,
}

function getNotificationText(n: Notification): { title: string; subtitle: string | null } {
  const actor = n.actor_name || 'Someone'
  const asset = n.asset_name || 'an asset'
  switch (n.type) {
    case 'mention':
      return { title: `${actor} mentioned you on ${asset}`, subtitle: n.comment_preview || null }
    case 'comment':
      return { title: `${actor} commented on ${asset}`, subtitle: n.comment_preview || null }
    case 'assignment':
      return { title: `${actor} assigned you to ${asset}`, subtitle: null }
    case 'approval':
      return { title: `${actor} updated approval on ${asset}`, subtitle: null }
    case 'due_soon':
      return { title: `${asset} is due soon`, subtitle: null }
    default:
      return { title: 'New notification', subtitle: null }
  }
}

function NotificationItem({ notification, onClose }: { notification: Notification; onClose: () => void }) {
  const { markAsRead } = useNotificationStore()
  const Icon = notificationIcons[notification.type]
  const { title, subtitle } = getNotificationText(notification)

  function handleClick() {
    if (!notification.read) markAsRead(notification.id)
    // Navigate to asset if possible
    if (notification.project_id && notification.asset_id) {
      const qs = notification.comment_id ? `?commentId=${notification.comment_id}` : ''
      window.location.href = `/projects/${notification.project_id}/assets/${notification.asset_id}${qs}`
      onClose()
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg-hover',
        !notification.read && 'bg-bg-secondary',
      )}
    >
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full mt-0.5',
          notification.type === 'mention' && 'bg-accent-muted text-text-primary',
          notification.type === 'approval' && 'bg-status-success/15 text-status-success',
          notification.type === 'comment' && 'bg-bg-tertiary text-text-secondary',
          (notification.type === 'assignment' || notification.type === 'due_soon') &&
            'bg-status-warning/15 text-status-warning',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <p className="text-sm text-text-primary font-medium">{title}</p>
        {subtitle && (
          <p className="text-xs text-text-secondary line-clamp-2">{subtitle}</p>
        )}
        <p className="text-2xs text-text-tertiary mt-0.5">{formatRelativeTime(notification.created_at)}</p>
      </div>
      {!notification.read && (
        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" />
      )}
    </button>
  )
}

interface NotificationDrawerProps {
  open: boolean
  onClose: () => void
}

export function NotificationDrawer({ open, onClose }: NotificationDrawerProps) {
  const { notifications, isLoading, fetchNotifications, markAllRead, unreadCount } =
    useNotificationStore()
  const [tab, setTab] = React.useState<'all' | 'unread'>('all')

  React.useEffect(() => {
    if (open) fetchNotifications()
  }, [open, fetchNotifications])

  const filtered = tab === 'unread' ? notifications.filter((n) => !n.read) : notifications

  if (!open) return null

  return (
    <>
      {/* Backdrop — offset to not cover sidebar */}
      <div className="fixed top-0 right-0 bottom-0 left-[52px] z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed left-[52px] top-0 z-50 h-full w-[380px] border-r border-border bg-bg-primary shadow-2xl flex flex-col animate-in slide-in-from-left-2 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <span className="text-sm font-semibold text-text-primary">Notifications</span>
          <div className="flex items-center gap-1">
            <Link
              href="/settings/notifications"
              onClick={onClose}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Notification settings"
            >
              <Settings className="h-4 w-4" />
            </Link>
            <button
              onClick={onClose}
              className="flex items-center justify-center h-7 w-7 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tabs + Mark all read */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setTab('all')}
              className={cn(
                'text-sm font-medium transition-colors',
                tab === 'all' ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              All
            </button>
            <button
              onClick={() => setTab('unread')}
              className={cn(
                'text-sm font-medium transition-colors',
                tab === 'unread' ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              Unread
            </button>
          </div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              Mark all as read
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-1 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-bg-secondary" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="h-14 w-14 rounded-full bg-bg-tertiary flex items-center justify-center mb-3">
                <Bell className="h-7 w-7 text-text-tertiary" />
              </div>
              <p className="text-sm font-medium text-text-primary">No Updates Yet</p>
              <p className="text-xs text-text-tertiary mt-1">New activity on your account will show here.</p>
            </div>
          ) : (
            <div className="p-1 space-y-0.5">
              {filtered.map((notification) => (
                <NotificationItem key={notification.id} notification={notification} onClose={onClose} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
