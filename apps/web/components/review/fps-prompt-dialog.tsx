'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]

interface FpsPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (fps: number) => void
}

export function FpsPromptDialog({
  open,
  onOpenChange,
  onConfirm,
}: FpsPromptDialogProps) {
  const [fps, setFps] = React.useState<number>(25)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-5 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Title className="text-sm font-semibold text-text-primary">
            Frame rate needed
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-text-tertiary">
            This video was uploaded before FreeFrame started capturing frame
            rates automatically, so its fps isn&apos;t on file. Pick the
            video&apos;s original frame rate so exported markers land on the
            correct frames. (Newly uploaded videos won&apos;t ask this.)
          </Dialog.Description>

          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {FPS_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={fps === option}
                onClick={() => setFps(option)}
                className={cn(
                  'rounded-md border px-2 py-1.5 text-[13px] font-medium transition-colors',
                  fps === option
                    ? 'border-accent bg-accent-muted text-accent'
                    : 'border-border text-text-secondary hover:bg-bg-hover',
                )}
              >
                {option}
              </button>
            ))}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onConfirm(fps)
                onOpenChange(false)
              }}
            >
              Export
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
