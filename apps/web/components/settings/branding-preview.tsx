'use client'

import * as React from 'react'
import { Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBrandingStore } from '@/stores/branding-store'
import { useResolvedTheme } from '@/hooks/use-resolved-theme'
import {
  AppShellMock,
  LoginScreenMock,
  EmailMock,
  MOCK_WIDTH,
  MOCK_HEIGHT,
} from './app-shell-mock'

const SCREENS = [
  { key: 'app', label: 'App' },
  { key: 'login', label: 'Sign-in' },
  { key: 'email', label: 'Email' },
] as const

type ScreenKey = (typeof SCREENS)[number]['key']

/**
 * Live preview of the screen this instance's branding actually lands on.
 *
 * It renders a scaled-down replica of the whole signed-in app shell rather than
 * a strip of the elements the controls below edit. A logo swatch on its own
 * says nothing about whether the mark reads at 28px against the product's own
 * chrome, which is the question an admin is actually asking before they save.
 *
 * Tracks the store, so it updates the moment a logo upload or a name change
 * lands rather than waiting for a reload.
 */
export function BrandingPreview() {
  const { orgName, orgLogoDark, orgLogoLight, loginLogoUrl } = useBrandingStore()
  const theme = useResolvedTheme()
  const [screen, setScreen] = React.useState<ScreenKey>('app')

  const appLogo =
    theme === 'light' ? orgLogoLight ?? orgLogoDark : orgLogoDark ?? orgLogoLight
  // Mirrors AuthBrandingHeader: the dedicated login logo wins on auth screens.
  const authLogo =
    loginLogoUrl ||
    (theme === 'dark' ? orgLogoDark ?? orgLogoLight : orgLogoLight ?? orgLogoDark)
  const logoUrl = screen === 'login' ? authLogo : appLogo

  // A presigned logo URL that has expired would otherwise leave a broken-image
  // glyph exactly where the brand mark belongs. Fall back to the default icon,
  // which is what the real sidebar ends up showing too.
  const [logoErrored, setLogoErrored] = React.useState(false)
  React.useEffect(() => setLogoErrored(false), [logoUrl])

  // Authored at MOCK_WIDTH and scaled to whatever width this card gets, so the
  // proportions stay the real app's. ResizeObserver is absent in jsdom, so the
  // initial value keeps tests and any SSR pass rendering a sane size.
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [scale, setScale] = React.useState(0.55)
  React.useEffect(() => {
    const node = hostRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / MOCK_WIDTH))
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-muted">
          <Eye className="h-4 w-4 text-text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">Preview</p>
          <p className="text-xs text-text-tertiary">
            {screen === 'login'
              ? 'What people see before signing in'
              : screen === 'email'
                ? 'What this instance sends from'
                : 'What your team sees after signing in'}
          </p>
        </div>

        <div className="ml-auto flex shrink-0 rounded-md border border-border bg-bg-primary p-0.5">
          {SCREENS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScreen(s.key)}
              aria-pressed={screen === s.key}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors',
                screen === s.key
                  ? 'bg-bg-hover font-medium text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative mt-5">
        <div className="overflow-hidden rounded-xl border border-border/70 bg-bg-tertiary shadow-[0_20px_45px_-24px_rgba(0,0,0,0.5)]">
          {/* Window chrome, so the well reads as a screen rather than a panel. */}
          <div className="flex items-center gap-1.5 border-b border-border/60 bg-bg-elevated/70 px-3 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
          </div>

          <div
            ref={hostRef}
            className="relative w-full overflow-hidden bg-bg-primary"
            style={{ height: MOCK_HEIGHT * scale }}
          >
            <div
              className="pointer-events-none origin-top-left select-none"
              style={{ width: MOCK_WIDTH, height: MOCK_HEIGHT, transform: `scale(${scale})` }}
            >
              {screen === 'email' ? (
                <EmailMock
                  orgName={orgName}
                  logoUrl={logoErrored ? null : logoUrl}
                  onLogoError={() => setLogoErrored(true)}
                />
              ) : screen === 'login' ? (
                <LoginScreenMock
                  orgName={orgName}
                  logoUrl={logoErrored ? null : logoUrl}
                  onLogoError={() => setLogoErrored(true)}
                />
              ) : (
                <AppShellMock
                  orgName={orgName}
                  logoUrl={logoErrored ? null : logoUrl}
                  onLogoError={() => setLogoErrored(true)}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <p className="mt-3 text-xs text-text-tertiary">
        {screen === 'login'
          ? 'Uses the sign-in logo when one is set, falling back to your org logo. Copies the real screen’s spacing, so the mark is shown at the size it will actually render.'
          : screen === 'email'
            ? 'Every email this instance sends carries your name in the header and footer. The From line follows it too, unless MAIL_FROM_NAME pins a different one.'
            : 'The sidebar is a faithful copy: same widths, spacing and logo size as the real one. Projects and avatars are placeholders.'}
      </p>
    </div>
  )
}
