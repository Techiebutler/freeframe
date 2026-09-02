import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

type LogoVariant = 'icon' | 'full'

type LogoAccessibility =
  | { decorative: true; alt?: never }
  | { decorative?: false; alt: string }

export type ThemedDefaultLogoProps = Omit<
  ComponentPropsWithoutRef<'img'>,
  'src' | 'srcSet' | 'alt' | 'aria-hidden' | 'style'
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
 * second image that would only be hidden by CSS. `className` is for sizing
 * and layout only; theme/filter styling is owned by this component.
 *
 * `style` and `srcSet` are omitted from the props type and pinned to undefined
 * after the spread, so the ownership above holds at runtime too rather than
 * resting on the caller being typechecked.
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
      srcSet={undefined}
      style={undefined}
      alt={decorative ? '' : alt}
      aria-hidden={decorative || undefined}
      className={cn('themed-default-logo', className)}
    />
  )
}
