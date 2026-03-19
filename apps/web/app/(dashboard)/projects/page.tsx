'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import * as Select from '@radix-ui/react-select'
import { Plus, LayoutGrid, List, FolderOpen, ChevronDown, X, Check, Filter, ArrowUpDown, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProjectCard } from '@/components/projects/project-card'
import { EmptyState } from '@/components/shared/empty-state'
import type { Project, ProjectType } from '@/types'

type ViewMode = 'grid' | 'list'

interface CreateProjectForm {
  name: string
  description: string
  project_type: ProjectType
}

export default function ProjectsPage() {
  const router = useRouter()
  const [viewMode, setViewMode] = React.useState<ViewMode>('grid')
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [isCreating, setIsCreating] = React.useState(false)
  const [formError, setFormError] = React.useState('')

  const [form, setForm] = React.useState<CreateProjectForm>({
    name: '',
    description: '',
    project_type: 'personal',
  })

  const { data: projects, isLoading, mutate } = useSWR<Project[]>(
    '/projects',
    () => api.get<Project[]>('/projects'),
  )


  const resetForm = () => {
    setForm({ name: '', description: '', project_type: 'personal' })
    setFormError('')
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) {
      setFormError('Project name is required.')
      return
    }

    setIsCreating(true)
    setFormError('')

    try {
      const created = await api.post<Project>('/projects', {
        name: form.name.trim(),
        description: form.description.trim() || null,
        project_type: form.project_type,
      })
      await mutate()
      setDialogOpen(false)
      resetForm()
      router.push(`/projects/${created.id}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project'
      setFormError(message)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Projects</h1>
          {projects && (
            <p className="mt-0.5 text-sm text-text-secondary">
              {projects.length} project{projects.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={cn(
                'p-1.5 transition-colors',
                viewMode === 'grid' ? 'bg-accent-muted text-accent' : 'text-text-secondary hover:bg-bg-hover',
              )}
              aria-label="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={cn(
                'p-1.5 transition-colors',
                viewMode === 'list' ? 'bg-accent-muted text-accent' : 'text-text-secondary hover:bg-bg-hover',
              )}
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          <Dialog.Root
            open={dialogOpen}
            onOpenChange={(open) => {
              setDialogOpen(open)
              if (!open) resetForm()
            }}
          >
            <Dialog.Trigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4" />
                New Project
              </Button>
            </Dialog.Trigger>

            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
                {/* Close button */}
                <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
                  <X className="h-4 w-4" />
                </Dialog.Close>

                <Dialog.Title className="text-base font-semibold text-text-primary">
                  New Project
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-text-secondary">
                  Create a personal or team project to organize your assets.
                </Dialog.Description>

                <form onSubmit={handleCreate} className="mt-5 space-y-4">
                  <Input
                    label="Project name"
                    placeholder="e.g. Brand Campaign 2025"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    required
                  />

                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">
                      Description
                    </label>
                    <textarea
                      rows={2}
                      placeholder="Optional description..."
                      value={form.description}
                      onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      className="flex w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary resize-none focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus"
                    />
                  </div>

                  {/* Project type */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-text-secondary">
                      Project type
                    </label>
                    <div className="flex gap-2">
                      {(['personal', 'team'] as ProjectType[]).map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, project_type: type, team_id: '' }))}
                          className={cn(
                            'flex-1 rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors',
                            form.project_type === type
                              ? 'border-accent bg-accent-muted text-accent'
                              : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                          )}
                        >
                          {type}
                        </button>
                      ))}
                    </div>
                  </div>


                  {formError && (
                    <p className="text-sm text-status-error">{formError}</p>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <Dialog.Close asChild>
                      <Button type="button" variant="secondary" size="sm">
                        Cancel
                      </Button>
                    </Dialog.Close>
                    <Button type="submit" size="sm" loading={isCreating}>
                      Create project
                    </Button>
                  </div>
                </form>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 text-sm">
        <button className="flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2.5 py-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
          <Filter className="h-3.5 w-3.5" />
          <span>Filtered by</span>
          <span className="text-accent">Active Projects</span>
        </button>
        <button className="flex items-center gap-1.5 rounded-md border border-border bg-bg-secondary px-2.5 py-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
          <ArrowUpDown className="h-3.5 w-3.5" />
          <span>Sorted by</span>
          <span className="text-text-primary">Name</span>
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div
          className={cn(
            viewMode === 'grid'
              ? 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
              : 'flex flex-col gap-2',
          )}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl bg-bg-secondary" />
          ))}
        </div>
      ) : !projects || projects.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {/* New Project card */}
          <button
            onClick={() => setDialogOpen(true)}
            className="group flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-bg-secondary/50 h-44 hover:border-accent/50 hover:bg-bg-tertiary transition-all duration-200"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-tertiary text-text-tertiary group-hover:bg-accent group-hover:text-white transition-colors">
              <Plus className="h-5 w-5" />
            </div>
            <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">New Project</span>
          </button>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
          {/* New Project card at the end */}
          <button
            onClick={() => setDialogOpen(true)}
            className="group flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-bg-secondary/50 min-h-[176px] hover:border-accent/50 hover:bg-bg-tertiary transition-all duration-200"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-tertiary text-text-tertiary group-hover:bg-accent group-hover:text-white transition-colors">
              <Plus className="h-5 w-5" />
            </div>
            <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">New Project</span>
          </button>
        </div>
      ) : (
        /* Frame.io-style table view */
        <div className="rounded-xl border border-border overflow-hidden bg-bg-secondary">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_180px_120px_140px_100px] gap-4 px-4 py-2.5 border-b border-border bg-bg-tertiary/50 text-xs font-medium text-text-secondary">
            <span className="flex items-center gap-1">Project <ArrowUpDown className="h-3 w-3" /></span>
            <span>Workspace</span>
            <span>Storage</span>
            <span>Creation Date</span>
            <span>Status</span>
          </div>
          {/* Table rows */}
          {projects.map((project) => (
            <a
              key={project.id}
              href={`/projects/${project.id}`}
              className="grid grid-cols-[1fr_180px_120px_140px_100px] gap-4 px-4 py-3 hover:bg-bg-hover transition-colors border-b border-border last:border-b-0 items-center"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-gradient-to-br from-violet-600 to-fuchsia-500">
                  <FolderOpen className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="text-sm font-medium text-text-primary truncate">
                  {project.name}
                </span>
              </div>
              <span className="text-sm text-text-secondary truncate">
                {project.org_id ? 'Workspace' : '—'}
              </span>
              <span className="text-sm text-text-tertiary">0 B (0 items)</span>
              <span className="text-sm text-text-tertiary">
                {new Date(project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <span className="inline-flex items-center rounded-full bg-status-success/10 px-2 py-0.5 text-2xs font-medium text-status-success">
                Active
              </span>
            </a>
          ))}
          {/* New Project row */}
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-3 px-4 py-3 w-full hover:bg-bg-hover transition-colors text-left"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-border text-text-tertiary hover:border-accent hover:text-accent transition-colors">
              <Plus className="h-3.5 w-3.5" />
            </div>
            <span className="text-sm text-text-secondary">New Project</span>
          </button>
        </div>
      )}
    </div>
  )
}
