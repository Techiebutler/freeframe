import { describe, it, expect, vi } from 'vitest';
import { act } from '@testing-library/react';
import { setViewportWidth } from './setup';

describe('matchMedia stub (#188)', () => {
  it('evaluates (min-width: 768px) correctly across viewports', () => {
    // 1. Below breakpoint (390px) -> false
    act(() => {
      setViewportWidth(390);
    });
    expect(window.matchMedia('(min-width: 768px)').matches).toBe(false);

    // 2. Exact boundary (768px) -> true
    act(() => {
      setViewportWidth(768);
    });
    expect(window.matchMedia('(min-width: 768px)').matches).toBe(true);

    // 3. Above breakpoint (1024px) -> true
    act(() => {
      setViewportWidth(1024);
    });
    expect(window.matchMedia('(min-width: 768px)').matches).toBe(true);
  });

  it('handles prefers-color-scheme explicitly, independent of viewport width', () => {
    // Every real matchMedia caller in the repo besides the 768px breakpoint is a
    // color-scheme query (theme-store.ts, theme-initializer.tsx,
    // folder-share-viewer.tsx) — it must never be answered from width logic.
    act(() => {
      setViewportWidth(1024); // >= 768, so a width-based fallthrough would wrongly report true
    });
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);

    act(() => {
      setViewportWidth(390);
    });
    expect(window.matchMedia('(prefers-color-scheme: dark)').matches).toBe(false);
  });

  it('fires a change event on subscribed listeners when the width crosses the query boundary', () => {
    // Pin a known starting width first — setViewportWidth is module-level state
    // shared across the `it` blocks in this file, so the test can't assume
    // where a previous one left it.
    act(() => {
      setViewportWidth(1024);
    });

    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = vi.fn();
    mql.addEventListener('change', onChange);

    act(() => {
      setViewportWidth(390); // below -> matches flips to false
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ matches: false, media: '(min-width: 768px)' });

    act(() => {
      setViewportWidth(1024); // back above -> matches flips to true
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ matches: true, media: '(min-width: 768px)' });

    // No-op: still above the breakpoint, matches doesn't flip, listener shouldn't re-fire.
    act(() => {
      setViewportWidth(1200);
    });
    expect(onChange).toHaveBeenCalledTimes(2);

    mql.removeEventListener('change', onChange);
    act(() => {
      setViewportWidth(390);
    });
    expect(onChange).toHaveBeenCalledTimes(2); // removed — no further calls
  });

  it('supports the legacy addListener/removeListener surface', () => {
    act(() => {
      setViewportWidth(1024);
    });

    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = vi.fn();
    mql.addListener(onChange);

    act(() => {
      setViewportWidth(390);
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    mql.removeListener(onChange);
    act(() => {
      setViewportWidth(1024);
    });
    expect(onChange).toHaveBeenCalledTimes(1); // removed — no further calls
  });
});
