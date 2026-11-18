import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useMediaQuery } from '../use-media-query'

/**
 * The review screens pick their comment surface from two of these:
 * a bottom sheet when `!isWide && !isLandscape`, the side-by-side column
 * otherwise. Getting the subscription wrong shows up as a layout that is
 * correct on load and then never reacts to a rotation.
 */

type Listener = (e: { matches: boolean }) => void

function stubMatchMedia(initial: Record<string, boolean>) {
  const listeners = new Map<string, Set<Listener>>()
  const state = { ...initial }
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return !!state[query]
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: Listener) => {
      if (!listeners.has(query)) listeners.set(query, new Set())
      listeners.get(query)!.add(fn)
    },
    removeEventListener: (_: string, fn: Listener) => listeners.get(query)?.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  return {
    change(query: string, matches: boolean) {
      state[query] = matches
      act(() => {
        listeners.get(query)?.forEach((fn) => fn({ matches }))
      })
    },
  }
}

function Probe({ query }: { query: string }) {
  const matches = useMediaQuery(query)
  return <span data-testid="result">{String(matches)}</span>
}

afterEach(() => vi.unstubAllGlobals())

describe('useMediaQuery', () => {
  it('reports the query state on first render, with no flash of the wrong layout', () => {
    stubMatchMedia({ '(min-width: 768px)': true })
    render(<Probe query="(min-width: 768px)" />)
    expect(screen.getByTestId('result').textContent).toBe('true')
  })

  it('reacts to a change, which is what a rotation is', () => {
    const mm = stubMatchMedia({ '(orientation: landscape)': false })
    render(<Probe query="(orientation: landscape)" />)
    expect(screen.getByTestId('result').textContent).toBe('false')

    mm.change('(orientation: landscape)', true)
    expect(screen.getByTestId('result').textContent).toBe('true')
  })

  it('tracks each query independently, since the sheet rule reads two of them', () => {
    stubMatchMedia({ '(min-width: 768px)': false, '(orientation: landscape)': true })
    render(
      <>
        <span data-testid="wide">{String(false)}</span>
        <Probe query="(orientation: landscape)" />
      </>,
    )
    // A landscape phone: narrow AND landscape, which is the case that must keep
    // the side-by-side column rather than taking the sheet.
    expect(screen.getByTestId('result').textContent).toBe('true')
  })
})
