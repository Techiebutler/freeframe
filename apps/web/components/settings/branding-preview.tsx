'use client'

import * as React from 'react'
import { useBrandingStore } from '@/stores/branding-store'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'
import { useThemeStore } from '@/stores/theme-store'


export function BrandingPreview() {
  const { orgName, orgLogoDark, orgLogoLight } =
    useBrandingStore()
  const { theme } = useThemeStore()

  const customLogo =
    theme === 'light'
      ? orgLogoLight ?? orgLogoDark
      : orgLogoDark ?? orgLogoLight

  return (
    <div className="rounded-lg border border-border bg-bg-secondary overflow-hidden">
      {/* Preview header */}
      <div className="px-3 py-1.5 border-b border-border bg-bg-tertiary">
        <p className="text-2xs font-medium text-text-tertiary uppercase tracking-wider">
          Sidebar Preview
        </p>
      </div>

      {/* Sidebar mockup */}
      <div className="flex p-3">
        <div className="w-[52px] shrink-0 flex flex-col items-center gap-2 border-r border-border pr-3">
          <div className="h-7 w-7 rounded-md overflow-hidden flex items-center justify-center bg-bg-tertiary">
            {customLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={customLogo}
                alt={orgName}
                className="h-full w-full object-contain"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/logo-icon.svg`}
                alt=""
                className="h-5 w-5 object-contain"
              />
            )}
          </div>
        </div>

        <div className="flex-1 pl-3 space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md overflow-hidden flex items-center justify-center bg-bg-tertiary shrink-0">
              {customLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={customLogo}
                  alt={orgName}
                  className="h-full w-full object-contain"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/logo-icon.svg`}
                  alt=""
                  className="h-5 w-5 object-contain"
                />
              )}
            </div>
            <div>
              <span className="text-sm font-semibold text-text-primary tracking-tight">
                {orgName}
              </span>
              <PoweredByBadge />
            </div>
          </div>

          <div className="space-y-1">
            <div className="h-2 w-24 rounded bg-bg-tertiary" />
            <div className="h-2 w-16 rounded bg-bg-tertiary" />
          </div>
        </div>
      </div>
    </div>
  )
}
