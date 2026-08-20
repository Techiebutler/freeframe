'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { LoginForm } from '@/components/auth/login-form'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'
import type { SetupStatus } from '@/types'


export default function LoginPage() {
  const router = useRouter()

  useEffect(() => {
    async function checkSetup() {
      try {
        const status = await api.get<SetupStatus>('/setup/status')
        if (status.needs_setup) {
          router.replace('/setup')
        }
      } catch {
        // ignore
      }
    }

    const token = getAccessToken()
    if (token) {
      document.cookie = `ff_access_token=${token}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
      const params = new URLSearchParams(window.location.search)
      const from = params.get('from')
      router.replace(from || '/projects')
      return
    }

    checkSetup()
  }, [router])

  return (
    <>
      {/* The branded logo + org name live in the (auth) layout, so every auth screen gets them */}
      <LoginForm />

      {/* Powered by FreeFrame */}
      <PoweredByBadge className="mt-6 text-center justify-center w-full" />
    </>
  )
}
