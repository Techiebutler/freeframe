'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import useSWR, { mutate as globalMutate } from 'swr'
import * as Tabs from '@radix-ui/react-tabs'
import * as Switch from '@radix-ui/react-switch'
import * as Select from '@radix-ui/react-select'
import * as Dialog from '@radix-ui/react-dialog'
import {
  Palette,
  Droplets,
  List,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  Check,
  X,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TemplateEditorDialog } from '@/components/watermark/template-editor-dialog'
import { TemplatePicker } from '@/components/watermark/template-picker'
import { WatermarkPreview } from '@/components/watermark/watermark-preview'
import type {
  ProjectBranding,
  WatermarkSettings,
  WatermarkTemplate,
  MetadataField,
  MetadataFieldType,
  ProjectRole,
  ViewerLayout,
} from '@/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function SimpleSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && <label className="text-sm font-medium text-text-secondary">{label}</label>}
      <Select.Root value={value} onValueChange={(v) => onChange(v as T)}>
        <Select.Trigger className="inline-flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 h-9 text-sm text-text-primary hover:bg-bg-tertiary transition-colors focus:outline-none focus:ring-1 focus:ring-border-focus">
          <Select.Value />
          <ChevronDown className="h-4 w-4 text-text-tertiary shrink-0" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-bg-secondary shadow-xl">
            <Select.Viewport className="p-1">
              {options.map((opt) => (
                <Select.Item
                  key={opt.value}
                  value={opt.value}
                  className="relative flex items-center gap-2 rounded-sm px-7 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover cursor-pointer"
                >
                  <Select.ItemIndicator className="absolute left-2">
                    <Check className="h-3.5 w-3.5 text-accent" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{opt.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  )
}

// ─── Branding Tab ─────────────────────────────────────────────────────────────

function BrandingTab({ projectId }: { projectId: string }) {
  const key = `/projects/${projectId}/branding`
  const { data: branding } = useSWR<ProjectBranding>(key, () =>
    api.get<ProjectBranding>(key),
  )

  const [form, setForm] = React.useState<Partial<ProjectBranding>>({})
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [logoFile, setLogoFile] = React.useState<File | null>(null)
  const [uploadingLogo, setUploadingLogo] = React.useState(false)
  const logoInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (branding) setForm(branding)
  }, [branding])

  const set = <K extends keyof ProjectBranding>(key: K, value: ProjectBranding[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMsg('')
    try {
      await api.patch(key, {
        primary_color: form.primary_color,
        secondary_color: form.secondary_color,
        custom_title: form.custom_title,
        custom_footer: form.custom_footer,
        viewer_layout: form.viewer_layout,
        featured_field: form.featured_field,
      })
      setMsg('Branding saved.')
      globalMutate(key)
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async () => {
    if (!logoFile) return
    setUploadingLogo(true)
    try {
      const fd = new FormData()
      fd.append('file', logoFile)
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/projects/${projectId}/branding/logo`,
        {
          method: 'POST',
          body: fd,
          headers: {
            Authorization: `Bearer ${document.cookie.match(/access_token=([^;]+)/)?.[1] ?? ''}`,
          },
        },
      )
      setLogoFile(null)
      globalMutate(key)
    } catch {
      setMsg('Logo upload failed.')
    } finally {
      setUploadingLogo(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {/* Logo */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-secondary">Logo</label>
        <div className="flex items-center gap-3">
          {branding?.logo_s3_key && (
            <div className="h-12 w-12 rounded-lg border border-border bg-bg-tertiary overflow-hidden flex items-center justify-center text-text-tertiary text-xs">
              Logo
            </div>
          )}
          <input
            type="file"
            ref={logoInputRef}
            accept="image/*"
            className="hidden"
            onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => logoInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            {logoFile ? logoFile.name : 'Choose file'}
          </Button>
          {logoFile && (
            <Button
              type="button"
              size="sm"
              onClick={handleLogoUpload}
              loading={uploadingLogo}
            >
              Upload
            </Button>
          )}
        </div>
      </div>

      {/* Colors */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">Primary color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.primary_color ?? '#7c3aed'}
              onChange={(e) => set('primary_color', e.target.value)}
              className="h-9 w-12 rounded-md border border-border bg-bg-secondary cursor-pointer"
            />
            <Input
              value={form.primary_color ?? ''}
              onChange={(e) => set('primary_color', e.target.value)}
              placeholder="#7c3aed"
              className="font-mono"
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">Secondary color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.secondary_color ?? '#a78bfa'}
              onChange={(e) => set('secondary_color', e.target.value)}
              className="h-9 w-12 rounded-md border border-border bg-bg-secondary cursor-pointer"
            />
            <Input
              value={form.secondary_color ?? ''}
              onChange={(e) => set('secondary_color', e.target.value)}
              placeholder="#a78bfa"
              className="font-mono"
            />
          </div>
        </div>
      </div>

      <Input
        label="Custom title"
        value={form.custom_title ?? ''}
        onChange={(e) => set('custom_title', e.target.value)}
        placeholder="My Project Hub"
      />
      <Input
        label="Custom footer"
        value={form.custom_footer ?? ''}
        onChange={(e) => set('custom_footer', e.target.value)}
        placeholder="Confidential — do not distribute"
      />
      <Input
        label="Featured field"
        value={form.featured_field ?? ''}
        onChange={(e) => set('featured_field', e.target.value)}
        placeholder="Custom metadata field name"
      />

      <SimpleSelect<ViewerLayout>
        label="Viewer layout"
        value={form.viewer_layout ?? 'grid'}
        options={[
          { value: 'grid', label: 'Grid' },
          { value: 'reel', label: 'Reel' },
        ]}
        onChange={(v) => set('viewer_layout', v)}
      />

      {msg && <p className="text-xs text-text-secondary">{msg}</p>}

      <div className="flex justify-end">
        <Button type="submit" size="sm" loading={saving}>
          Save branding
        </Button>
      </div>
    </form>
  )
}

// ─── Watermark Tab ────────────────────────────────────────────────────────────

const EXEMPTABLE_ROLES: { value: ProjectRole; label: string }[] = [
  { value: 'owner', label: 'Owners' },
  { value: 'editor', label: 'Editors' },
  { value: 'reviewer', label: 'Reviewers' },
  { value: 'viewer', label: 'Viewers' },
]

function PolicyToggle({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-bg-secondary px-4 py-3">
      <div>
        <p className="text-sm font-medium text-text-primary">{title}</p>
        <p className="text-xs text-text-tertiary">{description}</p>
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onChange}
        className="relative inline-flex h-5 w-9 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus data-[state=checked]:bg-accent data-[state=unchecked]:bg-bg-tertiary"
      >
        <Switch.Thumb className="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
      </Switch.Root>
    </div>
  )
}

function WatermarkTab({ projectId }: { projectId: string }) {
  const policyKey = `/projects/${projectId}/watermark`
  const templatesKey = `/projects/${projectId}/watermark-templates`
  const { data: wm } = useSWR<WatermarkSettings>(policyKey, () =>
    api.get<WatermarkSettings>(policyKey),
  )
  const { data: templates } = useSWR<WatermarkTemplate[]>(templatesKey, () =>
    api.get<WatermarkTemplate[]>(templatesKey),
  )

  const [form, setForm] = React.useState<Partial<WatermarkSettings>>({})
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editingTemplate, setEditingTemplate] = React.useState<WatermarkTemplate | null>(null)

  React.useEffect(() => {
    if (wm) setForm(wm)
  }, [wm])

  const set = <K extends keyof WatermarkSettings>(k: K, value: WatermarkSettings[K]) =>
    setForm((f) => ({ ...f, [k]: value }))

  const exemptRoles = form.exempt_roles ?? ['owner', 'editor']
  const toggleExemptRole = (role: ProjectRole) => {
    const next = exemptRoles.includes(role)
      ? exemptRoles.filter((r) => r !== role)
      : [...exemptRoles, role]
    set('exempt_roles', next)
  }

  const selectedTemplate =
    templates?.find((t) => t.id === form.template_id) ?? null

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMsg('')
    try {
      await api.put(policyKey, {
        require_internal: form.require_internal ?? false,
        require_shares: form.require_shares ?? false,
        template_id: form.template_id,
        exempt_roles: exemptRoles,
      })
      setMsg('Watermark settings saved.')
      globalMutate(policyKey)
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteTemplate = async (template: WatermarkTemplate) => {
    try {
      await api.delete(`/watermark-templates/${template.id}`)
      if (form.template_id === template.id) set('template_id', null)
      globalMutate(templatesKey)
    } catch {
      // ignore — instance templates can only be removed by an admin
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSave} className="space-y-4">
        <PolicyToggle
          title="Watermark for team members"
          description="Show a watermark when project members play or download media. Exempt roles below never see it."
          checked={form.require_internal ?? false}
          onChange={(v) => set('require_internal', v)}
        />

        <PolicyToggle
          title="Require on shares"
          description="Every share link from this project gets a watermark — the toggle is locked on in share settings."
          checked={form.require_shares ?? false}
          onChange={(v) => set('require_shares', v)}
        />

        {/* Exempt roles */}
        <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-text-primary">Exempt roles</p>
          <p className="text-xs text-text-tertiary">
            These team members see clean media in the app. Share link viewers are
            never exempt.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {EXEMPTABLE_ROLES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => toggleExemptRole(value)}
                className={cn(
                  'h-7 px-3 rounded-full text-xs font-medium transition-colors border',
                  exemptRoles.includes(value)
                    ? 'bg-accent/15 border-accent/40 text-accent'
                    : 'bg-bg-tertiary border-transparent text-text-secondary hover:text-text-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Default template */}
        <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3 space-y-2">
          <p className="text-sm font-medium text-text-primary">Default template</p>
          <p className="text-xs text-text-tertiary">
            Used whenever a watermark is shown, unless a share link picks its own.
          </p>
          <TemplatePicker
            templates={templates ?? []}
            value={form.template_id ?? null}
            onChange={(id) => set('template_id', id)}
            defaultLabel="Built-in (centered viewer email)"
          />
          {selectedTemplate && (
            <WatermarkPreview blocks={selectedTemplate.blocks} className="mt-2" />
          )}
        </div>

        {msg && <p className="text-xs text-text-secondary">{msg}</p>}

        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={saving}>
            Save watermark settings
          </Button>
        </div>
      </form>

      {/* Template manager */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-text-primary">Templates</h3>
            <p className="text-xs text-text-tertiary">
              Reusable watermark designs. Shared templates come from your instance
              admin.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditingTemplate(null)
              setEditorOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            New template
          </Button>
        </div>

        {!templates || templates.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary p-6 text-center">
            <p className="text-sm text-text-secondary">No templates yet.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden divide-y divide-border">
            {templates.map((template) => (
              <div
                key={template.id}
                className="flex items-center justify-between px-4 py-2.5 hover:bg-bg-tertiary transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {template.name}
                  </p>
                  <p className="text-xs text-text-tertiary">
                    {template.blocks.length}{' '}
                    {template.blocks.length === 1 ? 'text block' : 'text blocks'}
                    {template.scope === 'instance' ? ' · shared across instance' : ''}
                  </p>
                </div>
                {template.scope === 'project' && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingTemplate(template)
                        setEditorOpen(true)
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteTemplate(template)}
                      className="text-status-error hover:text-status-error"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <TemplateEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        template={editingTemplate}
        projectId={projectId}
        onSaved={() => globalMutate(templatesKey)}
      />
    </div>
  )
}

// ─── Metadata Tab ─────────────────────────────────────────────────────────────

const FIELD_TYPES: { value: MetadataFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'multi_select', label: 'Multi Select' },
]

function CreateFieldDialog({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [fieldType, setFieldType] = React.useState<MetadataFieldType>('text')
  const [options, setOptions] = React.useState('')
  const [required, setRequired] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    setError('')
    const opts =
      fieldType === 'select' || fieldType === 'multi_select'
        ? options
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean)
        : null
    try {
      await api.post(`/projects/${projectId}/metadata-fields`, {
        name: name.trim(),
        field_type: fieldType,
        options: opts,
        required,
      })
      setOpen(false)
      setName('')
      setFieldType('text')
      setOptions('')
      setRequired(false)
      onDone()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create field')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          Add Field
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Title className="text-base font-semibold text-text-primary">
            Add Metadata Field
          </Dialog.Title>
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <Input
              label="Field name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Scene number"
              required
            />
            <SimpleSelect<MetadataFieldType>
              label="Field type"
              value={fieldType}
              options={FIELD_TYPES}
              onChange={setFieldType}
            />
            {(fieldType === 'select' || fieldType === 'multi_select') && (
              <Input
                label="Options (comma separated)"
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                placeholder="Option 1, Option 2, Option 3"
              />
            )}
            <div className="flex items-center justify-between rounded-lg border border-border bg-bg-tertiary px-3 py-2">
              <span className="text-sm text-text-secondary">Required</span>
              <Switch.Root
                checked={required}
                onCheckedChange={setRequired}
                className="relative inline-flex h-5 w-9 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none data-[state=checked]:bg-accent data-[state=unchecked]:bg-bg-tertiary"
              >
                <Switch.Thumb className="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
              </Switch.Root>
            </div>
            {error && <p className="text-xs text-status-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={loading}>
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function MetadataTab({ projectId }: { projectId: string }) {
  const key = `/projects/${projectId}/metadata-fields`
  const { data: fields, isLoading } = useSWR<MetadataField[]>(
    key,
    () => api.get<MetadataField[]>(key),
  )

  const handleDelete = async (fieldId: string) => {
    try {
      await api.delete(`/metadata-fields/${fieldId}`)
      globalMutate(key)
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">
          Define custom fields for assets in this project.
        </p>
        <CreateFieldDialog projectId={projectId} onDone={() => globalMutate(key)} />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
          ))}
        </div>
      ) : !fields || fields.length === 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary p-6 text-center">
          <p className="text-sm text-text-secondary">No custom fields yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Name</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Options</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Required</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.id} className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors">
                  <td className="px-4 py-3 font-medium text-text-primary">{field.name}</td>
                  <td className="px-4 py-3 text-text-secondary capitalize">
                    {field.field_type.replace('_', ' ')}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">
                    {Array.isArray(field.options) && field.options.length > 0
                      ? (field.options as string[]).join(', ')
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-tertiary">
                    {field.required ? 'Yes' : 'No'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(field.id)}
                      className="text-status-error hover:text-status-error"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProjectSettingsPage() {
  const params = useParams()
  const projectId = params.id as string

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <h1 className="text-xl font-semibold text-text-primary">Project Settings</h1>

      <Tabs.Root defaultValue="branding">
        <Tabs.List className="flex items-center gap-1 border-b border-border -mb-px">
          {[
            { value: 'branding', label: 'Branding', icon: Palette },
            { value: 'watermark', label: 'Watermark', icon: Droplets },
            { value: 'metadata', label: 'Metadata Fields', icon: List },
          ].map(({ value, label, icon: Icon }) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                'border-transparent text-text-secondary hover:text-text-primary',
                'data-[state=active]:border-accent data-[state=active]:text-accent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <div className="pt-6">
          <Tabs.Content value="branding">
            <BrandingTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="watermark">
            <WatermarkTab projectId={projectId} />
          </Tabs.Content>
          <Tabs.Content value="metadata">
            <MetadataTab projectId={projectId} />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  )
}
