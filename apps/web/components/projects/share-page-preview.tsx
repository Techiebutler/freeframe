'use client'

import * as React from 'react'
import { Download } from 'lucide-react'
import { accentVars } from '@/lib/accent'
import { cn } from '@/lib/utils'
import { ShareBrandMark } from '@/components/share/share-brand-mark'

/**
 * A share page drawn small: its header, whatever the caller puts in the body,
 * and, where the page has one, its footer.
 *
 * The link panel previews a real link's contents in it, and project settings
 * previews the project's branding before it is saved. The theme and accent are
 * scoped to this frame: `data-theme` swaps the palette for the subtree and the
 * accent goes on it as inline variables, so the app around it keeps its own.
 * Nothing here touches the document.
 *
 * The header is the signed-out one, which is what a guest sees: the same
 * ShareBrandMark the page draws (project logo, else the instance's, else the
 * FreeFrame mark), the title, and Download All when the link allows downloads.
 */
export function SharePagePreviewFrame({
  theme,
  accent,
  projectLogoUrl,
  title,
  allowDownload,
  footer,
  className,
  children,
}: {
  theme: 'dark' | 'light'
  /** Already resolved by the caller; null keeps the theme's own accent. */
  accent: string | null | undefined
  projectLogoUrl: string | null | undefined
  title: string
  allowDownload: boolean
  /**
   * The footer text. Undefined draws no footer at all, as on the single-asset
   * review screen; null draws the footer bar with nothing in it.
   */
  footer?: string | null
  className?: string
  children: React.ReactNode
}) {
  const accentStyle = (accentVars(accent) ?? undefined) as React.CSSProperties | undefined
  return (
    <div
      data-theme={theme}
      data-testid="share-preview-frame"
      style={accentStyle}
      className={cn(
        'pointer-events-none select-none rounded-xl border border-border bg-bg-primary overflow-hidden text-text-primary',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-secondary px-4 h-11">
        <div className="flex min-w-0 items-center gap-2.5">
          <ShareBrandMark theme={theme} projectLogoUrl={projectLogoUrl} />
          <span className="truncate text-[13px] font-medium text-text-primary">{title}</span>
        </div>
        {allowDownload && (
          <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[11px] font-medium text-white">
            <Download className="h-3 w-3" />
            Download All
          </span>
        )}
      </div>
      <div className="p-4">{children}</div>
      {footer !== undefined && (
        <div data-testid="share-preview-footer" className="border-t border-border px-5 py-3 min-h-[2.5rem]">
          {footer ? <p className="text-xs text-text-tertiary break-words">{footer}</p> : null}
        </div>
      )}
    </div>
  )
}
