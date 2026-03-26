'use client'

import * as React from 'react'
import { Palette, Upload, X, Check, RotateCcw } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useBrandingStore } from '@/stores/branding-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function BrandingPage() {
  const { user } = useAuthStore()
  const { orgName, orgLogoUrl, setOrgName, setOrgLogoUrl } = useBrandingStore()

  const [nameValue, setNameValue] = React.useState(orgName)
  const [nameSaved, setNameSaved] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Sync if store changes externally
  React.useEffect(() => { setNameValue(orgName) }, [orgName])

  function handleSaveName() {
    const trimmed = nameValue.trim()
    if (!trimmed) return
    setOrgName(trimmed)
    setNameSaved(true)
    setTimeout(() => setNameSaved(false), 2000)
  }

  function handleLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const result = ev.target?.result
      if (typeof result === 'string') setOrgLogoUrl(result)
    }
    reader.readAsDataURL(file)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }

  const isAdmin = user?.is_superadmin

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Palette className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Branding</h1>
          <p className="text-sm text-text-secondary">
            Customize your workspace name and logo
          </p>
        </div>
      </div>

      {/* Workspace identity */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-text-primary">Workspace Identity</h2>
        <div className="rounded-lg border border-border bg-bg-secondary p-4 space-y-5">

          {/* Logo */}
          <div>
            <p className="text-sm font-medium text-text-primary mb-2">Logo</p>
            <div className="flex items-center gap-4">
              {/* Preview */}
              <div className="h-16 w-16 rounded-xl border border-border bg-bg-tertiary flex items-center justify-center overflow-hidden shrink-0">
                {orgLogoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={orgLogoUrl} alt="Logo" className="h-full w-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-1">
                    {/* Default FreeFrame logo icons */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/logo-icon.png" alt="FreeFrame" className="h-8 w-8 object-contain logo-dark" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/logo-icon-dark.png" alt="FreeFrame" className="h-8 w-8 object-contain logo-light" />
                  </div>
                )}
              </div>

              {/* Actions */}
              {isAdmin && (
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml,image/webp"
                    className="hidden"
                    onChange={handleLogoFile}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Upload logo
                  </Button>
                  {orgLogoUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOrgLogoUrl(null)}
                      className="text-status-error hover:text-status-error hover:bg-status-error/10"
                    >
                      <X className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  )}
                  <p className="text-2xs text-text-tertiary">PNG, JPG, SVG or WebP. Max 2 MB.</p>
                </div>
              )}
            </div>
          </div>

          {/* Name */}
          <div>
            <p className="text-sm font-medium text-text-primary mb-2">Workspace name</p>
            {isAdmin ? (
              <div className="flex items-center gap-2">
                <Input
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  placeholder="e.g. Acme Studio"
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                  className="max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleSaveName}
                  disabled={!nameValue.trim() || nameValue.trim() === orgName}
                >
                  {nameSaved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
                </Button>
                {orgName !== 'FreeFrame' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setOrgName('FreeFrame'); setNameValue('FreeFrame') }}
                    className="text-text-tertiary"
                  >
                    Reset
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-text-secondary">{orgName}</p>
            )}
            <p className="text-xs text-text-tertiary mt-1.5">
              Shown in the sidebar and browser tab. Defaults to &ldquo;FreeFrame&rdquo;.
            </p>
          </div>

        </div>
      </section>

      {/* Live preview */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Preview</h2>
        <div className="rounded-lg border border-border bg-bg-secondary p-4 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md overflow-hidden flex items-center justify-center bg-bg-tertiary shrink-0">
            {orgLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={orgLogoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-dark" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/logo-icon-dark.png" alt="FreeFrame" className="h-6 w-6 object-contain logo-light" />
              </>
            )}
          </div>
          <span className="text-sm font-semibold text-text-primary tracking-tight">{orgName}</span>
        </div>
      </section>

      {/* Reset all branding */}
      {isAdmin && (orgName !== 'FreeFrame' || orgLogoUrl) && (
        <section className="pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error hover:bg-status-error/10 gap-1.5"
            onClick={() => {
              setOrgName('FreeFrame')
              setNameValue('FreeFrame')
              setOrgLogoUrl(null)
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
        </section>
      )}

      {!isAdmin && (
        <p className="text-xs text-text-tertiary">
          Only super admins can edit branding settings.
        </p>
      )}
    </div>
  )
}
