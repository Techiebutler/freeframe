'use client'

import * as React from 'react'
import SharePage from '@/app/share/[token]/page'

type TokenParams = { token: string }

/**
 * A promise React already knows is fulfilled, so `React.use` inside SharePage
 * reads it synchronously instead of suspending the page for a tick.
 */
function resolvedParams(token: string): Promise<TokenParams> {
  const value = { token }
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value })
}

export default function ShortSharePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = React.use(params)
  const tokenParams = React.useMemo(() => resolvedParams(code), [code])
  return <SharePage params={tokenParams} />
}
