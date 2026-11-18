'use client'

import * as React from 'react'
import * as RadixAvatar from '@radix-ui/react-avatar'
import { cn } from '@/lib/utils'
import { readableTextOn } from '@/lib/accent'

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

interface AvatarProps {
  src?: string | null
  name?: string | null
  /** The user's chosen circle colour (`#rrggbb`), shown when there's no picture.
   *  Wins over any background in `className` or `style`. */
  color?: string | null
  size?: AvatarSize
  className?: string
  style?: React.CSSProperties
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
  xl: 'h-16 w-16 text-lg',
}

function getInitials(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/** Same object: equal ignoring the query string, where a signature lives. */
function samePicture(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}

/**
 * Every response signs a fresh download link, so a refetch hands the same
 * picture over under a new URL, and Radix resets to the initials and loads it
 * again: every avatar on a comment list flashed on each refetch. Keep the URL
 * already showing while the new one names the same object.
 */
function useStablePictureUrl(src: string | null | undefined) {
  const [shown, setShown] = React.useState(src)
  const same = samePicture(src, shown)
  if (src !== shown && !same) setShown(src)
  return same ? shown : src
}

export function Avatar({ src: incomingSrc, name, color, size = 'md', className, style }: AvatarProps) {
  const src = useStablePictureUrl(incomingSrc)
  return (
    <RadixAvatar.Root
      className={cn(
        'relative inline-flex items-center justify-center rounded-full overflow-hidden bg-accent-muted text-text-primary font-medium shrink-0',
        sizeClasses[size],
        className,
      )}
      style={color ? { ...style, backgroundColor: color, color: readableTextOn(color) } : style}
    >
      {src && (
        <RadixAvatar.Image
          src={src}
          alt={name ?? 'Avatar'}
          className="h-full w-full object-cover"
        />
      )}
      {/* No `delayMs`: even 0 defers the initials a tick, so they'd flash in. */}
      <RadixAvatar.Fallback className="flex h-full w-full items-center justify-center">
        {getInitials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
}
