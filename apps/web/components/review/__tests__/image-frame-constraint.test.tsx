import { describe, expect, it, beforeEach, vi } from 'vitest'
import * as React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ImageFrameConstraint } from '../image-frame-constraint'

/**
 * jsdom performs no layout, so offsetWidth/naturalWidth are always 0. These
 * tests stub those DOM properties to describe a laid-out image and then assert
 * on the style the component actually computes — the component's real effect
 * runs, nothing about it is mocked.
 */
function layOut(
  img: HTMLImageElement,
  g: { natural: [number, number]; box: [number, number]; offset: [number, number] },
) {
  const props: Record<string, number> = {
    naturalWidth: g.natural[0],
    naturalHeight: g.natural[1],
    offsetWidth: g.box[0],
    offsetHeight: g.box[1],
    offsetLeft: g.offset[0],
    offsetTop: g.offset[1],
  }
  for (const [k, value] of Object.entries(props)) {
    Object.defineProperty(img, k, { value, configurable: true })
  }
}

function Harness({
  geometry,
}: {
  geometry: { natural: [number, number]; box: [number, number]; offset: [number, number] }
}) {
  const imgRef = React.useRef<HTMLImageElement>(null)
  // Lay the image out before the constraint's effect reads it.
  React.useLayoutEffect(() => {
    if (imgRef.current) layOut(imgRef.current, geometry)
  }, [geometry])
  return (
    <div style={{ position: 'relative' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} alt="subject" />
      <ImageFrameConstraint imgRef={imgRef}>
        <div data-testid="child" />
      </ImageFrameConstraint>
    </div>
  )
}

const wrapper = () => screen.getByTestId('child').parentElement as HTMLElement

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

describe('ImageFrameConstraint', () => {
  it('positions the annotation layer over the picture, not the letterboxed container', () => {
    // 100x200 image centred in an 800x400 box: max-* leaves it at natural size.
    render(<Harness geometry={{ natural: [100, 200], box: [100, 200], offset: [350, 100] }} />)

    expect(wrapper()).toHaveStyle({
      position: 'absolute',
      left: '350px',
      top: '100px',
      width: '100px',
      height: '200px',
    })
  })

  it('excludes the letterbox bands when the element itself fills the container', () => {
    // The <video>-style case: element stretched to 800x400, picture is 200x400.
    render(<Harness geometry={{ natural: [100, 200], box: [800, 400], offset: [0, 0] }} />)

    expect(wrapper()).toHaveStyle({ left: '300px', top: '0px', width: '200px', height: '400px' })
  })

  it('recalculates once the image decodes and reports its intrinsic size', () => {
    const { container } = render(
      // naturalWidth 0 — not decoded yet, so the element box is all we know.
      <Harness geometry={{ natural: [0, 0], box: [800, 400], offset: [0, 0] }} />,
    )
    expect(wrapper()).toHaveStyle({ width: '800px', height: '400px' })

    const img = container.querySelector('img') as HTMLImageElement
    layOut(img, { natural: [100, 200], box: [800, 400], offset: [0, 0] })
    act(() => { fireEvent.load(img) })

    expect(wrapper()).toHaveStyle({ left: '300px', width: '200px', height: '400px' })
  })

  it('renders its children inside the constrained box', () => {
    render(<Harness geometry={{ natural: [100, 200], box: [100, 200], offset: [350, 100] }} />)
    // AnnotationOverlay and AnnotationCanvas both size themselves from their
    // parent, so being INSIDE this wrapper is what puts them in image space.
    expect(wrapper()).toContainElement(screen.getByTestId('child'))
  })

  it('recomputes when the container resizes', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { observers.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    })

    const { container } = render(
      <Harness geometry={{ natural: [100, 200], box: [800, 400], offset: [0, 0] }} />,
    )
    expect(wrapper()).toHaveStyle({ left: '300px', width: '200px' })

    // Sidebar collapses: the pane gets wider, so the picture recentres.
    const img = container.querySelector('img') as HTMLImageElement
    layOut(img, { natural: [100, 200], box: [1000, 400], offset: [0, 0] })
    act(() => { observers.forEach((cb) => cb()) })

    expect(wrapper()).toHaveStyle({ left: '400px', width: '200px' })
  })

  it('recomputes when the container resizes but the picture only recentres', () => {
    // Records what each observer was pointed at, so a resize can be delivered to
    // one element and not another. That distinction is the whole point here: the
    // test above fires every callback regardless of target, which passes whether
    // the component watches the picture or its container.
    const observed = new Map<Element, Array<() => void>>()
    vi.stubGlobal('ResizeObserver', class {
      cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe(el: Element) { observed.set(el, [...(observed.get(el) ?? []), this.cb]) }
      unobserve() {}
      disconnect() {}
    })

    // A 100x200 picture at natural size in a wide pane: max-* only ever shrinks,
    // so the element hugs the picture and the pane centres it.
    const { container } = render(
      <Harness geometry={{ natural: [100, 200], box: [100, 200], offset: [400, 100] }} />,
    )
    expect(wrapper()).toHaveStyle({ left: '400px', top: '100px' })

    // Sidebar collapses: the pane widens, the picture stays 100x200 and only
    // recentres. The <img>'s own box never changes, so an observer on the <img>
    // alone never fires — only one on the container does.
    const img = container.querySelector('img') as HTMLImageElement
    layOut(img, { natural: [100, 200], box: [100, 200], offset: [600, 100] })
    act(() => { observed.get(img.parentElement as Element)?.forEach((cb) => cb()) })

    expect(wrapper()).toHaveStyle({ left: '600px', top: '100px' })
  })
})
