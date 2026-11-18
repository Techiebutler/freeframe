'use client'

import * as React from 'react'
import { Upload, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar } from '@/components/shared/avatar'
import { api } from '@/lib/api'
import { prepareAvatar, AVATAR_INPUT_TYPES } from '@/lib/avatar-image'
import { useAuthStore } from '@/stores/auth-store'
import type { User } from '@/types'

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/
// What the picker opens on before a colour has been chosen.
const DEFAULT_PICKER_COLOR = '#7c3aed'

export function ProfileAvatarEditor() {
  const { user, setUser } = useAuthStore()
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const savedColor = user?.avatar_color ?? null
  const [colorValue, setColorValue] = React.useState(savedColor ?? '')
  const [savingColor, setSavingColor] = React.useState(false)
  const [colorError, setColorError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setColorValue(savedColor ?? '')
  }, [savedColor])

  if (!user) return null

  const hasPicture = !!user.avatar_url
  const busy = uploading || removing
  const trimmedColor = colorValue.trim()
  const colorIsValid = HEX_COLOR.test(trimmedColor)
  // Preview what's typed before it's saved, the way the accent colour does.
  const previewColor = colorIsValid ? trimmedColor : savedColor

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !user) return
    e.target.value = ''
    setError(null)
    setUploading(true)
    try {
      const blob = await prepareAvatar(file)
      // The signature covers the content type, so the PUT must send the same one.
      const { upload_url, key } = await api.post<{ upload_url: string; key: string }>(
        `/users/${user.id}/avatar-upload?content_type=${encodeURIComponent(blob.type)}`,
      )
      const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': blob.type },
      })
      if (!uploadRes.ok) throw new Error('Failed to upload image')
      const updated = await api.post<User>(`/users/${user.id}/avatar-confirm`, { key })
      setUser(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove() {
    if (!user) return
    setError(null)
    setRemoving(true)
    try {
      const updated = await api.delete<User>(`/users/${user.id}/avatar`)
      setUser(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  async function saveColor(next: string | null) {
    if (!user) return
    setColorError(null)
    setSavingColor(true)
    try {
      const updated = await api.patch<User>(`/users/${user.id}`, { avatar_color: next })
      setUser(updated)
    } catch (err) {
      setColorError(err instanceof Error ? err.message : 'Failed to save color')
    } finally {
      setSavingColor(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-bg-secondary">
        <Avatar
          src={user.avatar_url}
          name={user.name}
          color={previewColor}
          size="xl"
        />

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">Profile picture</p>
          <p className="text-xs text-text-tertiary mt-0.5 mb-3">
            Shown next to your comments, approvals and assignments.
          </p>

          {error && <p className="text-xs text-status-error mb-2">{error}</p>}

          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept={AVATAR_INPUT_TYPES.join(',')}
              className="hidden"
              onChange={handleFile}
              disabled={busy}
              data-testid="avatar-file-input"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {hasPicture ? 'Replace' : 'Upload'}
            </Button>
            {hasPicture && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemove}
                disabled={busy}
                className="text-status-error hover:text-status-error hover:bg-status-error/10"
              >
                <X className="h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>

          <p className="text-2xs text-text-tertiary mt-2">PNG · JPG · WEBP · max 10 MB</p>
        </div>
      </div>

      {!hasPicture && (
        <div className="space-y-2 rounded-lg border border-border bg-bg-secondary p-4">
          <div>
            <p className="text-sm font-medium text-text-primary">Circle color</p>
            <p className="text-xs text-text-tertiary mt-0.5">
              Shown behind your initials while you don&apos;t have a profile picture.
            </p>
          </div>
          {colorError && <p className="text-xs text-status-error">{colorError}</p>}
          <div className="flex items-center gap-2 pt-1">
            <input
              type="color"
              aria-label="Circle color"
              value={colorIsValid ? trimmedColor : savedColor || DEFAULT_PICKER_COLOR}
              onChange={(e) => setColorValue(e.target.value)}
              className="h-9 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            <Input
              aria-label="Circle color hex"
              value={colorValue}
              onChange={(e) => setColorValue(e.target.value)}
              placeholder={DEFAULT_PICKER_COLOR}
              maxLength={7}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && colorIsValid && trimmedColor.toLowerCase() !== savedColor) {
                  saveColor(trimmedColor)
                }
              }}
              className="flex-1 font-mono text-sm"
            />
            <Button
              size="sm"
              onClick={() => saveColor(trimmedColor)}
              loading={savingColor}
              disabled={!colorIsValid || trimmedColor.toLowerCase() === savedColor}
            >
              Save
            </Button>
            {savedColor && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => saveColor(null)}
                disabled={savingColor}
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
