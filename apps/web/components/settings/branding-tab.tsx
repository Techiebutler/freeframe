'use client'

import * as React from 'react'
import { Palette, Upload, RotateCcw, Check } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { HARDCODED_DEFAULTS, useBrandingStore } from '@/stores/branding-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { BrandingLogoUpload } from '@/components/settings/branding-logo-upload'
import { BrandingPreview } from '@/components/settings/branding-preview'

type BrandingSlot = 'logo-light' | 'logo-dark' | 'favicon' | 'apple-icon' | 'login-logo'

interface BrandingUrls {
  logo_light_url?: string | null
  logo_dark_url?: string | null
  favicon_url?: string | null
  apple_icon_url?: string | null
  login_logo_url?: string | null
}

// The update response carries a URL for every slot that's set, not just the one that
// changed — each slot has to read back its own field or it reports another slot's image.
const SLOT_FIELDS: Record<BrandingSlot, { keyField: string; urlField: keyof BrandingUrls }> = {
  'logo-light': { keyField: 'logo_light_key', urlField: 'logo_light_url' },
  'logo-dark': { keyField: 'logo_dark_key', urlField: 'logo_dark_url' },
  favicon: { keyField: 'favicon_key', urlField: 'favicon_url' },
  'apple-icon': { keyField: 'apple_icon_key', urlField: 'apple_icon_url' },
  'login-logo': { keyField: 'login_logo_key', urlField: 'login_logo_url' },
}

