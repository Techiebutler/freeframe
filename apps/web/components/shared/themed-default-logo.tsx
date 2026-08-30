import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

type LogoVariant = 'icon' | 'full'

type LogoAccessibility =
  | { decorative: true; alt?: never }
  | { decorative?: false; alt: string }

export type ThemedDefaultLogoProps = Omit<
  ComponentPropsWithoutRef<'img'>,
  'src' | 'alt' | 'aria-hidden'
> & {
  variant: LogoVariant
} & LogoAccessibility

const LOGO_SOURCES: Record<LogoVariant, string> = {
  icon: '/logo-icon-dark.png',
  full: '/logo-full-dark.svg',
}

/**
 * The built-in FreeFrame mark, recolored by the root data-theme in globals.css.
 * A single dark-ink asset keeps the markup hydration-safe and avoids fetching a
 * second image that would only be hidden by CSS.
 */
export function ThemedDefaultLogo({
  variant,
  decorative = false,
  alt,
  className,
  ...props
}: ThemedDefaultLogoProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...props}
      src={LOGO_SOURCES[variant]}
      alt={decorative ? '' : alt}
      aria-hidden={decorative || undefined}
      className={cn('themed-default-logo', className)}
    />
  )
}
