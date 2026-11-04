'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tooltip from '@radix-ui/react-tooltip'
import { AlertCircle, Loader2, CheckCircle2, ChevronDown, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, ApiError } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { menuContentClass, menuDangerItemClass, menuItemClass, useAfterClose } from '@/components/shared/item-menu'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion, AssetVersionStatus, DeletedAssetVersion } from '@/types'

export const versionStatusConfig: Record<
  AssetVersionStatus,
  { label: string; className: string; icon: React.ReactNode }
> = {
  uploading: {
    label: 'Uploading',
    className: 'text-status-info',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  processing: {
    label: 'Processing',
    className: 'text-status-warning',
    icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
  },
  ready: {
    label: 'Ready',
    className: 'text-status-success',
    icon: <CheckCircle2 className="h-2.5 w-2.5" />,
  },
  failed: {
    label: 'Failed',
    className: 'text-status-error',
    icon: <AlertCircle className="h-2.5 w-2.5" />,
  },
}

/** What deleting or restoring a version answers with. */
interface VersionChangeResponse {
  latest_version: AssetVersion | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a deleted version can still be restored, in words. Days, never
 * weeks: `restorable_until` is when the retention purge may take it, and once
 * that has passed it is gone at the purge's next run (03:00 UTC).
 */
export function restorableFor(version: DeletedAssetVersion, now: number = Date.now()): string | null {
  if (!version.restorable_until) return null
  const days = Math.ceil((new Date(version.restorable_until).getTime() - now) / DAY_MS)
  if (days <= 0) return 'removed at the next cleanup'
  return days === 1 ? 'restorable for 1 more day' : `restorable for ${days} days`
}

/**
 * Why the shown version cannot be deleted, or null when it can. Mirrors the
 * server's refusals, so the menu says so instead of offering a 409: an upload
 * in flight is discarded from the uploads panel, and the asset has to keep a
 * version that is ready or processing (an upload or a failed version can be
 * reclaimed, and the asset with it).
 */
export function deleteVersionBlocker(version: AssetVersion, versions: AssetVersion[]): string | null {
  if (version.processing_status === 'uploading') {
    return 'Still uploading. Discard it in the uploads panel.'
  }
  const others = versions.filter((v) => v.id !== version.id)
  const othersKept = others.some(
    (v) => v.processing_status === 'ready' || v.processing_status === 'processing',
  )
  if (othersKept) return null
  // Something else is there, but nothing that plays: a failed version or an
  // upload in flight, either of which the reaper can take with the asset.
  return others.length > 0 ? 'Asset needs at least 1 playable version.' : 'Asset needs at least 1 version.'
}

interface VersionSwitcherProps {
  versions: AssetVersion[]
  className?: string
  /**
   * Show each version's ⋯ menu (delete, restore) and the deleted versions that
   * can still be restored. Only for editors and above; never on a share page.
   */
  canDelete?: boolean
  /** Called once a version is deleted or restored, with what the server now reports as latest. */
  onVersionsChanged?: (latest: AssetVersion | null) => void
  /**
   * Called when the version on screen was deleted and the switcher moved to
   * `now`, so the page can say so. Nothing else ever changes the view.
   */
  onShownVersionDeleted?: (deleted: AssetVersion, now: AssetVersion | null) => void
}

type Row =
  | { kind: 'live'; version: AssetVersion }
  | { kind: 'deleted'; version: DeletedAssetVersion }

const rowItemClass =
  'flex-1 flex items-center justify-between gap-3 px-2.5 py-2 rounded-lg text-sm cursor-pointer outline-none transition-colors'

export function VersionSwitcher({
  versions, className, canDelete = false, onVersionsChanged, onShownVersionDeleted,
}: VersionSwitcherProps) {
  const currentVersion = useReviewStore((s) => s.currentVersion)
  const setCurrentVersion = useReviewStore((s) => s.setCurrentVersion)
  const [pendingDelete, setPendingDelete] = React.useState<AssetVersion | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [deleted, setDeleted] = React.useState<DeletedAssetVersion[]>([])
  const [restoreError, setRestoreError] = React.useState<string | null>(null)
  // Held here so a restore can keep the menu open until it has an answer: a
  // refusal is shown in the menu, a success closes it.
  const [menuOpen, setMenuOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  // A pick that opens a dialog runs once the menu has closed (see useAfterClose).
  const { schedule, onCloseAutoFocus } = useAfterClose()

  const sorted = React.useMemo(
    () => [...versions].sort((a, b) => a.version_number - b.version_number),
    [versions],
  )
  const assetId = sorted[0]?.asset_id

  // Asked again after each delete or restore, by bumping the revision.
  const [deletedRevision, setDeletedRevision] = React.useState(0)
  const refreshDeleted = () => setDeletedRevision((n) => n + 1)
  React.useEffect(() => {
    if (!canDelete || !assetId) return
    let live = true
    api.get<DeletedAssetVersion[]>(`/assets/${assetId}/deleted-versions`).then(
      (rows) => { if (live) setDeleted(rows ?? []) },
      // The list is a convenience for restoring; without it the switcher still switches.
      () => { if (live) setDeleted([]) },
    )
    return () => { live = false }
  }, [canDelete, assetId, deletedRevision])

  if (sorted.length === 0) return null

  async function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    setDeleteError(null)
    let latest: AssetVersion | null
    try {
      const res = await api.delete<VersionChangeResponse>(
        `/assets/${target.asset_id}/versions/${target.id}`,
      )
      latest = res?.latest_version ?? null
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.detail : 'Could not delete this version.')
      throw err
    }
    // The deleted version cannot stay on screen. Move to the newest one left
    // that can be watched, which is what opening the asset would pick, and to
    // the server's latest when none of them is ready.
    const remaining = sorted.filter((v) => v.id !== target.id)
    const next =
      [...remaining].reverse().find((v) => v.processing_status === 'ready') ?? latest
    if (useReviewStore.getState().currentVersion?.id === target.id) {
      if (next) setCurrentVersion(next)
      onShownVersionDeleted?.(target, next)
    }
    refreshDeleted()
    onVersionsChanged?.(latest)
  }

  async function restore(target: DeletedAssetVersion) {
    setRestoreError(null)
    let latest: AssetVersion | null
    try {
      const res = await api.post<VersionChangeResponse>(
        `/assets/${target.asset_id}/versions/${target.id}/restore`,
      )
      latest = res?.latest_version ?? null
    } catch (err) {
      setRestoreError(
        `v${target.version_number}: ${err instanceof ApiError ? err.detail : 'Could not restore this version.'}`,
      )
      refreshDeleted()
      return
    }
    setMenuOpen(false)
    setDeleted((rows) => rows.filter((v) => v.id !== target.id))
    onVersionsChanged?.(latest)
  }

  // Surface an in-flight new version (uploading/transcoding) on the always-visible
  // trigger — otherwise its status is only visible after opening the dropdown (#118).
  const latest = sorted[sorted.length - 1]
  const latestStatus = latest?.processing_status
  const inFlightCfg =
    latestStatus === 'uploading' || latestStatus === 'processing'
      ? versionStatusConfig[latestStatus]
      : null

  // Live and deleted versions in one list, by number. A deleted one is only
  // there to be restored, so it is listed for those who may restore it.
  const shownDeleted = canDelete ? deleted.filter((d) => !sorted.some((v) => v.id === d.id)) : []
  const rows: Row[] = [
    ...sorted.map((version): Row => ({ kind: 'live', version })),
    ...shownDeleted.map((version): Row => ({ kind: 'deleted', version })),
  ].sort((a, b) => a.version.version_number - b.version.version_number)
  const hasMenu = rows.length > 1

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <span className="text-xs text-text-tertiary shrink-0">Version:</span>
      <DropdownMenu.Root
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setRestoreError(null)
          setMenuOpen(open)
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button ref={triggerRef} className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors outline-none">
            <span>v{currentVersion?.version_number ?? latest.version_number}</span>
            {inFlightCfg && (
              <span
                data-testid="version-status-indicator"
                className="inline-flex items-center gap-1 text-[11px] text-white/90"
                title={`v${latest.version_number} — ${inFlightCfg.label}`}
              >
                {inFlightCfg.icon}
                {inFlightCfg.label}
              </span>
            )}
            {hasMenu && <ChevronDown className="h-3 w-3 opacity-70" />}
          </button>
        </DropdownMenu.Trigger>
        {hasMenu && (
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              onCloseAutoFocus={onCloseAutoFocus}
              className="z-[100] min-w-[200px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            >
              {rows.map((row) => {
                const version = row.version
                if (row.kind === 'deleted') {
                  const until = restorableFor(row.version)
                  return (
                    <div key={version.id} data-testid={`version-row-v${version.version_number}`} className="flex items-center gap-0.5 mx-1">
                      {/* Listed to be restored, not to be watched: never selectable. */}
                      <DropdownMenu.Item
                        disabled
                        className={cn(rowItemClass, 'text-text-tertiary opacity-60 cursor-not-allowed')}
                      >
                        <span className="flex flex-col">
                          <span className="line-through">v{version.version_number}</span>
                          {until && <span className="text-[10px] no-underline">{until}</span>}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[11px]" title={until ?? 'Deleted'}>
                          <Trash2 className="h-2.5 w-2.5" />
                          Deleted
                        </span>
                      </DropdownMenu.Item>
                      <VersionActions version={version.version_number}>
                        <DropdownMenu.Item
                          className={menuItemClass}
                          onSelect={(e) => {
                            e.preventDefault()
                            void restore(row.version)
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5 text-text-tertiary" />
                          Restore version
                        </DropdownMenu.Item>
                      </VersionActions>
                    </div>
                  )
                }
                const isActive = currentVersion?.id === version.id
                const statusCfg = versionStatusConfig[version.processing_status]
                const isDisabled =
                  version.processing_status === 'uploading' ||
                  version.processing_status === 'processing'
                const blocker = canDelete ? deleteVersionBlocker(version, sorted) : null
                return (
                  <div key={version.id} data-testid={`version-row-v${version.version_number}`} className="flex items-center gap-0.5 mx-1">
                    <DropdownMenu.Item
                      disabled={isDisabled}
                      onSelect={() => setCurrentVersion(version)}
                      className={cn(
                        rowItemClass,
                        isActive
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary data-[highlighted]:bg-bg-hover',
                        isDisabled && 'opacity-50 cursor-not-allowed',
                      )}
                    >
                      <span>v{version.version_number}</span>
                      <span
                        className={cn('inline-flex items-center gap-1 text-[11px]', statusCfg.className)}
                        title={statusCfg.label}
                      >
                        {statusCfg.icon}
                        {statusCfg.label}
                      </span>
                    </DropdownMenu.Item>
                    {canDelete && (
                      <VersionActions version={version.version_number} unavailable={blocker}>
                        <DropdownMenu.Item
                          className={menuDangerItemClass}
                          onSelect={() => schedule(() => {
                            setDeleteError(null)
                            setPendingDelete(version)
                          })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete version
                        </DropdownMenu.Item>
                      </VersionActions>
                    )}
                  </div>
                )
              })}
              {restoreError && (
                <p role="alert" className="mx-1 px-2.5 pt-1 text-[11px] text-status-error max-w-[240px]">
                  {restoreError}
                </p>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        )}
      </DropdownMenu.Root>
      {canDelete && (
        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPendingDelete(null)
              setDeleteError(null)
            }
          }}
          title={`Delete v${pendingDelete?.version_number ?? ''}?`}
          description={deleteDescription(pendingDelete, sorted)}
          confirmLabel="Delete version"
          variant="danger"
          error={deleteError}
          onConfirm={confirmDelete}
          // The dialog opens after the menu has closed, so what had the focus
          // then is gone. Back to the switcher, cancelled or confirmed.
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            triggerRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

const actionsTriggerClass =
  'flex items-center justify-center h-8 w-7 shrink-0 rounded-lg text-text-tertiary outline-none cursor-pointer data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary'

/**
 * A version row's ⋯: a submenu of the version menu, so it is a menu item like
 * the row beside it. Arrow keys reach it, Right, Enter or Space opens it, Left
 * closes it again, and picking it does not switch to the version. With the
 * mouse it opens on a click and closes on a second one; passing over it does
 * nothing, so the submenu does not spring open on the way to another row.
 *
 * `unavailable` greys it out instead, with the reason as a tooltip on hover and
 * on keyboard focus: it is set when the ⋯ has no entry to offer. Today Delete
 * is its only entry; once it holds others, it is unavailable only when none
 * of them is. It stays a focusable item rather than a disabled one, which the
 * arrow keys would skip, so the reason can be reached from the keyboard too.
 */
function VersionActions({
  version, unavailable = null, children,
}: { version: number; unavailable?: string | null; children: React.ReactNode }) {
  if (unavailable) {
    return (
      <Tooltip.Provider delayDuration={200}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <DropdownMenu.Item
              aria-label={`Actions for v${version}`}
              aria-disabled="true"
              data-unavailable=""
              // Keeps the menu open: there is nothing to pick.
              onSelect={(e) => e.preventDefault()}
              className={cn(actionsTriggerClass, 'opacity-40 cursor-not-allowed')}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenu.Item>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="right"
              sideOffset={8}
              className="z-[110] max-w-[240px] rounded-md bg-bg-elevated border border-border px-2.5 py-1.5 text-[11px] text-text-secondary shadow-xl"
            >
              {unavailable}
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    )
  }
  return <ActionsSubmenu version={version}>{children}</ActionsSubmenu>
}

function ActionsSubmenu({ version, children }: { version: number; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <DropdownMenu.Sub open={open} onOpenChange={setOpen}>
      <DropdownMenu.SubTrigger
        aria-label={`Actions for v${version}`}
        className={cn(actionsTriggerClass, 'hover:bg-bg-hover hover:text-text-primary data-[state=open]:bg-bg-hover')}
        // Radix opens a submenu when the mouse rests on its trigger and moves
        // the focus there. Both are its hover handling, skipped here; leaving
        // is skipped too, or the focus would go and the submenu close with it
        // as soon as the mouse drifts off after a click.
        onPointerMove={(e) => e.preventDefault()}
        onPointerLeave={(e) => e.preventDefault()}
        // A click on Radix's trigger only ever opens; the second one closes here.
        onClick={(e) => {
          if (!open) return
          e.preventDefault()
          setOpen(false)
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={4} className={menuContentClass}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  )
}

function deleteDescription(target: AssetVersion | null, sorted: AssetVersion[]): string {
  if (!target) return ''
  const base = target.processing_status === 'failed'
    ? `This deletes v${target.version_number}, with its comments and approvals. A version that failed cannot be restored, so this cannot be undone. Its number is not used again.`
    : `This moves v${target.version_number} to the trash, with its comments and approvals. It stays in this list, where you can restore it, until it is removed for good. Its number is not used again.`
  const newest = sorted[sorted.length - 1]
  if (newest?.id !== target.id) return base
  const previous = [...sorted].reverse().find((v) => v.id !== target.id && v.processing_status === 'ready')
  if (!previous) return base
  return `${base} v${previous.version_number} becomes the latest version, also on share links that show the latest.`
}
