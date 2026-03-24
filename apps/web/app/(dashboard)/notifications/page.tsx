'use client'

import * as React from 'react'
import {
  Bell,
  AtSign,
  UserCheck,
  MessageSquare,
  CheckCircle,
} from 'lucide-react'
import { useNotificationStore } from '@/stores/notification-store'
import { usePageTitle } from '@/hooks/use-page-title'
import { formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/empty-state'
import { cn } from '@/lib/utils'
import type { Notification, NotificationType } from '@/types'

const notificationIcons: Record<NotificationType, React.ElementType> = {
  mention: AtSign,
  assignment: UserCheck,
  due_soon: UserCheck,
  comment: MessageSquare,
  approval: CheckCircle,
}

const notificationLabels: Record<NotificationType, string> = {
  mention: 'mentioned you',
  assignment: 'assigned you to an asset',
  due_soon: 'asset due soon',
  comment: 'commented on an asset',
  approval: 'updated approval status',
}

function NotificationItem({ notification }: { notification: Notification }) {
  const { markAsRead } = useNotificationStore()
  const Icon = notificationIcons[notification.type]

  return (
    <button
      onClick={() => !notification.read && markAsRead(notification.id)}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-bg-hover',
        !notification.read && 'bg-bg-secondary',
      )}
    >
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          notification.type === 'mention' && 'bg-accent-muted text-accent',
          notification.type === 'approval' && 'bg-status-success/15 text-status-success',
          notification.type === 'comment' && 'bg-bg-tertiary text-text-secondary',
          (notification.type === 'assignment' || notification.type === 'due_soon') &&
            'bg-status-warning/15 text-status-warning',
        )}
      >
        <Icon className="h-4 w-4" />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <p className="text-sm text-text-primary">
          {notificationLabels[notification.type]}
        </p>
        <p className="text-xs text-text-tertiary">
          {formatRelativeTime(notification.created_at)}
        </p>
      </div>

      {!notification.read && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
      )}
    </button>
  )
}

export default function NotificationsPage() {
  usePageTitle('Notifications')
  const { notifications, isLoading, fetchNotifications, markAllRead, unreadCount } =
    useNotificationStore()

  React.useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Notifications</h1>
          {unreadCount > 0 && (
            <p className="text-sm text-text-secondary mt-0.5">
              {unreadCount} unread
            </p>
          )}
        </div>
        {unreadCount > 0 && (
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            Mark all read
          </Button>
        )}
      </div>

      {/* Notifications List */}
      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg bg-bg-secondary"
            />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No Updates Yet"
          description="New activity on your account will show here."
        />
      ) : (
        <div className="space-y-0.5">
          {notifications.map((notification) => (
            <NotificationItem
              key={notification.id}
              notification={notification}
            />
          ))}
        </div>
      )}
    </div>
  )
}
