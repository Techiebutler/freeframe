'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AuthTokens } from '@/types'

interface InviteDetails {
  readonly email: string
  readonly org_name: string
  readonly inviter_name: string | null
}

interface InviteAcceptProps {
  token: string
}

interface FormErrors {
  name?: string
  password?: string
  confirmPassword?: string
  general?: string
}

function validate(name: string, password: string, confirmPassword: string): FormErrors {
  const errors: FormErrors = {}
  if (!name.trim()) errors.name = 'Name is required'
  if (!password) {
    errors.password = 'Password is required'
  } else if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters'
  }
  if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match'
  return errors
}

export function InviteAccept({ token }: InviteAcceptProps) {
  const router = useRouter()
  const [invite, setInvite] = useState<InviteDetails | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteLoading, setInviteLoading] = useState(true)

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    async function fetchInvite() {
      try {
        const data = await api.get<InviteDetails>(`/auth/invite/${token}`)
        setInvite(data)
      } catch (err) {
        if (err instanceof ApiError) {
          setInviteError(err.status === 404 ? 'This invite link is invalid or has expired.' : err.detail)
        } else {
          setInviteError('Failed to load invite details.')
        }
      } finally {
        setInviteLoading(false)
      }
    }
    fetchInvite()
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validation = validate(name, password, confirmPassword)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    setSubmitting(true)
    setErrors({})
    try {
      const res = await api.post<AuthTokens>('/auth/accept-invite', {
        token,
        name,
        password,
      })
      setTokens(res.access_token, res.refresh_token)
      await useAuthStore.getState().fetchUser()
      router.replace('/')
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ general: err.detail })
      } else {
        setErrors({ general: 'Something went wrong. Please try again.' })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (inviteLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  if (inviteError) {
    return (
      <div className="text-center py-8">
        <div className="mb-4 mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-muted">
          <svg className="h-6 w-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h2 className="text-lg font-medium tracking-[-0.02em] text-text-primary mb-2">Invalid invite</h2>
        <p className="text-sm text-text-secondary">{inviteError}</p>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      {/* Invite card */}
      {invite && (
        <div className="mb-8 rounded-lg border border-border bg-bg-secondary p-4">
          <p className="text-xs text-text-tertiary uppercase tracking-wider mb-2">You&apos;ve been invited to</p>
          <p className="text-base font-medium tracking-[-0.02em] text-text-primary mb-1">{invite.org_name}</p>
          {invite.inviter_name && (
            <p className="text-sm text-text-secondary">
              Invited by <span className="text-text-primary">{invite.inviter_name}</span>
            </p>
          )}
          <p className="text-sm text-text-tertiary mt-1">{invite.email}</p>
        </div>
      )}

      <div className="mb-6">
        <h1 className="text-xl font-medium tracking-[-0.02em] text-text-primary mb-1">Accept invite</h1>
        <p className="text-sm text-text-secondary">Set up your account to get started.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {errors.general && (
          <div className="animate-shake rounded border border-accent-line bg-accent-muted px-3 py-2.5 font-mono text-[12px] text-accent">
            {errors.general}
          </div>
        )}

        <Input
          label="Full name"
          type="text"
          placeholder="Alex Johnson"
          autoComplete="name"
          value={name}
          onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: undefined })) }}
          error={errors.name}
        />

        <Input
          label="Password"
          type="password"
          placeholder="Min. 8 characters"
          autoComplete="new-password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: undefined })) }}
          error={errors.password}
        />

        <Input
          label="Confirm password"
          type="password"
          placeholder="Repeat password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => { setConfirmPassword(e.target.value); setErrors((p) => ({ ...p, confirmPassword: undefined })) }}
          error={errors.confirmPassword}
        />

        <Button type="submit" size="lg" loading={submitting} className="mt-2 w-full">
          Create account &amp; join
        </Button>
      </form>
    </div>
  )
}
