'use client'

import * as React from 'react'
import * as RadixAvatar from '@radix-ui/react-avatar'
import { cn } from '@/lib/utils'

type AvatarSize = 'sm' | 'md' | 'lg'

interface AvatarProps {
  src?: string | null
  name?: string | null
  size?: AvatarSize
  className?: string
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
}

function getInitials(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  return (
    <RadixAvatar.Root
      className={cn(
        'relative inline-flex items-center justify-center rounded-full overflow-hidden bg-accent-muted shrink-0',
        sizeClasses[size],
        className,
      )}
    >
      {src && (
        <RadixAvatar.Image
          src={src}
          alt={name ?? 'Avatar'}
          className="h-full w-full object-cover"
        />
      )}
      <RadixAvatar.Fallback
        className="flex h-full w-full items-center justify-center font-medium text-accent"
        delayMs={0}
      >
        {getInitials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
}
