'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { X, ChevronDown, ArrowLeft, Users, Crown, Loader2, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import type { ProjectRole, User } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectMembersDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectName: string
}

interface MemberWithUser {
  id: string
  user_id: string
  role: ProjectRole
  user: User
}

const ROLES: { value: ProjectRole; label: string; description: string }[] = [
  { value: 'owner', label: 'Full Access', description: 'Can manage all resources within the project' },
  { value: 'editor', label: 'Edit & Share', description: 'Can manage resources, download, and share' },
  { value: 'reviewer', label: 'Comment Only', description: 'Can view and comment on the relevant resources' },
  { value: 'viewer', label: 'View Only', description: 'Can view the relevant resources' },
]

function roleLabelFor(role: ProjectRole) {
  return ROLES.find((r) => r.value === role)?.label ?? role
}

// ─── Role Dropdown ──────────────────────────────────────────────────────────

function RoleDropdown({
  value,
  onChange,
  compact,
}: {
  value: ProjectRole
  onChange: (role: ProjectRole) => void
  compact?: boolean
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1 text-accent hover:text-accent-hover font-medium transition-colors outline-none',
            compact ? 'text-xs' : 'text-sm',
          )}
        >
          {roleLabelFor(value)}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[200] w-72 rounded-xl border border-border bg-bg-secondary shadow-2xl py-1 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          {ROLES.map((r) => (
            <DropdownMenu.Item
              key={r.value}
              onSelect={() => onChange(r.value)}
              className={cn(
                'flex items-start gap-3 px-3 py-2.5 cursor-pointer outline-none transition-colors mx-1 rounded-lg',
                value === r.value ? 'bg-bg-hover' : 'hover:bg-bg-hover',
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{r.label}</p>
                <p className="text-xs text-text-tertiary mt-0.5">{r.description}</p>
              </div>
              {value === r.value && <Check className="h-4 w-4 text-accent shrink-0 mt-0.5" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// ─── Add View ───────────────────────────────────────────────────────────────

function AddView({
  projectId,
  projectName,
  members: membersList,
  onSwitchToManage,
  onMemberAdded,
}: {
  projectId: string
  projectName: string
  members: MemberWithUser[]
  onSwitchToManage: () => void
  onMemberAdded: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [role, setRole] = React.useState<ProjectRole>('editor')
  const [suggestions, setSuggestions] = React.useState<User[]>([])
  const [showSuggestions, setShowSuggestions] = React.useState(false)
  const [selectedUser, setSelectedUser] = React.useState<User | null>(null)
  const [message, setMessage] = React.useState('')
  const [adding, setAdding] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Close suggestions on outside click
  React.useEffect(() => {
    if (!showSuggestions) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showSuggestions])

  // Debounced user search
  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (query.length < 1) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    timerRef.current = setTimeout(async () => {
      try {
        const users = await api.get<User[]>(`/users/search?q=${encodeURIComponent(query)}`)
        // Filter out users already in the project
        const existingUserIds = new Set(membersList.map((m) => m.user_id))
        const filtered = users.filter((u) => !existingUserIds.has(u.id))
        setSuggestions(filtered)
        setShowSuggestions(filtered.length > 0)
      } catch {
        setSuggestions([])
      }
    }, 250)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  function handleSelectUser(user: User) {
    setSelectedUser(user)
    setQuery(user.name || user.email)
    setShowSuggestions(false)
    setSuggestions([])
  }

  async function handleAdd() {
    if (!selectedUser) return
    setAdding(true)
    setError(null)
    try {
      await api.post(`/projects/${projectId}/members`, {
        user_id: selectedUser.id,
        role,
      })
      setSelectedUser(null)
      setQuery('')
      setMessage('')
      onMemberAdded()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to add member'
      setError(msg)
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <div className="h-8 w-8 rounded-lg bg-accent/20 flex items-center justify-center">
          <Users className="h-4 w-4 text-accent" />
        </div>
        <Dialog.Title className="text-base font-semibold text-text-primary">
          Add to {projectName}
        </Dialog.Title>
      </div>

      {/* Search input with role dropdown */}
      <div className="px-6" ref={containerRef}>
        <div className="flex items-center gap-2 rounded-lg border-2 border-accent bg-bg-tertiary px-3 py-2 focus-within:border-accent">
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedUser(null)
              setError(null)
            }}
            placeholder="Name or email"
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
          <RoleDropdown value={role} onChange={setRole} />
        </div>
        <p className="mt-1.5 text-xs text-text-tertiary">Add a new or existing Member</p>

        {/* Suggestions dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-medium text-text-tertiary mb-1.5">Suggested</p>
            <div className="space-y-0.5">
              {suggestions.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => handleSelectUser(user)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover transition-colors text-left',
                    selectedUser?.id === user.id && 'bg-bg-hover',
                  )}
                >
                  <Avatar name={user.name} src={user.avatar_url} size="md" />
                  <span className="text-sm font-medium text-text-primary truncate">{user.name}</span>
                  <span className="text-sm text-text-tertiary truncate">{user.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <p className="mt-2 text-xs text-status-error">{error}</p>}
      </div>

      {/* Message field */}
      <div className="px-6 mt-4">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Add a message (optional)"
          rows={2}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-border-focus resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-6 py-4">
        <Dialog.Close asChild>
          <Button variant="secondary" size="sm">Cancel</Button>
        </Dialog.Close>
        <Button
          size="sm"
          disabled={!selectedUser || adding}
          loading={adding}
          onClick={handleAdd}
        >
          Add
        </Button>
      </div>

      {/* Footer: member avatars + count + manage */}
      <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-bg-tertiary/50 rounded-b-xl">
        <div className="flex items-center gap-2">
          {membersList.length > 0 && (
            <div className="flex -space-x-2">
              {membersList.slice(0, 5).map((m) => (
                <Avatar key={m.id} name={m.user.name} src={m.user.avatar_url} size="sm" className="ring-2 ring-bg-secondary" />
              ))}
            </div>
          )}
          <span className="text-sm text-text-secondary font-medium">
            {membersList.length} Member{membersList.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={onSwitchToManage}
          className="text-sm text-text-secondary hover:text-text-primary font-medium transition-colors"
        >
          Manage
        </button>
      </div>
    </div>
  )
}

// ─── Manage View ────────────────────────────────────────────────────────────

function ManageView({
  projectId,
  projectName,
  members,
  isOwner,
  currentUserId,
  onBack,
  onMembersChanged,
}: {
  projectId: string
  projectName: string
  members: MemberWithUser[]
  isOwner: boolean
  currentUserId: string
  onBack: () => void
  onMembersChanged: () => void
}) {
  const [removing, setRemoving] = React.useState<string | null>(null)

  async function handleRoleChange(userId: string, newRole: ProjectRole) {
    try {
      await api.patch(`/projects/${projectId}/members/${userId}`, { role: newRole })
      onMembersChanged()
    } catch {
      // silently ignore
    }
  }

  async function handleRemove(userId: string) {
    setRemoving(userId)
    try {
      await api.delete(`/projects/${projectId}/members/${userId}`)
      onMembersChanged()
    } catch {
      // silently ignore
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-4">
        <button
          type="button"
          onClick={onBack}
          className="h-8 w-8 rounded-lg bg-bg-tertiary hover:bg-bg-hover flex items-center justify-center transition-colors"
        >
          <ArrowLeft className="h-4 w-4 text-text-secondary" />
        </button>
        <Dialog.Title className="text-base font-semibold text-text-primary">
          Members of {projectName}
        </Dialog.Title>
      </div>

      {/* Members list */}
      <div className="px-6 pb-4 space-y-1 max-h-[400px] overflow-y-auto">
        {members.map((m) => {
          const isCurrentUser = m.user_id === currentUserId
          const isProjectOwner = m.role === 'owner'

          return (
            <div
              key={m.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover/50 transition-colors group"
            >
              <Avatar name={m.user.name} src={m.user.avatar_url} size="md" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-medium text-text-primary truncate">{m.user.name}</p>
                  {isCurrentUser && (
                    <span className="text-[10px] text-text-tertiary">(you)</span>
                  )}
                </div>
                <p className="text-xs text-text-tertiary truncate">{m.user.email}</p>
              </div>

              {/* Role control */}
              <div className="flex items-center gap-2">
                {isOwner && !isCurrentUser ? (
                  <RoleDropdown
                    value={m.role}
                    onChange={(r) => handleRoleChange(m.user_id, r)}
                    compact
                  />
                ) : (
                  <span className={cn(
                    'text-xs font-medium',
                    isProjectOwner ? 'text-accent' : 'text-text-tertiary',
                  )}>
                    {isProjectOwner && <Crown className="h-3 w-3 inline mr-1" />}
                    {roleLabelFor(m.role)}
                  </span>
                )}

                {isOwner && !isCurrentUser && (
                  <button
                    type="button"
                    onClick={() => handleRemove(m.user_id)}
                    disabled={removing === m.user_id}
                    className="opacity-0 group-hover:opacity-100 h-6 w-6 rounded flex items-center justify-center text-text-tertiary hover:text-status-error hover:bg-status-error/10 transition-all"
                  >
                    {removing === m.user_id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {members.length === 0 && (
          <p className="text-sm text-text-tertiary text-center py-8">No members yet</p>
        )}
      </div>
    </div>
  )
}

// ─── Main Dialog ────────────────────────────────────────────────────────────

export function ProjectMembersDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: ProjectMembersDialogProps) {
  const [view, setView] = React.useState<'add' | 'manage'>('add')
  const [members, setMembers] = React.useState<MemberWithUser[]>([])
  const [loading, setLoading] = React.useState(false)
  const { user } = useAuthStore()

  const fetchMembers = React.useCallback(async () => {
    setLoading(true)
    try {
      const rawMembers = await api.get<{ id: string; user_id: string; role: ProjectRole }[]>(
        `/projects/${projectId}/members`,
      )
      if (rawMembers.length === 0) {
        setMembers([])
        setLoading(false)
        return
      }
      const userIds = rawMembers.map((m) => m.user_id)
      const users = await api.get<User[]>(`/users?ids=${userIds.join(',')}`)
      const userMap = new Map(users.map((u) => [u.id, u]))
      const hydrated: MemberWithUser[] = rawMembers
        .filter((m) => userMap.has(m.user_id))
        .map((m) => ({
          ...m,
          user: userMap.get(m.user_id)!,
        }))
      setMembers(hydrated)
    } catch {
      setMembers([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  React.useEffect(() => {
    if (open) {
      setView('add')
      fetchMembers()
    }
  }, [open, fetchMembers])

  const isOwner = members.some((m) => m.user_id === user?.id && m.role === 'owner')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-bg-secondary shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          <Dialog.Close className="absolute right-4 top-4 text-text-tertiary hover:text-text-primary transition-colors z-10">
            <X className="h-4 w-4" />
          </Dialog.Close>
          <Dialog.Description className="sr-only">
            Add or manage project members
          </Dialog.Description>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
            </div>
          ) : view === 'add' ? (
            <AddView
              projectId={projectId}
              projectName={projectName}
              members={members}
              onSwitchToManage={() => setView('manage')}
              onMemberAdded={fetchMembers}
            />
          ) : (
            <ManageView
              projectId={projectId}
              projectName={projectName}
              members={members}
              isOwner={isOwner}
              currentUserId={user?.id ?? ''}
              onBack={() => setView('add')}
              onMembersChanged={fetchMembers}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
