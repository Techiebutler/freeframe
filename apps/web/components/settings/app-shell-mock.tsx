'use client'

import * as React from 'react'
import { Layers, Upload, Search, Bell, ChevronsLeft } from 'lucide-react'
import { PoweredByBadge } from '@/components/shared/powered-by-badge'

/** Authored at a literal desktop size and scaled by the caller, so the internal
 *  proportions are the real app's by construction rather than by hand-matching. */
export const MOCK_WIDTH = 1120
export const MOCK_HEIGHT = 700

interface MockProps {
  orgName: string
  logoUrl: string | null
  onLogoError: () => void
}

/**
 * A replica of the signed-in app shell, not a diagram of it.
 *
 * The sidebar half mirrors components/layout/sidebar.tsx in its expanded state:
 * same 220px width, same 48px logo header with `gap-2.5 px-4`, the same 28px
 * logo. The attribution pill mirrors its placement in the dashboard layout,
 * floating bottom-right over the content. Those are the surfaces branding
 * controls, so they are copied class-for-class; if they change, this should
 * change with them.
 *
 * Everything else is scenery. It exists because a brand mark judged in
 * isolation tells you nothing about how it reads against the product around it,
 * which is the whole reason to look before saving.
 */
export function AppShellMock({ orgName, logoUrl, onLogoError }: MockProps) {
  return (
    <div
      className="relative flex bg-bg-primary text-text-primary"
      style={{ width: MOCK_WIDTH, height: MOCK_HEIGHT }}
    >
      <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-border bg-bg-secondary">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={orgName}
              onError={onLogoError}
              className="h-7 w-7 shrink-0 rounded object-contain"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/logo-icon.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
          )}
          <span className="truncate text-sm font-semibold tracking-tight text-text-primary">
            {orgName}
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          <div className="flex h-9 items-center gap-2.5 rounded-md bg-bg-hover px-2.5 text-text-primary">
            <Layers className="h-[18px] w-[18px] shrink-0" strokeWidth={2} />
            <span className="text-[13px] font-medium">Projects</span>
          </div>
          <div className="flex h-9 items-center gap-2.5 rounded-md px-2.5 text-text-secondary">
            <Upload className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />
            <span className="text-[13px]">Uploads</span>
          </div>
        </nav>

        <div className="shrink-0 space-y-2 border-t border-border p-3">
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
              <div className="h-full w-2/5 rounded-full bg-text-tertiary/50" />
            </div>
            <div className="h-1.5 w-16 rounded bg-bg-tertiary" />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <div className="h-6 w-6 shrink-0 rounded-full bg-bg-tertiary" />
            <div className="h-2 w-20 rounded bg-bg-tertiary" />
          </div>
          <div className="flex items-center gap-2 pt-1 text-text-tertiary">
            <ChevronsLeft className="h-4 w-4" />
            <span className="text-xs">Collapse</span>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="flex h-7 max-w-xs flex-1 items-center gap-2 rounded-md border border-border bg-bg-secondary px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
            <div className="h-1.5 w-24 rounded bg-bg-tertiary" />
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* A real primary button, so the accent color is visible on the
                surface it actually paints. */}
            <div className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5">
              <Upload className="h-3.5 w-3.5 text-text-inverse" strokeWidth={2} />
              <span className="text-xs font-medium text-text-inverse">Upload</span>
            </div>
            <Bell className="h-4 w-4 text-text-tertiary" strokeWidth={1.5} />
            <div className="h-6 w-6 rounded-full bg-bg-tertiary" />
          </div>
        </div>

        <div className="flex-1 space-y-4 p-5">
          <div className="space-y-2">
            <div className="h-3 w-32 rounded bg-bg-tertiary" />
            <div className="h-2 w-48 rounded bg-bg-tertiary/60" />
          </div>
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
                <div className="aspect-video bg-bg-tertiary" />
                <div className="space-y-1.5 p-2.5">
                  <div className="h-2 w-3/4 rounded bg-bg-tertiary" />
                  <div className="h-1.5 w-1/2 rounded bg-bg-tertiary/60" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Mirrors the dashboard layout: floats over the content, bottom-right. */}
      <PoweredByBadge className="absolute bottom-4 right-4 rounded-full border border-border bg-bg-elevated/90 px-3 py-1.5 shadow-lg" />
    </div>
  )
}

