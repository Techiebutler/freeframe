'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface FormState {
  email: string
  name: string
  password: string
  confirmPassword: string
  setupToken: string
}

interface FormErrors {
  email?: string
  name?: string
  password?: string
  confirmPassword?: string
  setupToken?: string
  general?: string
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {}
  if (!form.email) {
    errors.email = 'Email is required'
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    errors.email = 'Enter a valid email address'
  }
  if (!form.name.trim()) {
    errors.name = 'Name is required'
  }
  if (!form.password) {
    errors.password = 'Password is required'
  } else if (form.password.length < 8) {
    errors.password = 'Password must be at least 8 characters'
  }
  if (!form.confirmPassword) {
    errors.confirmPassword = 'Please confirm your password'
  } else if (form.password !== form.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match'
  }
  return errors
}

export function SetupWizard() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>({
    email: '',
    name: '',
    password: '',
    confirmPassword: '',
    setupToken: '',
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  function handleChange(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
      // Clear field error on change
      if (errors[field]) {
        setErrors((prev) => ({ ...prev, [field]: undefined }))
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validation = validate(form)
    if (Object.keys(validation).length > 0) {
      setErrors(validation)
      return
    }

    setLoading(true)
    setErrors({})
    try {
      const res = await api.post<{ access_token: string; refresh_token: string }>(
        '/setup/create-superadmin',
        {
          email: form.email,
          name: form.name,
          password: form.password,
          setup_token: form.setupToken || null,
        }
      )
      setTokens(res.access_token, res.refresh_token)
      setSuccess(true)
      setTimeout(() => {
        router.replace('/')
      }, 1800)
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors({ general: err.detail })
      } else {
        setErrors({ general: 'Something went wrong. Please try again.' })
      }
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="text-center py-8 animate-fade-in">
        <div className="mb-4 mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-status-success/15">
          <svg className="h-6 w-6 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-lg font-medium tracking-[-0.02em] text-text-primary mb-1">Admin account created</h2>
        <p className="text-sm text-text-secondary">Redirecting you to your projects…</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-medium tracking-[-0.02em] text-text-primary mb-1">Welcome to FreeFrame</h1>
        <p className="text-sm text-text-secondary">
          Create the super admin account to get started. This can only be done once.
        </p>
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
          value={form.name}
          onChange={handleChange('name')}
          error={errors.name}
        />

        <Input
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={form.email}
          onChange={handleChange('email')}
          error={errors.email}
        />

        <Input
          label="Password"
          type="password"
          placeholder="Min. 8 characters"
          autoComplete="new-password"
          value={form.password}
          onChange={handleChange('password')}
          error={errors.password}
        />

        <Input
          label="Confirm password"
          type="password"
          placeholder="Repeat password"
          autoComplete="new-password"
          value={form.confirmPassword}
          onChange={handleChange('confirmPassword')}
          error={errors.confirmPassword}
        />

        <Input
          label="Setup token"
          type="password"
          placeholder="Bootstrap token"
          autoComplete="one-time-code"
          value={form.setupToken}
          onChange={handleChange('setupToken')}
          error={errors.setupToken}
        />

        <Button
          type="submit"
          size="lg"
          loading={loading}
          className="mt-2 w-full"
        >
          Create admin account
        </Button>
      </form>
    </div>
  )
}
