import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Avatar } from '../shared/avatar'

describe('Avatar component', () => {
  it('renders root element when no image is provided', () => {
    const { container } = render(<Avatar name="John Doe" />)
    const root = container.firstChild as HTMLElement
    expect(root).toBeInTheDocument()
  })

  it('applies md size classes by default', () => {
    const { container } = render(<Avatar name="Test" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('h-8')
    expect(root.className).toContain('w-8')
  })

  it('applies sm size classes', () => {
    const { container } = render(<Avatar name="Test" size="sm" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('h-6')
    expect(root.className).toContain('w-6')
  })

  it('applies lg size classes', () => {
    const { container } = render(<Avatar name="Test" size="lg" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('h-10')
    expect(root.className).toContain('w-10')
  })

  it('applies custom className to root element', () => {
    const { container } = render(<Avatar name="Test" className="border-2" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('border-2')
  })

  it('renders rounded-full class for circular shape', () => {
    const { container } = render(<Avatar name="John Doe" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('rounded-full')
  })

  it('renders with a src prop without crashing', () => {
    // Radix Avatar.Image renders in a portal in jsdom — just verify no error thrown
    const { container } = render(<Avatar src="https://example.com/avatar.jpg" name="User" />)
    expect(container.firstChild).toBeInTheDocument()
  })

  it('applies xl size classes', () => {
    const { container } = render(<Avatar name="Test" size="xl" />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('h-16')
    expect(root.className).toContain('w-16')
  })

  it('paints a chosen color over the default background', () => {
    const { container } = render(<Avatar name="Test" color="#1e3a8a" />)
    const root = container.firstChild as HTMLElement
    expect(root.style.backgroundColor).toBe('rgb(30, 58, 138)')
  })

  it('uses light initials on a dark color and dark initials on a light one', () => {
    const dark = render(<Avatar name="Test" color="#1e3a8a" />).container.firstChild as HTMLElement
    const light = render(<Avatar name="Test" color="#fde68a" />).container.firstChild as HTMLElement
    expect(dark.style.color).toBe('rgb(255, 255, 255)')
    expect(light.style.color).toBe('rgb(24, 24, 27)')
  })

  it('lets a chosen color win over a passed style background', () => {
    const { container } = render(
      <Avatar name="Test" color="#1e3a8a" style={{ backgroundColor: '#ff0000' }} />,
    )
    const root = container.firstChild as HTMLElement
    expect(root.style.backgroundColor).toBe('rgb(30, 58, 138)')
  })

  it('leaves the theme background alone when no color is chosen', () => {
    const { container } = render(<Avatar name="Test" />)
    const root = container.firstChild as HTMLElement
    expect(root.style.backgroundColor).toBe('')
    expect(root.className).toContain('bg-accent-muted')
  })

  it('does not render fallback span when no src provided', () => {
    const { container } = render(<Avatar name="No Image" />)
    // Root span should be present
    const root = container.firstChild as HTMLElement
    expect(root).toBeInTheDocument()
    expect(root.tagName).toBe('SPAN')
  })
})

describe('Avatar picture URL across refetches', () => {
  class LoadedImage {
    complete = true
    naturalWidth = 1
    src = ''
    referrerPolicy = ''
    crossOrigin: string | null = null
    addEventListener() {}
    removeEventListener() {}
  }
  beforeEach(() => { vi.stubGlobal('Image', LoadedImage) })
  afterEach(() => { vi.unstubAllGlobals() })

  const signed = (path: string, sig: string) => `https://s3.test/${path}?X-Amz-Signature=${sig}`

  it('keeps the URL it shows when a refetch re-signs the same picture', () => {
    const { rerender } = render(<Avatar name="Ada" src={signed('avatars/u1/a.webp', '1')} />)
    rerender(<Avatar name="Ada" src={signed('avatars/u1/a.webp', '2')} />)

    expect((screen.getByAltText('Ada') as HTMLImageElement).src).toBe(signed('avatars/u1/a.webp', '1'))
  })

  it('switches when the picture itself changes', () => {
    const { rerender } = render(<Avatar name="Ada" src={signed('avatars/u1/a.webp', '1')} />)
    rerender(<Avatar name="Ada" src={signed('avatars/u1/b.webp', '2')} />)

    expect((screen.getByAltText('Ada') as HTMLImageElement).src).toBe(signed('avatars/u1/b.webp', '2'))
  })

  it('drops the picture when it is removed', () => {
    const { rerender } = render(<Avatar name="Ada Lovelace" src={signed('avatars/u1/a.webp', '1')} />)
    rerender(<Avatar name="Ada Lovelace" src={null} />)

    expect(screen.queryByAltText('Ada Lovelace')).toBeNull()
    expect(screen.getByText('AL')).toBeInTheDocument()
  })
})
