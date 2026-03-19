'use client'

import * as React from 'react'
import useSWR, { mutate } from 'swr'
import * as Dialog from '@radix-ui/react-dialog'
import { Building2, Users, Plus, X, Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { useAuthStore } from '@/stores/auth-store'
import { useRouter } from 'next/navigation'
import type { Organization, User, UserStatus } from '@/types'

interface OrgWithStats extends Organization {
  member_count?: number
  project_count?: number
}

interface AdminUsersResponse {
  items: (User & { role?: string; last_active?: string })[]
  total: number
}

function CreateOrgDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  const [slug, setSlug] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    setName(v)
    setSlug(v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !slug.trim()) return
    setLoading(true)
    setError('')
    try {
      await api.post('/organizations', { name: name.trim(), slug: slug.trim() })
      setOpen(false)
      setName('')
      setSlug('')
      onCreated()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create organization')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" />
          Create Organization
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="text-base font-semibold text-text-primary">
            Create Organization
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Set up a new organization workspace.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <Input
              label="Organization name"
              value={name}
              onChange={handleNameChange}
              placeholder="Acme Productions"
              required
            />
            <Input
              label="Slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="acme-productions"
              required
            />
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

function BulkInviteDialog() {
  const [open, setOpen] = React.useState(false)
  const [emails, setEmails] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const [success, setSuccess] = React.useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const emailList = emails
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean)
    if (emailList.length === 0) return
    setLoading(true)
    setError('')
    setSuccess('')
    try {
      let sent = 0
      for (const email of emailList) {
        await api.post('/auth/send-magic-code', { email })
        sent++
      }
      setSuccess(`${sent} invite(s) sent successfully.`)
      setEmails('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send invites')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="secondary" size="sm">
          <Users className="h-4 w-4" />
          Bulk Invite
        </Button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary p-6 shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </Dialog.Close>

          <Dialog.Title className="text-base font-semibold text-text-primary">
            Bulk Invite Users
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-text-secondary">
            Enter email addresses separated by commas or newlines.
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">Email addresses</label>
              <textarea
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="user1@example.com&#10;user2@example.com"
                rows={5}
                className="flex w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary transition-colors focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-none"
              />
            </div>
            {error && <p className="text-xs text-status-error">{error}</p>}
            {success && <p className="text-xs text-status-success">{success}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button type="submit" size="sm" loading={loading}>
                Send Invites
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function userStatusBadge(status: UserStatus) {
  const map: Record<UserStatus, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-[oklch(0.35_0.12_152/0.25)] text-status-success' },
    deactivated: { label: 'Deactivated', className: 'bg-[oklch(0.35_0.1_25/0.25)] text-status-error' },
    pending_invite: { label: 'Pending', className: 'bg-[oklch(0.35_0.12_70/0.25)] text-status-warning' },
    pending_verification: { label: 'Unverified', className: 'bg-bg-tertiary text-text-secondary' },
  }
  const cfg = map[status] ?? map.active
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', cfg.className)}>
      {cfg.label}
    </span>
  )
}

export default function AdminPage() {
  const { user, isSuperAdmin } = useAuthStore()
  const router = useRouter()

  const { data: orgs, isLoading: loadingOrgs, mutate: mutateOrgs } = useSWR<OrgWithStats[]>(
    isSuperAdmin ? '/organizations' : null,
    () => api.get<OrgWithStats[]>('/organizations'),
  )

  const { data: usersResp, isLoading: loadingUsers } = useSWR<AdminUsersResponse>(
    isSuperAdmin ? '/admin/users' : null,
    () => api.get<AdminUsersResponse>('/admin/users'),
  )

  React.useEffect(() => {
    if (user && !isSuperAdmin) {
      router.replace('/')
    }
  }, [user, isSuperAdmin, router])

  const handleDeactivate = async (userId: string) => {
    try {
      await api.patch(`/users/${userId}/deactivate`)
      mutate('/admin/users')
    } catch {
      // ignore
    }
  }

  const handleReactivate = async (userId: string) => {
    try {
      await api.patch(`/users/${userId}/reactivate`)
      mutate('/admin/users')
    } catch {
      // ignore
    }
  }

  if (!isSuperAdmin) {
    return null
  }

  return (
    <div className="p-6 space-y-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Shield className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Super Admin</h1>
          <p className="text-sm text-text-secondary">Manage organizations and platform users</p>
        </div>
      </div>

      {/* Organizations */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Organizations</h2>
          <CreateOrgDialog onCreated={mutateOrgs} />
        </div>

        {loadingOrgs ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-bg-tertiary" />
            ))}
          </div>
        ) : !orgs || orgs.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary">
            <EmptyState
              icon={Building2}
              title="No organizations"
              description="Create the first organization to get started."
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {orgs.map((org) => (
              <a
                key={org.id}
                href={`/org/${org.id}`}
                className="group flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4 hover:border-border-focus hover:bg-bg-tertiary transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-muted shrink-0">
                    <Building2 className="h-4 w-4 text-accent" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors truncate">
                      {org.name}
                    </p>
                    <p className="text-xs text-text-tertiary">/{org.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-text-tertiary">
                  <span>{org.member_count ?? 0} members</span>
                  <span>{org.project_count ?? 0} projects</span>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>

      {/* User management */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Platform Users</h2>
          <BulkInviteDialog />
        </div>

        {loadingUsers ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-bg-tertiary" />
            ))}
          </div>
        ) : !usersResp || usersResp.items.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-secondary">
            <EmptyState
              icon={Users}
              title="No users"
              description="Users will appear here once they register or are invited."
            />
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">User</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Status</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-text-tertiary">Joined</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-text-tertiary">Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersResp.items.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0 hover:bg-bg-tertiary transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar src={u.avatar_url} name={u.name} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{u.name}</p>
                          <p className="text-xs text-text-tertiary truncate">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">{userStatusBadge(u.status)}</td>
                    <td className="px-4 py-3 text-xs text-text-tertiary">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {u.status === 'active' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeactivate(u.id)}
                          className="text-status-error hover:text-status-error"
                        >
                          Deactivate
                        </Button>
                      ) : u.status === 'deactivated' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleReactivate(u.id)}
                        >
                          Reactivate
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