/**
 * A replica of the transactional email shell, mirroring
 * apps/api/templates/email/base.html: the org name as the header, the body
 * block, and the footer's copyright and account line, both of which now render
 * the org name rather than the product's.
 *
 * Worth previewing because email is the branding surface an admin can't check
 * without sending themselves one, and it is what people see before they ever
 * reach the app. Deliberately plain: base.html is a table-based email layout
 * with its own inline styles, so this shows the copy and hierarchy rather than
 * pretending to be a pixel-accurate render.
 */
export function EmailMock({ orgName, logoUrl, onLogoError }: MockProps) {
  const year = new Date().getFullYear()
  return (
    <div
      className="flex items-center justify-center bg-bg-tertiary px-4"
      style={{ width: MOCK_WIDTH, height: MOCK_HEIGHT }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-bg-secondary">
        <div className="flex items-center justify-center gap-2.5 border-b border-border px-6 py-6">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={orgName}
              onError={onLogoError}
              className="h-7 w-7 shrink-0 rounded object-contain"
            />
          ) : null}
          <span className="text-xl font-semibold text-text-primary">{orgName}</span>
        </div>

        <div className="space-y-4 px-6 py-6">
          <div className="h-3 w-56 rounded bg-bg-tertiary" />
          <p className="text-sm text-text-secondary">
            Use this code to sign in to {orgName}:
          </p>
          <div className="flex justify-center py-1">
            <span className="rounded-md border border-border bg-bg-primary px-5 py-2.5 font-mono text-xl tracking-[0.3em] text-text-primary">
              418362
            </span>
          </div>
          <div className="h-2 w-72 rounded bg-bg-tertiary/60" />
        </div>

        <div className="space-y-1.5 border-t border-border px-6 py-5 text-center">
          <p className="text-xs text-text-tertiary">
            © {year} {orgName}. All rights reserved.
          </p>
          <p className="text-2xs text-text-tertiary">
            You&apos;re receiving this email because you have an account on {orgName}.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * A replica of the sign-in screen, mirroring app/(auth)/layout.tsx: the same
 * radial glow, the same 48px-tall brand mark and org name above the card, the
 * same max-w-sm card, and the attribution line beneath it.
 *
 * Worth its own preview because this is the screen people who are not yet
 * signed in actually see, and it uses the dedicated login logo when one is set.
 */
export function LoginScreenMock({ orgName, logoUrl, onLogoError }: MockProps) {
  return (
    <div
      className="relative flex flex-col items-center justify-center bg-bg-primary px-4"
      style={{ width: MOCK_WIDTH, height: MOCK_HEIGHT }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/[0.04] blur-[120px]" />
      </div>

      <div className="relative mb-8 text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={orgName}
            onError={onLogoError}
            className="mx-auto mb-3 h-12 object-contain"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/logo-full.svg" alt="" className="mx-auto mb-3 h-12 object-contain" />
        )}
        <h1 className="text-xl font-semibold text-text-primary">{orgName}</h1>
      </div>

      <div className="relative w-full max-w-sm space-y-4 rounded-xl border border-border bg-bg-secondary/50 p-6 shadow-xl">
        <div className="space-y-2">
          <div className="h-2.5 w-24 rounded bg-bg-tertiary" />
          <div className="h-9 w-full rounded-md border border-border bg-bg-primary" />
        </div>
        <div className="h-9 w-full rounded-md bg-accent/80" />
        <div className="mx-auto h-2 w-32 rounded bg-bg-tertiary/60" />
      </div>

      <div className="relative mt-6">
        <PoweredByBadge className="justify-center" />
      </div>

      <p className="relative mt-8 text-2xs text-text-tertiary">
        Collaborative media review &amp; approval
      </p>
    </div>
  )
}
