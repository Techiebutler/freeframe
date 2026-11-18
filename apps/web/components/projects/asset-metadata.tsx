'use client'

import * as React from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { Star, ChevronDown, Check, CalendarDays, Tag, X } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import type {
  Asset,
  AssetStatus,
  MetadataField,
  AssetMetadata,
  User,
  MetadataFieldType,
} from '@/types'

// ─── Star rating ──────────────────────────────────────────────────────────────

function StarRating({
  value,
  onChange,
}: {
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [hover, setHover] = React.useState(0)
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => {
        const star = i + 1
        const filled = star <= (hover || value || 0)
        return (
          <button
            key={i}
            type="button"
            className="p-0.5 transition-transform hover:scale-110"
            onMouseEnter={() => setHover(star)}
            onMouseLeave={() => setHover(0)}
            onClick={() => onChange(value === star ? null : star)}
          >
            <Star
              className={cn(
                'h-4 w-4 transition-colors',
                filled ? 'fill-yellow-400 text-yellow-400' : 'text-text-tertiary',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}

// ─── Custom field renderer ────────────────────────────────────────────────────

function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: MetadataField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const type = field.field_type as MetadataFieldType

  if (type === 'text') {
    return (
      <input
        type="text"
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        placeholder={`Enter ${field.name.toLowerCase()}`}
      />
    )
  }

  if (type === 'number') {
    return (
      <input
        type="number"
        value={(value as number) ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        placeholder="0"
      />
    )
  }

  if (type === 'date') {
    return (
      <input
        type="date"
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
      />
    )
  }

  if (type === 'select') {
    const opts = (field.options as string[]) ?? []
    const current = (value as string) ?? ''
    return (
      <Select.Root value={current} onValueChange={onChange}>
        <Select.Trigger className="inline-flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-8 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus w-full">
          <Select.Value placeholder={`Select ${field.name}`} />
          <ChevronDown className="h-3.5 w-3.5 text-text-tertiary shrink-0" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl">
            <Select.Viewport className="p-1">
              {opts.map((opt) => (
                <Select.Item
                  key={opt}
                  value={opt}
                  className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  <Select.ItemIndicator className="absolute left-2">
                    <Check className="h-3.5 w-3.5 text-accent" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{opt}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    )
  }

  if (type === 'multi_select') {
    const opts = (field.options as string[]) ?? []
    const selected = (value as string[]) ?? []
    const toggle = (opt: string) => {
      if (selected.includes(opt)) {
        onChange(selected.filter((s) => s !== opt))
      } else {
        onChange([...selected, opt])
      }
    }
    return (
      <div className="flex flex-wrap gap-1.5">
        {opts.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors',
              selected.includes(opt)
                ? 'bg-accent-muted border-accent text-text-primary'
                : 'border-border text-text-secondary hover:border-text-secondary',
            )}
          >
            {opt}
          </button>
        ))}
      </div>
    )
  }

  return null
}

// ─── Main component ───────────────────────────────────────────────────────────

interface AssetMetadataEditorProps {
  asset: Asset
  projectId: string
  onUpdated?: () => void
}

export function AssetMetadataEditor({ asset, projectId, onUpdated }: AssetMetadataEditorProps) {
  const assetKey = `/assets/${asset.id}`

  // Built-in fields
  const [status, setStatus] = React.useState<AssetStatus>(asset.status)
  const [rating, setRating] = React.useState<number | null>(asset.rating)
  const [dueDate, setDueDate] = React.useState<string>(asset.due_date ?? '')
  const [keywords, setKeywords] = React.useState<string[]>(asset.keywords ?? [])
  const [keywordInput, setKeywordInput] = React.useState('')
  const [assigneeId, setAssigneeId] = React.useState<string>(asset.assignee_id ?? '')

  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState('')

  // Custom fields
  const { data: metadataFields } = useSWR<MetadataField[]>(
    `/projects/${projectId}/metadata-fields`,
    () => api.get<MetadataField[]>(`/projects/${projectId}/metadata-fields`),
  )

  const { data: assetMetadata } = useSWR<AssetMetadata[]>(
    `/assets/${asset.id}/metadata`,
    () => api.get<AssetMetadata[]>(`/assets/${asset.id}/metadata`),
  )

  const [customValues, setCustomValues] = React.useState<Record<string, unknown>>({})

  React.useEffect(() => {
    if (assetMetadata && metadataFields) {
      const map: Record<string, unknown> = {}
      for (const m of assetMetadata) {
        map[m.field_id] = m.value
      }
      setCustomValues(map)
    }
  }, [assetMetadata, metadataFields])

  const handleAddKeyword = () => {
    const kw = keywordInput.trim()
    if (kw && !keywords.includes(kw)) {
      setKeywords([...keywords, kw])
      setKeywordInput('')
    }
  }

  const handleRemoveKeyword = (kw: string) => {
    setKeywords(keywords.filter((k) => k !== kw))
  }

  const handleSave = async () => {
    setSaving(true)
    setMsg('')
    try {
      await api.patch(`/assets/${asset.id}/metadata`, {
        status,
        rating,
        due_date: dueDate || null,
        keywords,
        assignee_id: assigneeId || null,
        custom_fields: customValues,
      })
      setMsg('Saved.')
      globalMutate(assetKey)
      onUpdated?.()
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Rating */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide">Rating</label>
        <StarRating value={rating} onChange={setRating} />
      </div>

      {/* Assignee */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide">Assignee</label>
        <input
          type="text"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          placeholder="User ID"
          className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        />
      </div>

      {/* Due date */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex items-center gap-1">
          <CalendarDays className="h-3 w-3" />
          Due Date
        </label>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="flex h-8 w-full rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
        />
      </div>

      {/* Keywords */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-tertiary uppercase tracking-wide flex items-center gap-1">
          <Tag className="h-3 w-3" />
          Keywords
        </label>
        <div className="flex flex-wrap gap-1.5 mb-1">
          {keywords.map((kw) => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary border border-border px-2 py-0.5 text-xs text-text-secondary"
            >
              {kw}
              <button
                type="button"
                onClick={() => handleRemoveKeyword(kw)}
                className="text-text-tertiary hover:text-text-primary transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddKeyword()
              }
            }}
            placeholder="Add keyword..."
            className="flex h-8 flex-1 rounded-md border border-border bg-bg-secondary px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-colors"
          />
          <Button type="button" variant="secondary" size="sm" onClick={handleAddKeyword}>
            Add
          </Button>
        </div>
      </div>

      {/* Custom fields */}
      {metadataFields && metadataFields.length > 0 && (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-xs font-medium text-text-tertiary uppercase tracking-wide">Custom Fields</p>
          {metadataFields.map((field) => (
            <div key={field.id} className="flex flex-col gap-1.5">
              <label className="text-sm text-text-secondary flex items-center gap-1">
                {field.name}
                {field.required && <span className="text-status-error">*</span>}
              </label>
              <CustomFieldInput
                field={field}
                value={customValues[field.id]}
                onChange={(v) =>
                  setCustomValues((prev) => ({ ...prev, [field.id]: v }))
                }
              />
            </div>
          ))}
        </div>
      )}

      {/* Save */}
      <div className="flex items-center justify-between pt-2 border-t border-border">
        {msg && <p className="text-xs text-text-secondary">{msg}</p>}
        <div className="ml-auto">
          <Button size="sm" loading={saving} onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
