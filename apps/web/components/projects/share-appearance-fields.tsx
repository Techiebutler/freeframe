'use client'

import * as React from 'react'
import {
  LayoutGrid,
  List,
  Moon,
  RectangleHorizontal,
  RectangleVertical,
  Square,
  Sun,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SegmentRow, SelectRow, SettingRow, ToggleRow } from '@/components/ui/setting-controls'
import { parseHex } from '@/lib/accent'
import { cn } from '@/lib/utils'
import { useViewStore } from '@/stores/view-store'
import type { ShareLinkAppearance } from '@/types'

/**
 * What a brand-new link starts with: the same values the API's
 * ShareLinkAppearance applies when a create request carries none. The create
 * dialog holds these until Create, so a link never depends on how one browser
 * happened to be set up — pulling in the current view is a deliberate,
 * one-time copy via `appearanceFromView`.
 */
export const DEFAULT_SHARE_APPEARANCE: ShareLinkAppearance = {
  layout: 'grid',
  theme: 'dark',
  accent_color: null,
  open_in_viewer: true,
  sort_by: 'created_at',
  card_size: 'm',
  aspect_ratio: 'landscape',
  thumbnail_scale: 'fill',
  show_card_info: true,
}

/**
 * The fields "Use my current view" copies out of the folder view store.
 *
 * Only what a share link can actually express. Theme, accent and open-in-viewer
 * are the link's own (the view has no equivalent), and the view's extras —
 * sort direction, title lines, file size, uploader — have no share setting, so
 * the copy skips them. A view sorted by custom, status or type has no share
 * equivalent either, so the link keeps its own sort in that case.
 *
 * The sort is an approximation until sort direction is a share setting: the
 * view's Date sort is by last update in either direction, while a share page
 * always sorts `created_at` newest first. A view on Date ascending therefore
 * copies into a link that lists the other way round.
 *
 * This is a one-time fill: the caller merges the patch into the link's
 * appearance once, at the click, and nothing after that re-reads the view.
 */
export function appearanceFromView(): Partial<ShareLinkAppearance> {
  const { layout, cardSize, aspectRatio, thumbnailScale, showCardInfo, sortKey } =
    useViewStore.getState()
  const patch: Partial<ShareLinkAppearance> = {
    layout,
    card_size: cardSize.toLowerCase() as ShareLinkAppearance['card_size'],
    aspect_ratio: aspectRatio,
    thumbnail_scale: thumbnailScale,
    show_card_info: showCardInfo,
  }
  if (sortKey === 'date') patch.sort_by = 'created_at'
  else if (sortKey === 'name') patch.sort_by = 'name'
  return patch
}

/**
 * A colour setting: a hex field and a colour picker. The field commits on blur
 * or Enter; blank clears the colour (whatever the setting falls back to takes
 * over), and anything that isn't a 6-digit hex snaps back rather than being
 * sent for the API to refuse.
 *
 * A link's own accent uses it, as does a project's branding colour.
 * `name` is the setting's name in its accessible labels ("accent colour").
 */
export function HexColorField({
  label,
  name,
  value,
  onChange,
}: {
  label: string
  name: string
  value: string | null
  onChange: (color: string | null) => void
}) {
  const stored = value?.replace('#', '') ?? ''
  const [draft, setDraft] = React.useState(stored)
  React.useEffect(() => setDraft(stored), [stored])

  function commit() {
    const hex = draft.trim().replace(/^#/, '')
    if (!hex) {
      if (value) onChange(null)
      return
    }
    const color = `#${hex.toLowerCase()}`
    if (!parseHex(color)) {
      setDraft(stored)
      return
    }
    if (color !== value?.toLowerCase()) onChange(color)
  }
  const Name = name.charAt(0).toUpperCase() + name.slice(1)

  return (
    <SettingRow label={label}>
      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-border bg-bg-tertiary pl-2 focus-within:ring-2 focus-within:ring-accent">
          <span className="text-xs text-text-tertiary">#</span>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              }
            }}
            placeholder="Default"
            maxLength={7}
            aria-label={`${Name} hex`}
            className="w-16 bg-transparent px-1 py-1 text-xs font-mono text-text-primary placeholder:text-text-tertiary outline-none"
          />
        </div>
        <label
          className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border focus-within:ring-2 focus-within:ring-accent"
          style={{ backgroundColor: value ?? 'var(--accent)' }}
        >
          <input
            type="color"
            value={value ?? '#5b8def'}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${Name} picker`}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </label>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Clear ${name}`}
            className="rounded p-0.5 text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </SettingRow>
  )
}

