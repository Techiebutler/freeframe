import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThemedDefaultLogo } from '../themed-default-logo'

describe('ThemedDefaultLogo', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it.each(['light', 'dark'] as const)(
    'renders one canonical icon asset in the %s theme',
    (theme) => {
      document.documentElement.setAttribute('data-theme', theme)
      const { container } = render(
        <ThemedDefaultLogo variant="icon" alt="FreeFrame" className="h-7 w-7" />,
      )

      const images = container.querySelectorAll('img')
      expect(images).toHaveLength(1)
      expect(images[0]).toHaveAttribute('src', '/logo-icon-dark.png')
      expect(images[0]).toHaveClass('themed-default-logo', 'h-7', 'w-7')
    },
  )

  it('applies the production theme filter despite a later filter class', () => {
    const globalsCss = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8')
    const logoRules = globalsCss.match(
      /\[data-theme="(?:light|dark)"\]\s+\.themed-default-logo\s*\{[^}]+\}/g,
    )
    expect(logoRules).toHaveLength(2)

    const style = document.createElement('style')
    style.textContent = `${logoRules!.join('\n')}\n.filter-none { filter: none; }`
    document.head.appendChild(style)

    try {
      const { container } = render(
        <ThemedDefaultLogo variant="icon" alt="FreeFrame" className="filter-none" />,
      )
      const logo = container.querySelector('img')!

      document.documentElement.setAttribute('data-theme', 'light')
      expect(getComputedStyle(logo).filter).toBe('none')

      document.documentElement.setAttribute('data-theme', 'dark')
      expect(getComputedStyle(logo).filter).toBe('brightness(0) invert(1)')
    } finally {
      style.remove()
    }
  })

  it('does not expose style or srcSet overrides', () => {
    type LogoProps = ComponentProps<typeof ThemedDefaultLogo>
    type RestrictedPropsStayHidden = [
      'style' extends keyof LogoProps ? false : true,
      'srcSet' extends keyof LogoProps ? false : true,
    ]

    const restrictedPropsStayHidden: RestrictedPropsStayHidden = [true, true]
    expect(restrictedPropsStayHidden).toEqual([true, true])
  })

  it('uses the full lockup asset and forwards safe native image props', () => {
    render(
      <ThemedDefaultLogo
        variant="full"
        alt="FreeFrame lockup"
        className="h-12"
        data-testid="full-logo"
        decoding="async"
      />,
    )

    const logo = screen.getByRole('img', { name: 'FreeFrame lockup' })
    expect(logo).toHaveAttribute('src', '/logo-full-dark.svg')
    expect(logo).toHaveAttribute('decoding', 'async')
    expect(logo).toHaveClass('themed-default-logo', 'h-12')
  })

  it('makes decorative marks silent to assistive technology', () => {
    const { container } = render(
      <ThemedDefaultLogo variant="icon" decorative className="h-3.5 w-3.5" />,
    )

    const logo = container.querySelector('img')
    expect(logo).toHaveAttribute('alt', '')
    expect(logo).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