function QuickUpload({
  onSlotUpload,
}: {
  onSlotUpload: (slot: BrandingSlot, url: string) => void
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setError(null)

    if (file.size > 2 * 1024 * 1024) {
      setError('File must be under 2 MB')
      return
    }

    setUploading(true)
    // The signature covers the content type, so the same value has to go on the PUT.
    const contentType = file.type || 'image/png'
    try {
      for (const slot of Object.keys(SLOT_FIELDS) as BrandingSlot[]) {
        const { keyField, urlField } = SLOT_FIELDS[slot]
        const presignData = await api.post<{ upload_url: string; key: string }>(
          `/instance/branding/${slot}-upload?content_type=${encodeURIComponent(contentType)}`
        )
        const { upload_url: presignedUrl, key: s3Key } = presignData

        const uploadRes = await fetch(presignedUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': contentType },
        })
        if (!uploadRes.ok) throw new Error(`Failed to upload for ${slot}`)

        const data = await api.put<BrandingUrls>('/instance/branding', { [keyField]: s3Key })
        const url = data[urlField]
        // Apply each slot as it lands, so a later failure doesn't discard the ones
        // the server already accepted.
        if (url) onSlotUpload(slot, url)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      {error && <p className="text-xs text-status-error">{error}</p>}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/svg+xml,image/webp"
        className="hidden"
        onChange={handleFile}
      />
      <Button
        variant="secondary"
        size="lg"
        loading={uploading}
        onClick={() => fileInputRef.current?.click()}
        className="w-full max-w-xs"
      >
        <Upload className="h-4 w-4" />
        {uploading ? 'Uploading...' : 'Upload your logo'}
      </Button>
      <p className="text-xs text-text-tertiary text-center">
        PNG, SVG, or WebP · 512×512px+ · Transparent background
        <br />
        We&apos;ll apply it to all branding slots at once.
      </p>
    </div>
  )
}

export function BrandingTab() {
  const { user } = useAuthStore()
  const {
    orgName,
    orgLogoDark,
    orgLogoLight,
    faviconUrl,
    appleIconUrl,
    loginLogoUrl,
    poweredByFreeframe,
    primaryColor,
    setOrgName,
    setOrgLogoDark,
    setOrgLogoLight,
    setFaviconUrl,
    setAppleIconUrl,
    setLoginLogoUrl,
    setPoweredByFreeframe,
    setPrimaryColor,
    fetchBranding,
    loaded,
  } = useBrandingStore()

  const [nameValue, setNameValue] = React.useState(orgName)
  const [nameSaved, setNameSaved] = React.useState(false)
  const [resetOpen, setResetOpen] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const [resetError, setResetError] = React.useState<string | null>(null)
  const [savingPowered, setSavingPowered] = React.useState(false)
  const [savingName, setSavingName] = React.useState(false)
  const [savingColor, setSavingColor] = React.useState(false)
  const [colorValue, setColorValue] = React.useState(primaryColor || '')

  const isAdmin = user?.is_superadmin

  React.useEffect(() => {
    if (!loaded) fetchBranding()
  }, [loaded, fetchBranding])

  React.useEffect(() => {
    const state = useBrandingStore.getState()
    setNameValue(state.orgName)
    setColorValue(state.primaryColor || '')
  }, [orgName, primaryColor])

  async function handleSaveName() {
    const trimmed = nameValue.trim()
    if (!trimmed || trimmed === orgName) return
    setSavingName(true)
    try {
      const data = await api.put<{ org_name: string }>('/instance/branding', { org_name: trimmed })
      setOrgName(data.org_name || trimmed)
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch {
      setNameSaved(false)
    } finally {
      setSavingName(false)
    }
  }

  async function handleTogglePowered(value: boolean) {
    setSavingPowered(true)
    try {
      await api.put('/instance/branding', { powered_by_freeframe: value })
      setPoweredByFreeframe(value)
    } catch {
      // revert on error
    } finally {
      setSavingPowered(false)
    }
  }

  async function handleSaveColor() {
    const trimmed = colorValue.trim()
    if (!trimmed || trimmed === primaryColor) return
    if (!/^#[0-9A-Fa-f]{6}$/.test(trimmed)) {
      return
    }
    setSavingColor(true)
    try {
      await api.put('/instance/branding', { primary_color: trimmed })
      setPrimaryColor(trimmed)
    } catch {
      // silent
    } finally {
      setSavingColor(false)
    }
  }

  async function handleResetAll() {
    setResetting(true)
    setResetError(null)
    try {
      const data = await api.put('/instance/branding', {
        org_name: HARDCODED_DEFAULTS.orgName,
        logo_light_key: null,
        logo_dark_key: null,
        favicon_key: null,
        apple_icon_key: null,
        login_logo_key: null,
        primary_color: null,
        // Included so "reset all" really is all: the attribution toggle counts
        // toward hasCustomBranding, so leaving it out left the Reset section
        // on screen after a reset that had already finished.
        powered_by_freeframe: HARDCODED_DEFAULTS.poweredByFreeframe,
      })
      const { syncBranding } = useBrandingStore.getState()
      syncBranding(data as never)
      setNameValue(HARDCODED_DEFAULTS.orgName)
      setResetOpen(false)
    } catch (err) {
      // Rethrow so ConfirmDialog leaves itself open instead of closing as if the
      // reset had worked — the message below tells the admin what went wrong.
      setResetError(err instanceof Error ? err.message : 'Reset failed')
      throw err
    } finally {
      setResetting(false)
    }
  }

  const hasCustomBranding =
    orgName !== HARDCODED_DEFAULTS.orgName ||
    orgLogoDark !== null ||
    orgLogoLight !== null ||
    faviconUrl !== null ||
    appleIconUrl !== null ||
    loginLogoUrl !== null ||
    primaryColor !== HARDCODED_DEFAULTS.primaryColor ||
    poweredByFreeframe !== HARDCODED_DEFAULTS.poweredByFreeframe

  const slotProps = {
    disabled: !isAdmin,
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-muted">
          <Palette className="h-5 w-5 text-accent" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Branding</h1>
          <p className="text-base text-text-secondary">
            Customize your workspace name, logo, and identity
          </p>
        </div>
      </div>

      <BrandingPreview />

      {/* ── Section: Replace All ── */}
      {isAdmin && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text-secondary">Quick Upload</h2>
          <p className="text-sm text-text-secondary -mt-1">
            Upload one logo and we&apos;ll apply it everywhere. Or customize each slot individually below.
          </p>
          <div className="p-4 rounded-lg border-2 border-dashed border-border bg-bg-secondary hover:border-accent/50 transition-colors">
            <QuickUpload
              onSlotUpload={(slot, url) => {
                const setters: Record<BrandingSlot, (url: string) => void> = {
                  'logo-light': setOrgLogoLight,
                  'logo-dark': setOrgLogoDark,
                  favicon: setFaviconUrl,
                  'apple-icon': setAppleIconUrl,
                  'login-logo': setLoginLogoUrl,
                }
                setters[slot](url)
              }}
            />
          </div>
        </section>
      )}

      {/* ── Section: Logos & Icons ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-secondary">Logos & Icons</h2>
        <p className="text-sm text-text-secondary -mt-1">
          Upload logos for different contexts. Each slot can have its own image.
        </p>
        <div className="space-y-4">
            {/* Greeting */}
            <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
              <h3 className="text-sm font-medium text-text-secondary">Greeting</h3>
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
                    loading={savingName}
                    disabled={
                      !nameValue.trim() || nameValue.trim() === orgName
                    }
                  >
                    {nameSaved ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      'Save'
                    )}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-text-secondary">{orgName}</p>
              )}
              <p className="text-sm text-text-secondary">
                Shown in the sidebar. Defaults to &ldquo;FreeFrame&rdquo;.
              </p>
            </div>

            <BrandingLogoUpload
              slotKey="logo_light"
              label="Logo (Light bg)"
              description="Used on light backgrounds — dark-colored logo"
              acceptedFormats={['PNG', 'SVG', 'WebP']}
              minResolution="256×256px"
              guidance="Solid shapes work best."
              currentUrl={orgLogoLight}
              previewBg="bg-white"
              {...slotProps}
              onUpload={(url) => setOrgLogoLight(url)}
              onRemove={() => setOrgLogoLight(null)}
            />

            <BrandingLogoUpload
              slotKey="logo_dark"
              label="Logo (Dark bg)"
              description="Used on dark backgrounds — light-colored logo"
              acceptedFormats={['PNG', 'SVG', 'WebP']}
              minResolution="256×256px"
              guidance="Solid shapes work best against dark backgrounds."
              currentUrl={orgLogoDark}
              previewBg="bg-zinc-900"
              {...slotProps}
              onUpload={(url) => setOrgLogoDark(url)}
              onRemove={() => setOrgLogoDark(null)}
            />

            <BrandingLogoUpload
              slotKey="favicon"
              label="Favicon"
              description="Browser tab icon"
              acceptedFormats={['ICO', 'PNG']}
              minResolution="32×32px"
              guidance="Keep it simple — renders at 16-32px."
              currentUrl={faviconUrl}
              previewBg="bg-zinc-900"
              {...slotProps}
              onUpload={(url) => setFaviconUrl(url)}
              onRemove={() => setFaviconUrl(null)}
            />

            <BrandingLogoUpload
              slotKey="apple_icon"
              label="Apple Touch Icon"
              description="iOS home screen icon"
              acceptedFormats={['PNG']}
              minResolution="180×180px"
              guidance="Shown when users add FreeFrame to iPhone home screen."
              currentUrl={appleIconUrl}
              previewBg="bg-zinc-900"
              {...slotProps}
              onUpload={(url) => setAppleIconUrl(url)}
              onRemove={() => setAppleIconUrl(null)}
            />

            <BrandingLogoUpload
              slotKey="login_logo"
              label="Login Page Logo"
              description="Custom logo for the login page (optional)"
              acceptedFormats={['PNG', 'SVG', 'WebP']}
              minResolution="512×512px"
              guidance="If omitted, the main logo is used on the login page."
              currentUrl={loginLogoUrl}
              previewBg="bg-zinc-900"
              {...slotProps}
              onUpload={(url) => setLoginLogoUrl(url)}
              onRemove={() => setLoginLogoUrl(null)}
            />
          </div>
      </section>

      {/* ── Section: Primary Color ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-secondary">
          Primary Color
        </h2>
        <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
          <p className="text-sm text-text-secondary">
            Set a custom accent color for your instance. Used as a CSS variable (<code>--ff-primary</code>).
          </p>
          {isAdmin ? (
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={colorValue || '#7c3aed'}
                onChange={(e) => setColorValue(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
              <Input
                value={colorValue}
                onChange={(e) => setColorValue(e.target.value)}
                placeholder="#7c3aed"
                maxLength={7}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveColor()}
                className="max-w-[140px] font-mono text-sm"
              />
              <Button
                size="sm"
                onClick={handleSaveColor}
                loading={savingColor}
                disabled={!colorValue.trim() || colorValue.trim() === primaryColor || !/^#[0-9A-Fa-f]{6}$/.test(colorValue.trim())}
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-sm font-mono text-text-secondary">
              {primaryColor || '#7c3aed'}
            </p>
          )}
        </div>
      </section>

      {/* ── Section: Powered by FreeFrame ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-text-secondary">
          Powered by FreeFrame
        </h2>
        <div className="p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">
                Show attribution
              </p>
              <p className="text-sm text-text-secondary">
                Support FreeFrame by showing &ldquo;Powered by FreeFrame&rdquo;.
              </p>
            </div>
            {isAdmin ? (
              <Switch
                checked={poweredByFreeframe}
                onCheckedChange={handleTogglePowered}
                disabled={savingPowered}
              />
            ) : (
              <span className="text-sm text-text-secondary">
                {poweredByFreeframe ? 'On' : 'Off'}
              </span>
            )}
          </div>
        </div>
      </section>



      {/* ── Section: Reset ── */}
      {isAdmin && hasCustomBranding && (
        <section className="pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:text-status-error hover:bg-status-error/10 gap-1.5"
            onClick={() => {
              setResetError(null)
              setResetOpen(true)
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset all branding
          </Button>
          {resetError && (
            <p className="mt-2 text-xs text-status-error">{resetError}</p>
          )}
        </section>
      )}

      {!isAdmin && (
        <p className="text-xs text-text-tertiary">
          Only super admins can edit branding settings.
        </p>
      )}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset all branding?"
        description='This clears your custom name, logos and accent color, and turns the "Powered by FreeFrame" badge back on.'
        confirmLabel="Reset"
        variant="danger"
        loading={resetting}
        error={resetError}
        onConfirm={handleResetAll}
      />
    </div>
  )
}
