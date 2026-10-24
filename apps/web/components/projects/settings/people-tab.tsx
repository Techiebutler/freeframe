'use client'

import * as React from 'react'
import useSWR from 'swr'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Crown, Loader2, Search, UserPlus, X } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Avatar } from '@/components/shared/avatar'
import { SkeletonList } from '@/components/shared/skeleton'
import { useAuthStore } from '@/stores/auth-store'
import type { ProjectMember, ProjectRole, User } from '@/types'

const ROLES: { value: ProjectRole; label: string; description: string }[] = [
  { value: 'owner', label: 'Full Access', description: 'Can manage all resources within the project' },
  { value: 'editor', label: 'Edit & Share', description: 'Can manage resources, download, and share' },
  { value: 'reviewer', label: 'Comment Only', description: 'Can view and comment on the relevant resources' },
  { value: 'viewer', label: 'View Only', description: 'Can view the relevant resources' },
]

function roleLabel(role: ProjectRole) {
  return ROLES.find((r) => r.value === role)?.label ?? role
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function formatJoined(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function RoleDropdown({
  value,
  onChange,
  label,
  disabled,
}: {
  value: ProjectRole
  onChange: (role: ProjectRole) => void
  /** Accessible name for the trigger, e.g. "Role for Ana". */
  label: string
  disabled?: boolean
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={label}
          className="flex items-center gap-1 rounded text-sm font-medium text-accent hover:text-accent-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          {roleLabel(value)}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[200] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-secondary py-1 shadow-2xl"
        >
          {ROLES.map((r) => (
            <DropdownMenu.Item
              key={r.value}
              onSelect={() => onChange(r.value)}
              className={cn(
                'mx-1 flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors data-[highlighted]:bg-bg-hover',
                value === r.value && 'bg-bg-hover',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text-primary">{r.label}</p>
                <p className="mt-0.5 text-xs text-text-tertiary">{r.description}</p>
              </div>
              {value === r.value && <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Search people by name or email, pick one and a role, and add them. */
function AddMember({
  projectId,
  memberIds,
  onAdded,
}: {
  projectId: string
  memberIds: Set<string>
  onAdded: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<User[] | null>(null)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<User | null>(null)
  const [role, setRole] = React.useState<ProjectRole>('editor')
  const [adding, setAdding] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Results only show while there is a search and nobody picked yet, so a
  // cleared box needs no state reset here.
  const searching = !selected && !!query.trim()
  React.useEffect(() => {
    const q = query.trim()
    if (selected || !q) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const users = await api.get<User[]>(`/users/search?q=${encodeURIComponent(q)}`)
        if (cancelled) return
        setResults(users)
        setSearchError(null)
      } catch (err) {
        if (cancelled) return
        setResults(null)
        setSearchError(errorText(err, 'Search failed'))
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, selected])

  const candidates = (results ?? []).filter((u) => !memberIds.has(u.id))

  async function add() {
    if (!selected) return
    setAdding(true)
    setError(null)
    try {
      await api.post(`/projects/${projectId}/members`, { user_id: selected.id, role })
      setSelected(null)
      setQuery('')
      onAdded()
    } catch (err) {
      setError(errorText(err, 'Could not add this person'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-4 space-y-3">
      <h2 className="text-sm font-semibold text-text-primary">Add a member</h2>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 h-10 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <Search className="h-4 w-4 shrink-0 text-text-tertiary" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(null)
              setError(null)
            }}
            placeholder="Name or email"
            aria-label="Find people by name or email"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-text-primary placeholder:text-text-tertiary outline-none [@media(hover:hover)]:text-sm"
          />
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <RoleDropdown value={role} onChange={setRole} label="Role for the new member" />
          <Button type="button" size="sm" onClick={add} disabled={!selected} loading={adding}>
            <UserPlus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      {searching && results && (
        candidates.length > 0 ? (
          <ul aria-label="Search results" className="max-h-64 space-y-0.5 overflow-y-auto">
            {candidates.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(u)
                    setQuery(u.name || u.email)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg-hover transition-colors"
                >
                  <Avatar name={u.name} src={u.avatar_url} color={u.avatar_color} size="md" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-text-primary">{u.name}</span>
                    <span className="block truncate text-xs text-text-tertiary">{u.email}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-text-tertiary">
            {results.length > 0
              ? 'Everyone matching that is already a member.'
              : 'No one matches that. People need an account on this instance before they can be added.'}
          </p>
        )
      )}
      {searching && searchError && <p role="alert" className="text-xs text-status-error">{searchError}</p>}
      {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
    </section>
  )
}

interface MemberRow extends ProjectMember {
  user?: User
}

/**
 * The People tab of project settings: who is in the project and with which
 * role, adding people, and removing them. Only the owner reaches it, and the
 * owner cannot change or remove their own membership here.
 *
 * Shares its SWR key with the project page, so a change here shows there.
 */
export function ProjectPeopleTab({ projectId }: { projectId: string }) {
  const currentUserId = useAuthStore((s) => s.user?.id)
  const membersKey = `/projects/${projectId}/members`
  const {
    data: members,
    error: membersError,
    mutate: mutateMembers,
  } = useSWR<ProjectMember[]>(membersKey, () => api.get<ProjectMember[]>(membersKey))
  const ids = (members ?? []).map((m) => m.user_id)
  const usersKey = ids.length > 0 ? `/users?ids=${ids.join(',')}` : null
  const { data: users, error: usersError, mutate: mutateUsers } = useSWR<User[]>(
    usersKey,
    (key: string) => api.get<User[]>(key),
  )

  const [rowError, setRowError] = React.useState<string | null>(null)
  const [changing, setChanging] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<MemberRow | null>(null)
  const [removeError, setRemoveError] = React.useState<string | null>(null)

  if (membersError || usersError) {
    return (
      <div role="alert" className="rounded-xl border border-border bg-bg-secondary p-6 space-y-3">
        <p className="text-sm text-text-secondary">
          Members could not be loaded: {errorText(membersError ?? usersError, 'request failed')}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void mutateMembers()
            void mutateUsers()
          }}
        >
          Retry
        </Button>
      </div>
    )
  }
  if (!members || (usersKey && !users)) {
    return <SkeletonList rows={4} />
  }

  const byId = new Map((users ?? []).map((u) => [u.id, u]))
  const rows: MemberRow[] = members.map((m) => ({ ...m, user: byId.get(m.user_id) }))
  const memberIds = new Set(members.map((m) => m.user_id))
  const nameOf = (m: MemberRow) => m.user?.name || m.user?.email || 'this member'

  async function changeRole(m: MemberRow, role: ProjectRole) {
    if (role === m.role) return
    setRowError(null)
    setChanging(m.user_id)
    try {
      await api.patch(`/projects/${projectId}/members/${m.user_id}`, { role })
      await mutateMembers()
    } catch (err) {
      setRowError(`Could not change ${nameOf(m)}'s role: ${errorText(err, 'request failed')}`)
    } finally {
      setChanging(null)
    }
  }

  async function remove() {
    if (!removing) return
    setRemoveError(null)
    try {
      await api.delete(`/projects/${projectId}/members/${removing.user_id}`)
    } catch (err) {
      setRemoveError(errorText(err, 'Could not remove this member'))
      // Keeps the dialog open with the reason.
      throw err
    }
    await mutateMembers()
  }

  return (
    <div className="space-y-4">
      <AddMember projectId={projectId} memberIds={memberIds} onAdded={() => void mutateMembers()} />

      {rowError && <p role="alert" className="text-sm text-status-error">{rowError}</p>}

      <section className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
        <h2 className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">
          Members ({rows.length})
        </h2>
        <table className="w-full text-sm">
          <thead className="sr-only sm:not-sr-only">
            <tr className="border-b border-border bg-bg-tertiary text-left text-xs font-medium text-text-tertiary">
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Joined</th>
              <th className="px-4 py-2.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const isSelf = m.user_id === currentUserId
              return (
                <tr key={m.id} className="group border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar
                        name={m.user?.name ?? '?'}
                        src={m.user?.avatar_url}
                        color={m.user?.avatar_color}
                        size="sm"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {m.user?.name ?? 'Unknown user'}
                          {isSelf && <span className="ml-1.5 text-xs font-normal text-text-tertiary">(you)</span>}
                        </p>
                        <p className="truncate text-xs text-text-tertiary">{m.user?.email}</p>
                        <p className="text-2xs text-text-tertiary sm:hidden">Joined {formatJoined(m.invited_at)}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {isSelf ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs font-medium text-text-tertiary"
                        title="You cannot change your own role"
                      >
                        {m.role === 'owner' && <Crown className="h-3 w-3" />}
                        {roleLabel(m.role)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <RoleDropdown
                          value={m.role}
                          onChange={(r) => void changeRole(m, r)}
                          label={`Role for ${nameOf(m)}`}
                          disabled={changing === m.user_id}
                        />
                        {changing === m.user_id && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-tertiary" />}
                      </span>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-text-tertiary sm:table-cell">
                    {formatJoined(m.invited_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isSelf && (
                      <button
                        type="button"
                        aria-label={`Remove ${nameOf(m)}`}
                        onClick={() => {
                          setRemoveError(null)
                          setRemoving(m)
                        }}
                        // Always shown where there is no hover to reveal it.
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-text-tertiary hover:bg-status-error/10 hover:text-status-error focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-all [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        title={removing ? `Remove ${nameOf(removing)}?` : 'Remove member?'}
        description="They lose access to this project straight away. You can add them again later."
        confirmLabel="Remove"
        variant="danger"
        error={removeError}
        onConfirm={remove}
      />
    </div>
  )
}
