'use client'

import * as React from 'react'
import { Palette } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'

export default function BrandingPage() {
  const { user } = useAuthStore()

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Palette className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Branding</h1>
          <p className="text-sm text-text-secondary">
            Customize your account branding
          </p>
        </div>
      </div>

      {/* Account Name */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Account</h2>
        <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-accent-muted text-accent text-xl font-semibold">
              {user?.name?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div>
              <h3 className="text-sm font-medium text-text-primary">Name</h3>
              <p className="text-sm text-text-secondary mt-0.5">{user?.name}'s Account</p>
            </div>
          </div>
        </div>
      </section>

      {/* Shares */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Shares</h2>
        <p className="text-xs text-text-secondary">
          Set the default colors for all Shares created in this account. These default colors will apply to new Shares only.
        </p>
        
        <div className="space-y-3">
          <div className="p-4 rounded-lg border border-border bg-bg-secondary">
            <h3 className="text-sm font-medium text-text-primary mb-3">Accent Color</h3>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-accent border border-border"></div>
              <input
                type="text"
                value="#5B63FF"
                readOnly
                className="flex-1 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
              />
            </div>
          </div>

          <div className="p-4 rounded-lg border border-border bg-bg-secondary">
            <h3 className="text-sm font-medium text-text-primary mb-3">Background Color</h3>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-bg-primary border border-border"></div>
              <input
                type="text"
                value="#0A0A0B"
                readOnly
                className="flex-1 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
              />
            </div>
          </div>
        </div>
      </section>

      <div className="p-4 rounded-lg bg-bg-tertiary border border-border">
        <p className="text-xs text-text-secondary">
          Branding customization is currently view-only. Contact support to customize your branding.
        </p>
      </div>
    </div>
  )
}
