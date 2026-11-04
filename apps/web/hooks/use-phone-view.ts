'use client'

import { useCallback, useEffect, useState } from 'react'

const KEY = 'ar-flow-view'

/** Desktop Flow view (Talk + Draw): on by default, the last choice is remembered. */
export function usePhoneView() {
  const [on, setOn] = useState(true)
  useEffect(() => {
    try { if (localStorage.getItem(KEY) === '0') setOn(false) } catch {}
  }, [])
  const set = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setOn(prev => {
      const v = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem(KEY, v ? '1' : '0') } catch {}
      return v
    })
  }, [])
  return [on, set] as const
}
