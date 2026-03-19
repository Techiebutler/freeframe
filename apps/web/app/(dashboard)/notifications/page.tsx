'use client'

import * as React from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import {
  Bell,
  AtSign,
  UserCheck,
  MessageSquare,
  CheckCircle,
} from 'lucide-react'
import { useNotificationStore } from '@/stores/notification-store'
import { formatRelativeTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/shared/empty-state'
import { cn } from '@/lib/utils'
import type { Notification, NotificationType } from '@/types'

const tabConfig: { value: string; label: string; types?: NotificationType[] }[] = [
  { value: 'all', label: 'All' },
  { value: 'mention', label: 'Mentions', types: ['mention'] },
  { value: 'assignment', label: 'Assignments', types: ['assignment', 'due_soon'] },
  { value: 'comment', label: 'Comments', types: ['comment'] },
  { value: 'approval', label: 'Approvals', types: ['approval'] },
]

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
          notification.type === 'approval' && 'bg-[oklch(0.35_0.12_152/0.25)] text-status-success',
          notification.type === 'comment' && 'bg-bg-tertiary text-text-secondary',
          (notification.type === 'assignment' || notification.type === 'due_soon') &&
            'bg-[oklch(0.35_0.12_70/0.25)] text-status-warning',
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
  const { notifications, isLoading, fetchNotifications, markAllRead, unreadCount } =
    useNotificationStore()

  const [activeTab, setActiveTab] = React.useState('all')

  React.useEffect(() => {
    fetchNotifications()
  }, [fetchNotifications])

  const filteredNotifications = React.useMemo(() => {
    const tab = tabConfig.find((t) => t.value === activeTab)
    if (!tab?.types) return notifications
    return notifications.filter((n) => tab.types!.includes(n.type))
  }, [notifications, activeTab])

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

      {/* Tabs */}
      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        <Tabs.List className="flex gap-1 border-b border-border">
          {tabConfig.map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              className={cn(
                'px-3 py-2 text-sm transition-colors border-b-2 -mb-px',
                'text-text-secondary hover:text-text-primary',
                'data-[state=active]:border-accent data-[state=active]:text-text-primary',
                'data-[state=inactive]:border-transparent',
              )}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {tabConfig.map((tab) => (
          <Tabs.Content key={tab.value} value={tab.value} className="mt-2 focus:outline-none">
            {isLoading ? (
              <div className="space-y-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-16 animate-pulse rounded-lg bg-bg-secondary"
                  />
                ))}
              </div>
            ) : filteredNotifications.length === 0 ? (
              <EmptyState
                icon={Bell}
                title="No notifications"
                description="You're all caught up."
              />
            ) : (
              <div className="space-y-0.5">
                {filteredNotifications.map((notification) => (
                  <NotificationItem
                    key={notification.id}
                    notification={notification}
                  />
                ))}
              </div>
            )}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  )
}
