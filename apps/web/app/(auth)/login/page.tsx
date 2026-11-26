'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { ensureAccessToken, getAccessToken, getRefreshToken, setTokens } from '@/lib/auth'
import { usesRefreshCookie } from '@/lib/auth-transport'
import { safeInternalPath } from '@/lib/safe-redirect'
import { LoginForm } from '@/components/auth/login-form'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'
import type { SetupStatus } from '@/types'


export default function LoginPage() {
  const router = useRouter()
  const [ready, setReady] = useState(false)

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

    let active = true
    async function initialize() {
      const cookieMode = usesRefreshCookie()
      const token = cookieMode ? await ensureAccessToken() : getAccessToken()
      if (!active) return
      if (token) {
        if (!cookieMode) setTokens(token, getRefreshToken() ?? undefined)
        const params = new URLSearchParams(window.location.search)
        router.replace(safeInternalPath(params.get('from')))
        return
      }
      void checkSetup()
      setReady(true)
    }
    void initialize()
    return () => { active = false }
  }, [router])

  return (
    <>
      {/* The branded logo + org name live in the (auth) layout, so every auth screen gets them */}
      {ready && <LoginForm />}

      {/* Powered by FreeFrame */}
      <PoweredByBadge className="mt-6 text-center justify-center w-full" />
    </>
  )
}
