'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  LayoutGrid, List, RectangleHorizontal, Square, RectangleVertical,
  SlidersHorizontal,
} from 'lucide-react'
import {
  SegmentRow,
  SelectRow,
  ToggleRow as BaseToggleRow,
} from '@/components/ui/setting-controls'
import {
  useViewStore,
  type ViewLayout, type CardSize, type AspectRatio,
  type ThumbnailScale, type TitleLines,
} from '@/stores/view-store'

// ─── Rows ───────────────────────────────────────────────────────────────────
// The controls live in components/ui/setting-controls, shared with a share
// link's Appearance block. This popover's frame is always dark, hence `overlay`.

export function ToggleRow(props: Omit<React.ComponentProps<typeof BaseToggleRow>, 'tone'>) {
  return <BaseToggleRow {...props} tone="overlay" />
}

export function LayoutRow({ value, onChange }: { value: ViewLayout; onChange: (v: ViewLayout) => void }) {
  return (
    <SegmentRow<ViewLayout>
      label="Layout"
      tone="overlay"
      options={[
        { value: 'grid', icon: <LayoutGrid className="h-3.5 w-3.5" />, ariaLabel: 'Grid' },
        { value: 'list', icon: <List className="h-3.5 w-3.5" />, ariaLabel: 'List' },
      ]}
      value={value}
      onChange={onChange}
    />
  )
}

export function CardSizeRow({ value, onChange }: { value: CardSize; onChange: (v: CardSize) => void }) {
  return (
    <SegmentRow<CardSize>
      label="Card Size"
      tone="overlay"
      options={[
        { value: 'S', label: 'S' },
        { value: 'M', label: 'M' },
        { value: 'L', label: 'L' },
      ]}
      value={value}
      onChange={onChange}
    />
  )
}

// ─── Popover frame ──────────────────────────────────────────────────────────

export function AppearancePopoverFrame({ children }: { children: React.ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors">
          <SlidersHorizontal className="h-4 w-4" />
          Appearance
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-xl border border-white/10 bg-[#1a1a1f] shadow-2xl p-4 space-y-4
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

// ─── Main popover ───────────────────────────────────────────────────────────

export function AppearancePopover() {
  const {
    layout, setLayout,
    cardSize, setCardSize,
    aspectRatio, setAspectRatio,
    thumbnailScale, setThumbnailScale,
    showCardInfo, setShowCardInfo,
    titleLines, setTitleLines,
    flattenFolders, setFlattenFolders,
    showFileSize, setShowFileSize,
    showUploader, setShowUploader,
  } = useViewStore()

  return (
    <AppearancePopoverFrame>
      <LayoutRow value={layout} onChange={setLayout} />

      {/* Card Size — only in grid mode */}
      {layout === 'grid' && <CardSizeRow value={cardSize} onChange={setCardSize} />}

      {/* Aspect Ratio — only in grid mode */}
      {layout === 'grid' && (
        <SegmentRow<AspectRatio>
          label="Aspect Ratio"
          tone="overlay"
          options={[
            { value: 'landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" />, ariaLabel: 'Landscape' },
            { value: 'square', icon: <Square className="h-3.5 w-3.5" />, ariaLabel: 'Square' },
            { value: 'portrait', icon: <RectangleVertical className="h-3.5 w-3.5" />, ariaLabel: 'Portrait' },
          ]}
          value={aspectRatio}
          onChange={setAspectRatio}
        />
      )}

      {/* Thumbnail Scale — only in grid mode */}
      {layout === 'grid' && (
        <SegmentRow<ThumbnailScale>
          label="Thumbnail Scale"
          tone="overlay"
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'fill', label: 'Fill' },
          ]}
          value={thumbnailScale}
          onChange={setThumbnailScale}
        />
      )}

      {/* Show Card Info */}
      <ToggleRow label="Show Card Info" checked={showCardInfo} onCheckedChange={setShowCardInfo} />

      {/* Titles */}
      {showCardInfo && (
        <SelectRow<TitleLines>
          label="Titles"
          tone="overlay"
          value={titleLines}
          options={[
            { value: '1', label: '1 Line' },
            { value: '2', label: '2 Lines' },
            { value: '3', label: '3 Lines' },
          ]}
          onChange={setTitleLines}
        />
      )}

      {/* Flatten Folders */}
      <ToggleRow label="Flatten Folders" checked={flattenFolders} onCheckedChange={setFlattenFolders} />

      {/* Fields section */}
      <div className="pt-1 border-t border-white/10">
        <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2.5">Fields</p>
        <div className="space-y-3">
          <ToggleRow label="File Size" checked={showFileSize} onCheckedChange={setShowFileSize} />
          <ToggleRow label="Uploaded By" checked={showUploader} onCheckedChange={setShowUploader} />
        </div>
      </div>
    </AppearancePopoverFrame>
  )
}
