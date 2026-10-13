'use client'

import * as React from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Switch from '@radix-ui/react-switch'
import {
  LayoutGrid, List, RectangleHorizontal, Square, RectangleVertical,
  ChevronDown, SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useViewStore,
  type ViewLayout, type CardSize, type AspectRatio,
  type ThumbnailScale, type TitleLines,
} from '@/stores/view-store'

// ─── Segmented control ──────────────────────────────────────────────────────

interface SegmentOption<T extends string> {
  value: T
  label?: string
  icon?: React.ReactNode
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
    <div className="flex rounded-md border border-white/10 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center justify-center px-3 py-1.5 text-xs transition-colors min-w-[36px]',
            value === opt.value
              ? 'bg-accent text-white'
              : 'bg-white/5 text-text-tertiary hover:text-text-secondary hover:bg-white/10',
          )}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  )
}

// ─── Toggle switch row ──────────────────────────────────────────────────────

export function ToggleRow({
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
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        className={cn(
          'relative h-5 w-9 rounded-full transition-colors outline-none',
          checked ? 'bg-accent' : 'bg-white/15',
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
          className="appearance-none bg-white/5 border border-white/10 rounded-md pl-2.5 pr-7 py-1 text-xs text-text-primary outline-none cursor-pointer hover:bg-white/10 transition-colors"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#232328]">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-text-tertiary pointer-events-none" />
      </div>
    </div>
  )
}

// ─── Shared rows ────────────────────────────────────────────────────────────

export function LayoutRow({ value, onChange }: { value: ViewLayout; onChange: (v: ViewLayout) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">Layout</span>
      <Segment<ViewLayout>
        options={[
          { value: 'grid', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
          { value: 'list', icon: <List className="h-3.5 w-3.5" /> },
        ]}
        value={value}
        onChange={onChange}
      />
    </div>
  )
}

export function CardSizeRow({ value, onChange }: { value: CardSize; onChange: (v: CardSize) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-text-secondary">Card Size</span>
      <Segment<CardSize>
        options={[
          { value: 'S', label: 'S' },
          { value: 'M', label: 'M' },
          { value: 'L', label: 'L' },
        ]}
        value={value}
        onChange={onChange}
      />
    </div>
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
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Aspect Ratio</span>
          <Segment<AspectRatio>
            options={[
              { value: 'landscape', icon: <RectangleHorizontal className="h-3.5 w-3.5" /> },
              { value: 'square', icon: <Square className="h-3.5 w-3.5" /> },
              { value: 'portrait', icon: <RectangleVertical className="h-3.5 w-3.5" /> },
            ]}
            value={aspectRatio}
            onChange={setAspectRatio}
          />
        </div>
      )}

      {/* Thumbnail Scale — only in grid mode */}
      {layout === 'grid' && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-text-secondary">Thumbnail Scale</span>
          <Segment<ThumbnailScale>
            options={[
              { value: 'fit', label: 'Fit' },
              { value: 'fill', label: 'Fill' },
            ]}
            value={thumbnailScale}
            onChange={setThumbnailScale}
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
