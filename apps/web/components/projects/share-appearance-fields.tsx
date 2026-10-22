'use client'

import * as React from 'react'
import * as Switch from '@radix-ui/react-switch'
import {
  ChevronDown,
  LayoutGrid,
  List,
  RectangleHorizontal,
  RectangleVertical,
  Square,
  Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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

// ─── Rows and controls ──────────────────────────────────────────────────────
// Deliberately the same shapes as the folder view's Appearance popover
// (appearance-popover.tsx): a label row with a compact segmented control on
// the right, plain switches, and a compact select with a chevron. The share
// block edits the same settings the popover edits for your own view, so the
// two read as one system.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-text-secondary">{label}</span>
      {children}
    </div>
  )
}

interface SegmentOption<T extends string> {
  value: T
  label?: string
  icon?: React.ReactNode
  ariaLabel?: string
}

function Segment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-md border border-border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-label={opt.ariaLabel}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center justify-center px-3 py-1.5 text-xs transition-colors min-w-[36px]',
            value === opt.value
              ? 'bg-accent text-white'
              : 'bg-bg-tertiary text-text-tertiary hover:bg-bg-hover hover:text-text-secondary',
          )}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-text-primary">{label}</p>
        {description && (
          <p className="text-xs text-text-tertiary mt-0.5">{description}</p>
        )}
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-bg-hover',
        )}
      >
        <Switch.Thumb
          className={cn(
            'block h-4 w-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </Switch.Root>
    </div>
  )
}

/**
 * The Appearance block a share link edits: layout, card size, aspect ratio,
 * fit/fill, card info and sort.
 *
 * The card rows follow the folder Appearance popover: in list layout the
 * grid-only settings (card size, aspect ratio, fit/fill) are hidden, their
 * values kept on the link in case it goes back to grid. Theme, accent colour
 * and open-in-viewer are not offered at all — a link keeps whatever it stored
 * and new links take the defaults above (the theme's own accent, open in
 * viewer, dark theme).
 *
 * One component for both places that edit it — the create dialog and the
 * link panel's Settings > Appearance — so the two can't drift. It holds no
 * state of its own; the caller owns the appearance and merges every patch it
 * is handed.
 */
export function ShareAppearanceFields({
  appearance,
  onChange,
  onUseCurrentView,
}: {
  appearance: ShareLinkAppearance
  onChange: (patch: Partial<ShareLinkAppearance>) => void
  /**
   * Renders the "Use my current view" action (see `appearanceFromView`).
   * Only the create dialog passes it: there the folder view sits behind the
   * modal, so "my current view" is something the person can see. The link
   * panel edits a saved link with no view on screen, so it has nothing to
   * copy from and omits the action.
   */
  onUseCurrentView?: () => void
}) {
  return (
    <div className="space-y-3">
      {onUseCurrentView && (
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

      {/* Layout — same icons as the folder view's Appearance popover */}
      <Row label="Layout">
        <Segment<ShareLinkAppearance['layout']>
          options={[
            { value: 'grid', icon: <LayoutGrid className="h-3.5 w-3.5" />, ariaLabel: 'Grid' },
            { value: 'list', icon: <List className="h-3.5 w-3.5" />, ariaLabel: 'List' },
          ]}
          value={appearance.layout}
          onChange={(layout) => onChange({ layout })}
        />
      </Row>

      {/* Card Size — only in grid mode */}
      {appearance.layout === 'grid' && (
        <Row label="Card Size">
          <Segment<ShareLinkAppearance['card_size']>
            options={[
              { value: 's', label: 'S' },
              { value: 'm', label: 'M' },
              { value: 'l', label: 'L' },
            ]}
            value={(appearance.card_size || 'm') as ShareLinkAppearance['card_size']}
            onChange={(card_size) => onChange({ card_size })}
          />
        </Row>
      )}

      {/* Aspect Ratio — only in grid mode */}
      {appearance.layout === 'grid' && (
        <Row label="Aspect Ratio">
          <Segment<ShareLinkAppearance['aspect_ratio']>
            options={[
              { value: 'landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" />, ariaLabel: 'Landscape' },
              { value: 'square', icon: <Square className="h-3.5 w-3.5" />, ariaLabel: 'Square' },
              { value: 'portrait', icon: <RectangleVertical className="h-3.5 w-3.5" />, ariaLabel: 'Portrait' },
            ]}
            value={(appearance.aspect_ratio || 'landscape') as ShareLinkAppearance['aspect_ratio']}
            onChange={(aspect_ratio) => onChange({ aspect_ratio })}
          />
        </Row>
      )}

      {/* Thumbnail Scale — only in grid mode */}
      {appearance.layout === 'grid' && (
        <Row label="Thumbnail Scale">
          <Segment<ShareLinkAppearance['thumbnail_scale']>
            options={[
              { value: 'fit', label: 'Fit' },
              { value: 'fill', label: 'Fill' },
            ]}
            value={(appearance.thumbnail_scale || 'fill') as ShareLinkAppearance['thumbnail_scale']}
            onChange={(thumbnail_scale) => onChange({ thumbnail_scale })}
          />
        </Row>
      )}

      {/* Show Card Info */}
      <ToggleRow
        label="Show Card Info"
        description="Display name, type, and size below thumbnail"
        checked={appearance.show_card_info !== false}
        onCheckedChange={(checked) => onChange({ show_card_info: checked })}
      />

      {/* Sort */}
      <Row label="Sort By">
        <div className="relative">
          <select
            value={appearance.sort_by}
            onChange={(e) =>
              onChange({ sort_by: e.target.value as ShareLinkAppearance['sort_by'] })
            }
            aria-label="Sort By"
            className="appearance-none bg-bg-tertiary border border-border rounded-md pl-2.5 pr-7 py-1 text-xs text-text-primary outline-none cursor-pointer hover:bg-bg-hover transition-colors [color-scheme:auto]"
          >
            <option value="name">Name</option>
            <option value="created_at">Date created</option>
            <option value="file_size">Size</option>
          </select>
          <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-text-tertiary pointer-events-none" />
        </div>
      </Row>
    </div>
  )
}
