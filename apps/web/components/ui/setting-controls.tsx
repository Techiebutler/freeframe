'use client'

import * as React from 'react'
import * as Switch from '@radix-ui/react-switch'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Compact settings controls: a label row with a segmented control, switch or
 * select on the right. The folder view's Appearance popover and a share link's
 * Appearance block both build from these, so the two read as one system.
 *
 * `tone` picks the palette. `surface` (the default) uses the theme tokens, for
 * controls on a themed surface such as a dialog or panel. `overlay` is for the
 * Appearance popovers, whose frame is a fixed dark colour in either theme.
 */
export type ControlTone = 'surface' | 'overlay'

const tones = {
  surface: {
    frame: 'border-border',
    idle: 'bg-bg-tertiary text-text-tertiary hover:bg-bg-hover hover:text-text-secondary',
    track: 'bg-bg-hover',
    select: 'bg-bg-tertiary border-border hover:bg-bg-hover [color-scheme:auto]',
    option: undefined,
  },
  overlay: {
    frame: 'border-white/10',
    idle: 'bg-white/5 text-text-tertiary hover:text-text-secondary hover:bg-white/10',
    track: 'bg-white/15',
    select: 'bg-white/5 border-white/10 hover:bg-white/10',
    option: 'bg-[#232328]',
  },
} as const

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

export function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-text-secondary">{label}</span>
      {children}
    </div>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label?: string
  icon?: React.ReactNode
  /** Required when the option shows only an icon. */
  ariaLabel?: string
}

/** A row of toggle buttons; the pressed one is the current value. */
export function Segment<T extends string>({
  label,
  options,
  value,
  onChange,
  tone = 'surface',
}: {
  /** Names the group for assistive tech; the visible label is the row's. */
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (v: T) => void
  tone?: ControlTone
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex rounded-md border overflow-hidden', tones[tone].frame)}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-label={opt.ariaLabel}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center justify-center px-3 py-1.5 text-xs transition-colors min-w-[36px] focus-visible:ring-inset',
            focusRing,
            value === opt.value ? 'bg-accent text-text-inverse' : tones[tone].idle,
          )}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  )
}

export function SegmentRow<T extends string>({
  label,
  ...segment
}: Omit<React.ComponentProps<typeof Segment<T>>, 'label'> & { label: string }) {
  return (
    <SettingRow label={label}>
      <Segment<T> label={label} {...segment} />
    </SettingRow>
  )
}

/**
 * A labelled switch. With a description the label reads as a heading over it
 * (primary text); without one it matches the other rows' labels.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  tone = 'surface',
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  tone?: ControlTone
}) {
  const id = React.useId()
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p id={`${id}-label`} className={cn('text-sm', description ? 'text-text-primary' : 'text-text-secondary')}>
          {label}
        </p>
        {description && (
          <p id={`${id}-desc`} className="text-xs text-text-tertiary mt-0.5">{description}</p>
        )}
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        className={cn(
          'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
          focusRing,
          checked ? 'bg-accent' : tones[tone].track,
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

export function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  tone = 'surface',
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  tone?: ControlTone
}) {
  return (
    <SettingRow label={label}>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          aria-label={label}
          className={cn(
            'appearance-none border rounded-md pl-2.5 pr-7 py-1 text-xs text-text-primary cursor-pointer transition-colors',
            focusRing,
            tones[tone].select,
          )}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className={tones[tone].option}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-text-tertiary pointer-events-none" />
      </div>
    </SettingRow>
  )
}
