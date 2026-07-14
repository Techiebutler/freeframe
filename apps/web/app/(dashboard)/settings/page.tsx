'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/auth-store'

export default function SettingsPage() {
  const router = useRouter()
  const { user, isSuperAdmin } = useAuthStore()

  // Wait for the auth store to hydrate before choosing a destination — the dashboard
  // layout fetches the user asynchronously and doesn't block rendering, so `isSuperAdmin`
  // is briefly false on a fresh load. Redirecting before `user` exists would bounce an
  // admin to a non-admin page. Non-admins can't open /settings/admin (it redirects them
  // to home), so send them to the first settings page they can actually access.
  React.useEffect(() => {
    if (!user) return
    router.replace(isSuperAdmin ? '/settings/admin' : '/settings/appearance')
  }, [user, isSuperAdmin, router])

  return null
}
