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

export function LoginForm() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [classicEmail, setClassicEmail] = useState('')
  const [classicPassword, setClassicPassword] = useState('')
  const [classicError, setClassicError] = useState('')

  async function handleClassicLogin(e: FormEvent) {
    e.preventDefault()
    setClassicError('')

    if (!classicEmail || !classicPassword) {
      setClassicError('Email and password are required')
      return
    }

    setLoading(true)
    try {
      const res = await api.post<AuthTokens>('/auth/login', {
        email: classicEmail,
        password: classicPassword,
      })
      setTokens(res.access_token, res.refresh_token)
      await useAuthStore.getState().fetchUser()
      router.replace('/')
    } catch (err) {
      if (err instanceof ApiError) {
        setClassicError(err.detail)
      } else {
        setClassicError('Invalid email or password')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="animate-slide-up">
      <div className="mb-8">
        <h1 className="text-xl font-medium tracking-[-0.02em] text-text-primary mb-1">Sign in to FreeFrame</h1>
        <p className="text-sm text-text-secondary">Enter your email and password.</p>
      </div>

      <form onSubmit={handleClassicLogin} className="flex flex-col gap-4">
        {classicError && (
          <div className="animate-shake rounded border border-accent-line bg-accent-muted px-3 py-2.5 font-mono text-[12px] text-accent">
            {classicError}
          </div>
        )}

        <Input
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={classicEmail}
          onChange={(e) => { setClassicEmail(e.target.value); setClassicError('') }}
        />

        <Input
          label="Password"
          type="password"
          placeholder="Your password"
          autoComplete="current-password"
          value={classicPassword}
          onChange={(e) => { setClassicPassword(e.target.value); setClassicError('') }}
        />

        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-xs text-text-secondary hover:text-text-primary">
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" loading={loading} className="mt-2 w-full">
          Sign in
        </Button>
      </form>
    </div>
  )
}
