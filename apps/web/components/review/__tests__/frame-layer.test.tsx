import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRef } from 'react'
import { useFirstFrame } from '@/hooks/use-first-frame'
import { setLastFrame } from '@/lib/first-frame'
import { FrameLayer } from '../frame-layer'

function Harness({ src, poster }: { src: string | null; poster?: string | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  const f = useFirstFrame(ref, src, poster)
  return (
    <div>
      <video ref={ref} data-testid="v" />
      <FrameLayer covered={f.covered} image={f.image} />
    </div>
  )
}

const covered = () => screen.getByTestId('frame-layer').getAttribute('data-covered')

beforeEach(() => setLastFrame(null))

describe('frame layer over the video', () => {
  it('shows the poster until loadeddata, then uncovers', () => {
    render(<Harness src="a.mp4" poster="/p.jpg" />)
    expect(covered()).toBe('true')
    expect(screen.getByTestId('frame-layer')).toHaveAttribute('src', '/p.jpg')
    act(() => { fireEvent(screen.getByTestId('v'), new Event('loadeddata')) })
    expect(covered()).toBe('false')
  })

  it('without a poster nothing is drawn over the video', () => {
    render(<Harness src="a.mp4" />)
    expect(screen.queryByTestId('frame-layer')).toBeNull()
  })

  it('switching source keeps the last frame visible until the new source has a frame', () => {
    const { rerender } = render(<Harness src="hook1.mp4" poster="/p1.jpg" />)
    act(() => { fireEvent(screen.getByTestId('v'), new Event('loadeddata')) })
    expect(covered()).toBe('false')
    setLastFrame('data:image/jpeg;base64,AAA') // what hook 1 left behind
    rerender(<Harness src="hook2.mp4" />)
    expect(covered()).toBe('true')
    expect(screen.getByTestId('frame-layer')).toHaveAttribute('src', 'data:image/jpeg;base64,AAA')
    act(() => { fireEvent(screen.getByTestId('v'), new Event('seeked')) })
    expect(covered()).toBe('false')
  })
})
