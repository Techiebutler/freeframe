import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { stubGeometry, restoreGeometry } from '@/test/geometry'
import { render, screen, waitFor } from '@testing-library/react'
import { ImageViewer } from '../image-viewer'
import { useReviewStore } from '@/stores/review-store'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(async () => ({ url: '/asset.webp' })) },
}))

const asset = { id: 'a1', name: 'Demo', asset_type: 'image' } as never
const version = { id: 'v1', version_number: 1, files: [] } as never

/**
 * Regression guard for #185. The annotation layer used to be mounted in a plain
 * `absolute inset-0` div, i.e. the letterboxed CONTAINER box, so a drawing made
 * in one container aspect ratio landed somewhere else in another. It must be
 * mounted in the box the picture actually occupies.
 *
 * jsdom does no layout, so the <img> geometry is stubbed on the prototype
 * before render — the component's own effect then reads it for real.
 */

beforeEach(() => {
  useReviewStore.getState().reset()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  restoreGeometry()
})

describe('ImageViewer annotation frame', () => {
  it('mounts the annotation layer over the picture, not the letterboxed container', async () => {
    // A portrait image rendered at natural size inside a wider container:
    // max-w-full/max-h-full leaves 350px of empty space either side.
    stubGeometry({
      naturalWidth: 100, naturalHeight: 200,
      offsetWidth: 100, offsetHeight: 200, offsetLeft: 350, offsetTop: 100,
    })

    render(
      <ImageViewer
        asset={asset}
        version={version}
        annotationCanvas={<div data-testid="annotation-slot" />}
      />,
    )

    const slot = await screen.findByTestId('annotation-slot')
    await waitFor(() => {
      expect(slot.parentElement).toHaveStyle({
        position: 'absolute',
        left: '350px',
        top: '100px',
        width: '100px',
        height: '200px',
      })
    })
  })

  it('keeps the annotation layer a sibling of the image so it zooms and pans with it', async () => {
    stubGeometry({
      naturalWidth: 100, naturalHeight: 200,
      offsetWidth: 100, offsetHeight: 200, offsetLeft: 350, offsetTop: 100,
    })

    const { container } = render(
      <ImageViewer
        asset={asset}
        version={version}
        annotationCanvas={<div data-testid="annotation-slot" />}
      />,
    )

    const slot = await screen.findByTestId('annotation-slot')
    const img = container.querySelector('img') as HTMLImageElement
    // Same positioned ancestor as the <img>: the constraint's left/top are in
    // that element's coordinate space, and the whole group sits inside the
    // zoom/pan transform.
    expect(slot.parentElement?.parentElement).toContainElement(img)
  })
})
