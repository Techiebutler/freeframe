'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { LoginForm } from '@/components/auth/login-form'
import { useBrandingStore } from '@/stores/branding-store'
import { useThemeStore } from '@/stores/theme-store'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'
import type { SetupStatus } from '@/types'


export default function LoginPage() {
  const router = useRouter()
  const {
    orgName,
    loginLogoUrl,
    orgLogoLight,
    orgLogoDark,
    fetchBranding,
    loaded,
  } = useBrandingStore()
  const { theme } = useThemeStore()

  useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

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

  const displayLogo = loginLogoUrl || (theme === 'dark' ? (orgLogoDark ?? orgLogoLight) : (orgLogoLight ?? orgLogoDark)) || undefined

  return (
    <>
      {/* Branding header */}
      <div className="mb-8 text-center">
        {displayLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayLogo}
            alt={orgName}
            className="h-12 mx-auto mb-3 object-contain"
            onError={(e) => {
              const target = e.currentTarget
              if (target.src !== `/logo-full.svg`) {
                target.src = `/logo-full.svg`
              }
            }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/logo-full.svg`}
            alt="FreeFrame"
            className="h-12 mx-auto mb-3 object-contain"
          />
        )}
        <h1 className="text-xl font-semibold text-text-primary">
          {orgName}
        </h1>
      </div>

      <LoginForm />

      {/* Powered by FreeFrame */}
      <PoweredByBadge className="mt-6 text-center justify-center w-full" />
    </>
  )
}
