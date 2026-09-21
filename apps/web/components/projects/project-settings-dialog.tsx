'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { X, ImagePlus, Globe, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { Project } from '@/types'

interface ProjectSettingsDialogProps {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: () => void
}

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onUpdated,
}: ProjectSettingsDialogProps) {
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description || '')
  const [isPublic, setIsPublic] = React.useState(project.is_public ?? false)
  const [posterPreview, setPosterPreview] = React.useState<string | null>(project.poster_url ?? null)
  const [posterFile, setPosterFile] = React.useState<File | null>(null)
  const [saving, setSaving] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Sync state when project changes
  React.useEffect(() => {
    setName(project.name)
    setDescription(project.description || '')
    setIsPublic(project.is_public ?? false)
    setPosterPreview(project.poster_url ?? null)
    setPosterFile(null)
  }, [project])

  const handlePosterSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPosterFile(file)
    setPosterPreview(URL.createObjectURL(file))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Upload poster if changed
      if (posterFile) {
        const formData = new FormData()
        formData.append('file', posterFile)
        await api.upload(`/projects/${project.id}/poster`, formData)
      }

      // Update project fields
      await api.patch(`/projects/${project.id}`, {
        name: name.trim(),
        description: description.trim() || null,
        is_public: isPublic,
      })

      onUpdated()
      onOpenChange(false)
    } catch {
      // silently fail
    } finally {
      setSaving(false)
    }
  }

  const gradient = getGradientForProject(project.id)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] rounded-xl border border-border bg-bg-secondary shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <Dialog.Title className="text-base font-semibold text-text-primary">
              Project settings
            </Dialog.Title>
            <Dialog.Close className="text-text-tertiary hover:text-text-primary transition-colors">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="p-6">
            <div className="flex gap-6">
              {/* Left: Poster + Name */}
              <div className="flex flex-col items-center gap-3 w-56 shrink-0">
                {/* Poster area */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="relative w-full aspect-square rounded-xl overflow-hidden border-2 border-dashed border-border hover:border-accent/50 transition-colors group"
                >
                  {posterPreview ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={posterPreview} alt="Poster" className="h-full w-full object-cover" />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <ImagePlus className="h-6 w-6 text-white" />
                      </div>
                    </>
                  ) : (
                    <div className={cn('h-full w-full bg-gradient-to-br flex items-center justify-center', gradient)}>
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/20 text-white/80 group-hover:bg-black/30 transition-colors">
                        <ImagePlus className="h-6 w-6" />
                      </div>
                    </div>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handlePosterSelect}
                />

                {/* Project name input */}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full text-center text-sm font-semibold text-text-primary bg-bg-tertiary rounded-lg px-3 py-2 border border-border focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-colors"
                  placeholder="Project name"
                />
              </div>

              {/* Right: Settings */}
              <div className="flex-1 space-y-5">
                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-tertiary uppercase tracking-wider">Description</label>
                  <textarea
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional project description..."
                    className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-colors"
                  />
                </div>

                {/* Public / Private toggle */}
                <div className="rounded-xl border border-border bg-bg-tertiary/50 p-4">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg mt-0.5',
                      isPublic ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-tertiary',
                    )}>
                      {isPublic ? <Globe className="h-4.5 w-4.5" /> : <Lock className="h-4.5 w-4.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-text-primary">
                          {isPublic ? 'Public Project' : 'Private Project'}
                        </span>
                        <Switch.Root
                          checked={isPublic}
                          onCheckedChange={setIsPublic}
                          className={cn(
                            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors',
                            isPublic ? 'bg-accent' : 'bg-bg-tertiary',
                          )}
                        >
                          <Switch.Thumb className={cn(
                            'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                            isPublic ? 'translate-x-[18px]' : 'translate-x-0.5',
                            'mt-0.5',
                          )} />
                        </Switch.Root>
                      </div>
                      <p className="text-xs text-text-tertiary mt-0.5">
                        {isPublic
                          ? 'All users in the system can view this project.'
                          : 'Only invited members can access this project.'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">Cancel</Button>
            </Dialog.Close>
            <Button size="sm" onClick={handleSave} loading={saving} disabled={!name.trim()}>
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

