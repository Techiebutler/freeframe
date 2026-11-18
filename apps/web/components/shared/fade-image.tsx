'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

type FadeImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  /** Classes for the wrapper-less shimmer shown while the image loads. */
  placeholderClassName?: string
}

/**
 * Thumbnail <img> that never "pops" in: a shimmer holds the space while the
 * file downloads, then the image fades in once it is decoded. Images already
 * in the browser cache render immediately with no animation.
 *
 * Renders the shimmer as an absolutely positioned sibling, so the parent must
 * be `relative` (every thumbnail container here already is).
 */
export const FadeImage = React.forwardRef<HTMLImageElement, FadeImageProps>(function FadeImage(
  { className, placeholderClassName, onLoad, onError, loading = 'lazy', decoding = 'async', alt = '', src, ...props },
  forwardedRef,
) {
  const localRef = React.useRef<HTMLImageElement | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [instant, setInstant] = React.useState(false)

  const setRef = React.useCallback(
    (node: HTMLImageElement | null) => {
      localRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    },
    [forwardedRef],
  )

  // A new source starts hidden again; a cached one is complete on mount.
  React.useLayoutEffect(() => {
    const node = localRef.current
    const cached = !!node && node.complete && node.naturalWidth > 0
    setInstant(cached)
    setLoaded(cached)
  }, [src])

  return (
    <>
      {!loaded && (
        <span
          aria-hidden="true"
          className={cn('skeleton-shimmer animate-shimmer motion-reduce:animate-none pointer-events-none absolute inset-0', placeholderClassName)}
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={setRef}
        src={src}
        alt={alt}
        loading={loading}
        decoding={decoding}
        onLoad={(event) => {
          setLoaded(true)
          onLoad?.(event)
        }}
        onError={(event) => {
          setLoaded(true)
          onError?.(event)
        }}
        className={cn(
          !instant && 'transition-opacity duration-300 ease-out',
          loaded ? 'opacity-100' : 'opacity-0',
          className,
        )}
        {...props}
      />
    </>
  )
})
