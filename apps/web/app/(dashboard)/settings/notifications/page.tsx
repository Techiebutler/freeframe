'use client'

import * as React from 'react'
import { Bell } from 'lucide-react'

interface NotificationSetting {
  id: string
  title: string
  description: string
  options: { label: string; value: string }[]
  defaultValue: string
}

const notificationSettings: NotificationSetting[] = [
  {
    id: 'email_frequency',
    title: 'Email Notifications Frequency',
    description: 'Email updates will be sent to your email address',
    options: [
      { label: 'Instantly', value: 'instant' },
      { label: '15 Minutes', value: '15min' },
      { label: 'Hourly', value: 'hourly' },
      { label: 'Daily', value: 'daily' },
      { label: 'Never', value: 'never' },
    ],
    defaultValue: '15min',
  },
]

const commentNotifications = [
  {
    id: 'general_comments',
    title: 'General Comments',
    description: 'When someone comments on an asset',
  },
  {
    id: 'comment_replies',
    title: 'Comment Replies',
    description: 'When someone replies to your comment',
  },
  {
    id: 'mentions',
    title: '@Mentions',
    description: 'When someone @mentions you in a comment',
  },
]

const assetNotifications = [
  {
    id: 'your_uploads',
    title: 'Your Uploads',
    description: 'When you upload assets',
  },
  {
    id: 'other_uploads',
    title: 'Other Uploads',
    description: 'When other users upload assets',
  },
  {
    id: 'status_updates',
    title: 'Status Updates',
    description: "When someone changes an asset's status",
  },
  {
    id: 'assigned_to_you',
    title: 'Assigned to You',
    description: 'When someone assigns an asset to you',
  },
]

export default function NotificationsPage() {
  const [emailFrequency, setEmailFrequency] = React.useState('15min')
  const [commentSettings, setCommentSettings] = React.useState<Record<string, string>>({
    general_comments: 'all_on',
    comment_replies: 'all_on',
    mentions: 'all_on',
  })
  const [assetSettings, setAssetSettings] = React.useState<Record<string, string>>({
    your_uploads: 'all_off',
    other_uploads: 'all_on',
    status_updates: 'all_on',
    assigned_to_you: 'all_on',
  })

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Bell className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Notifications</h1>
          <p className="text-sm text-text-secondary">
            Manage your notification preferences
          </p>
        </div>
      </div>

      {/* Email Frequency */}
      <section className="space-y-4">
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-bg-secondary">
          <Bell className="h-5 w-5 text-text-secondary mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-text-primary">
              Email Notifications Frequency
            </h3>
            <p className="text-xs text-text-tertiary mt-1">
              Email updates will be sent to your email address
            </p>
            <select
              value={emailFrequency}
              onChange={(e) => setEmailFrequency(e.target.value)}
              className="mt-3 w-40 rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="instant">Instantly</option>
              <option value="15min">15 Minutes</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="never">Never</option>
            </select>
          </div>
        </div>
      </section>

      {/* Comments Section */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Comments</h2>
        <div className="space-y-3">
          {commentNotifications.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-secondary"
            >
              <div>
                <h3 className="text-sm font-medium text-text-primary">{item.title}</h3>
                <p className="text-xs text-text-tertiary mt-0.5">{item.description}</p>
              </div>
              <select
                value={commentSettings[item.id] || 'all_on'}
                onChange={(e) =>
                  setCommentSettings({ ...commentSettings, [item.id]: e.target.value })
                }
                className="rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="all_on">All On</option>
                <option value="in_app">In-App Only</option>
                <option value="all_off">All Off</option>
              </select>
            </div>
          ))}
        </div>
      </section>

      {/* Assets Section */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Assets</h2>
        <div className="space-y-3">
          {assetNotifications.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-secondary"
            >
              <div>
                <h3 className="text-sm font-medium text-text-primary">{item.title}</h3>
                <p className="text-xs text-text-tertiary mt-0.5">{item.description}</p>
              </div>
              <select
                value={assetSettings[item.id] || 'all_on'}
                onChange={(e) =>
                  setAssetSettings({ ...assetSettings, [item.id]: e.target.value })
                }
                className="rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="all_on">All On</option>
                <option value="in_app">In-App Only</option>
                <option value="all_off">All Off</option>
              </select>
            </div>
          ))}
        </div>
      </section>

      {/* Info Note */}
      <div className="p-4 rounded-lg bg-bg-tertiary border border-border">
        <p className="text-xs text-text-secondary">
          You will always get important administrative emails, such as password resets and account billing.
        </p>
      </div>
    </div>
  )
}
