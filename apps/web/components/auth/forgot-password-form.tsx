'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!email) {
      setError('Email is required')
      return
    }

    setLoading(true)
    try {
      await api.post('/auth/forgot-password', { email })
      setSent(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError(err.detail)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="animate-slide-up">
      <div className="mb-8">
        <h1 className="text-xl font-medium tracking-[-0.02em] text-text-primary mb-1">Reset your password</h1>
        <p className="text-sm text-text-secondary">Enter your email and we&apos;ll send you a reset link.</p>
      </div>

      {sent ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">
            If that email is registered, a reset link is on its way. Check your inbox.
          </p>
          <Link href="/login" className="text-sm text-text-secondary hover:text-text-primary underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <div className="animate-shake rounded border border-accent-line bg-accent-muted px-3 py-2.5 font-mono text-[12px] text-accent">
              {error}
            </div>
          )}

          <Input
            label="Email address"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError('') }}
          />

          <Button type="submit" size="lg" loading={loading} className="mt-2 w-full">
            Send reset link
          </Button>

          <Link href="/login" className="text-sm text-text-secondary hover:text-text-primary underline">
            Back to sign in
          </Link>
        </form>
      )}
    </div>
  )
}
