'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AuthTokens } from '@/types'

interface ResetPasswordFormProps {
  token: string
}

interface FormErrors {
  password?: string
  confirmPassword?: string
  general?: string
}

function validate(password: string, confirmPassword: string): FormErrors {
  const errors: FormErrors = {}
  if (!password) {
    errors.password = 'Password is required'
  } else if (password.length < 8) {
    errors.password = 'Password must be at least 8 characters'
  }
  if (password !== confirmPassword) errors.confirmPassword = 'Passwords do not match'
  return errors
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const validation = validate(password, confirmPassword)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    setSubmitting(true)
    setErrors({})
    try {
      const res = await api.post<AuthTokens>('/auth/reset-password', {
        token,
        password,
      })
      setTokens(res.access_token, res.refresh_token)
      await useAuthStore.getState().fetchUser()
      router.replace('/projects')
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

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-xl font-medium tracking-[-0.02em] text-text-primary mb-1">Choose a new password</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {errors.general && (
          <>
            <div className="animate-shake rounded border border-accent-line bg-accent-muted px-3 py-2.5 font-mono text-[12px] text-accent">
              {errors.general}
            </div>
            <Link href="/forgot-password" className="text-sm text-text-secondary hover:text-text-primary underline">
              Request a new link
            </Link>
          </>
        )}

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
          Reset password
        </Button>
      </form>
    </div>
  )
}
