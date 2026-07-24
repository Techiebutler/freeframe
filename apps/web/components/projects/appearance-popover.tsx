'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  LayoutGrid, List, RectangleHorizontal, Square, RectangleVertical,
  ChevronDown, SlidersHorizontal,
} from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import {
  useViewStore,
  type ViewLayout, type CardSize, type AspectRatio,
  type ThumbnailScale, type TitleLines,
} from '@/stores/view-store'

function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <Switch
        size="sm"
        aria-label={label}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

// ─── Select dropdown row ────────────────────────────────────────────────────

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none bg-bg-tertiary border border-border rounded pl-2.5 pr-7 py-1 text-xs text-text-primary outline-none cursor-pointer hover:bg-bg-hover transition-colors"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-bg-elevated">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-text-tertiary pointer-events-none" />
      </div>
    </div>
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
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary hover:text-text-primary transition-colors">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Appearance
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded border border-border bg-bg-elevated shadow-xl p-4 space-y-4
            data-[state=open]:animate-in data-[state=closed]:animate-out
            data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0
            data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {/* Layout */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Layout</span>
            <Segmented<ViewLayout>
              options={[
                { value: 'grid', label: 'Grid', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
                { value: 'list', label: 'List', icon: <List className="h-3.5 w-3.5" /> },
              ]}
              value={layout}
              onChange={setLayout}
              optionClassName="px-3 py-1.5"
            />
          </div>

          {/* Card Size — only in grid mode */}
          {layout === 'grid' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Card Size</span>
              <Segmented<CardSize>
                options={[
                  { value: 'S', label: 'S' },
                  { value: 'M', label: 'M' },
                  { value: 'L', label: 'L' },
                ]}
                value={cardSize}
                onChange={setCardSize}
                optionClassName="px-3 py-1.5"
              />
            </div>
          )}

          {/* Aspect Ratio — only in grid mode */}
          {layout === 'grid' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Aspect Ratio</span>
              <Segmented<AspectRatio>
                options={[
                  { value: 'landscape', label: 'Landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" /> },
                  { value: 'square', label: 'Square', icon: <Square className="h-3.5 w-3.5" /> },
                  { value: 'portrait', label: 'Portrait', icon: <RectangleVertical className="h-3.5 w-3.5" /> },
                ]}
                value={aspectRatio}
                onChange={setAspectRatio}
                optionClassName="px-3 py-1.5"
              />
            </div>
          )}

          {/* Thumbnail Scale — only in grid mode */}
          {layout === 'grid' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">Thumbnail Scale</span>
              <Segmented<ThumbnailScale>
                options={[
                  { value: 'fit', label: 'Fit' },
                  { value: 'fill', label: 'Fill' },
                ]}
                value={thumbnailScale}
                onChange={setThumbnailScale}
                optionClassName="px-3 py-1.5"
              />
            </div>
          )}

          {/* Show Card Info */}
          <ToggleRow label="Show Card Info" checked={showCardInfo} onCheckedChange={setShowCardInfo} />

          {/* Titles */}
          {showCardInfo && (
            <SelectRow
              label="Titles"
              value={titleLines}
              options={[
                { value: '1', label: '1 Line' },
                { value: '2', label: '2 Lines' },
                { value: '3', label: '3 Lines' },
              ]}
              onChange={(v) => setTitleLines(v as TitleLines)}
            />
          )}

          {/* Flatten Folders */}
          <ToggleRow label="Flatten Folders" checked={flattenFolders} onCheckedChange={setFlattenFolders} />

          {/* Fields section */}
          <div className="pt-1 border-t border-border">
            <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-2.5">Fields</p>
            <div className="space-y-3">
              <ToggleRow label="File Size" checked={showFileSize} onCheckedChange={setShowFileSize} />
              <ToggleRow label="Uploaded By" checked={showUploader} onCheckedChange={setShowUploader} />
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
