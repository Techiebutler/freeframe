import { describe, it, expect } from 'vitest';
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
});
