'use client'

import * as React from 'react'
import useSWR from 'swr'
import { CheckCircle2, XCircle, Clock, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { api } from '@/lib/api'
import type { Approval, User, ApprovalStatus } from '@/types'

// ─── Extended approval type ───────────────────────────────────────────────────

interface ApprovalWithUser extends Approval {
  user?: User
}

interface ApprovalsResponse {
  approvals: ApprovalWithUser[]
}

// ─── Status visual config ─────────────────────────────────────────────────────

const statusConfig: Record<
  ApprovalStatus,
  { icon: React.ReactNode; label: string; className: string }
> = {
  approved: {
    icon: <CheckCircle2 className="h-4 w-4" />,
    label: 'Approved',
    className: 'text-status-success',
  },
  rejected: {
    icon: <XCircle className="h-4 w-4" />,
    label: 'Rejected',
    className: 'text-status-error',
  },
  pending: {
    icon: <Clock className="h-4 w-4" />,
    label: 'Pending',
    className: 'text-text-tertiary',
  },
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ApprovalBarProps {
  assetId: string
  versionId: string
  currentUserId?: string
  className?: string
}

// ─── Reject note dialog (inline) ─────────────────────────────────────────────

interface RejectNoteProps {
  onConfirm: (note: string) => Promise<void>
  onCancel: () => void
}

function RejectNoteDialog({ onConfirm, onCancel }: RejectNoteProps) {
  const [note, setNote] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  async function handleConfirm() {
    setSubmitting(true)
    try {
      await onConfirm(note)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-xl border border-border bg-bg-elevated p-5 shadow-xl animate-slide-up">
        <h3 className="text-sm font-semibold text-text-primary mb-1">Reject with note</h3>
        <p className="text-xs text-text-tertiary mb-3">
          Optionally add a note explaining why this version is being rejected.
        </p>
        <textarea
          className="w-full resize-none rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus min-h-[80px]"
          placeholder="Optional rejection note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoFocus
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirm}
            loading={submitting}
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Approval bar ─────────────────────────────────────────────────────────────

export function ApprovalBar({ assetId, versionId, currentUserId, className }: ApprovalBarProps) {
  const swrKey = assetId ? `/assets/${assetId}/approvals?version_id=${versionId}` : null

  const { data, isLoading, mutate } = useSWR<ApprovalsResponse>(
    swrKey,
    (key: string) => api.get<ApprovalsResponse>(key),
    { revalidateOnFocus: false },
  )

  const [approving, setApproving] = React.useState(false)
  const [showRejectDialog, setShowRejectDialog] = React.useState(false)
  const [actionError, setActionError] = React.useState<string | null>(null)

  const approvals = data?.approvals ?? []
  const myApproval = approvals.find((a) => a.user_id === currentUserId)

  async function handleApprove() {
    setApproving(true)
    setActionError(null)
    try {
      await api.post(`/assets/${assetId}/approve`, { version_id: versionId })
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve')
    } finally {
      setApproving(false)
    }
  }

  async function handleReject(note: string) {
    setActionError(null)
    try {
      await api.post(`/assets/${assetId}/reject`, { version_id: versionId, note })
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject')
      throw err
    } finally {
      setShowRejectDialog(false)
    }
  }

  // Summary counts
  const approvedCount = approvals.filter((a) => a.status === 'approved').length
  const rejectedCount = approvals.filter((a) => a.status === 'rejected').length
  const pendingCount = approvals.filter((a) => a.status === 'pending').length

  return (
    <>
      {showRejectDialog && (
        <RejectNoteDialog
          onConfirm={handleReject}
          onCancel={() => setShowRejectDialog(false)}
        />
      )}

      <div
        className={cn(
          'flex items-center gap-3 px-4 py-2 border-t border-border bg-bg-secondary',
          className,
        )}
      >
        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" />
            <span className="text-xs text-text-tertiary">Loading approvals…</span>
          </div>
        )}

        {/* Reviewer list */}
        {!isLoading && approvals.length > 0 && (
          <div className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto">
            <span className="text-2xs text-text-tertiary shrink-0">Reviews:</span>
            <div className="flex items-center gap-1.5">
              {approvals.map((approval) => {
                const config = statusConfig[approval.status]
                return (
                  <div
                    key={approval.id}
                    className="flex items-center gap-1 rounded-full border border-border bg-bg-tertiary px-2 py-0.5"
                    title={`${approval.user?.name ?? 'Unknown'}: ${config.label}`}
                  >
                    <Avatar
                      src={approval.user?.avatar_url}
                      name={approval.user?.name}
                      size="sm"
                    />
                    <span className={cn('shrink-0', config.className)}>
                      {config.icon}
                    </span>
                  </div>
                )
              })}
            </div>

            {/* Summary */}
            <div className="flex items-center gap-2 ml-2 shrink-0">
              {approvedCount > 0 && (
                <span className="text-2xs text-status-success font-medium">
                  {approvedCount} approved
                </span>
              )}
              {rejectedCount > 0 && (
                <span className="text-2xs text-status-error font-medium">
                  {rejectedCount} rejected
                </span>
              )}
              {pendingCount > 0 && (
                <span className="text-2xs text-text-tertiary">
                  {pendingCount} pending
                </span>
              )}
            </div>
          </div>
        )}

        {!isLoading && approvals.length === 0 && (
          <span className="text-xs text-text-tertiary flex-1">No review requests yet</span>
        )}

        {/* Error */}
        {actionError && (
          <span className="text-xs text-status-error shrink-0">{actionError}</span>
        )}

        {/* Action buttons */}
        {currentUserId && (
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {myApproval?.status === 'approved' && (
              <span className="inline-flex items-center gap-1 text-xs text-status-success font-medium">
                <CheckCircle2 className="h-4 w-4" />
                You approved
              </span>
            )}
            {myApproval?.status === 'rejected' && (
              <span className="inline-flex items-center gap-1 text-xs text-status-error font-medium">
                <XCircle className="h-4 w-4" />
                You rejected
              </span>
            )}
            {(!myApproval || myApproval.status === 'pending') && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowRejectDialog(true)}
                  disabled={approving}
                  className="text-status-error border-status-error/30 hover:border-status-error/60 hover:bg-status-error/10"
                >
                  <XCircle className="h-4 w-4" />
                  Reject
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleApprove}
                  loading={approving}
                  className="bg-status-success hover:opacity-90"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  Approve
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
