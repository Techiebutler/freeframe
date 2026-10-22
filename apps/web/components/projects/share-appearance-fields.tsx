'use client'

import * as React from 'react'
import * as Switch from '@radix-ui/react-switch'
import { LayoutGrid, LayoutList, Wand2 } from 'lucide-react'
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
 * The whole Appearance block a share link carries: layout, open-in-viewer,
 * theme, accent, card size, aspect ratio, fit/fill, card info and sort.
 *
 * One component for both places that edit it — the create dialog and the
 * link panel's Settings > Appearance — so the two can't drift. It holds no
 * state of its own beyond the accent draft the text/color pair needs; the
 * caller owns the appearance and merges every patch it is handed.
 */
export function ShareAppearanceFields({
  appearance,
  onChange,
  onUseCurrentView,
}: {
  appearance: ShareLinkAppearance
  onChange: (patch: Partial<ShareLinkAppearance>) => void
  /** When set, renders the "Use my current view" action (see `appearanceFromView`). */
  onUseCurrentView?: () => void
}) {
  const [accentDraft, setAccentDraft] = React.useState(appearance.accent_color ?? '')

  // Follow the appearance from above (a save landing, a current-view fill)
  // without clobbering a mid-edit draft on every unrelated keystroke.
  React.useEffect(() => {
    setAccentDraft(appearance.accent_color ?? '')
  }, [appearance.accent_color])

  const accentSwatch = accentDraft ? `#${accentDraft.replace('#', '')}` : '#6366f1'

  return (
    <div className="space-y-3">
      {onUseCurrentView && (
        <div className="space-y-1">
          <button
            type="button"
            onClick={onUseCurrentView}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary hover:border-border-focus transition-colors"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Use my current view
          </button>
          <p className="text-2xs text-text-tertiary">
            Fills the settings below from how folders look in your own view
            right now, once. The link then keeps them as its own.
          </p>
        </div>
      )}

      {/* Layout — Grid / List */}
      <div className="space-y-1.5">
        <p className="text-xs text-text-secondary">Layout</p>
        <div className="flex gap-2">
          {(['grid', 'list'] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              onClick={() => onChange({ layout })}
              className={cn(
                'flex-1 flex flex-col items-center gap-1.5 rounded-lg border py-3 text-xs font-medium capitalize transition-colors',
                appearance.layout === layout
                  ? 'bg-accent/10 border-accent text-accent'
                  : 'border-border text-text-secondary hover:text-text-primary hover:border-border-focus',
              )}
            >
              {layout === 'grid' ? (
                <LayoutGrid className="h-4 w-4" />
              ) : (
                <LayoutList className="h-4 w-4" />
              )}
              {layout}
            </button>
          ))}
        </div>
      </div>

      {/* Open in viewer */}
      <ToggleRow
        label="Open in viewer"
        description="Click assets to open full viewer"
        checked={appearance.open_in_viewer}
        onCheckedChange={(checked) => onChange({ open_in_viewer: checked })}
      />

      {/* Theme — Dark / Light */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Theme</p>
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(['dark', 'light'] as const).map((theme) => (
            <button
              key={theme}
              type="button"
              onClick={() => onChange({ theme })}
              className={cn(
                'px-4 py-1.5 text-xs font-medium capitalize transition-colors',
                appearance.theme === theme
                  ? 'bg-accent text-text-inverse'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {theme === 'dark' ? '🌙' : '☀️'}
            </button>
          ))}
        </div>
      </div>

      {/* Accent color */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Accent Color</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary">#</span>
          <input
            type="text"
            value={accentDraft}
            onChange={(e) => setAccentDraft(e.target.value)}
            onBlur={() => {
              const color = accentDraft.trim() || null
              if (color !== (appearance.accent_color || '')) {
                onChange({
                  accent_color: color ? `#${color.replace('#', '')}` : null,
                })
              }
            }}
            placeholder="None"
            maxLength={7}
            className="w-20 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 font-mono"
          />
          <label className="relative h-6 w-6 rounded-full border border-border cursor-pointer overflow-hidden shrink-0">
            <div
              className="absolute inset-0 rounded-full"
              style={{ backgroundColor: accentSwatch }}
            />
            <input
              type="color"
              value={accentSwatch}
              onChange={(e) => {
                const hex = e.target.value.replace('#', '')
                setAccentDraft(hex)
                onChange({ accent_color: `#${hex}` })
              }}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </label>
        </div>
      </div>

      {/* Card Size — S / M / L */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Card Size</p>
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(['s', 'm', 'l'] as const).map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => onChange({ card_size: size })}
              className={cn(
                'px-4 py-1.5 text-xs font-medium uppercase transition-colors',
                (appearance.card_size || 'm') === size
                  ? 'bg-accent text-text-inverse'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {size}
            </button>
          ))}
        </div>
      </div>

      {/* Aspect Ratio */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Aspect Ratio</p>
        <div className="flex rounded-lg border border-border overflow-hidden">
          {[
            { value: 'landscape' as const, icon: '▭' },
            { value: 'square' as const, icon: '□' },
            { value: 'portrait' as const, icon: '▯' },
          ].map(({ value, icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ aspect_ratio: value })}
              className={cn(
                'px-4 py-1.5 text-sm transition-colors',
                (appearance.aspect_ratio || 'landscape') === value
                  ? 'bg-accent text-text-inverse'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      {/* Thumbnail Scale — Fit / Fill */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-primary">Thumbnail Scale</p>
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(['fit', 'fill'] as const).map((scale) => (
            <button
              key={scale}
              type="button"
              onClick={() => onChange({ thumbnail_scale: scale })}
              className={cn(
                'px-4 py-1.5 text-xs font-medium capitalize transition-colors',
                (appearance.thumbnail_scale || 'fill') === scale
                  ? 'bg-accent text-text-inverse'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {scale}
            </button>
          ))}
        </div>
      </div>

      {/* Show Card Info */}
      <ToggleRow
        label="Show Card Info"
        description="Display name, type, and size below thumbnail"
        checked={appearance.show_card_info !== false}
        onCheckedChange={(checked) => onChange({ show_card_info: checked })}
      />

      {/* Sort */}
      <div className="space-y-1.5">
        <p className="text-xs text-text-secondary">Sort By</p>
        <select
          value={appearance.sort_by}
          onChange={(e) =>
            onChange({ sort_by: e.target.value as ShareLinkAppearance['sort_by'] })
          }
          className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/50 [color-scheme:auto]"
        >
          <option value="name">Name</option>
          <option value="created_at">Date created</option>
          <option value="file_size">Size</option>
        </select>
      </div>
    </div>
  )
}