/**
 * The Appearance block a share link edits.
 *
 * Card settings first — layout, card size, aspect ratio, fit/fill, card info
 * and sort — following the folder Appearance popover: in list layout the
 * grid-only rows are hidden, their values kept on the link in case it goes
 * back to grid. Then the Page group: theme, accent colour and open-in-viewer.
 *
 * A single-asset link opens straight into the viewer, which reads only the
 * theme and accent, so `kind="asset"` shows just those two.
 *
 * One component for both places that edit it — the create dialog and the
 * link panel's Settings > Appearance — so the two can't drift. The caller owns
 * the appearance and merges every patch it is handed.
 */
export function ShareAppearanceFields({
  appearance,
  onChange,
  onUseCurrentView,
  kind = 'collection',
}: {
  appearance: ShareLinkAppearance
  onChange: (patch: Partial<ShareLinkAppearance>) => void
  /**
   * Renders the "Use my current view" action (see `appearanceFromView`).
   * Only the create dialog passes it, and only when it opens over a folder
   * view, so "my current view" is something the person can see. Not shown
   * for an asset link, which has no card settings to fill.
   */
  onUseCurrentView?: () => void
  kind?: 'asset' | 'collection'
}) {
  const isCollection = kind === 'collection'
  const isGrid = appearance.layout === 'grid'

  return (
    <div className="space-y-3">
      {isCollection && onUseCurrentView && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={onUseCurrentView}
        >
          <Wand2 className="h-3.5 w-3.5" />
          Use my current view
        </Button>
      )}

      {isCollection && (
        <>
          {/* Same icons as the folder view's Appearance popover */}
          <SegmentRow<ShareLinkAppearance['layout']>
            label="Layout"
            options={[
              { value: 'grid', icon: <LayoutGrid className="h-3.5 w-3.5" />, ariaLabel: 'Grid' },
              { value: 'list', icon: <List className="h-3.5 w-3.5" />, ariaLabel: 'List' },
            ]}
            value={appearance.layout}
            onChange={(layout) => onChange({ layout })}
          />

          {isGrid && (
            <>
              <SegmentRow<ShareLinkAppearance['card_size']>
                label="Card Size"
                options={[
                  { value: 's', label: 'S' },
                  { value: 'm', label: 'M' },
                  { value: 'l', label: 'L' },
                ]}
                value={appearance.card_size || 'm'}
                onChange={(card_size) => onChange({ card_size })}
              />
              <SegmentRow<ShareLinkAppearance['aspect_ratio']>
                label="Aspect Ratio"
                options={[
                  { value: 'landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" />, ariaLabel: 'Landscape' },
                  { value: 'square', icon: <Square className="h-3.5 w-3.5" />, ariaLabel: 'Square' },
                  { value: 'portrait', icon: <RectangleVertical className="h-3.5 w-3.5" />, ariaLabel: 'Portrait' },
                ]}
                value={appearance.aspect_ratio || 'landscape'}
                onChange={(aspect_ratio) => onChange({ aspect_ratio })}
              />
              <SegmentRow<ShareLinkAppearance['thumbnail_scale']>
                label="Thumbnail Scale"
                options={[
                  { value: 'fit', label: 'Fit' },
                  { value: 'fill', label: 'Fill' },
                ]}
                value={appearance.thumbnail_scale || 'fill'}
                onChange={(thumbnail_scale) => onChange({ thumbnail_scale })}
              />
            </>
          )}

          <ToggleRow
            label="Show Card Info"
            description="Display name, type, and size below thumbnail"
            checked={appearance.show_card_info !== false}
            onCheckedChange={(checked) => onChange({ show_card_info: checked })}
          />

          <SelectRow<ShareLinkAppearance['sort_by']>
            label="Sort By"
            value={appearance.sort_by}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'created_at', label: 'Date created' },
              { value: 'file_size', label: 'Size' },
            ]}
            onChange={(sort_by) => onChange({ sort_by })}
          />
        </>
      )}

      {/* Page — how the share page itself looks and behaves */}
      <div className={cn('space-y-3', isCollection && 'pt-3 border-t border-border')}>
        {isCollection && (
          <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Page</p>
        )}
        <SegmentRow<ShareLinkAppearance['theme']>
          label="Theme"
          options={[
            { value: 'dark', icon: <Moon className="h-3.5 w-3.5" />, ariaLabel: 'Dark' },
            { value: 'light', icon: <Sun className="h-3.5 w-3.5" />, ariaLabel: 'Light' },
          ]}
          value={appearance.theme === 'light' ? 'light' : 'dark'}
          onChange={(theme) => onChange({ theme })}
        />
        <HexColorField
          label="Accent Color"
          name="accent colour"
          value={appearance.accent_color}
          onChange={(accent_color) => onChange({ accent_color })}
        />
        {isCollection && (
          <ToggleRow
            label="Open in Viewer"
            description="Clicking an asset opens it in the full viewer"
            checked={appearance.open_in_viewer !== false}
            onCheckedChange={(checked) => onChange({ open_in_viewer: checked })}
          />
        )}
      </div>
    </div>
  )
}
