'use client'

import { use } from 'react'
import { InviteAccept } from '@/components/auth/invite-accept'

interface InvitePageProps {
  params: Promise<{ token: string }>
}

export default function InvitePage({ params }: InvitePageProps) {
  const { token } = use(params)
  return <InviteAccept token={token} />
}
