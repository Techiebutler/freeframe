'use client'

import * as React from 'react'
import * as Switch from '@radix-ui/react-switch'
import { Search, Folder, File, Copy, Check, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/utils'
import type { ShareLinkListItem } from '@/types'

interface ShareLinksTableProps {
  shareLinks: ShareLinkListItem[]
  onSelectLink: (token: string) => void
  onToggleEnabled: (token: string, enabled: boolean) => void
  onViewActivity: (token: string) => void
  frontendUrl: string
}

export function ShareLinksTable({
  shareLinks,
  onSelectLink,
  onToggleEnabled,
  onViewActivity,
  frontendUrl,
}: ShareLinksTableProps) {
  const [search, setSearch] = React.useState('')
  const [copiedToken, setCopiedToken] = React.useState<string | null>(null)

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return shareLinks
    return shareLinks.filter((link) => link.title.toLowerCase().includes(q))
  }, [shareLinks, search])

  const handleCopy = React.useCallback(
    async (token: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const url = `${frontendUrl}/share/${token}`
      await navigator.clipboard.writeText(url)
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    },
    [frontendUrl],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-tertiary pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search for Shares"
          className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-bg-tertiary text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus transition-colors"
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center py-16 text-center">
          <p className="text-sm text-text-tertiary">
            {shareLinks.length === 0
              ? 'No share links yet. Create one by sharing an asset or folder.'
              : 'No share links match your search.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border bg-bg-secondary">
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Title
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Link
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Visibility
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Access Type
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Last Viewed
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Views
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                  Activity
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((link, i) => {
                const shareUrl = `${frontendUrl}/share/${link.token}`
                const isCopied = copiedToken === link.token
                const isLast = i === filtered.length - 1

                return (
                  <tr
                    key={link.token}
                    className={cn(
                      'group transition-colors hover:bg-white/[0.03]',
                      !isLast && 'border-b border-border',
                    )}
                  >
                    {/* Title */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onSelectLink(link.token)}
                        className="flex items-center gap-2 text-left hover:text-accent transition-colors"
                      >
                        {link.share_type === 'folder' ? (
                          <Folder className="h-4 w-4 text-text-tertiary shrink-0" />
                        ) : (
                          <File className="h-4 w-4 text-text-tertiary shrink-0" />
                        )}
                        <span className="text-text-primary font-medium truncate max-w-[180px]">
                          {link.title}
                        </span>
                      </button>
                    </td>

                    {/* Link */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-secondary font-mono truncate max-w-[200px]">
                          {shareUrl}
                        </span>
                        <button
                          onClick={(e) => handleCopy(link.token, e)}
                          className="flex items-center justify-center h-6 w-6 rounded border border-border bg-bg-tertiary hover:bg-white/10 text-text-tertiary hover:text-text-primary transition-colors shrink-0"
                          title="Copy link"
                        >
                          {isCopied ? (
                            <Check className="h-3 w-3 text-green-400" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </td>

                    {/* Visibility (toggle) */}
                    <td className="px-4 py-3">
                      <Switch.Root
                        checked={link.is_enabled}
                        onCheckedChange={(checked) => onToggleEnabled(link.token, checked)}
                        className={cn(
                          'relative h-5 w-9 rounded-full transition-colors outline-none cursor-pointer',
                          link.is_enabled ? 'bg-accent' : 'bg-white/15',
                        )}
                      >
                        <Switch.Thumb
                          className={cn(
                            'block h-4 w-4 rounded-full bg-white transition-transform',
                            link.is_enabled ? 'translate-x-[18px]' : 'translate-x-[2px]',
                          )}
                        />
                      </Switch.Root>
                    </td>

                    {/* Access Type */}
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">
                        Public
                      </span>
                    </td>

                    {/* Last Viewed */}
                    <td className="px-4 py-3">
                      <span className="text-xs text-text-tertiary">
                        {link.last_viewed_at ? formatRelativeTime(link.last_viewed_at) : '—'}
                      </span>
                    </td>

                    {/* Views */}
                    <td className="px-4 py-3">
                      <span className="text-sm text-text-secondary tabular-nums">
                        {link.view_count}
                      </span>
                    </td>

                    {/* Activity */}
                    <td className="px-4 py-3">
                      <button
                        onClick={() => onViewActivity(link.token)}
                        className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        View Activity
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer count */}
      <div className="mt-3 shrink-0">
        <span className="text-xs text-text-tertiary">
          {shareLinks.length} {shareLinks.length === 1 ? 'Share' : 'Shares'}
        </span>
      </div>
    </div>
  )
}
