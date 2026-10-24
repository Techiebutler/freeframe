'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { mutate as globalMutate } from 'swr'
import { AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

/**
 * The Danger tab of project settings: deleting the project.
 *
 * Typing the project's name is the confirmation, so the target is explicit.
 * The copy says what really happens: the project goes from the app at once,
 * its data is purged after the instance's retention period, and the app has
 * no way to bring it back in between.
 */
export function ProjectDangerTab({ projectId, projectName }: { projectId: string; projectName: string }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const inputId = React.useId()

  const matches = typed.trim() === projectName.trim()

  async function deleteProject() {
    setError(null)
    try {
      await api.delete(`/projects/${projectId}`)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The project could not be deleted')
      // Keeps the dialog open with the reason.
      throw err
    }
    void globalMutate('/projects')
    router.push('/projects')
  }

  return (
    <section className="rounded-xl border border-status-error/40 bg-status-error/5">
      <div className="flex items-start gap-3 p-5">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-error" />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-text-primary">Delete this project</h2>
          <p className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{projectName}</span> and everything in
            it (folders, assets, versions, comments and share links) disappear for everyone right
            away, and its share links stop working. The data is permanently deleted after the
            retention period. It cannot be restored from the app.
          </p>
        </div>
      </div>
      <div className="flex justify-end border-t border-status-error/25 px-5 py-3">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            setTyped('')
            setError(null)
            setOpen(true)
          }}
        >
          Delete project
        </Button>
      </div>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete "${projectName}"?`}
        description="It disappears now and is permanently deleted after the retention period. It cannot be restored from the app."
        confirmLabel="Delete project"
        variant="danger"
        confirmDisabled={!matches}
        error={error}
        onConfirm={deleteProject}
      >
        <label htmlFor={inputId} className="block space-y-1.5">
          <span className="text-xs text-text-tertiary">
            Type <span className="font-medium text-text-primary">{projectName}</span> to confirm
          </span>
          <input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full rounded-md border border-border bg-bg-primary px-3 text-[16px] text-text-primary outline-none focus:border-border-focus [@media(hover:hover)]:text-sm"
          />
        </label>
      </ConfirmDialog>
    </section>
  )
}
